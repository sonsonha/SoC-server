import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { Db } from '../infrastructure/db/client.js';
import {
  financeAllocationSettings,
  financeDebtPayments,
  financeDebts,
  financeExpenseCategories,
  financeExpenseEntries,
  financeIncomeAllocations,
  financeIncomeEntries,
  financeIncomeSources,
} from '../infrastructure/db/schema/index.js';

export type FinanceBucket = 'LIVING' | 'SAFETY' | 'GROWTH' | 'FUN';
export type ExpenseCategoryKind = 'ESSENTIAL' | 'FIXED' | 'DISCRETIONARY' | 'OTHER';
export type ExpenseRecurrence = 'FIXED' | 'VARIABLE';

export type AllocationPcts = {
  livingPct: number;
  safetyPct: number;
  growthPct: number;
  funPct: number;
};

const BUCKETS: FinanceBucket[] = ['LIVING', 'SAFETY', 'GROWTH', 'FUN'];

const DEFAULT_PCTS: AllocationPcts = {
  livingPct: 50,
  safetyPct: 15,
  growthPct: 30,
  funPct: 5,
};

const DEFAULT_SAFETY_TARGET_MONTHS = 6;

const LEGACY_GROWTH_BUCKETS = new Set([
  'INVESTING',
  'OPPORTUNITY',
  'LEARNING',
  'COMPOUND',
]);

const SEED_CATEGORIES: Array<{
  name: string;
  kind: ExpenseCategoryKind;
  recurrence: ExpenseRecurrence;
  defaultBucket: FinanceBucket;
  sortOrder: number;
}> = [
  { name: 'Food', kind: 'ESSENTIAL', recurrence: 'VARIABLE', defaultBucket: 'LIVING', sortOrder: 10 },
  { name: 'Groceries', kind: 'ESSENTIAL', recurrence: 'VARIABLE', defaultBucket: 'LIVING', sortOrder: 20 },
  { name: 'Transport', kind: 'ESSENTIAL', recurrence: 'VARIABLE', defaultBucket: 'LIVING', sortOrder: 30 },
  { name: 'Rent', kind: 'FIXED', recurrence: 'FIXED', defaultBucket: 'LIVING', sortOrder: 40 },
  { name: 'Electricity', kind: 'FIXED', recurrence: 'FIXED', defaultBucket: 'LIVING', sortOrder: 50 },
  { name: 'Internet', kind: 'FIXED', recurrence: 'FIXED', defaultBucket: 'LIVING', sortOrder: 60 },
  { name: 'Software/AI', kind: 'FIXED', recurrence: 'FIXED', defaultBucket: 'LIVING', sortOrder: 70 },
  { name: 'Phone', kind: 'FIXED', recurrence: 'FIXED', defaultBucket: 'LIVING', sortOrder: 80 },
  { name: 'Hosting', kind: 'FIXED', recurrence: 'FIXED', defaultBucket: 'LIVING', sortOrder: 85 },
  { name: 'Shopping', kind: 'DISCRETIONARY', recurrence: 'VARIABLE', defaultBucket: 'FUN', sortOrder: 90 },
  { name: 'Entertainment', kind: 'DISCRETIONARY', recurrence: 'VARIABLE', defaultBucket: 'FUN', sortOrder: 100 },
  { name: 'Health', kind: 'OTHER', recurrence: 'VARIABLE', defaultBucket: 'SAFETY', sortOrder: 110 },
  { name: 'Education', kind: 'OTHER', recurrence: 'VARIABLE', defaultBucket: 'GROWTH', sortOrder: 120 },
  { name: 'Books', kind: 'OTHER', recurrence: 'VARIABLE', defaultBucket: 'GROWTH', sortOrder: 125 },
  { name: 'Courses', kind: 'OTHER', recurrence: 'VARIABLE', defaultBucket: 'GROWTH', sortOrder: 126 },
  { name: 'Investing', kind: 'OTHER', recurrence: 'VARIABLE', defaultBucket: 'GROWTH', sortOrder: 127 },
  { name: 'Product Experiment', kind: 'OTHER', recurrence: 'VARIABLE', defaultBucket: 'GROWTH', sortOrder: 128 },
  { name: 'Other', kind: 'OTHER', recurrence: 'VARIABLE', defaultBucket: 'LIVING', sortOrder: 130 },
];

function financeError(message: string, statusCode = 400, code = 'INVALID_INPUT') {
  return Object.assign(new Error(message), { statusCode, code });
}

function isBucket(value: string): value is FinanceBucket {
  return (BUCKETS as string[]).includes(value);
}

/** Map legacy bucket IDs into the canonical 4-bucket model. */
export function canonicalizeBucket(value: string): FinanceBucket | null {
  if (LEGACY_GROWTH_BUCKETS.has(value)) return 'GROWTH';
  if (isBucket(value)) return value;
  return null;
}

function isKind(value: string): value is ExpenseCategoryKind {
  return ['ESSENTIAL', 'FIXED', 'DISCRETIONARY', 'OTHER'].includes(value);
}

function isRecurrence(value: string): value is ExpenseRecurrence {
  return value === 'FIXED' || value === 'VARIABLE';
}

function defaultRecurrenceForKind(kind: ExpenseCategoryKind): ExpenseRecurrence {
  return kind === 'FIXED' ? 'FIXED' : 'VARIABLE';
}

function sumPcts(pcts: AllocationPcts): number {
  return pcts.livingPct + pcts.safetyPct + pcts.growthPct + pcts.funPct;
}

/** Split integer VND by percents; remainder goes to Fun so sum == amount. */
export function allocateAmountVnd(
  amountVnd: number,
  pcts: AllocationPcts,
): Array<{ bucket: FinanceBucket; amountVnd: number; pctApplied: number }> {
  if (!Number.isInteger(amountVnd) || amountVnd < 0) {
    throw financeError('amountVnd must be a non-negative integer');
  }
  if (sumPcts(pcts) !== 100) {
    throw financeError('Allocation percentages must sum to 100');
  }
  const living = Math.floor((amountVnd * pcts.livingPct) / 100);
  const safety = Math.floor((amountVnd * pcts.safetyPct) / 100);
  const growth = Math.floor((amountVnd * pcts.growthPct) / 100);
  const fun = amountVnd - living - safety - growth;
  return [
    { bucket: 'LIVING', amountVnd: living, pctApplied: pcts.livingPct },
    { bucket: 'SAFETY', amountVnd: safety, pctApplied: pcts.safetyPct },
    { bucket: 'GROWTH', amountVnd: growth, pctApplied: pcts.growthPct },
    { bucket: 'FUN', amountVnd: fun, pctApplied: pcts.funPct },
  ];
}

