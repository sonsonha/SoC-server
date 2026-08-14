import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import {
  calendarCommitments,
  calendarSyncState,
  dailyPlans,
  planBlocks,
  tasks,
  timeBlocks,
} from '../../infrastructure/db/schema/index.js';
import type {
  CalendarEvent,
  CalendarProvider,
} from '../../infrastructure/providers/calendar/types.js';
import type { JobQueue } from '../../infrastructure/jobs/jobQueue.js';
import type { NotificationService } from '../../infrastructure/notifications/notificationService.js';

const REPLAN_DEBOUNCE_MS = 5 * 60_000;
const HORIZON_DAYS = 14;

function dateKey(epochMs: number, timeZone = 'Asia/Ho_Chi_Minh'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));
}

export type CalendarPullSummary = {
  fetched: number;
  upserted: number;
  removed: number;
  ownedUpdated: number;
  ownedRemoved: number;
  replannedDates: string[];
  connected: boolean;
};

export function isPlannerOwnedCalendarEvent(event: CalendarEvent): boolean {
  return event.appMetadata?.plannerOrigin === 'personal-os' && Boolean(event.appMetadata.timeBlockId);
}

export function plannerBlockReconciliation(
  block: {
    title: string;
    startEpochMs: number;
    endEpochMs: number;
    syncStatus: string;
  },
  event?: CalendarEvent,
): 'remove' | 'update' | 'none' {
  if (!event) return 'remove';
  return block.title !== event.title ||
    block.startEpochMs !== event.startEpochMs ||
    block.endEpochMs !== event.endEpochMs ||
    block.syncStatus !== 'SYNCED'
    ? 'update'
    : 'none';
}

export class CalendarPullService {
  constructor(
    private readonly db: Db,
    private readonly calendar: CalendarProvider,
    private readonly jobs: JobQueue,
    private readonly notifications: NotificationService | null = null,
    private readonly isConnected: () => Promise<boolean> = async () => true,
  ) {}

