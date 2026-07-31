import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../infrastructure/db/client.js';
import {
  dailyPlans,
  planBlocks,
  preparations,
  resources,
  seasons,
} from '../infrastructure/db/schema/index.js';

export class TodayService {
  constructor(private readonly db: Db) {}

  async getToday(date: string, locationId = 'loc-home') {
    const planRows = await this.db
      .select()
      .from(dailyPlans)
      .where(and(eq(dailyPlans.date, date), isNull(dailyPlans.deletedAt)))
      .limit(1);
    const plan = planRows[0];

    const blocks = await this.db
      .select()
      .from(planBlocks)
      .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));

    const seasonRows = await this.db
      .select()
      .from(seasons)
      .where(and(eq(seasons.active, true), isNull(seasons.deletedAt)))
      .limit(1);

    const outcome = plan?.mainOutcome ?? seasonRows[0]?.title ?? 'Make progress today';
    const nowMs = Date.now();

    const enriched = await Promise.all(
      blocks.map(async (block) => {
        let preparation = null;
        let resource = null;
        if (block.preparationId) {
          const prepRows = await this.db
            .select()
            .from(preparations)
            .where(eq(preparations.id, block.preparationId))
            .limit(1);
          preparation = prepRows[0] ?? null;
          if (preparation?.selectedResourceId) {
            const resRows = await this.db
              .select()
              .from(resources)
              .where(eq(resources.id, preparation.selectedResourceId))
              .limit(1);
            resource = resRows[0] ?? null;
          }
        }
        return { block, preparation, resource };
      }),
    );

    enriched.sort((a, b) => a.block.startEpochMs - b.block.startEpochMs);

    const currentOrNext =
      enriched.find(
        (e) => e.block.endEpochMs >= nowMs && e.preparation?.status === 'READY',
      ) ??
      enriched.find((e) => e.block.endEpochMs >= nowMs) ??
      enriched[0];

    const now =
      currentOrNext?.preparation != null
        ? {
            type: 'PREPARATION' as const,
            preparation: {
              id: currentOrNext.preparation.id,
              status: currentOrNext.preparation.status,
              title: currentOrNext.block.title,
              goal: currentOrNext.preparation.goal,
              practicePrompt: currentOrNext.preparation.practicePrompt,
              doneCriteria: currentOrNext.preparation.doneCriteria,
              timeBudgetMinutes: currentOrNext.preparation.timeBudgetMinutes,
              resource: currentOrNext.resource
                ? {
                    id: currentOrNext.resource.id,
                    title: currentOrNext.resource.title,
                    url: currentOrNext.resource.url,
                    format: currentOrNext.resource.format,
                  }
                : null,
            },
            block: {
              id: currentOrNext.block.id,
              startEpochMs: currentOrNext.block.startEpochMs,
              endEpochMs: currentOrNext.block.endEpochMs,
              locationId: currentOrNext.block.locationId,
            },
          }
        : null;

    return {
      date,
      outcome,
      now,
      anchors: [],
      timeline: enriched.map((e) => ({
        blockId: e.block.id,
        title: e.block.title,
        startEpochMs: e.block.startEpochMs,
        endEpochMs: e.block.endEpochMs,
        preparationStatus: e.preparation?.status ?? null,
        ownership: e.block.ownership,
      })),
      hardStop: plan?.hardStopNotes
        ? {
            notes: plan.hardStopNotes,
            atEpochMs: currentOrNext?.block.endEpochMs ?? null,
          }
        : null,
      firstAction: now
        ? {
            title: now.preparation.title,
            why: now.preparation.goal,
            need: now.preparation.resource?.title ?? null,
            doneCriteria: now.preparation.doneCriteria,
            window: now.block,
            preparationId: now.preparation.id,
            status: now.preparation.status,
          }
        : null,
      calendar: {
        cosCount: blocks.filter((b) => b.ownership === 'COS').length,
        externalCount: blocks.filter((b) => b.ownership === 'EXTERNAL').length,
        status: plan?.status === 'ACCEPTED' ? 'synced' : 'proposed',
      },
      briefing: plan?.briefing ?? null,
      planStatus: plan?.status ?? null,
      context: { energyMode: 'NORMAL', locationId },
    };
  }
}
