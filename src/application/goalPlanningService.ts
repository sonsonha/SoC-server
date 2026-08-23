import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../infrastructure/db/client.js';
import { goals, planningRuns, seasons } from '../infrastructure/db/schema/index.js';
import { resolveLegacyPlannerOwnerUserId } from '../modules/identity/legacyPlannerOwner.js';

export class GoalPlanningService {
  constructor(private readonly db: Db) {}

  async listGoals(horizon?: string) {
    const userId = await resolveLegacyPlannerOwnerUserId(this.db);
    const rows = await this.db
      .select()
      .from(goals)
      .where(and(eq(goals.userId, userId), eq(goals.status, 'ACTIVE'), isNull(goals.deletedAt)))
      .orderBy(asc(goals.horizon), asc(goals.title));
    return horizon ? rows.filter((g) => g.horizon === horizon) : rows;
  }

  async upsertGoal(input: {
    id?: string;
    title: string;
    lifeArea?: string;
    horizon: string;
    parentId?: string | null;
    description?: string;
    successCriteria?: string;
    targetDate?: string | null;
    seasonId?: string | null;
    capacityShare?: number | null;
  }) {
    const id = input.id ?? `goal-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const userId = await resolveLegacyPlannerOwnerUserId(this.db);
    await this.db
      .insert(goals)
      .values({
        id,
        userId,
        title: input.title,
        lifeArea: input.lifeArea ?? 'GENERAL',
        seasonId: input.seasonId ?? null,
        description: input.description ?? '',
        horizon: input.horizon,
        status: 'ACTIVE',
        targetDate: input.targetDate ?? null,
        parentId: input.parentId ?? null,
        successCriteria: input.successCriteria ?? '',
        capacityShare: input.capacityShare ?? null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: goals.id,
        set: {
          title: input.title,
          lifeArea: input.lifeArea ?? 'GENERAL',
          horizon: input.horizon,
          parentId: input.parentId ?? null,
          description: input.description ?? '',
          successCriteria: input.successCriteria ?? '',
          targetDate: input.targetDate ?? null,
          seasonId: input.seasonId ?? null,
          capacityShare: input.capacityShare ?? null,
          updatedAt: now,
          revision: 2,
        },
      });
    return this.db.select().from(goals).where(eq(goals.id, id)).limit(1).then((r) => r[0]);
  }

  async generateQuarterPlan(input?: { year?: number; quarter?: number }) {
    const now = new Date();
    const year = input?.year ?? now.getUTCFullYear();
    const quarter = input?.quarter ?? Math.floor(now.getUTCMonth() / 3) + 1;
    const period = `${year}-Q${quarter}`;
    const idempotencyKey = `quarter_plan:${period}`;

    const existing = await this.db
      .select()
      .from(planningRuns)
      .where(eq(planningRuns.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing[0]?.status === 'SUCCEEDED') {
      const qGoals = await this.listGoals('QUARTER');
      return { period, goals: qGoals, reused: true };
    }

    const runId = randomUUID();
    await this.db.insert(planningRuns).values({
      id: runId,
      runType: 'PREPARE_QUARTER',
      targetPeriod: period,
      trigger: 'MANUAL',
      status: 'RUNNING',
      startedAt: now,
      idempotencyKey,
      details: {},
    });

    const yearGoals = await this.listGoals('YEAR');
    const season = await this.db
      .select()
      .from(seasons)
      .where(and(eq(seasons.active, true), isNull(seasons.deletedAt)))
      .limit(1);

    const created = [];
    const seeds = yearGoals.slice(0, 5);
    if (seeds.length === 0) {
      const g = await this.upsertGoal({
        title: season[0]?.title ? `Q${quarter}: ${season[0].title}` : `Q${quarter} outcomes`,
        horizon: 'QUARTER',
        lifeArea: 'GENERAL',
        successCriteria: '3–5 measurable advances this quarter',
        targetDate: `${year}-${String(quarter * 3).padStart(2, '0')}-28`,
      });
      created.push(g);
    } else {
      for (const y of seeds) {
        const g = await this.upsertGoal({
          title: `Q${quarter}: ${y.title}`,
          horizon: 'QUARTER',
          parentId: y.id,
          lifeArea: y.lifeArea,
          successCriteria: y.successCriteria || `Progress toward ${y.title}`,
          targetDate: `${year}-${String(quarter * 3).padStart(2, '0')}-28`,
        });
        created.push(g);
      }
    }

    await this.db
      .update(planningRuns)
      .set({
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        details: { created: created.map((c) => c?.id) },
      })
      .where(eq(planningRuns.id, runId));

    return { period, goals: created, reused: false };
  }

  async generateMonthPlan(input?: { year?: number; month?: number }) {
    const now = new Date();
    const year = input?.year ?? now.getUTCFullYear();
    const month = input?.month ?? now.getUTCMonth() + 1;
    const period = `${year}-${String(month).padStart(2, '0')}`;
    const idempotencyKey = `month_plan:${period}`;

    const existing = await this.db
      .select()
      .from(planningRuns)
      .where(eq(planningRuns.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing[0]?.status === 'SUCCEEDED') {
      return { period, goals: await this.listGoals('MONTH'), reused: true };
    }

    const runId = randomUUID();
    await this.db.insert(planningRuns).values({
      id: runId,
      runType: 'PREPARE_MONTH',
      targetPeriod: period,
      trigger: 'MANUAL',
      status: 'RUNNING',
      startedAt: now,
      idempotencyKey,
      details: {},
    });

    const quarters = await this.listGoals('QUARTER');
    const created = [];
    const seeds = quarters.slice(0, 4);
    if (seeds.length === 0) {
      created.push(
        await this.upsertGoal({
          title: `Milestone ${period}`,
          horizon: 'MONTH',
          successCriteria: 'Concrete progress this month',
          targetDate: `${period}-28`,
        }),
      );
    } else {
      for (const q of seeds) {
        created.push(
          await this.upsertGoal({
            title: `${period}: ${q.title}`,
            horizon: 'MONTH',
            parentId: q.id,
            lifeArea: q.lifeArea,
            successCriteria: q.successCriteria || q.title,
            targetDate: `${period}-28`,
          }),
        );
      }
    }

    await this.db
      .update(planningRuns)
      .set({
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        details: { created: created.map((c) => c?.id) },
      })
      .where(eq(planningRuns.id, runId));

    return { period, goals: created, reused: false };
  }

  /** Trace a goal upward through parents. */
  async traceUp(goalId: string) {
    type Node = { id: string; title: string; horizon: string; parentId: string | null };
    const chain: Node[] = [];
    const all = await this.db
      .select({
        id: goals.id,
        title: goals.title,
        horizon: goals.horizon,
        parentId: goals.parentId,
      })
      .from(goals);
    const byId = new Map(all.map((g) => [g.id, g]));
    let currentId: string | null = goalId;
    const guard = new Set<string>();
    while (currentId && !guard.has(currentId)) {
      guard.add(currentId);
      const found = byId.get(currentId);
      if (!found) break;
      chain.push(found);
      currentId = found.parentId;
    }
    return chain;
  }
}