/** Build allocation rows from explicit per-bucket amounts (per-income override). */
export function allocateFromAmounts(
  amountVnd: number,
  amounts: Partial<Record<FinanceBucket, number>>,
): Array<{ bucket: FinanceBucket; amountVnd: number; pctApplied: number }> {
  if (!Number.isInteger(amountVnd) || amountVnd < 0) {
    throw financeError('amountVnd must be a non-negative integer');
  }
  const living = amounts.LIVING ?? 0;
  const safety = amounts.SAFETY ?? 0;
  const growth = amounts.GROWTH ?? 0;
  const fun = amounts.FUN ?? 0;
  for (const n of [living, safety, growth, fun]) {
    if (!Number.isInteger(n) || n < 0) {
      throw financeError('Each allocation amount must be a non-negative integer');
    }
  }
  if (living + safety + growth + fun !== amountVnd) {
    throw financeError('Allocation amounts must sum to income amount');
  }
  const pct = (part: number) => (amountVnd === 0 ? 0 : Math.round((part * 100) / amountVnd));
  // Keep pcts summing sensibly; Fun absorbs pct remainder conceptually via amounts.
  const livingPct = pct(living);
  const safetyPct = pct(safety);
  const growthPct = pct(growth);
  const funPct = amountVnd === 0 ? 0 : 100 - livingPct - safetyPct - growthPct;
  return [
    { bucket: 'LIVING', amountVnd: living, pctApplied: livingPct },
    { bucket: 'SAFETY', amountVnd: safety, pctApplied: safetyPct },
    { bucket: 'GROWTH', amountVnd: growth, pctApplied: growthPct },
    { bucket: 'FUN', amountVnd: fun, pctApplied: funPct },
  ];
}

/**
 * Rescale existing pct snapshot to a new income total.
 * Maps INVESTING|OPPORTUNITY|LEARNING|COMPOUND → GROWTH (summing pcts).
 */
export function rescaleAllocations(
  amountVnd: number,
  previous: Array<{ bucket: string; pctApplied: number }>,
): Array<{ bucket: FinanceBucket; amountVnd: number; pctApplied: number }> {
  const byBucket: Partial<Record<FinanceBucket, number>> = {};
  for (const p of previous) {
    const key = canonicalizeBucket(p.bucket);
    if (!key) continue;
    byBucket[key] = (byBucket[key] ?? 0) + p.pctApplied;
  }
  const pcts: AllocationPcts = {
    livingPct: byBucket.LIVING ?? 0,
    safetyPct: byBucket.SAFETY ?? 0,
    growthPct: byBucket.GROWTH ?? 0,
    funPct: byBucket.FUN ?? 0,
  };
  if (sumPcts(pcts) !== 100) {
    return allocateAmountVnd(amountVnd, DEFAULT_PCTS);
  }
  return allocateAmountVnd(amountVnd, pcts);
}

export function monthBounds(month: string): { start: string; end: string; prevMonth: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw financeError('month must be YYYY-MM');
  }
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${month}-${String(lastDay).padStart(2, '0')}`;
  const prev = m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, '0')}`;
  return { start, end, prevMonth: prev };
}

