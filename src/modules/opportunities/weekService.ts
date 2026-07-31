import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../infrastructure/db/client.js';
import { opportunities, preparations } from '../../infrastructure/db/schema/index.js';

const FOURTEEN_DAYS_MS = 14 * 86_400_000;

export class WeekService {
  constructor(private readonly db: Db) {}

  async getWeekSummary(weekStart: string) {
    const startMs = new Date(`${weekStart}T00:00:00.000Z`).getTime();
    const endMs = startMs + 7 * 86_400_000;
    const nowMs = Date.now();

    const opps = await this.db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.active, true), isNull(opportunities.deletedAt)));

    const deadlines = [];
    for (const opp of opps) {
      if (!opp.deadlineEpochMs) continue;
      if (opp.deadlineEpochMs < nowMs - 86_400_000) continue;
      if (opp.deadlineEpochMs > endMs + FOURTEEN_DAYS_MS) continue;

      const prepRows = await this.db
        .select()
        .from(preparations)
        .where(
          and(
            eq(preparations.targetType, 'OPPORTUNITY'),
            eq(preparations.targetId, opp.id),
            isNull(preparations.deletedAt),
          ),
        )
        .limit(1);

      const daysUntil = Math.ceil((opp.deadlineEpochMs - nowMs) / 86_400_000);
      deadlines.push({
        opportunityId: opp.id,
        title: opp.title,
        deadlineEpochMs: opp.deadlineEpochMs,
        daysUntil,
        prepStatus: prepRows[0]?.status ?? null,
        preparationId: prepRows[0]?.id ?? null,
      });
    }

    deadlines.sort((a, b) => a.deadlineEpochMs - b.deadlineEpochMs);

    return {
      weekStart,
      deadlines,
      upcomingCount: deadlines.filter((d) => d.daysUntil <= 14 && d.daysUntil >= 0).length,
    };
  }
}

export async function runOpportunityScanStub(db: Db): Promise<number> {
  const nowMs = Date.now();
  const horizon = nowMs + FOURTEEN_DAYS_MS;
  const opps = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.active, true), isNull(opportunities.deletedAt)));

  const within = opps.filter((o) => o.deadlineEpochMs && o.deadlineEpochMs <= horizon && o.deadlineEpochMs >= nowMs);
  if (within.length > 0) {
    console.info(`[proactive.opportunity_scan] ${within.length} deadline(s) within 14 days`);
  }
  return within.length;
}