  async pull(opts?: { fromEpochMs?: number; toEpochMs?: number }): Promise<CalendarPullSummary> {
    const connected = await this.isConnected();
    const now = Date.now();
    const fromEpochMs = opts?.fromEpochMs ?? now - 86_400_000;
    const toEpochMs = opts?.toEpochMs ?? now + HORIZON_DAYS * 86_400_000;

    if (!connected) {
      return {
        fetched: 0,
        upserted: 0,
        removed: 0,
        ownedUpdated: 0,
        ownedRemoved: 0,
        replannedDates: [],
        connected: false,
      };
    }

    const [primaryEvents, cosEvents, plannerOwnedRows] = await Promise.all([
      this.calendar.listEvents(fromEpochMs, toEpochMs),
      this.calendar.listCosEvents
        ? this.calendar.listCosEvents(fromEpochMs, toEpochMs)
        : Promise.resolve([]),
      this.db
        .select()
        .from(timeBlocks)
        .where(
          and(
            isNull(timeBlocks.deletedAt),
            lt(timeBlocks.startEpochMs, toEpochMs),
            gt(timeBlocks.endEpochMs, fromEpochMs),
          ),
        ),
    ]);
    const allEventsById = new Map(
      [...primaryEvents, ...cosEvents].map((event) => [event.eventId, event]),
    );
    const knownOwnedIds = new Set<string>(
      plannerOwnedRows.flatMap((row) => row.googleEventId ? [row.googleEventId] : []),
    );
    const ownedEventsByBlockId = new Map(
      [...allEventsById.values()].flatMap((event) => {
        const blockId = isPlannerOwnedCalendarEvent(event)
          ? event.appMetadata?.timeBlockId
          : undefined;
        return blockId ? [[blockId, event] as const] : [];
      }),
    );
    const events = [...allEventsById.values()].filter(
      (event) => !knownOwnedIds.has(event.eventId) && !isPlannerOwnedCalendarEvent(event),
    );
    const existing = await this.db
      .select()
      .from(calendarCommitments)
      .where(isNull(calendarCommitments.deletedAt));

    const byExternal = new Map(existing.map((r) => [r.externalCalendarEventId, r]));
    const seen = new Set<string>();
    let upserted = 0;
    let ownedUpdated = 0;
    let ownedRemoved = 0;
    const touchedDates = new Set<string>();
    let materialChange = false;

    // Personal OS owns these rows, so edits/deletes made directly in Google
    // reconcile back to the local source of truth instead of being imported as
    // duplicate locked EXTERNAL commitments.
    if (this.calendar.listCosEvents) {
      for (const row of plannerOwnedRows) {
        const event =
          (row.googleEventId ? allEventsById.get(row.googleEventId) : undefined) ??
          ownedEventsByBlockId.get(row.id);
        // A pending/failed local block that never obtained a Google event ID
        // has nothing to reconcile yet; retryCalendarSync handles it below.
        if (!row.googleEventId && !event) continue;
        const reconciliation = plannerBlockReconciliation(row, event);
        if (reconciliation === 'remove') {
          const changedAt = new Date();
          await this.db
            .update(timeBlocks)
            .set({
              deletedAt: changedAt,
              syncStatus: 'SYNCED',
              revision: row.revision + 1,
              updatedAt: changedAt,
            })
            .where(eq(timeBlocks.id, row.id));
          if (row.taskId) {
            const taskRows = await this.db.select().from(tasks).where(eq(tasks.id, row.taskId)).limit(1);
            const task = taskRows[0];
            if (task && !task.deletedAt && task.status !== 'DONE') {
              await this.db
                .update(tasks)
                .set({ status: 'TODO', revision: task.revision + 1, updatedAt: changedAt })
                .where(eq(tasks.id, task.id));
            }
          }
          touchedDates.add(dateKey(row.startEpochMs));
          ownedRemoved += 1;
          materialChange = true;
          continue;
        }
        if (reconciliation === 'update' && event) {
          await this.db
            .update(timeBlocks)
            .set({
              title: event.title,
              startEpochMs: event.startEpochMs,
              endEpochMs: event.endEpochMs,
              calendarId: event.calendarId ?? row.calendarId,
              googleEventId: event.eventId,
              syncStatus: 'SYNCED',
              revision: row.revision + 1,
              updatedAt: new Date(),
            })
            .where(eq(timeBlocks.id, row.id));
          touchedDates.add(dateKey(row.startEpochMs));
          touchedDates.add(dateKey(event.startEpochMs));
          ownedUpdated += 1;
          materialChange = true;
        }
      }
    }

    for (const event of events) {
      seen.add(event.eventId);
      const prev = byExternal.get(event.eventId);
      const id = prev?.id ?? `cal-${event.eventId}`;
      const changed =
        !prev ||
        prev.title !== event.title ||
        prev.startEpochMs !== event.startEpochMs ||
        prev.endEpochMs !== event.endEpochMs;

      await this.db
        .insert(calendarCommitments)
        .values({
          id,
          externalCalendarEventId: event.eventId,
          title: event.title,
          startEpochMs: event.startEpochMs,
          endEpochMs: event.endEpochMs,
          location: event.location ?? null,
          calendarId: event.calendarId ?? 'primary',
          revision: (prev?.revision ?? 0) + 1,
          updatedAt: new Date(),
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: calendarCommitments.id,
          set: {
            title: event.title,
            startEpochMs: event.startEpochMs,
            endEpochMs: event.endEpochMs,
            location: event.location ?? null,
            calendarId: event.calendarId ?? 'primary',
            revision: (prev?.revision ?? 0) + 1,
            updatedAt: new Date(),
            deletedAt: null,
          },
        });

      const date = dateKey(event.startEpochMs);
      await this.ensureDailyPlan(date);
      await this.upsertExternalBlock({
        commitmentId: id,
        externalEventId: event.eventId,
        title: event.title,
        date,
        startEpochMs: event.startEpochMs,
        endEpochMs: event.endEpochMs,
      });

      upserted += 1;
      if (changed) {
        materialChange = true;
        touchedDates.add(date);
      }
    }

    let removed = 0;
    for (const row of existing) {
      if (seen.has(row.externalCalendarEventId)) continue;
      if (row.startEpochMs > toEpochMs || row.endEpochMs < fromEpochMs) continue;
      await this.db
        .update(calendarCommitments)
        .set({ deletedAt: new Date(), updatedAt: new Date(), revision: row.revision + 1 })
        .where(eq(calendarCommitments.id, row.id));
      await this.softDeleteExternalBlocks(row.id);
      removed += 1;
      materialChange = true;
      touchedDates.add(dateKey(row.startEpochMs));
    }

    const replannedDates: string[] = [];
    if (materialChange) {
      const stateRows = await this.db.select().from(calendarSyncState).limit(1);
      const lastReplan = stateRows[0]?.lastReplanAt?.getTime() ?? 0;
      if (Date.now() - lastReplan >= REPLAN_DEBOUNCE_MS) {
        for (const date of touchedDates) {
          this.jobs.enqueue('plan.replan', {
            date,
            disruption: {
              type: 'NEW_MEETING',
              note: 'Calendar sync — EXTERNAL commitments updated',
            },
          });
          replannedDates.push(date);
        }
        await this.db
          .insert(calendarSyncState)
          .values({
            id: 'default',
            lastSyncAt: new Date(),
            lastReplanAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: calendarSyncState.id,
            set: {
              lastSyncAt: new Date(),
              lastReplanAt: new Date(),
              updatedAt: new Date(),
            },
          });
        if (this.notifications && replannedDates.length > 0) {
          await this.notifications.notify({
            type: 'PLAN_UPDATED',
            title: 'Calendar updated',
            body: 'External meetings synced — plan adjusting',
            deepLink: 'cos://today',
            entityType: 'calendar',
            entityId: 'sync',
          });
        }
      } else {
        await this.touchSyncState();
      }
    } else {
      await this.touchSyncState();
    }

    return {
      fetched: allEventsById.size,
      upserted,
      removed,
      ownedUpdated,
      ownedRemoved,
      replannedDates,
      connected: true,
    };
  }