export function todayInHoChiMinh(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

type BucketTotals = Record<FinanceBucket, number>;

function emptyBuckets(): BucketTotals {
  return {
    LIVING: 0,
    SAFETY: 0,
    GROWTH: 0,
    FUN: 0,
  };
}

export class FinanceService {
  constructor(private readonly db: Db) {}

  async ensureBootstrap(userId: string) {
    await this.ensureSettings(userId);
    await this.ensureSeedCategories(userId);
  }

  async ensureSettings(userId: string) {
    const existing = await this.db
      .select()
      .from(financeAllocationSettings)
      .where(and(
        eq(financeAllocationSettings.userId, userId),
        isNull(financeAllocationSettings.deletedAt),
      ))
      .limit(1);
    if (existing[0]) return existing[0];

    const id = randomUUID();
    const now = new Date();
    // Parallel bootstrap (summary + sources + …) can race; ignore duplicate user_id.
    await this.db
      .insert(financeAllocationSettings)
      .values({
        id,
        userId,
        ...DEFAULT_PCTS,
        safetyTargetMonths: DEFAULT_SAFETY_TARGET_MONTHS,
        currency: 'VND',
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoNothing({ target: financeAllocationSettings.userId });

    const rows = await this.db
      .select()
      .from(financeAllocationSettings)
      .where(and(
        eq(financeAllocationSettings.userId, userId),
        isNull(financeAllocationSettings.deletedAt),
      ))
      .limit(1);
    if (!rows[0]) {
      throw financeError('Could not initialize finance settings', 500, 'INTERNAL');
    }
    return rows[0];
  }

  async ensureSeedCategories(userId: string) {
    const existing = await this.db
      .select({ id: financeExpenseCategories.id })
      .from(financeExpenseCategories)
      .where(and(
        eq(financeExpenseCategories.userId, userId),
        isNull(financeExpenseCategories.deletedAt),
      ))
      .limit(1);
    if (existing[0]) return;

    const now = new Date();
    try {
      await this.db.insert(financeExpenseCategories).values(
        SEED_CATEGORIES.map((cat) => ({
          id: randomUUID(),
          userId,
          name: cat.name,
          kind: cat.kind,
          recurrence: cat.recurrence,
          defaultBucket: cat.defaultBucket,
          active: true,
          sortOrder: cat.sortOrder,
          isSystem: true,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })),
      );
    } catch (err) {
      // Concurrent seed from parallel requests — another insert already won.
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate key|unique constraint/i.test(message)) throw err;
    }
  }

  // ── Settings ──────────────────────────────────────────────

  async getAllocationSettings(userId: string) {
    await this.ensureBootstrap(userId);
    const row = await this.ensureSettings(userId);
    return this.serializeSettings(row);
  }

  async updateAllocationSettings(
    userId: string,
    input: AllocationPcts & { currency?: string; safetyTargetMonths?: number },
  ) {
    if (sumPcts(input) !== 100) throw financeError('Allocation percentages must sum to 100');
    for (const n of [
      input.livingPct,
      input.safetyPct,
      input.growthPct,
      input.funPct,
    ]) {
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        throw financeError('Each percentage must be an integer 0–100');
      }
    }
    if (input.safetyTargetMonths != null) {
      if (![3, 6, 9, 12].includes(input.safetyTargetMonths)) {
        throw financeError('safetyTargetMonths must be 3, 6, 9, or 12');
      }
    }
    const row = await this.ensureSettings(userId);
    await this.db
      .update(financeAllocationSettings)
      .set({
        livingPct: input.livingPct,
        safetyPct: input.safetyPct,
        growthPct: input.growthPct,
        funPct: input.funPct,
        safetyTargetMonths: input.safetyTargetMonths ?? row.safetyTargetMonths,
        currency: input.currency ?? row.currency,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(financeAllocationSettings.id, row.id));
    return this.getAllocationSettings(userId);
  }

  // ── Income sources ────────────────────────────────────────

  async listIncomeSources(userId: string) {
    await this.ensureBootstrap(userId);
    const rows = await this.db
      .select()
      .from(financeIncomeSources)
      .where(and(eq(financeIncomeSources.userId, userId), isNull(financeIncomeSources.deletedAt)))
      .orderBy(asc(financeIncomeSources.sortOrder), asc(financeIncomeSources.name));
    return rows.map((r) => this.serializeSource(r));
  }

  async createIncomeSource(userId: string, input: { name: string; sortOrder?: number }) {
    const name = input.name.trim();
    if (!name) throw financeError('Name is required');
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(financeIncomeSources).values({
      id,
      userId,
      name: name.slice(0, 120),
      active: true,
      sortOrder: input.sortOrder ?? 0,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    return this.getIncomeSource(userId, id);
  }

  async patchIncomeSource(
    userId: string,
    id: string,
    input: Partial<{ name: string; active: boolean; sortOrder: number }>,
  ) {
    const row = await this.requireSource(userId, id);
    await this.db
      .update(financeIncomeSources)
      .set({
        name: input.name != null ? input.name.trim().slice(0, 120) : row.name,
        active: input.active ?? row.active,
        sortOrder: input.sortOrder ?? row.sortOrder,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(financeIncomeSources.id, id));
    return this.getIncomeSource(userId, id);
  }

  async deleteIncomeSource(userId: string, id: string) {
    const row = await this.requireSource(userId, id);
    const linked = await this.db
      .select({ id: financeIncomeEntries.id })
      .from(financeIncomeEntries)
      .where(and(
        eq(financeIncomeEntries.sourceId, id),
        isNull(financeIncomeEntries.deletedAt),
      ))
      .limit(1);
    if (linked[0]) {
      await this.db
        .update(financeIncomeSources)
        .set({
          active: false,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(financeIncomeSources.id, id));
      return { id, deleted: false as const, deactivated: true as const };
    }
    await this.db
      .update(financeIncomeSources)
      .set({
        deletedAt: new Date(),
        active: false,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(financeIncomeSources.id, id));
    return { id, deleted: true as const, deactivated: false as const };
  }

  // ── Income entries ────────────────────────────────────────

  async createIncomeEntry(
    userId: string,
    input: {
      sourceId: string;
      amountVnd: number;
      receivedAt?: string;
      note?: string;
      /** Optional per-income override; must sum to amountVnd. Does not change settings. */
      allocations?: Array<{ bucket: FinanceBucket; amountVnd: number }>;
    },
  ) {
    await this.requireSource(userId, input.sourceId);
    if (!Number.isInteger(input.amountVnd) || input.amountVnd < 0) {
      throw financeError('amountVnd must be a non-negative integer');
    }
    const settings = await this.ensureSettings(userId);
    const receivedAt = input.receivedAt?.trim() || todayInHoChiMinh();
    this.assertDate(receivedAt);

    let allocations: Array<{ bucket: FinanceBucket; amountVnd: number; pctApplied: number }>;
    if (input.allocations) {
      const amounts: Partial<Record<FinanceBucket, number>> = {};
      for (const row of input.allocations) {
        if (!isBucket(row.bucket)) throw financeError(`Invalid bucket: ${row.bucket}`);
        amounts[row.bucket] = (amounts[row.bucket] ?? 0) + row.amountVnd;
      }
      allocations = allocateFromAmounts(input.amountVnd, amounts);
    } else {
      allocations = allocateAmountVnd(input.amountVnd, {
        livingPct: settings.livingPct,
        safetyPct: settings.safetyPct,
        growthPct: settings.growthPct,
        funPct: settings.funPct,
      });
    }
    const id = randomUUID();
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx.insert(financeIncomeEntries).values({
        id,
        userId,
        sourceId: input.sourceId,
        amountVnd: input.amountVnd,
        currency: settings.currency,
        receivedAt,
        note: (input.note ?? '').slice(0, 2000),
        policyLivingPct: settings.livingPct,
        policySafetyPct: settings.safetyPct,
        policyGrowthPct: settings.growthPct,
        policyFunPct: settings.funPct,
        createdAt: now,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });
      await tx.insert(financeIncomeAllocations).values(
        allocations.map((a) => ({
          id: randomUUID(),
          userId,
          incomeEntryId: id,
          bucket: a.bucket,
          amountVnd: a.amountVnd,
          pctApplied: a.pctApplied,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        })),
      );
    });

    return this.getIncomeEntry(userId, id);
  }

  async patchIncomeEntry(
    userId: string,
    id: string,
    input: Partial<{ sourceId: string; amountVnd: number; receivedAt: string; note: string }>,
  ) {
    const row = await this.requireIncome(userId, id);
    if (input.sourceId) await this.requireSource(userId, input.sourceId);
    if (input.amountVnd != null && (!Number.isInteger(input.amountVnd) || input.amountVnd < 0)) {
      throw financeError('amountVnd must be a non-negative integer');
    }
    if (input.receivedAt) this.assertDate(input.receivedAt);

    const nextAmount = input.amountVnd ?? row.amountVnd;
    const amountChanged = nextAmount !== row.amountVnd;

    await this.db.transaction(async (tx) => {
      await tx
        .update(financeIncomeEntries)
        .set({
          sourceId: input.sourceId ?? row.sourceId,
          amountVnd: nextAmount,
          receivedAt: input.receivedAt ?? row.receivedAt,
          note: input.note != null ? input.note.slice(0, 2000) : row.note,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(financeIncomeEntries.id, id));

      if (amountChanged) {
        const existing = await tx
          .select()
          .from(financeIncomeAllocations)
          .where(and(
            eq(financeIncomeAllocations.incomeEntryId, id),
            isNull(financeIncomeAllocations.deletedAt),
          ));
        const rescaled = rescaleAllocations(
          nextAmount,
          existing.map((e) => ({
            bucket: e.bucket,
            pctApplied: e.pctApplied,
          })),
        );
        const now = new Date();
        const usedIds = new Set<string>();
        for (const a of rescaled) {
          const match = existing.find((e) =>
            !usedIds.has(e.id) && canonicalizeBucket(e.bucket) === a.bucket,
          );
          if (match) {
            usedIds.add(match.id);
            await tx
              .update(financeIncomeAllocations)
              .set({
                bucket: a.bucket,
                amountVnd: a.amountVnd,
                pctApplied: a.pctApplied,
                revision: match.revision + 1,
                updatedAt: now,
              })
              .where(eq(financeIncomeAllocations.id, match.id));
          } else {
            await tx.insert(financeIncomeAllocations).values({
              id: randomUUID(),
              userId,
              incomeEntryId: id,
              bucket: a.bucket,
              amountVnd: a.amountVnd,
              pctApplied: a.pctApplied,
              revision: 1,
              updatedAt: now,
              deletedAt: null,
            });
          }
        }
        for (const e of existing) {
          if (!usedIds.has(e.id)) {
            await tx
              .update(financeIncomeAllocations)
              .set({ deletedAt: now, updatedAt: now })
              .where(eq(financeIncomeAllocations.id, e.id));
          }
        }
      }
    });

    return this.getIncomeEntry(userId, id);
  }

  async deleteIncomeEntry(userId: string, id: string) {
    const row = await this.requireIncome(userId, id);
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(financeIncomeEntries)
        .set({ deletedAt: now, revision: row.revision + 1, updatedAt: now })
        .where(eq(financeIncomeEntries.id, id));
      await tx
        .update(financeIncomeAllocations)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(
          eq(financeIncomeAllocations.incomeEntryId, id),
          isNull(financeIncomeAllocations.deletedAt),
        ));
    });
    return { id, deleted: true as const };
  }

  // ── Categories ────────────────────────────────────────────

  async listExpenseCategories(userId: string) {
    await this.ensureBootstrap(userId);
    const rows = await this.db
      .select()
      .from(financeExpenseCategories)
      .where(and(
        eq(financeExpenseCategories.userId, userId),
        isNull(financeExpenseCategories.deletedAt),
      ))
      .orderBy(asc(financeExpenseCategories.sortOrder), asc(financeExpenseCategories.name));
    return rows.map((r) => this.serializeCategory(r));
  }

  async createExpenseCategory(
    userId: string,
    input: {
      name: string;
      kind?: ExpenseCategoryKind;
      recurrence?: ExpenseRecurrence;
      defaultBucket?: FinanceBucket;
      sortOrder?: number;
    },
  ) {
    const name = input.name.trim();
    if (!name) throw financeError('Name is required');
    const kind = input.kind ?? 'OTHER';
    const recurrence = input.recurrence ?? defaultRecurrenceForKind(kind);
    const defaultBucket = input.defaultBucket ?? 'LIVING';
    if (!isKind(kind)) throw financeError('Invalid category kind');
    if (!isRecurrence(recurrence)) throw financeError('Invalid recurrence');
    if (!isBucket(defaultBucket)) throw financeError('Invalid default bucket');
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(financeExpenseCategories).values({
      id,
      userId,
      name: name.slice(0, 120),
      kind,
      recurrence,
      defaultBucket,
      active: true,
      sortOrder: input.sortOrder ?? 200,
      isSystem: false,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    return this.getCategory(userId, id);
  }

  async patchExpenseCategory(
    userId: string,
    id: string,
    input: Partial<{
      name: string;
      kind: ExpenseCategoryKind;
      recurrence: ExpenseRecurrence;
      defaultBucket: FinanceBucket;
      active: boolean;
      sortOrder: number;
    }>,
  ) {
    const row = await this.requireCategory(userId, id);
    if (input.kind && !isKind(input.kind)) throw financeError('Invalid category kind');
    if (input.recurrence && !isRecurrence(input.recurrence)) {
      throw financeError('Invalid recurrence');
    }
    if (input.defaultBucket && !isBucket(input.defaultBucket)) {
      throw financeError('Invalid default bucket');
    }
    await this.db
      .update(financeExpenseCategories)
      .set({
        name: input.name != null ? input.name.trim().slice(0, 120) : row.name,
        kind: input.kind ?? row.kind,
        recurrence: input.recurrence ?? row.recurrence,
        defaultBucket: input.defaultBucket ?? row.defaultBucket,
        active: input.active ?? row.active,
        sortOrder: input.sortOrder ?? row.sortOrder,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(financeExpenseCategories.id, id));
    return this.getCategory(userId, id);
  }

  async deleteExpenseCategory(userId: string, id: string) {
    const row = await this.requireCategory(userId, id);
    const linked = await this.db
      .select({ id: financeExpenseEntries.id })
      .from(financeExpenseEntries)
      .where(and(
        eq(financeExpenseEntries.categoryId, id),
        isNull(financeExpenseEntries.deletedAt),
      ))
      .limit(1);
    if (linked[0] || row.isSystem) {
      await this.db
        .update(financeExpenseCategories)
        .set({
          active: false,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(financeExpenseCategories.id, id));
      return { id, deleted: false as const, deactivated: true as const };
    }
    await this.db
      .update(financeExpenseCategories)
      .set({
        deletedAt: new Date(),
        active: false,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(financeExpenseCategories.id, id));
    return { id, deleted: true as const, deactivated: false as const };
  }

  // ── Expenses ──────────────────────────────────────────────

  async createExpenseEntry(
    userId: string,
    input: {
      categoryId: string;
      amountVnd: number;
      spentAt?: string;
      note?: string;
      fundingBucket?: FinanceBucket;
    },
  ) {
    const category = await this.requireCategory(userId, input.categoryId);
    if (!Number.isInteger(input.amountVnd) || input.amountVnd < 0) {
      throw financeError('amountVnd must be a non-negative integer');
    }
    const rawBucket = input.fundingBucket ?? category.defaultBucket;
    const fundingBucket = canonicalizeBucket(rawBucket);
    if (!fundingBucket) throw financeError('Invalid funding bucket');
    const spentAt = input.spentAt?.trim() || todayInHoChiMinh();
    this.assertDate(spentAt);
    const settings = await this.ensureSettings(userId);
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(financeExpenseEntries).values({
      id,
      userId,
      categoryId: input.categoryId,
      amountVnd: input.amountVnd,
      currency: settings.currency,
      fundingBucket,
      spentAt,
      note: (input.note ?? '').slice(0, 2000),
      createdAt: now,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    return this.getExpenseEntry(userId, id);
  }

  async patchExpenseEntry(
    userId: string,
    id: string,
    input: Partial<{
      categoryId: string;
      amountVnd: number;
      spentAt: string;
      note: string;
      fundingBucket: FinanceBucket;
    }>,
  ) {
    const row = await this.requireExpense(userId, id);
    if (input.categoryId) await this.requireCategory(userId, input.categoryId);
    if (input.amountVnd != null && (!Number.isInteger(input.amountVnd) || input.amountVnd < 0)) {
      throw financeError('amountVnd must be a non-negative integer');
    }
    if (input.fundingBucket && !isBucket(input.fundingBucket)) {
      throw financeError('Invalid funding bucket');
    }
    if (input.spentAt) this.assertDate(input.spentAt);
    await this.db
      .update(financeExpenseEntries)
      .set({
        categoryId: input.categoryId ?? row.categoryId,
        amountVnd: input.amountVnd ?? row.amountVnd,
        spentAt: input.spentAt ?? row.spentAt,
        note: input.note != null ? input.note.slice(0, 2000) : row.note,
        fundingBucket: input.fundingBucket ?? row.fundingBucket,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(financeExpenseEntries.id, id));
    return this.getExpenseEntry(userId, id);
  }

  async deleteExpenseEntry(userId: string, id: string) {
    const row = await this.requireExpense(userId, id);
    await this.db
      .update(financeExpenseEntries)
      .set({
        deletedAt: new Date(),
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(financeExpenseEntries.id, id));
    return { id, deleted: true as const };
  }

  // ── Debts ─────────────────────────────────────────────────

  async listDebts(userId: string) {
    await this.ensureBootstrap(userId);
    const rows = await this.db
      .select()
      .from(financeDebts)
      .where(and(eq(financeDebts.userId, userId), isNull(financeDebts.deletedAt)))
      .orderBy(asc(financeDebts.name));
    return rows.map((r) => this.serializeDebt(r));
  }

  async createDebt(
    userId: string,
    input: { name: string; outstandingVnd: number; monthlyRequiredVnd: number },
  ) {
    const name = input.name.trim();
    if (!name) throw financeError('Name is required');
    if (!Number.isInteger(input.outstandingVnd) || input.outstandingVnd < 0) {
      throw financeError('outstandingVnd must be a non-negative integer');
    }
    if (!Number.isInteger(input.monthlyRequiredVnd) || input.monthlyRequiredVnd < 0) {
      throw financeError('monthlyRequiredVnd must be a non-negative integer');
    }
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(financeDebts).values({
      id,
      userId,
      name: name.slice(0, 120),
      outstandingVnd: input.outstandingVnd,
      monthlyRequiredVnd: input.monthlyRequiredVnd,
      active: true,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    return this.getDebt(userId, id);
  }

  async patchDebt(
    userId: string,
    id: string,
    input: Partial<{
      name: string;
      outstandingVnd: number;
      monthlyRequiredVnd: number;
      active: boolean;
    }>,
  ) {
    const row = await this.requireDebt(userId, id);
    if (input.outstandingVnd != null && (!Number.isInteger(input.outstandingVnd) || input.outstandingVnd < 0)) {
      throw financeError('outstandingVnd must be a non-negative integer');
    }
    if (
      input.monthlyRequiredVnd != null
      && (!Number.isInteger(input.monthlyRequiredVnd) || input.monthlyRequiredVnd < 0)
    ) {
      throw financeError('monthlyRequiredVnd must be a non-negative integer');
    }
    await this.db
      .update(financeDebts)
      .set({
        name: input.name != null ? input.name.trim().slice(0, 120) : row.name,
        outstandingVnd: input.outstandingVnd ?? row.outstandingVnd,
        monthlyRequiredVnd: input.monthlyRequiredVnd ?? row.monthlyRequiredVnd,
        active: input.active ?? row.active,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(financeDebts.id, id));
    return this.getDebt(userId, id);
  }

  async deleteDebt(userId: string, id: string) {
    const row = await this.requireDebt(userId, id);
    await this.db
      .update(financeDebts)
      .set({
        deletedAt: new Date(),
        active: false,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(financeDebts.id, id));
    return { id, deleted: true as const };
  }

  async createDebtPayment(
    userId: string,
    input: { debtId: string; amountVnd: number; paidAt?: string; note?: string },
  ) {
    const debt = await this.requireDebt(userId, input.debtId);
    if (!Number.isInteger(input.amountVnd) || input.amountVnd <= 0) {
      throw financeError('amountVnd must be a positive integer');
    }
    if (input.amountVnd > debt.outstandingVnd) {
      throw financeError('Payment exceeds outstanding debt');
    }
    const paidAt = input.paidAt?.trim() || todayInHoChiMinh();
    this.assertDate(paidAt);
    const settings = await this.ensureSettings(userId);
    const id = randomUUID();
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx.insert(financeDebtPayments).values({
        id,
        userId,
        debtId: input.debtId,
        amountVnd: input.amountVnd,
        currency: settings.currency,
        paidAt,
        note: (input.note ?? '').slice(0, 2000),
        createdAt: now,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });
      await tx
        .update(financeDebts)
        .set({
          outstandingVnd: debt.outstandingVnd - input.amountVnd,
          revision: debt.revision + 1,
          updatedAt: now,
        })
        .where(eq(financeDebts.id, debt.id));
    });

    return this.getDebtPayment(userId, id);
  }

  async patchDebtPayment(
    userId: string,
    id: string,
    input: Partial<{ amountVnd: number; paidAt: string; note: string }>,
  ) {
    const payment = await this.requireDebtPayment(userId, id);
    const debt = await this.requireDebt(userId, payment.debtId);
    if (input.amountVnd != null && (!Number.isInteger(input.amountVnd) || input.amountVnd <= 0)) {
      throw financeError('amountVnd must be a positive integer');
    }
    if (input.paidAt) this.assertDate(input.paidAt);

    const nextAmount = input.amountVnd ?? payment.amountVnd;
    const delta = nextAmount - payment.amountVnd;
    const nextOutstanding = debt.outstandingVnd - delta;
    if (nextOutstanding < 0) throw financeError('Payment exceeds outstanding debt');

    await this.db.transaction(async (tx) => {
      await tx
        .update(financeDebtPayments)
        .set({
          amountVnd: nextAmount,
          paidAt: input.paidAt ?? payment.paidAt,
          note: input.note != null ? input.note.slice(0, 2000) : payment.note,
          revision: payment.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(financeDebtPayments.id, id));
      if (delta !== 0) {
        await tx
          .update(financeDebts)
          .set({
            outstandingVnd: nextOutstanding,
            revision: debt.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(financeDebts.id, debt.id));
      }
    });

    return this.getDebtPayment(userId, id);
  }

  async deleteDebtPayment(userId: string, id: string) {
    const payment = await this.requireDebtPayment(userId, id);
    const debt = await this.requireDebt(userId, payment.debtId);
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(financeDebtPayments)
        .set({ deletedAt: now, revision: payment.revision + 1, updatedAt: now })
        .where(eq(financeDebtPayments.id, id));
      await tx
        .update(financeDebts)
        .set({
          outstandingVnd: debt.outstandingVnd + payment.amountVnd,
          revision: debt.revision + 1,
          updatedAt: now,
        })
        .where(eq(financeDebts.id, debt.id));
    });
    return { id, deleted: true as const };
  }

  // ── Summary + transactions ────────────────────────────────

  async getSummary(userId: string, month: string) {
    await this.ensureBootstrap(userId);
    const { start, end, prevMonth } = monthBounds(month);
    const prev = monthBounds(prevMonth);

    const [incomes, expenses, payments, debts, allocations, settings] = await Promise.all([
      this.db
        .select()
        .from(financeIncomeEntries)
        .where(and(
          eq(financeIncomeEntries.userId, userId),
          isNull(financeIncomeEntries.deletedAt),
          gte(financeIncomeEntries.receivedAt, start),
          lte(financeIncomeEntries.receivedAt, end),
        )),
      this.db
        .select({
          entry: financeExpenseEntries,
          categoryKind: financeExpenseCategories.kind,
          categoryName: financeExpenseCategories.name,
        })
        .from(financeExpenseEntries)
        .innerJoin(
          financeExpenseCategories,
          eq(financeExpenseEntries.categoryId, financeExpenseCategories.id),
        )
        .where(and(
          eq(financeExpenseEntries.userId, userId),
          isNull(financeExpenseEntries.deletedAt),
          gte(financeExpenseEntries.spentAt, start),
          lte(financeExpenseEntries.spentAt, end),
        )),
      this.db
        .select()
        .from(financeDebtPayments)
        .where(and(
          eq(financeDebtPayments.userId, userId),
          isNull(financeDebtPayments.deletedAt),
          gte(financeDebtPayments.paidAt, start),
          lte(financeDebtPayments.paidAt, end),
        )),
      this.db
        .select()
        .from(financeDebts)
        .where(and(
          eq(financeDebts.userId, userId),
          isNull(financeDebts.deletedAt),
          eq(financeDebts.active, true),
        )),
      this.db
        .select({
          alloc: financeIncomeAllocations,
          receivedAt: financeIncomeEntries.receivedAt,
        })
        .from(financeIncomeAllocations)
        .innerJoin(
          financeIncomeEntries,
          eq(financeIncomeAllocations.incomeEntryId, financeIncomeEntries.id),
        )
        .where(and(
          eq(financeIncomeAllocations.userId, userId),
          isNull(financeIncomeAllocations.deletedAt),
          isNull(financeIncomeEntries.deletedAt),
          gte(financeIncomeEntries.receivedAt, start),
          lte(financeIncomeEntries.receivedAt, end),
        )),
      this.ensureSettings(userId),
    ]);

    const [
      allAllocations,
      allExpenses,
      allPayments,
      prevIncomes,
      prevExpenses,
      prevPayments,
    ] = await Promise.all([
      this.db
        .select()
        .from(financeIncomeAllocations)
        .where(and(
          eq(financeIncomeAllocations.userId, userId),
          isNull(financeIncomeAllocations.deletedAt),
        )),
      this.db
        .select()
        .from(financeExpenseEntries)
        .where(and(
          eq(financeExpenseEntries.userId, userId),
          isNull(financeExpenseEntries.deletedAt),
        )),
      this.db
        .select()
        .from(financeDebtPayments)
        .where(and(
          eq(financeDebtPayments.userId, userId),
          isNull(financeDebtPayments.deletedAt),
        )),
      this.db
        .select()
        .from(financeIncomeEntries)
        .where(and(
          eq(financeIncomeEntries.userId, userId),
          isNull(financeIncomeEntries.deletedAt),
          gte(financeIncomeEntries.receivedAt, prev.start),
          lte(financeIncomeEntries.receivedAt, prev.end),
        )),
      this.db
        .select()
        .from(financeExpenseEntries)
        .where(and(
          eq(financeExpenseEntries.userId, userId),
          isNull(financeExpenseEntries.deletedAt),
          gte(financeExpenseEntries.spentAt, prev.start),
          lte(financeExpenseEntries.spentAt, prev.end),
        )),
      this.db
        .select()
        .from(financeDebtPayments)
        .where(and(
          eq(financeDebtPayments.userId, userId),
          isNull(financeDebtPayments.deletedAt),
          gte(financeDebtPayments.paidAt, prev.start),
          lte(financeDebtPayments.paidAt, prev.end),
        )),
    ]);

    const income = incomes.reduce((s, r) => s + r.amountVnd, 0);
    const spending = expenses.reduce((s, r) => s + r.entry.amountVnd, 0);
    const debtPaid = payments.reduce((s, r) => s + r.amountVnd, 0);
    const netCashflow = income - spending - debtPaid;
    const outstandingDebt = debts.reduce((s, r) => s + r.outstandingVnd, 0);
    const monthlyRequired = debts.reduce((s, r) => s + r.monthlyRequiredVnd, 0);
    const remainingRequired = Math.max(0, monthlyRequired - debtPaid);
    const fixedBooked = expenses
      .filter((e) => e.categoryKind === 'FIXED')
      .reduce((s, e) => s + e.entry.amountVnd, 0);

    const allocated = emptyBuckets();
    for (const row of allocations) {
      const b = canonicalizeBucket(row.alloc.bucket);
      if (b) allocated[b] += row.alloc.amountVnd;
    }

    const spentFrom = emptyBuckets();
    for (const row of expenses) {
      const b = canonicalizeBucket(row.entry.fundingBucket);
      if (b) spentFrom[b] += row.entry.amountVnd;
    }
    spentFrom.LIVING += debtPaid;

    const lifetimeAllocated = emptyBuckets();
    for (const row of allAllocations) {
      const b = canonicalizeBucket(row.bucket);
      if (b) lifetimeAllocated[b] += row.amountVnd;
    }
    const lifetimeSpent = emptyBuckets();
    for (const row of allExpenses) {
      const b = canonicalizeBucket(row.fundingBucket);
      if (b) lifetimeSpent[b] += row.amountVnd;
    }
    lifetimeSpent.LIVING += allPayments.reduce((s, p) => s + p.amountVnd, 0);

    const byCategoryMap = new Map<string, { categoryId: string; name: string; amountVnd: number }>();
    const growthByCategoryMap = new Map<string, { categoryId: string; name: string; amountVnd: number }>();
    for (const row of expenses) {
      const key = row.entry.categoryId;
      const cur = byCategoryMap.get(key) ?? {
        categoryId: key,
        name: row.categoryName,
        amountVnd: 0,
      };
      cur.amountVnd += row.entry.amountVnd;
      byCategoryMap.set(key, cur);

      if (canonicalizeBucket(row.entry.fundingBucket) === 'GROWTH') {
        const g = growthByCategoryMap.get(key) ?? {
          categoryId: key,
          name: row.categoryName,
          amountVnd: 0,
        };
        g.amountVnd += row.entry.amountVnd;
        growthByCategoryMap.set(key, g);
      }
    }

    const prevIncome = prevIncomes.reduce((s, r) => s + r.amountVnd, 0);
    const prevSpending = prevExpenses.reduce((s, r) => s + r.amountVnd, 0);
    const prevDebtPaid = prevPayments.reduce((s, r) => s + r.amountVnd, 0);

    const targetPct: Record<FinanceBucket, number> = {
      LIVING: settings.livingPct,
      SAFETY: settings.safetyPct,
      GROWTH: settings.growthPct,
      FUN: settings.funPct,
    };

    const buckets = BUCKETS.map((bucket) => {
      const alloc = allocated[bucket];
      const spent = spentFrom[bucket];
      return {
        bucket,
        allocatedVnd: alloc,
        spentVnd: spent,
        remainingVnd: alloc - spent,
        pctOfIncome: income > 0 ? Math.round((alloc * 1000) / income) / 10 : 0,
        targetPct: targetPct[bucket],
        lifetimeBalanceVnd: lifetimeAllocated[bucket] - lifetimeSpent[bucket],
      };
    });

    return {
      month,
      currency: settings.currency,
      incomeVnd: income,
      spendingVnd: spending,
      debtPaidVnd: debtPaid,
      netCashflowVnd: netCashflow,
      outstandingDebtVnd: outstandingDebt,
      monthlyDebtRequiredVnd: monthlyRequired,
      debtRemainingRequiredVnd: remainingRequired,
      fixedExpensesVnd: fixedBooked,
      deficitVnd: Math.min(0, income - monthlyRequired),
      showDeficit: income < monthlyRequired,
      allocationRatePct: income > 0
        ? Math.round(((allocated.SAFETY + allocated.GROWTH + allocated.FUN) * 1000) / income) / 10
        : 0,
      buckets,
      spendingByCategory: [...byCategoryMap.values()].sort((a, b) => b.amountVnd - a.amountVnd),
      growthSpendingByCategory: [...growthByCategoryMap.values()].sort((a, b) => b.amountVnd - a.amountVnd),
      previousMonth: {
        month: prevMonth,
        incomeVnd: prevIncome,
        spendingVnd: prevSpending,
        debtPaidVnd: prevDebtPaid,
        netCashflowVnd: prevIncome - prevSpending - prevDebtPaid,
      },
      debts: debts.map((d) => this.serializeDebt(d)),
      settings: this.serializeSettings(settings),
    };
  }

  async listTransactions(
    userId: string,
    opts: {
      type?: 'all' | 'income' | 'expense' | 'debt';
      month?: string;
      sourceId?: string;
      categoryId?: string;
      limit?: number;
    } = {},
  ) {
    await this.ensureBootstrap(userId);
    const type = opts.type ?? 'all';
    const limit = Math.min(opts.limit ?? 100, 500);
    let start: string | null = null;
    let end: string | null = null;
    if (opts.month) {
      const bounds = monthBounds(opts.month);
      start = bounds.start;
      end = bounds.end;
    }

    type Tx = {
      id: string;
      type: 'income' | 'expense' | 'debt';
      amountVnd: number;
      occurredAt: string;
      createdAt: string;
      note: string;
      label: string;
      meta: Record<string, unknown>;
    };
    const items: Tx[] = [];

    if (type === 'all' || type === 'income') {
      const rows = await this.db
        .select({
          entry: financeIncomeEntries,
          sourceName: financeIncomeSources.name,
        })
        .from(financeIncomeEntries)
        .innerJoin(
          financeIncomeSources,
          eq(financeIncomeEntries.sourceId, financeIncomeSources.id),
        )
        .where(and(
          eq(financeIncomeEntries.userId, userId),
          isNull(financeIncomeEntries.deletedAt),
          start ? gte(financeIncomeEntries.receivedAt, start) : undefined,
          end ? lte(financeIncomeEntries.receivedAt, end) : undefined,
          opts.sourceId ? eq(financeIncomeEntries.sourceId, opts.sourceId) : undefined,
        ))
        .orderBy(desc(financeIncomeEntries.receivedAt))
        .limit(limit);
      for (const row of rows) {
        items.push({
          id: row.entry.id,
          type: 'income',
          amountVnd: row.entry.amountVnd,
          occurredAt: String(row.entry.receivedAt),
          createdAt: row.entry.createdAt.toISOString(),
          note: row.entry.note,
          label: row.sourceName,
          meta: { sourceId: row.entry.sourceId },
        });
      }
    }

    if (type === 'all' || type === 'expense') {
      const rows = await this.db
        .select({
          entry: financeExpenseEntries,
          categoryName: financeExpenseCategories.name,
        })
        .from(financeExpenseEntries)
        .innerJoin(
          financeExpenseCategories,
          eq(financeExpenseEntries.categoryId, financeExpenseCategories.id),
        )
        .where(and(
          eq(financeExpenseEntries.userId, userId),
          isNull(financeExpenseEntries.deletedAt),
          start ? gte(financeExpenseEntries.spentAt, start) : undefined,
          end ? lte(financeExpenseEntries.spentAt, end) : undefined,
          opts.categoryId ? eq(financeExpenseEntries.categoryId, opts.categoryId) : undefined,
        ))
        .orderBy(desc(financeExpenseEntries.spentAt))
        .limit(limit);
      for (const row of rows) {
        items.push({
          id: row.entry.id,
          type: 'expense',
          amountVnd: row.entry.amountVnd,
          occurredAt: String(row.entry.spentAt),
          createdAt: row.entry.createdAt.toISOString(),
          note: row.entry.note,
          label: row.categoryName,
          meta: {
            categoryId: row.entry.categoryId,
            fundingBucket: row.entry.fundingBucket,
          },
        });
      }
    }

    if (type === 'all' || type === 'debt') {
      const rows = await this.db
        .select({
          payment: financeDebtPayments,
          debtName: financeDebts.name,
        })
        .from(financeDebtPayments)
        .innerJoin(financeDebts, eq(financeDebtPayments.debtId, financeDebts.id))
        .where(and(
          eq(financeDebtPayments.userId, userId),
          isNull(financeDebtPayments.deletedAt),
          start ? gte(financeDebtPayments.paidAt, start) : undefined,
          end ? lte(financeDebtPayments.paidAt, end) : undefined,
        ))
        .orderBy(desc(financeDebtPayments.paidAt))
        .limit(limit);
      for (const row of rows) {
        items.push({
          id: row.payment.id,
          type: 'debt',
          amountVnd: row.payment.amountVnd,
          occurredAt: String(row.payment.paidAt),
          createdAt: row.payment.createdAt.toISOString(),
          note: row.payment.note,
          label: row.debtName,
          meta: { debtId: row.payment.debtId },
        });
      }
    }

    items.sort((a, b) => {
      const d = b.occurredAt.localeCompare(a.occurredAt);
      if (d !== 0) return d;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return { transactions: items.slice(0, limit) };
  }

  // ── serializers / requires ────────────────────────────────

  private assertDate(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw financeError('Date must be YYYY-MM-DD');
    }
  }

  private serializeSettings(row: typeof financeAllocationSettings.$inferSelect) {
    return {
      id: row.id,
      livingPct: row.livingPct,
      safetyPct: row.safetyPct,
      growthPct: row.growthPct,
      funPct: row.funPct,
      safetyTargetMonths: row.safetyTargetMonths,
      currency: row.currency,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private serializeSource(row: typeof financeIncomeSources.$inferSelect) {
    return {
      id: row.id,
      name: row.name,
      active: row.active,
      sortOrder: row.sortOrder,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private serializeCategory(row: typeof financeExpenseCategories.$inferSelect) {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      recurrence: row.recurrence,
      defaultBucket: row.defaultBucket,
      active: row.active,
      sortOrder: row.sortOrder,
      isSystem: row.isSystem,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private serializeDebt(row: typeof financeDebts.$inferSelect) {
    return {
      id: row.id,
      name: row.name,
      outstandingVnd: row.outstandingVnd,
      monthlyRequiredVnd: row.monthlyRequiredVnd,
      active: row.active,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async getIncomeSource(userId: string, id: string) {
    return this.serializeSource(await this.requireSource(userId, id));
  }

  private async getCategory(userId: string, id: string) {
    return this.serializeCategory(await this.requireCategory(userId, id));
  }

  private async getDebt(userId: string, id: string) {
    return this.serializeDebt(await this.requireDebt(userId, id));
  }

  private async getIncomeEntry(userId: string, id: string) {
    const row = await this.requireIncome(userId, id);
    const allocations = await this.db
      .select()
      .from(financeIncomeAllocations)
      .where(and(
        eq(financeIncomeAllocations.incomeEntryId, id),
        isNull(financeIncomeAllocations.deletedAt),
      ));
    return {
      id: row.id,
      sourceId: row.sourceId,
      amountVnd: row.amountVnd,
      currency: row.currency,
      receivedAt: String(row.receivedAt),
      note: row.note,
      policyLivingPct: row.policyLivingPct,
      policySafetyPct: row.policySafetyPct,
      policyGrowthPct: row.policyGrowthPct,
      policyFunPct: row.policyFunPct,
      createdAt: row.createdAt.toISOString(),
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
      allocations: allocations.map((a) => ({
        bucket: a.bucket,
        amountVnd: a.amountVnd,
        pctApplied: a.pctApplied,
      })),
    };
  }

  private async getExpenseEntry(userId: string, id: string) {
    const row = await this.requireExpense(userId, id);
    return {
      id: row.id,
      categoryId: row.categoryId,
      amountVnd: row.amountVnd,
      currency: row.currency,
      fundingBucket: row.fundingBucket,
      spentAt: String(row.spentAt),
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async getDebtPayment(userId: string, id: string) {
    const row = await this.requireDebtPayment(userId, id);
    return {
      id: row.id,
      debtId: row.debtId,
      amountVnd: row.amountVnd,
      currency: row.currency,
      paidAt: String(row.paidAt),
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async requireSource(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(financeIncomeSources)
      .where(and(
        eq(financeIncomeSources.id, id),
        eq(financeIncomeSources.userId, userId),
        isNull(financeIncomeSources.deletedAt),
      ))
      .limit(1);
    if (!rows[0]) throw financeError('Income source not found', 404, 'NOT_FOUND');
    return rows[0];
  }

  private async requireIncome(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(financeIncomeEntries)
      .where(and(
        eq(financeIncomeEntries.id, id),
        eq(financeIncomeEntries.userId, userId),
        isNull(financeIncomeEntries.deletedAt),
      ))
      .limit(1);
    if (!rows[0]) throw financeError('Income entry not found', 404, 'NOT_FOUND');
    return rows[0];
  }

  private async requireCategory(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(financeExpenseCategories)
      .where(and(
        eq(financeExpenseCategories.id, id),
        eq(financeExpenseCategories.userId, userId),
        isNull(financeExpenseCategories.deletedAt),
      ))
      .limit(1);
    if (!rows[0]) throw financeError('Category not found', 404, 'NOT_FOUND');
    return rows[0];
  }

  private async requireExpense(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(financeExpenseEntries)
      .where(and(
        eq(financeExpenseEntries.id, id),
        eq(financeExpenseEntries.userId, userId),
        isNull(financeExpenseEntries.deletedAt),
      ))
      .limit(1);
    if (!rows[0]) throw financeError('Expense not found', 404, 'NOT_FOUND');
    return rows[0];
  }

  private async requireDebt(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(financeDebts)
      .where(and(
        eq(financeDebts.id, id),
        eq(financeDebts.userId, userId),
        isNull(financeDebts.deletedAt),
      ))
      .limit(1);
    if (!rows[0]) throw financeError('Debt not found', 404, 'NOT_FOUND');
    return rows[0];
  }

  private async requireDebtPayment(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(financeDebtPayments)
      .where(and(
        eq(financeDebtPayments.id, id),
        eq(financeDebtPayments.userId, userId),
        isNull(financeDebtPayments.deletedAt),
      ))
      .limit(1);
    if (!rows[0]) throw financeError('Debt payment not found', 404, 'NOT_FOUND');
    return rows[0];
  }
}
