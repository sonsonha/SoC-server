import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, gte, lte } from 'drizzle-orm';
import type { Db } from '../../infrastructure/db/client.js';
import {
  opportunities,
  planBlocks,
  preparations,
  proactiveScanRuns,
  waitingItems,
} from '../../infrastructure/db/schema/index.js';
import type { JobQueue } from '../../infrastructure/jobs/jobQueue.js';
import type { NotificationService } from '../../infrastructure/notifications/notificationService.js';
import type { LearningCurriculumService } from '../learning/curriculumService.js';

const HOURS_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type ScanSummary = {
  prepEnqueued: number;
  prepReadyNotified: number;
  deadlinesNotified: number;
  waitingNotified: number;
  refreshEnqueued: number;
  cadenceScheduled: number;
};

export class ProactiveScanService {
  private learning: LearningCurriculumService | null = null;

  constructor(
    private readonly db: Db,
    private readonly jobs: JobQueue,
    private readonly notifications: NotificationService,
  ) {}

  setLearningService(service: LearningCurriculumService): void {
    this.learning = service;
  }

  async run(): Promise<ScanSummary> {
    const runId = randomUUID();
    const startedAt = new Date();
    await this.db.insert(proactiveScanRuns).values({
      id: runId,
      startedAt,
      finishedAt: null,
      summary: null,
    });

    const summary: ScanSummary = {
      prepEnqueued: 0,
      prepReadyNotified: 0,
      deadlinesNotified: 0,
      waitingNotified: 0,
      refreshEnqueued: 0,
      cadenceScheduled: 0,
    };

    try {
      await this.scanUpcomingBlocks(summary);
      await this.scanDeadlines(summary);
      await this.scanWaitingFollowUps(summary);
      await this.scanStalePreparations(summary);
      await this.scanLearningCadence(summary);
    } finally {
      await this.db
        .update(proactiveScanRuns)
        .set({ finishedAt: new Date(), summary })
        .where(eq(proactiveScanRuns.id, runId));
    }

    return summary;
  }

  private async scanLearningCadence(summary: ScanSummary): Promise<void> {
    if (!this.learning) return;
    const d = new Date();
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + diff);
    const weekStart = d.toISOString().slice(0, 10);
    const result = await this.learning.ensureCadenceForWeek(weekStart);
    summary.cadenceScheduled = result.scheduled;
  }

  private async scanUpcomingBlocks(summary: ScanSummary): Promise<void> {
    const now = Date.now();
    const horizon = now + 24 * HOURS_MS;
    const blocks = await this.db
      .select()
      .from(planBlocks)
      .where(
        and(
          isNull(planBlocks.deletedAt),
          gte(planBlocks.startEpochMs, now),
          lte(planBlocks.startEpochMs, horizon),
        ),
      );

    for (const block of blocks) {
      if (!block.preparationId) continue;
      const prepRows = await this.db
        .select()
        .from(preparations)
        .where(and(eq(preparations.id, block.preparationId), isNull(preparations.deletedAt)))
        .limit(1);
      const prep = prepRows[0];
      if (!prep) continue;

      if (prep.status === 'PENDING' || prep.status === 'PREPARING') {
        this.jobs.enqueue('preparation.run', { preparationId: prep.id });
        summary.prepEnqueued += 1;
      } else if (prep.status === 'READY') {
        const recentlyPrepared =
          prep.lastPreparedAt && now - prep.lastPreparedAt.getTime() < 2 * HOURS_MS;
        if (recentlyPrepared) {
          const result = await this.notifications.notify({
            type: 'PREP_READY',
            title: `${block.title || 'Session'} ready`,
            body: `Starts soon — open prepared activity`,
            deepLink: `cos://prepared/${prep.id}`,
            entityType: 'preparation',
            entityId: prep.id,
          });
          summary.prepReadyNotified += result.sent;
        }
      } else if (prep.status === 'NEEDS_INPUT') {
        await this.notifications.notify({
          type: 'PREP_NEEDS_INPUT',
          title: 'Preparation needs input',
          body: block.title || prep.failureReason || 'Open to continue',
          deepLink: `cos://prepared/${prep.id}`,
          entityType: 'preparation',
          entityId: prep.id,
        });
      }
    }
  }

  private async scanDeadlines(summary: ScanSummary): Promise<void> {
    const now = Date.now();
    const thresholds = [3, 7, 14];
    const opps = await this.db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.active, true), isNull(opportunities.deletedAt)));

    for (const opp of opps) {
      if (!opp.deadlineEpochMs) continue;
      const daysUntil = Math.ceil((opp.deadlineEpochMs - now) / DAY_MS);
      if (!thresholds.includes(daysUntil)) continue;

      const result = await this.notifications.notify({
        type: 'DEADLINE',
        title: `Deadline in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`,
        body: opp.title,
        deepLink: 'cos://week',
        entityType: 'opportunity',
        entityId: opp.id,
      });
      summary.deadlinesNotified += result.sent;
    }
  }

  private async scanWaitingFollowUps(summary: ScanSummary): Promise<void> {
    const now = new Date();
    const items = await this.db
      .select()
      .from(waitingItems)
      .where(
        and(
          eq(waitingItems.status, 'ACTIVE'),
          isNull(waitingItems.deletedAt),
          lt(waitingItems.followUpAt, now),
        ),
      );

    for (const item of items) {
      const on = item.waitingOnLabel ?? 'someone';
      const result = await this.notifications.notify({
        type: 'WAITING_FOLLOW_UP',
        title: 'Follow up?',
        body: `Still waiting on ${on}: ${item.title}`,
        deepLink: 'cos://waiting',
        entityType: 'waiting_item',
        entityId: item.id,
      });
      summary.waitingNotified += result.sent;
    }
  }

  private async scanStalePreparations(summary: ScanSummary): Promise<void> {
    const now = Date.now();
    const preps = await this.db
      .select()
      .from(preparations)
      .where(and(eq(preparations.status, 'READY'), isNull(preparations.deletedAt)));

    for (const prep of preps) {
      if (!prep.lastPreparedAt) continue;
      const ageMs = now - prep.lastPreparedAt.getTime();
      const stale =
        (prep.freshnessPolicy === 'DAILY' && ageMs > DAY_MS) ||
        (prep.freshnessPolicy === 'EVENT_BOUND' && ageMs > 12 * HOURS_MS);
      if (!stale) continue;

      if (prep.targetType === 'SOCIAL') {
        this.jobs.enqueue('preparation.refresh', { preparationId: prep.id });
      } else {
        this.jobs.enqueue('preparation.run', { preparationId: prep.id });
      }
      summary.refreshEnqueued += 1;
    }
  }
}
