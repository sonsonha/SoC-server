import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../infrastructure/db/client.js';
import type {
  DisruptionPayload,
  PlanBlockRecord,
  ReplanResult,
} from '../domain/planning/disruption.js';
import {
  calendarCommitments,
  calendarSyncState,
  dailyPlans,
  learningItems,
  learningTracks,
  planBlocks,
  planningRuns,
  preparations,
  seasons,
  tasks,
} from '../infrastructure/db/schema/index.js';
import { planRevisions } from '../infrastructure/db/schema/planning.js';
import type { JobQueue } from '../infrastructure/jobs/jobQueue.js';
import { replanFromNow } from '../modules/planning/replanner.js';
import type { NotificationService } from '../infrastructure/notifications/notificationService.js';
import type { CalendarProvider } from '../infrastructure/providers/calendar/types.js';
import {
  autonomyAllowsCalendarWrite,
  getPlanningPreferences,
} from '../modules/planning/planningPrefs.js';

export type GenerateDayInput = {
  date: string;
  taskId?: string;
  learningItemId?: string;
  locationId?: string;
};

export type ReplanInput = {
  date: string;
  from?: string;
  disruption: DisruptionPayload;
};

export type PrepareTomorrowInput = {
  date?: string;
};

type BusyWindow = { startEpochMs: number; endEpochMs: number };

type CosSlotCandidate = {
  title: string;
  minutes: number;
  type: 'TASK' | 'HABIT';
  taskId: string | null;
  habitId: string | null;
  learningItemId?: string | null;
  locationId: string;
  needsPrep: boolean;
  targetType: string;
  goal?: string;
  doneCriteria?: string[];
};

const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 21;
const HARD_STOP_HOUR = 18;
const BUFFER_MS = 15 * 60_000;

function dateKey(epochMs: number, timeZone = TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));
}

function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Local wall-clock for Asia/Ho_Chi_Minh (UTC+7, no DST). Prefer planning_preferences timezone for scheduling. */
function localEpochMs(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hour - 7, minute, 0);
}

function overlaps(a: BusyWindow, b: BusyWindow): boolean {
  return a.startEpochMs < b.endEpochMs && a.endEpochMs > b.startEpochMs;
}

function findSlot(
  date: string,
  minutes: number,
  busy: BusyWindow[],
  preferAfterMs?: number,
): BusyWindow | null {
  const dayStart = localEpochMs(date, DAY_START_HOUR);
  const dayEnd = localEpochMs(date, DAY_END_HOUR);
  const durationMs = minutes * 60_000;
  let cursor = Math.max(dayStart, preferAfterMs ?? dayStart);

  while (cursor + durationMs <= dayEnd) {
    const candidate = { startEpochMs: cursor, endEpochMs: cursor + durationMs };
    const hit = busy.find((w) => overlaps(candidate, w));
    if (!hit) return candidate;
    cursor = hit.endEpochMs + BUFFER_MS;
  }
  return null;
}

export class PlanService {
  private notifications: NotificationService | null = null;
  private calendar: CalendarProvider | null = null;

  constructor(
    private readonly db: Db,
    private readonly jobs: JobQueue,
  ) {}

  setNotificationService(service: NotificationService): void {
    this.notifications = service;
  }

  setCalendarProvider(provider: CalendarProvider): void {
    this.calendar = provider;
  }

