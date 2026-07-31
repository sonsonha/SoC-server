import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import {
  calendarCommitments,
  calendarSyncState,
  dailyPlans,
  planBlocks,
} from '../../infrastructure/db/schema/index.js';
import type { CalendarProvider } from '../../infrastructure/providers/calendar/types.js';
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
  replannedDates: string[];
  connected: boolean;
};

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
      return { fetched: 0, upserted: 0, removed: 0, replannedDates: [], connected: false };
    }

    const events = await this.calendar.listEvents(fromEpochMs, toEpochMs);
    const existing = await this.db
      .select()
      .from(calendarCommitments)
      .where(isNull(calendarCommitments.deletedAt));

    const byExternal = new Map(existing.map((r) => [r.externalCalendarEventId, r]));
    const seen = new Set<string>();
    let upserted = 0;
    const touchedDates = new Set<string>();
    let materialChange = false;

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
      fetched: events.length,
      upserted,
      removed,
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
