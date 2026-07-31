import { and, eq, isNull, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import { decisions, decisionOptions } from '../../infrastructure/db/schema/index.js';

export class DecisionService {
  constructor(private readonly db: Db) {}

  async listOpen() {
    return this.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.status, 'OPEN'), isNull(decisions.deletedAt)))
      .orderBy(desc(decisions.updatedAt));
  }

  async getWithOptions(id: string) {
    const rows = await this.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.id, id), isNull(decisions.deletedAt)))
      .limit(1);
    if (!rows[0]) return null;
    const options = await this.db
      .select()
      .from(decisionOptions)
      .where(and(eq(decisionOptions.decisionId, id), isNull(decisionOptions.deletedAt)))
      .orderBy(decisionOptions.sortOrder);
    return { decision: rows[0], options };
  }

  async create(input: {
    title: string;
    context: string;
    deadlineAt?: Date;
    options: Array<{ label: string; pros?: string; cons?: string }>;
  }): Promise<{ decisionId: string; optionIds: string[] }> {
    const decisionId = randomUUID();
    const now = new Date();
    await this.db.insert(decisions).values({
      id: decisionId,
      title: input.title,
      context: input.context,
      status: 'OPEN',
      deadlineAt: input.deadlineAt ?? null,
      resolvedOptionId: null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    const optionIds: string[] = [];
    for (let i = 0; i < input.options.length; i++) {
      const opt = input.options[i];
      const optionId = randomUUID();
      optionIds.push(optionId);
      await this.db.insert(decisionOptions).values({
        id: optionId,
        decisionId,
        label: opt.label,
        pros: opt.pros ?? '',
        cons: opt.cons ?? '',
        sortOrder: i,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });
    }
    return { decisionId, optionIds };
  }

  async resolve(decisionId: string, optionId: string): Promise<void> {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.id, decisionId), isNull(decisions.deletedAt)))
      .limit(1);
    const decision = rows[0];
    if (!decision) {
      throw Object.assign(new Error('Decision not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }

    const optRows = await this.db
      .select()
      .from(decisionOptions)
      .where(and(eq(decisionOptions.id, optionId), eq(decisionOptions.decisionId, decisionId)))
      .limit(1);
    if (!optRows[0]) {
      throw Object.assign(new Error('Option not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }

    await this.db
      .update(decisions)
      .set({
        status: 'RESOLVED',
        resolvedOptionId: optionId,
        revision: decision.revision + 1,
        updatedAt: now,
      })
      .where(eq(decisions.id, decisionId));
  }
}