  async listStoredEvents(fromEpochMs: number, toEpochMs: number) {
    const rows = await this.db
      .select()
      .from(calendarCommitments)
      .where(isNull(calendarCommitments.deletedAt));
    return rows
      .filter((r) => r.startEpochMs < toEpochMs && r.endEpochMs > fromEpochMs)
      .map((r) => ({
        eventId: r.externalCalendarEventId,
        title: r.title,
        startEpochMs: r.startEpochMs,
        endEpochMs: r.endEpochMs,
        location: r.location,
        ownership: 'EXTERNAL' as const,
      }));
  }

  private async touchSyncState(): Promise<void> {
    await this.db
      .insert(calendarSyncState)
      .values({ id: 'default', lastSyncAt: new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: calendarSyncState.id,
        set: { lastSyncAt: new Date(), updatedAt: new Date() },
      });
  }

  private async ensureDailyPlan(date: string): Promise<string> {
    const planId = `plan-${date}`;
    const existing = await this.db
      .select({ id: dailyPlans.id })
      .from(dailyPlans)
      .where(eq(dailyPlans.id, planId))
      .limit(1);
    if (existing[0]) return planId;
    await this.db.insert(dailyPlans).values({
      id: planId,
      date,
      mainOutcome: null,
      anchorTaskIds: [],
      briefing: null,
      bufferMinutes: 30,
      hardStopNotes: null,
      revision: 1,
      updatedAt: new Date(),
    });
    return planId;
  }

  private async upsertExternalBlock(input: {
    commitmentId: string;
    externalEventId: string;
    title: string;
    date: string;
    startEpochMs: number;
    endEpochMs: number;
  }): Promise<void> {
    const blockId = `ext-${input.externalEventId}`;
    const planId = `plan-${input.date}`;
    await this.db
      .insert(planBlocks)
      .values({
        id: blockId,
        dailyPlanId: planId,
        date: input.date,
        startEpochMs: input.startEpochMs,
        endEpochMs: input.endEpochMs,
        type: 'COMMITMENT',
        ownership: 'EXTERNAL',
        title: input.title,
        taskId: null,
        habitId: null,
        commitmentId: input.commitmentId,
        locationId: null,
        locked: true,
        preparationId: null,
        revision: 1,
        updatedAt: new Date(),
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: planBlocks.id,
        set: {
          title: input.title,
          startEpochMs: input.startEpochMs,
          endEpochMs: input.endEpochMs,
          date: input.date,
          dailyPlanId: planId,
          commitmentId: input.commitmentId,
          ownership: 'EXTERNAL',
          locked: true,
          deletedAt: null,
          revision: 2,
          updatedAt: new Date(),
        },
      });
  }

  private async softDeleteExternalBlocks(commitmentId: string): Promise<void> {
    await this.db
      .update(planBlocks)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(planBlocks.commitmentId, commitmentId),
          eq(planBlocks.ownership, 'EXTERNAL'),
          isNull(planBlocks.deletedAt),
        ),
      );
  }
}

/** Pure ownership helper — EXTERNAL blocks must survive replan diffs. */
export function externalBlocksUntouched(
  before: Array<{ id: string; ownership: string; startEpochMs: number; endEpochMs: number }>,
  after: Array<{ id: string; ownership: string; startEpochMs: number; endEpochMs: number }>,
): boolean {
  const beforeExt = before.filter((b) => b.ownership === 'EXTERNAL');
  for (const b of beforeExt) {
    const match = after.find((a) => a.id === b.id);
    if (!match) return false;
    if (match.startEpochMs !== b.startEpochMs || match.endEpochMs !== b.endEpochMs) return false;
  }
  return true;
}

export { randomUUID };