  async generateDay(input: GenerateDayInput): Promise<{
    dailyPlanId: string;
    blockId: string;
    preparationId: string;
  }> {
    const planId = `plan-${input.date}`;
    const now = new Date();

    const seasonRows = await this.db
      .select()
      .from(seasons)
      .where(and(eq(seasons.active, true), isNull(seasons.deletedAt)))
      .limit(1);
    const mainOutcome = seasonRows[0]?.title ?? 'Make meaningful progress today';

    let taskTitle = 'Learning session';
    let taskMinutes = 45;
    let taskId = input.taskId;

    if (taskId) {
      const taskRows = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      if (taskRows[0]) {
        taskTitle = taskRows[0].title;
        taskMinutes = taskRows[0].estimatedMinutes;
      }
    } else if (input.learningItemId) {
      const liRows = await this.db
        .select()
        .from(learningItems)
        .where(eq(learningItems.id, input.learningItemId))
        .limit(1);
      if (liRows[0]) {
        taskTitle = liRows[0].title;
        taskMinutes = liRows[0].estimatedMinutes;
      }
    }

    const briefing = `Focus: ${mainOutcome}. First block: ${taskTitle}.`;
    const hardStopNotes = `Hard stop deep work by ${HARD_STOP_HOUR}:00 — protect evening wind-down.`;

    await this.db
      .insert(dailyPlans)
      .values({
        id: planId,
        date: input.date,
        mainOutcome,
        anchorTaskIds: taskId ? [taskId] : [],
        briefing,
        bufferMinutes: 30,
        hardStopNotes,
        status: 'ACCEPTED',
        acceptedAt: now,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: dailyPlans.id,
        set: {
          mainOutcome,
          anchorTaskIds: taskId ? [taskId] : [],
          briefing,
          hardStopNotes,
          status: 'ACCEPTED',
          acceptedAt: now,
          revision: 2,
          updatedAt: now,
        },
      });

    const [y, m, d] = input.date.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, d, 14, 0, 0));
    const end = new Date(start.getTime() + taskMinutes * 60_000);

    const preparationId = randomUUID();
    await this.db.insert(preparations).values({
      id: preparationId,
      targetType: 'TASK_BLOCK',
      targetId: taskId ?? preparationId,
      status: 'PENDING',
      scheduledStartAt: start,
      timeBudgetMinutes: taskMinutes,
      goal: '',
      practicePrompt: '',
      doneCriteria: [],
      selectedResourceId: null,
      backupResourceIds: [],
      provenance: null,
      freshnessPolicy: 'STATIC',
      lastPreparedAt: null,
      failureReason: null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    const blockId = `block-${input.date}-learning`;
    await this.db
      .insert(planBlocks)
      .values({
        id: blockId,
        dailyPlanId: planId,
        date: input.date,
        startEpochMs: start.getTime(),
        endEpochMs: end.getTime(),
        type: 'TASK',
        ownership: 'COS',
        title: taskTitle,
        taskId: taskId ?? null,
        habitId: null,
        commitmentId: null,
        locationId: input.locationId ?? 'loc-home',
        locked: false,
        preparationId,
        externalCalendarEventId: null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: planBlocks.id,
        set: {
          title: taskTitle,
          startEpochMs: start.getTime(),
          endEpochMs: end.getTime(),
          taskId: taskId ?? null,
          preparationId,
          revision: 2,
          updatedAt: now,
        },
      });

    this.jobs.enqueue('preparation.run', { preparationId });
    await this.enqueueCosCalendarSync(input.date);

    return { dailyPlanId: planId, blockId, preparationId };
  }

  /**
   * Builds a fuller proposed day for tomorrow (or explicit date):
   * season outcome, EXTERNAL commitments, multi COS blocks, prep enqueue.
   */
  async prepareTomorrow(input: PrepareTomorrowInput = {}): Promise<{
    dailyPlanId: string;
    date: string;
    blockCount: number;
    preparationIds: string[];
  }> {
    const date = input.date ?? addCalendarDays(dateKey(Date.now()), 1);
    const planId = `plan-${date}`;
    const now = new Date();

    const seasonRows = await this.db
      .select()
      .from(seasons)
      .where(and(eq(seasons.active, true), isNull(seasons.deletedAt)))
      .limit(1);
    const season = seasonRows[0];
    const mainOutcome = season?.title ?? 'Make meaningful progress tomorrow';

    const dayStart = localEpochMs(date, 0);
    const dayEnd = localEpochMs(date, 24);
    const commitments = await this.db
      .select()
      .from(calendarCommitments)
      .where(isNull(calendarCommitments.deletedAt));
    const dayCommitments = commitments.filter(
      (c) => c.startEpochMs < dayEnd && c.endEpochMs > dayStart,
    );

    await this.ensureExternalBlocks(date, planId, dayCommitments, now);

    const existingBlocks = await this.db
      .select()
      .from(planBlocks)
      .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));

    // Soft-delete prior COS blocks so we rebuild a fresh proposed day.
    let needsCosCleanup = false;
    for (const old of existingBlocks) {
      if (old.ownership === 'EXTERNAL') continue;
      await this.db
        .update(planBlocks)
        .set({ deletedAt: now, revision: old.revision + 1, updatedAt: now })
        .where(eq(planBlocks.id, old.id));
      if (old.externalCalendarEventId) needsCosCleanup = true;
    }
    if (needsCosCleanup) {
      await this.enqueueCosCalendarSync(date);
    }

    const busy: BusyWindow[] = dayCommitments.map((c) => ({
      startEpochMs: c.startEpochMs,
      endEpochMs: c.endEpochMs,
    }));

    const candidates = await this.collectCosCandidates(date);
    const preparationIds: string[] = [];
    const placedTitles: string[] = [];
    const anchorTaskIds: string[] = [];
    let preferAfter = localEpochMs(date, DAY_START_HOUR);
    let slotIndex = 0;

    for (const candidate of candidates) {
      const slot = findSlot(date, candidate.minutes, busy, preferAfter);
      if (!slot) continue;

      const blockId = `block-${date}-cos-${slotIndex}`;
      slotIndex += 1;

      let preparationId: string | null = null;
      if (candidate.needsPrep) {
        preparationId = randomUUID();
        await this.db.insert(preparations).values({
          id: preparationId,
          targetType: candidate.targetType,
          targetId: candidate.taskId ?? candidate.learningItemId ?? preparationId,
          status: 'PENDING',
          scheduledStartAt: new Date(slot.startEpochMs),
          timeBudgetMinutes: candidate.minutes,
          goal: candidate.goal ?? '',
          practicePrompt: '',
          doneCriteria: candidate.doneCriteria ?? [],
          selectedResourceId: null,
          backupResourceIds: [],
          provenance: null,
          freshnessPolicy: 'STATIC',
          lastPreparedAt: null,
          failureReason: null,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        });
        preparationIds.push(preparationId);
      }

      await this.db
        .insert(planBlocks)
        .values({
          id: blockId,
          dailyPlanId: planId,
          date,
          startEpochMs: slot.startEpochMs,
          endEpochMs: slot.endEpochMs,
          type: candidate.type,
          ownership: 'COS',
          title: candidate.title,
          taskId: candidate.taskId,
          habitId: candidate.habitId,
          commitmentId: null,
          locationId: candidate.locationId,
          locked: false,
          preparationId,
          externalCalendarEventId: null,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: planBlocks.id,
          set: {
            dailyPlanId: planId,
            startEpochMs: slot.startEpochMs,
            endEpochMs: slot.endEpochMs,
            type: candidate.type,
            ownership: 'COS',
            title: candidate.title,
            taskId: candidate.taskId,
            habitId: candidate.habitId,
            locationId: candidate.locationId,
            preparationId,
            revision: 2,
            updatedAt: now,
            deletedAt: null,
          },
        });

      busy.push({ ...slot, startEpochMs: slot.startEpochMs - BUFFER_MS, endEpochMs: slot.endEpochMs + BUFFER_MS });
      preferAfter = slot.endEpochMs + BUFFER_MS;
      placedTitles.push(candidate.title);
      if (candidate.taskId) anchorTaskIds.push(candidate.taskId);
    }

    // Fallback: at least one learning/focus block if nothing else placed.
    if (placedTitles.length === 0) {
      const minutes = 45;
      const slot =
        findSlot(date, minutes, busy, localEpochMs(date, 14)) ??
        ({
          startEpochMs: localEpochMs(date, 14),
          endEpochMs: localEpochMs(date, 14) + minutes * 60_000,
        } satisfies BusyWindow);
      const preparationId = randomUUID();
      await this.db.insert(preparations).values({
        id: preparationId,
        targetType: 'TASK_BLOCK',
        targetId: preparationId,
        status: 'PENDING',
        scheduledStartAt: new Date(slot.startEpochMs),
        timeBudgetMinutes: minutes,
        goal: mainOutcome,
        practicePrompt: '',
        doneCriteria: [],
        selectedResourceId: null,
        backupResourceIds: [],
        provenance: null,
        freshnessPolicy: 'STATIC',
        lastPreparedAt: null,
        failureReason: null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });
      preparationIds.push(preparationId);
      await this.db
        .insert(planBlocks)
        .values({
          id: `block-${date}-cos-0`,
          dailyPlanId: planId,
          date,
          startEpochMs: slot.startEpochMs,
          endEpochMs: slot.endEpochMs,
          type: 'TASK',
          ownership: 'COS',
          title: 'Focus block',
          taskId: null,
          habitId: null,
          commitmentId: null,
          locationId: 'loc-home',
          locked: false,
          preparationId,
          externalCalendarEventId: null,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: planBlocks.id,
          set: {
            startEpochMs: slot.startEpochMs,
            endEpochMs: slot.endEpochMs,
            preparationId,
            title: 'Focus block',
            deletedAt: null,
            updatedAt: now,
            revision: 2,
          },
        });
      placedTitles.push('Focus block');
    }

    const extCount = dayCommitments.length;
    const first = placedTitles[0];
    const briefing = [
      `Tomorrow focuses on ${mainOutcome}.`,
      first ? `First action: ${first}.` : null,
      extCount > 0
        ? `${extCount} external calendar commitment${extCount === 1 ? '' : 's'} protected.`
        : 'No external meetings on the calendar.',
    ]
      .filter(Boolean)
      .join(' ');
    const hardStopNotes = `Hard stop deep work by ${HARD_STOP_HOUR}:00 — protect evening wind-down.`;

    await this.db
      .insert(dailyPlans)
      .values({
        id: planId,
        date,
        mainOutcome,
        anchorTaskIds,
        briefing,
        bufferMinutes: 30,
        hardStopNotes,
        status: 'ACCEPTED',
        planState: 'ACTIVE',
        reviewState: 'UNREVIEWED',
        firstActionTitle: placedTitles[0] ?? null,
        acceptedAt: now,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: dailyPlans.id,
        set: {
          mainOutcome,
          anchorTaskIds,
          briefing,
          hardStopNotes,
          status: 'ACCEPTED',
          planState: 'ACTIVE',
          // Preserve REVIEWED / MANUALLY_ADJUSTED if user already reviewed
          firstActionTitle: placedTitles[0] ?? null,
          acceptedAt: now,
          revision: 2,
          updatedAt: now,
          deletedAt: null,
        },
      });

    for (const preparationId of preparationIds) {
      this.jobs.enqueue('preparation.run', { preparationId });
    }

    await this.enqueueCosCalendarSync(date);

    const finalBlocks = await this.db
      .select()
      .from(planBlocks)
      .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));

    return {
      dailyPlanId: planId,
      date,
      blockCount: finalBlocks.length,
      preparationIds,
    };
  }

  /**
   * Lightweight morning refresh: pull calendar, verify prep readiness, refresh brief if needed.
   * Idempotent — does not regenerate the whole day unless conflicts appear.
   */
  async morningRefresh(input: { date?: string } = {}): Promise<{
    date: string;
    calendarPulled: boolean;
    prepRefreshed: number;
    replanned: boolean;
  }> {
    const date = input.date ?? dateKey(Date.now());
    const idempotencyKey = `morning_refresh:${date}`;
    const existing = await this.db
      .select()
      .from(planningRuns)
      .where(eq(planningRuns.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing[0]?.status === 'SUCCEEDED') {
      return { date, calendarPulled: false, prepRefreshed: 0, replanned: false };
    }

    const runId = randomUUID();
    await this.db.insert(planningRuns).values({
      id: runId,
      runType: 'MORNING_REFRESH',
      targetPeriod: date,
      trigger: 'SCHEDULE',
      status: 'RUNNING',
      startedAt: new Date(),
      idempotencyKey,
      details: {},
    });

    this.jobs.enqueue('calendar.pull', {});
    let prepRefreshed = 0;
    const blocks = await this.db
      .select()
      .from(planBlocks)
      .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));
    for (const block of blocks) {
      if (!block.preparationId) continue;
      const prepRows = await this.db
        .select()
        .from(preparations)
        .where(eq(preparations.id, block.preparationId))
        .limit(1);
      const prep = prepRows[0];
      if (prep && (prep.status === 'PENDING' || prep.status === 'FAILED' || prep.freshnessPolicy === 'DAILY')) {
        this.jobs.enqueue('preparation.refresh', { preparationId: prep.id });
        prepRefreshed += 1;
      }
    }

    // Rebuild briefing lightly if missing
    const planRows = await this.db
      .select()
      .from(dailyPlans)
      .where(eq(dailyPlans.date, date))
      .limit(1);
    if (planRows[0] && !planRows[0].briefing) {
      const first = blocks.find((b) => b.ownership === 'COS');
      await this.db
        .update(dailyPlans)
        .set({
          briefing: first
            ? `Your day is ready. Start with ${first.title}.`
            : 'Your day is ready.',
          firstActionTitle: first?.title ?? planRows[0].firstActionTitle,
          updatedAt: new Date(),
        })
        .where(eq(dailyPlans.id, planRows[0].id));
    }

    await this.db
      .update(planningRuns)
      .set({
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        details: { prepRefreshed },
      })
      .where(eq(planningRuns.id, runId));

    return { date, calendarPulled: true, prepRefreshed, replanned: false };
  }

  async acceptPlan(date: string): Promise<{
    dailyPlanId: string;
    date: string;
    status: string;
    acceptedAt: string;
    calendarSyncEnqueued: boolean;
  }> {
    const planRows = await this.db
      .select()
      .from(dailyPlans)
      .where(and(eq(dailyPlans.date, date), isNull(dailyPlans.deletedAt)))
      .limit(1);
    const plan = planRows[0];
    if (!plan) {
      throw Object.assign(new Error(`No plan for date ${date}`), {
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    }

    const now = new Date();
    await this.db
      .update(dailyPlans)
      .set({
        status: 'ACCEPTED',
        planState: 'ACTIVE',
        reviewState: 'REVIEWED',
        reviewedAt: now,
        acceptedAt: now,
        revision: plan.revision + 1,
        updatedAt: now,
      })
      .where(eq(dailyPlans.id, plan.id));

    const calendarSyncEnqueued = await this.enqueueCosCalendarSync(date);

    return {
      dailyPlanId: plan.id,
      date,
      status: 'ACCEPTED',
      acceptedAt: now.toISOString(),
      calendarSyncEnqueued,
    };
  }

  /** Upsert COS blocks to calendar; delete COS events for dropped blocks. Never touches EXTERNAL. */
  async syncCosCalendar(date: string): Promise<{ upserted: number; deleted: number }> {
    const prefs = await getPlanningPreferences(this.db);
    if (!autonomyAllowsCalendarWrite(prefs.autonomy)) {
      return { upserted: 0, deleted: 0 };
    }
    if (!this.calendar?.upsertCosEvent) {
      return { upserted: 0, deleted: 0 };
    }

    const blocks = await this.db
      .select()
      .from(planBlocks)
      .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));

    const activeCos = blocks.filter((b) => b.ownership === 'COS');
    // Soft-deleted rows: deletedAt IS NOT NULL
    const allForDate = await this.db
      .select()
      .from(planBlocks)
      .where(eq(planBlocks.date, date));
    const dropped = allForDate.filter(
      (b) => b.ownership === 'COS' && b.deletedAt != null && b.externalCalendarEventId,
    );

    let deleted = 0;
    if (this.calendar.deleteCosEvent) {
      for (const block of dropped) {
        const eventId = block.externalCalendarEventId!;
        await this.calendar.deleteCosEvent(eventId);
        await this.db
          .update(planBlocks)
          .set({ externalCalendarEventId: null, updatedAt: new Date() })
          .where(eq(planBlocks.id, block.id));
        deleted += 1;
      }
    }

    let upserted = 0;
    for (const block of activeCos) {
      const eventId = await this.calendar.upsertCosEvent!({
        eventId: block.externalCalendarEventId ?? undefined,
        title: block.title,
        startEpochMs: block.startEpochMs,
        endEpochMs: block.endEpochMs,
        location: block.locationId,
        calendarId: 'cos',
      });
      if (eventId !== block.externalCalendarEventId) {
        await this.db
          .update(planBlocks)
          .set({
            externalCalendarEventId: eventId,
            revision: block.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(planBlocks.id, block.id));
      }
      upserted += 1;
    }

    return { upserted, deleted };
  }

  async replan(input: ReplanInput): Promise<
    ReplanResult & {
      plan: {
        id: string;
        date: string;
        mainOutcome: string | null;
        anchorTaskIds: string[];
        revision: number;
      };
    }
  > {
    const fromMs = input.from ? new Date(input.from).getTime() : Date.now();
    const now = new Date();

    const planRows = await this.db
      .select()
      .from(dailyPlans)
      .where(and(eq(dailyPlans.date, input.date), isNull(dailyPlans.deletedAt)))
      .limit(1);
    const planRow = planRows[0];
    if (!planRow) {
      throw Object.assign(new Error(`No plan for date ${input.date}`), {
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    }

    const blockRows = await this.db
      .select()
      .from(planBlocks)
      .where(and(eq(planBlocks.date, input.date), isNull(planBlocks.deletedAt)));

    let blocks: PlanBlockRecord[] = blockRows.map((row) => ({
      id: row.id,
      dailyPlanId: row.dailyPlanId,
      date: row.date,
      startEpochMs: row.startEpochMs,
      endEpochMs: row.endEpochMs,
      type: row.type,
      ownership: row.ownership,
      title: row.title,
      taskId: row.taskId,
      habitId: row.habitId,
      commitmentId: row.commitmentId,
      locationId: row.locationId,
      locked: row.locked,
      preparationId: row.preparationId,
      revision: row.revision,
    }));

    const anchorTaskIds = (planRow.anchorTaskIds as string[]) ?? [];

    if (input.disruption.type === 'OVERRUN' && input.disruption.taskId) {
      await this.db
        .update(tasks)
        .set({
          status: 'IN_PROGRESS',
          nextAction: input.disruption.nextAction ?? null,
          revision: 2,
          updatedAt: now,
        })
        .where(eq(tasks.id, input.disruption.taskId));

      blocks = blocks.map((block) => {
        if (block.taskId !== input.disruption.taskId) return block;
        return {
          ...block,
          locked: true,
          endEpochMs: Math.max(block.endEpochMs, fromMs),
        };
      });
    }

    const result = replanFromNow(blocks, input.disruption, fromMs, input.date, anchorTaskIds);
    const resultIds = new Set(result.blocks.map((b) => b.id));
    const prepIdsToRun = new Set<string>();

    for (const old of blockRows) {
      if (old.ownership === 'EXTERNAL') continue;
      if (!resultIds.has(old.id)) {
        await this.db
          .update(planBlocks)
          .set({ deletedAt: now, revision: old.revision + 1, updatedAt: now })
          .where(eq(planBlocks.id, old.id));
      }
    }

    for (const block of result.blocks) {
      const existing = blockRows.find((b) => b.id === block.id);
      const prepChanged =
        block.preparationId != null &&
        (!existing ||
          existing.startEpochMs !== block.startEpochMs ||
          existing.preparationId !== block.preparationId);

      await this.db
        .insert(planBlocks)
        .values({
          id: block.id,
          dailyPlanId: block.dailyPlanId,
          date: block.date,
          startEpochMs: block.startEpochMs,
          endEpochMs: block.endEpochMs,
          type: block.type,
          ownership: block.ownership,
          title: block.title,
          taskId: block.taskId,
          habitId: block.habitId,
          commitmentId: block.commitmentId,
          locationId: block.locationId,
          locked: block.locked,
          preparationId: block.preparationId,
          externalCalendarEventId: existing?.externalCalendarEventId ?? null,
          revision: block.revision,
          updatedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: planBlocks.id,
          set: {
            startEpochMs: block.startEpochMs,
            endEpochMs: block.endEpochMs,
            title: block.title,
            ownership: block.ownership,
            locked: block.locked,
            locationId: block.locationId,
            revision: block.revision,
            updatedAt: now,
            deletedAt: null,
          },
        });

      if (prepChanged && block.preparationId) {
        prepIdsToRun.add(block.preparationId);
      }
    }

    const hardStopNotes =
      input.disruption.type === 'OVERRUN' && input.disruption.taskId
        ? `Hard stop on task ${input.disruption.taskId} at ${new Date(fromMs).toISOString()}`
        : planRow.hardStopNotes;

    await this.db
      .update(dailyPlans)
      .set({
        revision: planRow.revision + 1,
        hardStopNotes,
        updatedAt: now,
      })
      .where(eq(dailyPlans.id, planRow.id));

    for (const preparationId of prepIdsToRun) {
      this.jobs.enqueue('preparation.run', { preparationId });
    }

    await this.enqueueCosCalendarSync(input.date);

    if (this.notifications) {
      void this.notifications
        .notify({
          type: 'PLAN_UPDATED',
          title: 'Plan updated',
          body: result.summary || `Today's plan was revised`,
          deepLink: 'cos://today',
          entityType: 'daily_plan',
          entityId: planRow.id,
        })
        .catch(() => undefined);
    }

    return {
      ...result,
      plan: {
        id: planRow.id,
        date: planRow.date,
        mainOutcome: planRow.mainOutcome,
        anchorTaskIds,
        revision: planRow.revision + 1,
      },
    };
  }

  /**
   * Evening review adjustment: move one COS block without regenerating the whole day.
   * Marks review_state = MANUALLY_ADJUSTED; syncs only affected calendar date.
   */
  async adjustPlanBlock(input: {
    date: string;
    blockId: string;
    startEpochMs: number;
    endEpochMs: number;
  }): Promise<{
    date: string;
    blockId: string;
    reviewState: string;
    calendarSyncEnqueued: boolean;
  }> {
    const planRows = await this.db
      .select()
      .from(dailyPlans)
      .where(and(eq(dailyPlans.date, input.date), isNull(dailyPlans.deletedAt)))
      .limit(1);
    const plan = planRows[0];
    if (!plan) {
      throw Object.assign(new Error(`No plan for date ${input.date}`), {
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    }

    const blockRows = await this.db
      .select()
      .from(planBlocks)
      .where(and(eq(planBlocks.id, input.blockId), isNull(planBlocks.deletedAt)))
      .limit(1);
    const block = blockRows[0];
    if (!block || block.date !== input.date) {
      throw Object.assign(new Error(`Block ${input.blockId} not found on ${input.date}`), {
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    }
    if (block.ownership === 'EXTERNAL') {
      throw Object.assign(new Error('Cannot adjust EXTERNAL calendar blocks'), {
        statusCode: 400,
        code: 'EXTERNAL_READONLY',
      });
    }
    if (input.endEpochMs <= input.startEpochMs) {
      throw Object.assign(new Error('endEpochMs must be after startEpochMs'), {
        statusCode: 400,
        code: 'INVALID_RANGE',
      });
    }

    const now = new Date();
    await this.db
      .update(planBlocks)
      .set({
        startEpochMs: input.startEpochMs,
        endEpochMs: input.endEpochMs,
        revision: block.revision + 1,
        updatedAt: now,
      })
      .where(eq(planBlocks.id, block.id));

    await this.db
      .update(dailyPlans)
      .set({
        reviewState: 'MANUALLY_ADJUSTED',
        reviewedAt: now,
        planState: 'ACTIVE',
        status: 'ACCEPTED',
        revision: plan.revision + 1,
        updatedAt: now,
      })
      .where(eq(dailyPlans.id, plan.id));

    await this.db.insert(planRevisions).values({
      id: randomUUID(),
      entityType: 'DAILY_PLAN',
      entityId: plan.id,
      revision: plan.revision + 1,
      trigger: 'MANUAL_ADJUST',
      summary: `Moved block ${block.title} on ${input.date}`,
      diff: {
        blockId: block.id,
        from: { startEpochMs: block.startEpochMs, endEpochMs: block.endEpochMs },
        to: { startEpochMs: input.startEpochMs, endEpochMs: input.endEpochMs },
      },
      createdAt: now,
    });

    const calendarSyncEnqueued = await this.enqueueCosCalendarSync(input.date);
    return {
      date: input.date,
      blockId: block.id,
      reviewState: 'MANUALLY_ADJUSTED',
      calendarSyncEnqueued,
    };
  }

  async getPlanPreview(date: string): Promise<{
    date: string;
    status: string;
    mainOutcome: string | null;
    briefing: string | null;
    hardStopNotes: string | null;
    bufferMinutes: number;
    acceptedAt: string | null;
    firstAction: { title: string; startEpochMs: number; endEpochMs: number; preparationId: string | null } | null;
    preparedBullets: string[];
    schedule: Array<{
      id: string;
      title: string;
      startEpochMs: number;
      endEpochMs: number;
      ownership: string;
      type: string;
    }>;
    calendarCosCount: number;
    externalCount: number;
  } | null> {
    const planRows = await this.db
      .select()
      .from(dailyPlans)
      .where(and(eq(dailyPlans.date, date), isNull(dailyPlans.deletedAt)))
      .limit(1);
    const plan = planRows[0];
    if (!plan) return null;

    const blocks = await this.db
      .select()
      .from(planBlocks)
      .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)))
      .orderBy(asc(planBlocks.startEpochMs));

    const firstCos = blocks.find((b) => b.ownership === 'COS' && b.type === 'TASK') ?? blocks[0];
    const preparedBullets: string[] = [];
    for (const block of blocks.filter((b) => b.preparationId).slice(0, 5)) {
      preparedBullets.push(block.title);
    }

    return {
      date,
      status: plan.status,
      mainOutcome: plan.mainOutcome,
      briefing: plan.briefing,
      hardStopNotes: plan.hardStopNotes,
      bufferMinutes: plan.bufferMinutes,
      acceptedAt: plan.acceptedAt?.toISOString() ?? null,
      firstAction: firstCos
        ? {
            title: firstCos.title,
            startEpochMs: firstCos.startEpochMs,
            endEpochMs: firstCos.endEpochMs,
            preparationId: firstCos.preparationId,
          }
        : null,
      preparedBullets,
      schedule: blocks.map((b) => ({
        id: b.id,
        title: b.title,
        startEpochMs: b.startEpochMs,
        endEpochMs: b.endEpochMs,
        ownership: b.ownership,
        type: b.type,
      })),
      calendarCosCount: blocks.filter((b) => b.ownership === 'COS').length,
      externalCount: blocks.filter((b) => b.ownership === 'EXTERNAL').length,
    };
  }

  private async collectCosCandidates(date: string): Promise<CosSlotCandidate[]> {
    const out: CosSlotCandidate[] = [];

    const openTasks = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          isNull(tasks.deletedAt),
          or(eq(tasks.status, 'TODO'), eq(tasks.status, 'IN_PROGRESS'), eq(tasks.status, 'PLANNED')),
        ),
      )
      .orderBy(asc(tasks.priority));

    for (const task of openTasks.slice(0, 4)) {
      out.push({
        title: task.title,
        minutes: Math.min(Math.max(task.estimatedMinutes || 30, 25), 90),
        type: 'TASK',
        taskId: task.id,
        habitId: null,
        locationId: 'loc-home',
        needsPrep: true,
        targetType: 'TASK_BLOCK',
        goal: task.nextAction ?? task.title,
        doneCriteria: task.nextAction ? [task.nextAction] : [],
      });
    }

    const tracks = await this.db
      .select()
      .from(learningTracks)
      .where(and(eq(learningTracks.status, 'ACTIVE'), isNull(learningTracks.deletedAt)))
      .orderBy(asc(learningTracks.priority));

    for (const track of tracks.slice(0, 2)) {
      const already = out.some((c) => c.title === track.title);
      if (already) continue;
      out.push({
        title: track.title,
        minutes: 45,
        type: 'TASK',
        taskId: `task-${track.id}-${date}`,
        habitId: null,
        learningItemId: `li-${track.id}-${date}`,
        locationId: 'loc-home',
        needsPrep: true,
        targetType: 'LEARNING',
        goal: track.definitionOfProgress || track.topic,
        doneCriteria: track.definitionOfProgress ? [track.definitionOfProgress] : [],
      });
    }

    // Lightweight habit placeholders (no habits table yet) — energy / movement floors.
    if (out.length < 2) {
      out.push({
        title: 'Movement / habit floor',
        minutes: 20,
        type: 'HABIT',
        taskId: null,
        habitId: 'habit-movement',
        locationId: 'loc-home',
        needsPrep: false,
        targetType: 'TASK_BLOCK',
      });
    }

    // Curated news brief once per prepared day.
    out.push({
      title: 'News brief (3 items)',
      minutes: 15,
      type: 'TASK',
      taskId: `task-news-${date}`,
      habitId: null,
      locationId: 'loc-home',
      needsPrep: true,
      targetType: 'NEWS',
      goal: 'Scan curated overnight news',
      doneCriteria: ['Opened 3 items', 'Noted one takeaway'],
    });

    return out;
  }

  private async ensureExternalBlocks(
    date: string,
    planId: string,
    dayCommitments: Array<{
      id: string;
      externalCalendarEventId: string;
      title: string;
      startEpochMs: number;
      endEpochMs: number;
    }>,
    now: Date,
  ): Promise<void> {
    // Ensure plan row exists so EXTERNAL upserts have a parent id.
    const existing = await this.db
      .select({ id: dailyPlans.id })
      .from(dailyPlans)
      .where(eq(dailyPlans.id, planId))
      .limit(1);
    if (!existing[0]) {
      await this.db.insert(dailyPlans).values({
        id: planId,
        date,
        mainOutcome: null,
        anchorTaskIds: [],
        briefing: null,
        bufferMinutes: 30,
        hardStopNotes: null,
        status: 'PROPOSED',
        acceptedAt: null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });
    }

    for (const c of dayCommitments) {
      const blockId = `ext-${c.externalCalendarEventId}`;
      await this.db
        .insert(planBlocks)
        .values({
          id: blockId,
          dailyPlanId: planId,
          date,
          startEpochMs: c.startEpochMs,
          endEpochMs: c.endEpochMs,
          type: 'COMMITMENT',
          ownership: 'EXTERNAL',
          title: c.title,
          taskId: null,
          habitId: null,
          commitmentId: c.id,
          locationId: null,
          locked: true,
          preparationId: null,
          externalCalendarEventId: null,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: planBlocks.id,
          set: {
            title: c.title,
            startEpochMs: c.startEpochMs,
            endEpochMs: c.endEpochMs,
            date,
            dailyPlanId: planId,
            commitmentId: c.id,
            ownership: 'EXTERNAL',
            locked: true,
            deletedAt: null,
            revision: 2,
            updatedAt: now,
          },
        });
    }
  }

  /** Enqueue COS calendar upsert only when planning autonomy allows writes. */
  private async enqueueCosCalendarSync(date: string): Promise<boolean> {
    const prefs = await getPlanningPreferences(this.db);
    if (!autonomyAllowsCalendarWrite(prefs.autonomy)) return false;
    this.jobs.enqueue('calendar.sync_cos', { date });
    return true;
  }
}

// Silence unused import warnings for helpers used by tests / future wiring
void calendarSyncState;
void inArray;
