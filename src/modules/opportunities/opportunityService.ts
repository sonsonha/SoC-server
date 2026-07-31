import { and, eq, isNull, asc } from 'drizzle-orm';
import type { Db } from '../../infrastructure/db/client.js';
import {
  opportunities,
  opportunityRequirements,
  preparations,
} from '../../infrastructure/db/schema/index.js';

export class OpportunityService {
  constructor(private readonly db: Db) {}

  async list() {
    const rows = await this.db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.active, true), isNull(opportunities.deletedAt)));

    const result = [];
    for (const opp of rows) {
      const prep = await this.findPrepForOpportunity(opp.id);
      const reqs = await this.db
        .select()
        .from(opportunityRequirements)
        .where(
          and(eq(opportunityRequirements.opportunityId, opp.id), isNull(opportunityRequirements.deletedAt)),
        );
      result.push({
        ...opp,
        prepStatus: prep?.status ?? null,
        preparationId: prep?.id ?? null,
        requirementsDone: reqs.filter((r) => r.done).length,
        requirementsTotal: reqs.length,
      });
    }
    return result;
  }

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.id, id), isNull(opportunities.deletedAt)))
      .limit(1);
    if (!rows[0]) return null;

    const requirements = await this.db
      .select()
      .from(opportunityRequirements)
      .where(
        and(eq(opportunityRequirements.opportunityId, id), isNull(opportunityRequirements.deletedAt)),
      )
      .orderBy(asc(opportunityRequirements.sortOrder));

    const prep = await this.findPrepForOpportunity(id);
    return { opportunity: rows[0], requirements, preparation: prep };
  }

  async toggleRequirement(id: string, done: boolean): Promise<void> {
    const rows = await this.db
      .select()
      .from(opportunityRequirements)
      .where(and(eq(opportunityRequirements.id, id), isNull(opportunityRequirements.deletedAt)))
      .limit(1);
    const req = rows[0];
    if (!req) {
      throw Object.assign(new Error('Requirement not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }
    const now = new Date();
    await this.db
      .update(opportunityRequirements)
      .set({ done, revision: req.revision + 1, updatedAt: now })
      .where(eq(opportunityRequirements.id, id));

    await this.db
      .update(opportunities)
      .set({ lastTouchedEpochMs: now.getTime(), updatedAt: now, revision: 2 })
      .where(eq(opportunities.id, req.opportunityId));
  }

  private async findPrepForOpportunity(opportunityId: string) {
    const prepRows = await this.db
      .select()
      .from(preparations)
      .where(
        and(
          eq(preparations.targetType, 'OPPORTUNITY'),
          eq(preparations.targetId, opportunityId),
          isNull(preparations.deletedAt),
        ),
      )
      .limit(1);
    return prepRows[0] ?? null;
  }
}
