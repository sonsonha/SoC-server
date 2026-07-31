import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../infrastructure/db/client.js';
import type { JobQueue } from '../infrastructure/jobs/jobQueue.js';
import {
  dailyPlans,
  goals,
  planBlocks,
  planningRuns,
  planRevisions,
  seasons,
  weeklyOutcomes,
  weeklyPlans,
} from '../infrastructure/db/schema/index.js';
import type { PlanService } from './planService.js';
import {
  addDays,
  autonomyAllowsCalendarWrite,
  autonomyAllowsInternalActivate,
  getPlanningPreferences,
  weekStartMonday,
  upcomingWeekStartAfterSunday,
} from '../modules/planning/planningPrefs.js';

export type PrepareWeekInput = {
  weekStart?: string;
  trigger?: string;
};

type OutcomePick = {
  title: string;
  goalId: string | null;
  monthGoalId: string | null;
  quarterGoalId: string | null;
  yearGoalId: string | null;
  successCriteria: string;
};

/**
 * Sunday Weekly Preparation — generates a full Mon–Sun week without requiring review.
 */
export class WeeklyPlanService {
  constructor(
    private readonly db: Db,
    private readonly jobs: JobQueue,
    private readonly planService: PlanService,
  ) {}

  async prepareWeek(input: PrepareWeekInput = {}): Promise<{
    weeklyPlanId: string;
    weekStart: string;
    dates: string[];
    outcomeCount: number;
    conflictNotes: string | null;
    calendarSyncEnqueued: boolean;
  }> {
    const prefs = await getPlanningPreferences(this.db);
    const weekStart =
      input.weekStart ?? upcomingWeekStartAfterSunday(Date.now(), prefs.timezone);
    const trigger = input.trigger ?? 'SCHEDULE';
    const force = trigger === 'FORCE';
    const idempotencyKey = force
      ? `prepare_week:${weekStart}:force:${Date.now()}`
      : `prepare_week:${weekStart}`;

    if (!force) {
      const existingRun = await this.db
        .select()
        .from(planningRuns)
        .where(eq(planningRuns.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existingRun[0]?.status === 'SUCCEEDED' && existingRun[0].outputPlanId) {
        const plan = await this.db
          .select()
          .from(weeklyPlans)
          .where(eq(weeklyPlans.id, existingRun[0].outputPlanId))
          .limit(1);
        if (plan[0] && !plan[0].deletedAt) {
          return {
            weeklyPlanId: plan[0].id,
            weekStart,
            dates: Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
            outcomeCount: 0,
            conflictNotes: plan[0].conflictNotes,
            calendarSyncEnqueued: false,
          };
        }
      }
    }

    const runId = randomUUID();
    try {
      await this.db.insert(planningRuns).values({
        id: runId,
        runType: 'PREPARE_WEEK',
        targetPeriod: weekStart,
        trigger,
        status: 'RUNNING',
        startedAt: new Date(),
        idempotencyKey,
        details: {},
      });
    } catch {
      const raced = await this.db
        .select()
        .from(planningRuns)
        .where(eq(planningRuns.idempotencyKey, idempotencyKey))
        .limit(1);
      if (raced[0]?.outputPlanId) {
        return {
          weeklyPlanId: raced[0].outputPlanId,
          weekStart,
          dates: Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
          outcomeCount: 0,
          conflictNotes: null,
          calendarSyncEnqueued: false,
        };
      }
    }

    try {
      const result = await this.buildWeek(weekStart, prefs.capacityUtilization, prefs.autonomy, trigger);
      await this.db
        .update(planningRuns)
        .set({
          status: 'SUCCEEDED',
          finishedAt: new Date(),
          outputPlanId: result.weeklyPlanId,
          outputRevision: 1,
          details: { dates: result.dates, outcomeCount: result.outcomeCount },
        })
        .where(eq(planningRuns.id, runId));
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(planningRuns)
        .set({ status: 'FAILED', finishedAt: new Date(), error: message })
        .where(eq(planningRuns.id, runId));
      return this.minimalFallbackWeek(weekStart, prefs.autonomy);
    }
  }

  private async buildWeek(
    weekStart: string,
    utilization: number,
    autonomy: string,
    trigger: string,
  ) {
    const now = new Date();
    const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

    const prior = await this.db
      .select()
      .from(weeklyPlans)
      .where(
        and(eq(weeklyPlans.weekStart, weekStart), eq(weeklyPlans.status, 'ACTIVE'), isNull(weeklyPlans.deletedAt)),
      );
    for (const p of prior) {
      await this.db
        .update(weeklyPlans)
        .set({ status: 'SUPERSEDED', updatedAt: now, revision: p.revision + 1 })
        .where(eq(weeklyPlans.id, p.id));
    }

    const seasonRows = await this.db
      .select()
      .from(seasons)
      .where(and(eq(seasons.active, true), isNull(seasons.deletedAt)))
      .limit(1);
    const season = seasonRows[0];

    const hierarchy = await this.db
      .select()
      .from(goals)
      .where(and(eq(goals.status, 'ACTIVE'), isNull(goals.deletedAt)));
    const outcomes = this.pickWeeklyOutcomes(hierarchy, season?.title);

    const dayFree = 9 * 60;
    const capacityMinutes = Math.floor(7 * dayFree * utilization);
    let utilized = 0;
    const conflictParts: string[] = [];

    const weeklyPlanId = `week-${weekStart}-r${Date.now().toString(36)}`;
    await this.db.insert(weeklyPlans).values({
      id: weeklyPlanId,
      weekStart,
      seasonId: season?.id ?? null,
      status: 'ACTIVE',
      reviewState: 'UNREVIEWED',
      capacityMinutes,
      utilizedMinutes: 0,
      utilizationTarget: utilization,
      bufferMinutes: 180,
      summary: `Week of ${weekStart}: ${outcomes.map((o) => o.title).join(' · ')}`,
      conflictNotes: null,
      calendarSyncStatus: autonomyAllowsCalendarWrite(autonomy) ? 'PENDING' : 'SKIPPED',
      acceptedAt: autonomyAllowsInternalActivate(autonomy) ? now : null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      await this.db
        .insert(weeklyOutcomes)
        .values({
          id: `${weeklyPlanId}-o${i}`,
          weeklyPlanId,
          title: o.title,
          sortOrder: i,
          goalId: o.goalId,
          monthGoalId: o.monthGoalId,
          quarterGoalId: o.quarterGoalId,
          yearGoalId: o.yearGoalId,
          status: 'ACTIVE',
          successCriteria: o.successCriteria,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: weeklyOutcomes.id,
          set: {
            title: o.title,
            goalId: o.goalId,
            monthGoalId: o.monthGoalId,
            quarterGoalId: o.quarterGoalId,
            yearGoalId: o.yearGoalId,
            successCriteria: o.successCriteria,
            updatedAt: now,
            deletedAt: null,
          },
        });
    }

    const activate = autonomyAllowsInternalActivate(autonomy);
    for (let dayIdx = 0; dayIdx < dates.length; dayIdx++) {
      const date = dates[dayIdx];
      const dayResult = await this.planService.prepareTomorrow({ date });
      utilized += 90 * Math.max(1, Math.min(dayResult.blockCount, 4));

      const dayOutcome = outcomes[dayIdx % outcomes.length];
      const goalIds = [
        dayOutcome?.goalId,
        dayOutcome?.monthGoalId,
        dayOutcome?.quarterGoalId,
        dayOutcome?.yearGoalId,
      ].filter((x): x is string => Boolean(x));

      await this.db
        .update(dailyPlans)
        .set({
          weeklyPlanId,
          planState: activate ? 'ACTIVE' : 'GENERATED',
          status: activate ? 'ACCEPTED' : 'PROPOSED',
          acceptedAt: activate ? now : null,
          reviewState: 'UNREVIEWED',
          mainOutcome: dayOutcome?.title ?? undefined,
          goalIds,
          updatedAt: now,
        })
        .where(eq(dailyPlans.date, date));

      if (dayOutcome?.goalId) {
        const blocks = await this.db
          .select()
          .from(planBlocks)
          .where(and(eq(planBlocks.date, date), eq(planBlocks.ownership, 'COS'), isNull(planBlocks.deletedAt)))
          .orderBy(asc(planBlocks.startEpochMs))
          .limit(1);
        if (blocks[0]) {
          await this.db
            .update(planBlocks)
            .set({
              goalId: dayOutcome.goalId,
              weeklyOutcomeId: `${weeklyPlanId}-o${dayIdx % outcomes.length}`,
              updatedAt: now,
            })
            .where(eq(planBlocks.id, blocks[0].id));

          await this.db
            .update(dailyPlans)
            .set({ firstActionTitle: blocks[0].title, updatedAt: now })
            .where(eq(dailyPlans.date, date));
        }
      }

      if (activate && autonomyAllowsCalendarWrite(autonomy)) {
        this.jobs.enqueue('calendar.sync_cos', { date });
      }
    }

    if (utilized > capacityMinutes) {
      conflictParts.push(
        `Requested ~${utilized}m exceeds capacity ${capacityMinutes}m at ${(utilization * 100).toFixed(0)}% utilization — lower-priority work deferred.`,
      );
    }

    const conflictNotes = conflictParts.length ? conflictParts.join(' ') : null;
    await this.db
      .update(weeklyPlans)
      .set({
        utilizedMinutes: utilized,
        conflictNotes,
        calendarSyncStatus: autonomyAllowsCalendarWrite(autonomy) ? 'SYNCED' : 'SKIPPED',
        updatedAt: new Date(),
      })
      .where(eq(weeklyPlans.id, weeklyPlanId));

    await this.db.insert(planRevisions).values({
      id: randomUUID(),
      entityType: 'WEEKLY_PLAN',
      entityId: weeklyPlanId,
      revision: 1,
      trigger,
      summary: `Generated week ${weekStart} with ${outcomes.length} outcomes`,
      diff: { dates, outcomes: outcomes.map((o) => o.title) },
      createdAt: new Date(),
    });

    return {
      weeklyPlanId,
      weekStart,
      dates,
      outcomeCount: outcomes.length,
      conflictNotes,
      calendarSyncEnqueued: autonomyAllowsCalendarWrite(autonomy),
    };
  }

  private async minimalFallbackWeek(weekStart: string, autonomy: string) {
    const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const weeklyPlanId = `week-${weekStart}-fallback`;
    const now = new Date();
    await this.db
      .insert(weeklyPlans)
      .values({
        id: weeklyPlanId,
        weekStart,
        status: 'ACTIVE',
        reviewState: 'UNREVIEWED',
        capacityMinutes: 7 * 240,
        utilizedMinutes: 0,
        utilizationTarget: 0.7,
        bufferMinutes: 180,
        summary: 'Minimal fallback week (primary generation failed)',
        conflictNotes: 'Fallback week — review when possible',
        calendarSyncStatus: 'PENDING',
        acceptedAt: autonomyAllowsInternalActivate(autonomy) ? now : null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoNothing();

    for (const date of dates) {
      await this.planService.prepareTomorrow({ date });
      if (autonomyAllowsCalendarWrite(autonomy)) {
        this.jobs.enqueue('calendar.sync_cos', { date });
      }
    }
    return {
      weeklyPlanId,
      weekStart,
      dates,
      outcomeCount: 0,
      conflictNotes: 'Fallback week — review when possible' as string | null,
      calendarSyncEnqueued: autonomyAllowsCalendarWrite(autonomy),
    };
  }

  private pickWeeklyOutcomes(
    allGoals: Array<{
      id: string;
      title: string;
      horizon: string;
      parentId: string | null;
      successCriteria: string;
    }>,
    seasonTitle?: string,
  ): OutcomePick[] {
    const byHorizon = (h: string) => allGoals.filter((g) => g.horizon === h);
    const months = byHorizon('MONTH');
    const quarters = byHorizon('QUARTER');
    const years = byHorizon('YEAR');
    const weeks = byHorizon('WEEK');
    const shorts = byHorizon('SHORT');

    const picked = (weeks.length ? weeks : months.length ? months : shorts).slice(0, 3);
    if (picked.length > 0) {
      return picked.map((g) => {
        const month = g.horizon === 'MONTH' ? g : months.find((m) => m.id === g.parentId) ?? null;
        const quarter =
          g.horizon === 'QUARTER'
            ? g
            : quarters.find((q) => q.id === (month?.parentId ?? g.parentId)) ?? null;
        const year =
          g.horizon === 'YEAR'
            ? g
            : years.find((y) => y.id === (quarter?.parentId ?? month?.parentId ?? g.parentId)) ?? null;
        return {
          title: g.title,
          goalId: g.id,
          monthGoalId: month?.id ?? null,
          quarterGoalId: quarter?.id ?? null,
          yearGoalId: year?.id ?? null,
          successCriteria: g.successCriteria || `Meaningful progress on ${g.title}`,
        };
      });
    }

    const fallbackTitles = [
      seasonTitle ? `Advance: ${seasonTitle}` : 'Ship one meaningful outcome',
      'Protect health / movement',
      'Clear one administrative blocker',
    ];
    return fallbackTitles.map((title) => ({
      title,
      goalId: null,
      monthGoalId: null,
      quarterGoalId: null,
      yearGoalId: null,
      successCriteria: title,
    }));
  }

  async getActiveWeek(weekStart?: string) {
    const prefs = await getPlanningPreferences(this.db);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: prefs.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const resolved = weekStart ?? weekStartMonday(today, prefs.timezone);

    const planRows = await this.db
      .select()
      .from(weeklyPlans)
      .where(
        and(eq(weeklyPlans.weekStart, resolved), eq(weeklyPlans.status, 'ACTIVE'), isNull(weeklyPlans.deletedAt)),
      )
      .limit(1);
    const plan = planRows[0];
    if (!plan) return null;

    const outcomes = await this.db
      .select()
      .from(weeklyOutcomes)
      .where(and(eq(weeklyOutcomes.weeklyPlanId, plan.id), isNull(weeklyOutcomes.deletedAt)))
      .orderBy(asc(weeklyOutcomes.sortOrder));

    const dates = Array.from({ length: 7 }, (_, i) => addDays(resolved, i));
    const days = [];
    for (const date of dates) {
      const dp = await this.db.select().from(dailyPlans).where(eq(dailyPlans.date, date)).limit(1);
      const blocks = await this.db
        .select()
        .from(planBlocks)
        .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)))
        .orderBy(asc(planBlocks.startEpochMs));
      days.push({
        date,
        mainOutcome: dp[0]?.mainOutcome ?? null,
        anchors: (dp[0]?.anchorTaskIds as string[]) ?? [],
        planState: dp[0]?.planState ?? null,
        reviewState: dp[0]?.reviewState ?? null,
        firstActionTitle: dp[0]?.firstActionTitle ?? blocks.find((b) => b.ownership === 'COS')?.title ?? null,
        blockCount: blocks.length,
        prepReady: blocks.filter((b) => b.preparationId).length,
      });
    }

    return {
      weekStart: resolved,
      plan,
      outcomes,
      days,
      capacity: {
        capacityMinutes: plan.capacityMinutes,
        utilizedMinutes: plan.utilizedMinutes,
        utilizationTarget: plan.utilizationTarget,
        bufferMinutes: plan.bufferMinutes,
      },
      calendarSyncStatus: plan.calendarSyncStatus,
      conflictNotes: plan.conflictNotes,
    };
  }
}
