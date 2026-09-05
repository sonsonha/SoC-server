import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
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
import {
  allocateAmountVnd,
  canonicalizeBucket,
  monthBounds,
  todayInHoChiMinh,
  type FinanceBucket,
} from './financeService.js';

export type AnalyticsGrain = 'week' | 'month' | 'quarter' | 'year';

const BUCKETS: FinanceBucket[] = ['LIVING', 'SAFETY', 'GROWTH', 'FUN'];

function financeError(message: string, statusCode = 400, code = 'INVALID_INPUT') {
  return Object.assign(new Error(message), { statusCode, code });
}

function emptyBuckets(): Record<FinanceBucket, number> {
  return { LIVING: 0, SAFETY: 0, GROWTH: 0, FUN: 0 };
}

function pctOf(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return Math.round((part * 1000) / whole) / 10;
}

function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) * 1000) / previous) / 10;
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function daysInclusive(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

/** Monday-start ISO week containing the given Asia/Ho_Chi_Minh calendar day. */
export function weekBounds(anchorDate: string): { start: string; end: string; label: string; periodKey: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) {
    throw financeError('week period must be YYYY-MM-DD');
  }
  const [y, m, d] = anchorDate.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 Sun
  const offsetToMon = dow === 0 ? -6 : 1 - dow;
  const start = addDays(anchorDate, offsetToMon);
  const end = addDays(start, 6);
  return {
    start,
    end,
    label: `${start} – ${end}`,
    periodKey: start,
  };
}

export function quarterBounds(periodKey: string): { start: string; end: string; label: string; periodKey: string } {
  // YYYY-Qn or YYYY-MM (derive quarter)
  let year: number;
  let q: number;
  const qMatch = /^(\d{4})-Q([1-4])$/i.exec(periodKey);
  const mMatch = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (qMatch) {
    year = Number(qMatch[1]);
    q = Number(qMatch[2]);
  } else if (mMatch) {
    year = Number(mMatch[1]);
    q = Math.ceil(Number(mMatch[2]) / 3);
  } else {
    throw financeError('quarter period must be YYYY-Qn or YYYY-MM');
  }
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const start = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  const end = `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end, label: `Q${q} ${year}`, periodKey: `${year}-Q${q}` };
}

export function yearBounds(periodKey: string): { start: string; end: string; label: string; periodKey: string } {
  const yMatch = /^(\d{4})$/.exec(periodKey) ?? /^(\d{4})-\d{2}$/.exec(periodKey);
  if (!yMatch) throw financeError('year period must be YYYY or YYYY-MM');
  const year = Number(yMatch[1]);
  return {
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    label: String(year),
    periodKey: String(year),
  };
}

export function resolvePeriod(
  grain: AnalyticsGrain,
  periodKey: string | undefined,
): {
  grain: AnalyticsGrain;
  periodKey: string;
  label: string;
  start: string;
  end: string;
  seriesGrain: 'day' | 'month';
} {
  const today = todayInHoChiMinh();
  if (grain === 'week') {
    const key = periodKey && /^\d{4}-\d{2}-\d{2}$/.test(periodKey) ? periodKey : today;
    const b = weekBounds(key);
    return { grain, periodKey: b.periodKey, label: b.label, start: b.start, end: b.end, seriesGrain: 'day' };
  }
  if (grain === 'month') {
    const key = periodKey && /^\d{4}-\d{2}$/.test(periodKey) ? periodKey : today.slice(0, 7);
    const b = monthBounds(key);
    const [y, m] = key.split('-').map(Number) as [number, number];
    const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return {
      grain,
      periodKey: key,
      label: monthName,
      start: b.start,
      end: b.end,
      seriesGrain: 'day',
    };
  }
  if (grain === 'quarter') {
    const key = periodKey ?? `${today.slice(0, 4)}-Q${Math.ceil(Number(today.slice(5, 7)) / 3)}`;
    const b = quarterBounds(key);
    return { grain, periodKey: b.periodKey, label: b.label, start: b.start, end: b.end, seriesGrain: 'month' };
  }
  const key = periodKey ?? today.slice(0, 4);
  const b = yearBounds(key);
  return { grain, periodKey: b.periodKey, label: b.label, start: b.start, end: b.end, seriesGrain: 'month' };
}

export function shiftPeriod(grain: AnalyticsGrain, periodKey: string, delta: number): string {
  if (grain === 'week') {
    return addDays(periodKey, delta * 7);
  }
  if (grain === 'month') {
    const [y, m] = periodKey.split('-').map(Number) as [number, number];
    const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (grain === 'quarter') {
    const b = quarterBounds(periodKey);
    const q = Number(b.periodKey.slice(-1));
    const y = Number(b.periodKey.slice(0, 4));
    let nq = q + delta;
    let ny = y;
    while (nq > 4) { nq -= 4; ny += 1; }
    while (nq < 1) { nq += 4; ny -= 1; }
    return `${ny}-Q${nq}`;
  }
  return String(Number(yearBounds(periodKey).periodKey) + delta);
}

export function previousPeriodKey(grain: AnalyticsGrain, periodKey: string): string {
  return shiftPeriod(grain, periodKey, -1);
}

function growthGroupForCategory(name: string): string {
  const n = name.toLowerCase();
  if (/invest|etf|stock|fund/.test(n)) return 'Investment';
  if (/educat|book|course|learn|ielts|cert|tutor|workshop|conference/.test(n)) return 'Learning';
  if (/experiment|mvp|product|ads|api credit|business/.test(n)) return 'Product / Business Experiments';
  if (/career|interview/.test(n)) return 'Career';
  if (/tool|equipment|hardware|laptop/.test(n)) return 'Tools / Equipment';
  return 'Other Growth';
}

export function buildInsights(input: {
  incomeVnd: number;
  planVsActual: Array<{
    bucket: FinanceBucket;
    targetVnd: number;
    allocatedVnd: number;
    usedExpenseVnd: number;
  }>;
  safetyRunwayMonths: number | null;
  safetyTargetMonths: number;
  debtPaidVnd: number;
  outstandingDebtDeltaVnd: number;
  incomeConcentrationPct: number | null;
  prevGrowthAllocatedVnd: number;
  growthAllocatedVnd: number;
}): string[] {
  const out: string[] = [];
  for (const row of input.planVsActual) {
    if (row.bucket === 'LIVING' && row.targetVnd > 0 && row.usedExpenseVnd > row.targetVnd) {
      const over = Math.round(((row.usedExpenseVnd - row.targetVnd) * 1000) / row.targetVnd) / 10;
      if (over >= 10) {
        out.push(`Living spending is ${over}% above its target allocation this period.`);
      }
    }
    if (row.bucket === 'FUN' && row.allocatedVnd > 0) {
      const usedPct = Math.round((row.usedExpenseVnd * 1000) / row.allocatedVnd) / 10;
      if (usedPct >= 90) {
        out.push(`Fun spending has used ${usedPct}% of this period's allocation.`);
      }
    }
  }
  if (input.safetyRunwayMonths != null) {
    out.push(
      `Safety balance covers approximately ${input.safetyRunwayMonths.toFixed(1)} months of core spending`
        + (input.safetyRunwayMonths < input.safetyTargetMonths
          ? ` (target ${input.safetyTargetMonths} months).`
          : '.'),
    );
  }
  if (input.prevGrowthAllocatedVnd > 0) {
    const d = deltaPct(input.growthAllocatedVnd, input.prevGrowthAllocatedVnd);
    if (d != null && Math.abs(d) >= 10) {
      out.push(
        `Growth allocation is ${Math.abs(d)}% ${d >= 0 ? 'higher' : 'lower'} than the previous period.`,
      );
    }
  }
  if (input.outstandingDebtDeltaVnd !== 0) {
    const abs = Math.abs(input.outstandingDebtDeltaVnd).toLocaleString('en-US');
    out.push(
      input.outstandingDebtDeltaVnd < 0
        ? `Debt decreased by ${abs} VND this period.`
        : `Outstanding debt increased by ${abs} VND vs opening estimate.`,
    );
  }
  if (input.incomeConcentrationPct != null && input.incomeConcentrationPct >= 70) {
    out.push(`${input.incomeConcentrationPct}% of income this period came from one source.`);
  }
  return out.slice(0, 5);
}

export class FinanceAnalyticsService {
  constructor(private readonly db: Db) {}

  async getAnalytics(
    userId: string,
    opts: { grain?: AnalyticsGrain; period?: string } = {},
  ) {
    const grain = opts.grain ?? 'month';
    if (!['week', 'month', 'quarter', 'year'].includes(grain)) {
      throw financeError('grain must be week|month|quarter|year');
    }
    const period = resolvePeriod(grain, opts.period);
    const prevKey = previousPeriodKey(grain, period.periodKey);
    const prevPeriod = resolvePeriod(grain, prevKey);

    const settingsRows = await this.db
      .select()
      .from(financeAllocationSettings)
      .where(and(
        eq(financeAllocationSettings.userId, userId),
        isNull(financeAllocationSettings.deletedAt),
      ))
      .limit(1);
    const settings = settingsRows[0];
    const safetyTargetMonths = settings?.safetyTargetMonths ?? 6;

    const [
      incomes,
      allocations,
      expenses,
      payments,
      allAllocations,
      allExpenses,
      allPayments,
      debts,
      prevIncomes,
      prevAllocations,
      prevExpenses,
      prevPayments,
      sources,
      categories,
    ] = await Promise.all([
      this.db.select().from(financeIncomeEntries).where(and(
        eq(financeIncomeEntries.userId, userId),
        isNull(financeIncomeEntries.deletedAt),
        gte(financeIncomeEntries.receivedAt, period.start),
        lte(financeIncomeEntries.receivedAt, period.end),
      )),
      this.db.select({
        alloc: financeIncomeAllocations,
        receivedAt: financeIncomeEntries.receivedAt,
      }).from(financeIncomeAllocations)
        .innerJoin(financeIncomeEntries, eq(financeIncomeAllocations.incomeEntryId, financeIncomeEntries.id))
        .where(and(
          eq(financeIncomeAllocations.userId, userId),
          isNull(financeIncomeAllocations.deletedAt),
          isNull(financeIncomeEntries.deletedAt),
          gte(financeIncomeEntries.receivedAt, period.start),
          lte(financeIncomeEntries.receivedAt, period.end),
        )),
      this.db.select({
        entry: financeExpenseEntries,
        categoryName: financeExpenseCategories.name,
        categoryKind: financeExpenseCategories.kind,
        recurrence: financeExpenseCategories.recurrence,
        defaultBucket: financeExpenseCategories.defaultBucket,
      }).from(financeExpenseEntries)
        .innerJoin(financeExpenseCategories, eq(financeExpenseEntries.categoryId, financeExpenseCategories.id))
        .where(and(
          eq(financeExpenseEntries.userId, userId),
          isNull(financeExpenseEntries.deletedAt),
          gte(financeExpenseEntries.spentAt, period.start),
          lte(financeExpenseEntries.spentAt, period.end),
        )),
      this.db.select().from(financeDebtPayments).where(and(
        eq(financeDebtPayments.userId, userId),
        isNull(financeDebtPayments.deletedAt),
        gte(financeDebtPayments.paidAt, period.start),
        lte(financeDebtPayments.paidAt, period.end),
      )),
      this.db.select().from(financeIncomeAllocations).where(and(
        eq(financeIncomeAllocations.userId, userId),
        isNull(financeIncomeAllocations.deletedAt),
      )),
      this.db.select().from(financeExpenseEntries).where(and(
        eq(financeExpenseEntries.userId, userId),
        isNull(financeExpenseEntries.deletedAt),
      )),
      this.db.select().from(financeDebtPayments).where(and(
        eq(financeDebtPayments.userId, userId),
        isNull(financeDebtPayments.deletedAt),
      )),
      this.db.select().from(financeDebts).where(and(
        eq(financeDebts.userId, userId),
        isNull(financeDebts.deletedAt),
        eq(financeDebts.active, true),
      )),
      this.db.select().from(financeIncomeEntries).where(and(
        eq(financeIncomeEntries.userId, userId),
        isNull(financeIncomeEntries.deletedAt),
        gte(financeIncomeEntries.receivedAt, prevPeriod.start),
        lte(financeIncomeEntries.receivedAt, prevPeriod.end),
      )),
      this.db.select({
        alloc: financeIncomeAllocations,
      }).from(financeIncomeAllocations)
        .innerJoin(financeIncomeEntries, eq(financeIncomeAllocations.incomeEntryId, financeIncomeEntries.id))
        .where(and(
          eq(financeIncomeAllocations.userId, userId),
          isNull(financeIncomeAllocations.deletedAt),
          isNull(financeIncomeEntries.deletedAt),
          gte(financeIncomeEntries.receivedAt, prevPeriod.start),
          lte(financeIncomeEntries.receivedAt, prevPeriod.end),
        )),
      this.db.select({
        entry: financeExpenseEntries,
        categoryName: financeExpenseCategories.name,
        categoryKind: financeExpenseCategories.kind,
        recurrence: financeExpenseCategories.recurrence,
        defaultBucket: financeExpenseCategories.defaultBucket,
      }).from(financeExpenseEntries)
        .innerJoin(financeExpenseCategories, eq(financeExpenseEntries.categoryId, financeExpenseCategories.id))
        .where(and(
          eq(financeExpenseEntries.userId, userId),
          isNull(financeExpenseEntries.deletedAt),
          gte(financeExpenseEntries.spentAt, prevPeriod.start),
          lte(financeExpenseEntries.spentAt, prevPeriod.end),
        )),
      this.db.select().from(financeDebtPayments).where(and(
        eq(financeDebtPayments.userId, userId),
        isNull(financeDebtPayments.deletedAt),
        gte(financeDebtPayments.paidAt, prevPeriod.start),
        lte(financeDebtPayments.paidAt, prevPeriod.end),
      )),
      this.db.select().from(financeIncomeSources).where(and(
        eq(financeIncomeSources.userId, userId),
        isNull(financeIncomeSources.deletedAt),
      )),
      this.db.select().from(financeExpenseCategories).where(and(
        eq(financeExpenseCategories.userId, userId),
        isNull(financeExpenseCategories.deletedAt),
      )),
    ]);

    const incomeVnd = incomes.reduce((s, r) => s + r.amountVnd, 0);
    const spendingVnd = expenses.reduce((s, r) => s + r.entry.amountVnd, 0);
    const debtPaidVnd = payments.reduce((s, r) => s + r.amountVnd, 0);
    const netCashflowVnd = incomeVnd - spendingVnd - debtPaidVnd;

    const target = emptyBuckets();
    for (const inc of incomes) {
      const rows = allocateAmountVnd(inc.amountVnd, {
        livingPct: inc.policyLivingPct,
        safetyPct: inc.policySafetyPct,
        growthPct: inc.policyGrowthPct,
        funPct: inc.policyFunPct,
      });
      for (const r of rows) target[r.bucket] += r.amountVnd;
    }

    const allocated = emptyBuckets();
    for (const row of allocations) {
      const b = canonicalizeBucket(row.alloc.bucket);
      if (b) allocated[b] += row.alloc.amountVnd;
    }

    const usedExpense = emptyBuckets();
    for (const row of expenses) {
      const b = canonicalizeBucket(row.entry.fundingBucket);
      if (b) usedExpense[b] += row.entry.amountVnd;
    }

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
    const lifetimeDebt = allPayments.reduce((s, p) => s + p.amountVnd, 0);
    lifetimeSpent.LIVING += lifetimeDebt;

    // Transfers not implemented — always 0
    const reallocIn = emptyBuckets();
    const reallocOut = emptyBuckets();

    const planVsActual = BUCKETS.map((bucket) => {
      const targetVnd = target[bucket];
      const allocatedVnd = allocated[bucket];
      const usedExpenseVnd = usedExpense[bucket];
      const debtWithdrawalsVnd = bucket === 'LIVING' ? debtPaidVnd : 0;
      const netChangeVnd = allocatedVnd + reallocIn[bucket] - reallocOut[bucket]
        - usedExpenseVnd - debtWithdrawalsVnd;
      return {
        bucket,
        targetVnd,
        targetPctOfIncome: pctOf(targetVnd, incomeVnd),
        allocatedVnd,
        allocatedPctOfIncome: pctOf(allocatedVnd, incomeVnd),
        usedExpenseVnd,
        usagePctOfIncome: pctOf(usedExpenseVnd, incomeVnd),
        varianceVsAllocationVnd: allocatedVnd - usedExpenseVnd,
        varianceVsTargetVnd: allocatedVnd - targetVnd,
        incomeAllocatedVnd: allocatedVnd,
        reallocInVnd: reallocIn[bucket],
        reallocOutVnd: reallocOut[bucket],
        debtWithdrawalsVnd,
        netChangeVnd,
        lifetimeBalanceVnd: lifetimeAllocated[bucket] - lifetimeSpent[bucket],
      };
    });

    const sourceName = new Map(sources.map((s) => [s.id, s.name]));
    const incomeBySourceMap = new Map<string, { sourceId: string; name: string; amountVnd: number }>();
    for (const inc of incomes) {
      const cur = incomeBySourceMap.get(inc.sourceId) ?? {
        sourceId: inc.sourceId,
        name: sourceName.get(inc.sourceId) ?? 'Unknown',
        amountVnd: 0,
      };
      cur.amountVnd += inc.amountVnd;
      incomeBySourceMap.set(inc.sourceId, cur);
    }
    const incomeBySource = [...incomeBySourceMap.values()]
      .map((r) => ({
        ...r,
        pctOfIncome: pctOf(r.amountVnd, incomeVnd),
      }))
      .sort((a, b) => b.amountVnd - a.amountVnd);

    const prevIncomeBySource = new Map<string, number>();
    for (const inc of prevIncomes) {
      prevIncomeBySource.set(inc.sourceId, (prevIncomeBySource.get(inc.sourceId) ?? 0) + inc.amountVnd);
    }

    const incomeBySourceWithDelta = incomeBySource.map((r) => {
      const prev = prevIncomeBySource.get(r.sourceId) ?? 0;
      return {
        ...r,
        previousAmountVnd: prev,
        deltaVnd: r.amountVnd - prev,
        deltaPct: deltaPct(r.amountVnd, prev),
      };
    });

    const maxSource = incomeBySource[0]?.amountVnd ?? 0;
    const incomeConcentrationPct = pctOf(maxSource, incomeVnd);

    const byCategoryMap = new Map<string, {
      categoryId: string;
      name: string;
      amountVnd: number;
      kind: string;
      recurrence: string;
    }>();
    for (const row of expenses) {
      const key = row.entry.categoryId;
      const cur = byCategoryMap.get(key) ?? {
        categoryId: key,
        name: row.categoryName,
        amountVnd: 0,
        kind: row.categoryKind,
        recurrence: row.recurrence,
      };
      cur.amountVnd += row.entry.amountVnd;
      byCategoryMap.set(key, cur);
    }
    const prevByCategory = new Map<string, number>();
    for (const row of prevExpenses) {
      prevByCategory.set(
        row.entry.categoryId,
        (prevByCategory.get(row.entry.categoryId) ?? 0) + row.entry.amountVnd,
      );
    }
    const spendingByCategory = [...byCategoryMap.values()]
      .map((r) => {
        const prev = prevByCategory.get(r.categoryId) ?? 0;
        return {
          ...r,
          pctOfExpenses: pctOf(r.amountVnd, spendingVnd),
          previousAmountVnd: prev,
          deltaVnd: r.amountVnd - prev,
          deltaPct: deltaPct(r.amountVnd, prev),
        };
      })
      .sort((a, b) => b.amountVnd - a.amountVnd);

    const growthGroupMap = new Map<string, number>();
    for (const row of expenses) {
      if (canonicalizeBucket(row.entry.fundingBucket) !== 'GROWTH') continue;
      const group = growthGroupForCategory(row.categoryName);
      growthGroupMap.set(group, (growthGroupMap.get(group) ?? 0) + row.entry.amountVnd);
    }
    const growthBreakdown = [...growthGroupMap.entries()]
      .map(([group, amountVnd]) => ({
        group,
        amountVnd,
        pctOfGrowthUsage: pctOf(amountVnd, usedExpense.GROWTH),
      }))
      .sort((a, b) => b.amountVnd - a.amountVnd);

    // Core burn: Fixed Essential (Living) in period + 3-month avg Variable Essential
    const catById = new Map(categories.map((c) => [c.id, c]));
    const isFixedEssentialLiving = (kind: string, recurrence: string, funding: string) => {
      const b = canonicalizeBucket(funding);
      if (b !== 'LIVING') return false;
      if (recurrence === 'FIXED') return kind === 'FIXED' || kind === 'ESSENTIAL' || kind === 'OTHER';
      // Approximate: FIXED kind treated as fixed essential for Living
      return kind === 'FIXED';
    };
    const isVarEssentialLiving = (kind: string, recurrence: string, funding: string) => {
      const b = canonicalizeBucket(funding);
      if (b !== 'LIVING') return false;
      if (recurrence === 'VARIABLE' && kind === 'ESSENTIAL') return true;
      return kind === 'ESSENTIAL' && recurrence !== 'FIXED';
    };

    let fixedEssentialVnd = 0;
    for (const row of expenses) {
      if (isFixedEssentialLiving(row.categoryKind, row.recurrence, row.entry.fundingBucket)) {
        fixedEssentialVnd += row.entry.amountVnd;
      }
    }

    // Last 3 full calendar months before period.end's month (or including current for month grain)
    const endMonth = period.end.slice(0, 7);
    const varEssentialMonths: number[] = [];
    for (let i = 0; i < 3; i++) {
      const mk = shiftPeriod('month', endMonth, -i);
      const mb = monthBounds(mk);
      let sum = 0;
      for (const row of allExpenses) {
        const spent = String(row.spentAt);
        if (spent < mb.start || spent > mb.end) continue;
        const cat = catById.get(row.categoryId);
        const kind = cat?.kind ?? 'OTHER';
        const recurrence = cat?.recurrence ?? 'VARIABLE';
        if (isVarEssentialLiving(kind, recurrence, row.fundingBucket)) {
          sum += row.amountVnd;
        }
      }
      varEssentialMonths.push(sum);
    }
    const varEssentialAvg = varEssentialMonths.length
      ? Math.round(varEssentialMonths.reduce((a, b) => a + b, 0) / varEssentialMonths.length)
      : 0;
    const coreMonthlyBurnVnd = fixedEssentialVnd + varEssentialAvg;
    const safetyBalanceVnd = lifetimeAllocated.SAFETY - lifetimeSpent.SAFETY;
    const safetyRunwayMonths = coreMonthlyBurnVnd > 0
      ? Math.round((safetyBalanceVnd * 10) / coreMonthlyBurnVnd) / 10
      : null;
    const safetyTargetAmountVnd = coreMonthlyBurnVnd * safetyTargetMonths;
    const safetyTargetProgressPct = safetyTargetAmountVnd > 0
      ? Math.round((safetyBalanceVnd * 1000) / safetyTargetAmountVnd) / 10
      : null;

    const outstandingDebtVnd = debts.reduce((s, d) => s + d.outstandingVnd, 0);
    const monthlyDebtRequiredVnd = debts.reduce((s, d) => s + d.monthlyRequiredVnd, 0);
    // Opening ≈ closing + payments (no new-debt events)
    const openingDebtVnd = outstandingDebtVnd + debtPaidVnd;
    const debtRemainingRequiredVnd = Math.max(0, monthlyDebtRequiredVnd - debtPaidVnd);

    const mandatoryFixedVnd = fixedEssentialVnd;
    const mandatoryObligationsVnd = monthlyDebtRequiredVnd + mandatoryFixedVnd;
    const projectedSurplusVnd = incomeVnd - mandatoryObligationsVnd;

    const prevIncomeVnd = prevIncomes.reduce((s, r) => s + r.amountVnd, 0);
    const prevSpendingVnd = prevExpenses.reduce((s, r) => s + r.entry.amountVnd, 0);
    const prevDebtPaidVnd = prevPayments.reduce((s, r) => s + r.amountVnd, 0);
    const prevAllocated = emptyBuckets();
    for (const row of prevAllocations) {
      const b = canonicalizeBucket(row.alloc.bucket);
      if (b) prevAllocated[b] += row.alloc.amountVnd;
    }
    const prevUsed = emptyBuckets();
    for (const row of prevExpenses) {
      const b = canonicalizeBucket(row.entry.fundingBucket);
      if (b) prevUsed[b] += row.entry.amountVnd;
    }

    const compareMetric = (current: number, previous: number) => ({
      currentVnd: current,
      previousVnd: previous,
      deltaVnd: current - previous,
      deltaPct: deltaPct(current, previous),
    });

    const comparison = {
      periodKey: period.periodKey,
      previousPeriodKey: prevPeriod.periodKey,
      previousLabel: prevPeriod.label,
      income: compareMetric(incomeVnd, prevIncomeVnd),
      expenses: compareMetric(spendingVnd, prevSpendingVnd),
      debtPaid: compareMetric(debtPaidVnd, prevDebtPaidVnd),
      netCashflow: compareMetric(netCashflowVnd, prevIncomeVnd - prevSpendingVnd - prevDebtPaidVnd),
      livingUsage: compareMetric(usedExpense.LIVING, prevUsed.LIVING),
      growthAllocated: compareMetric(allocated.GROWTH, prevAllocated.GROWTH),
      funUsage: compareMetric(usedExpense.FUN, prevUsed.FUN),
    };

    // Cashflow trend series
    const series: Array<{
      key: string;
      label: string;
      incomeVnd: number;
      expensesVnd: number;
      debtPaidVnd: number;
      netCashflowVnd: number;
    }> = [];

    if (period.seriesGrain === 'day') {
      const n = daysInclusive(period.start, period.end);
      for (let i = 0; i < n; i++) {
        const day = addDays(period.start, i);
        const dayIncome = incomes.filter((r) => String(r.receivedAt) === day)
          .reduce((s, r) => s + r.amountVnd, 0);
        const dayExp = expenses.filter((r) => String(r.entry.spentAt) === day)
          .reduce((s, r) => s + r.entry.amountVnd, 0);
        const dayDebt = payments.filter((r) => String(r.paidAt) === day)
          .reduce((s, r) => s + r.amountVnd, 0);
        series.push({
          key: day,
          label: day.slice(5),
          incomeVnd: dayIncome,
          expensesVnd: dayExp,
          debtPaidVnd: dayDebt,
          netCashflowVnd: dayIncome - dayExp - dayDebt,
        });
      }
    } else {
      // monthly points from start to end
      let mk = period.start.slice(0, 7);
      const endMk = period.end.slice(0, 7);
      while (mk <= endMk) {
        const mb = monthBounds(mk);
        const mIncome = incomes.filter((r) => {
          const d = String(r.receivedAt);
          return d >= mb.start && d <= mb.end;
        }).reduce((s, r) => s + r.amountVnd, 0);
        const mExp = expenses.filter((r) => {
          const d = String(r.entry.spentAt);
          return d >= mb.start && d <= mb.end;
        }).reduce((s, r) => s + r.entry.amountVnd, 0);
        const mDebt = payments.filter((r) => {
          const d = String(r.paidAt);
          return d >= mb.start && d <= mb.end;
        }).reduce((s, r) => s + r.amountVnd, 0);
        series.push({
          key: mk,
          label: mk,
          incomeVnd: mIncome,
          expensesVnd: mExp,
          debtPaidVnd: mDebt,
          netCashflowVnd: mIncome - mExp - mDebt,
        });
        mk = shiftPeriod('month', mk, 1);
      }
    }

    // Debt trend for quarter/year: outstanding is point-in-time; expose payment series only
    const debtTrend = series.map((s) => ({
      key: s.key,
      label: s.label,
      debtPaidVnd: s.debtPaidVnd,
    }));

    const rates = {
      livingUsageRatePct: pctOf(usedExpense.LIVING, incomeVnd),
      growthAllocationRatePct: pctOf(allocated.GROWTH, incomeVnd),
      growthUsageRatePct: pctOf(usedExpense.GROWTH, incomeVnd),
      safetyAllocationRatePct: pctOf(allocated.SAFETY, incomeVnd),
      funUsageRatePct: pctOf(usedExpense.FUN, incomeVnd),
    };

    const insights = buildInsights({
      incomeVnd,
      planVsActual,
      safetyRunwayMonths,
      safetyTargetMonths,
      debtPaidVnd,
      outstandingDebtDeltaVnd: outstandingDebtVnd - openingDebtVnd,
      incomeConcentrationPct,
      prevGrowthAllocatedVnd: prevAllocated.GROWTH,
      growthAllocatedVnd: allocated.GROWTH,
    });

    // Week pace vs enclosing month (optional signal)
    let weekPace: {
      enclosingMonth: string;
      monthElapsedPct: number | null;
      livingUsedOfMonthAllocatedPct: number | null;
    } | null = null;
    if (grain === 'week') {
      const enclosingMonth = period.start.slice(0, 7);
      const mb = monthBounds(enclosingMonth);
      const monthDays = daysInclusive(mb.start, mb.end);
      const elapsedDays = daysInclusive(mb.start, period.end <= mb.end ? period.end : mb.end);
      const monthElapsedPct = Math.round((elapsedDays * 1000) / monthDays) / 10;
      // Month living allocation from all incomes in month — approximate with period allocated scaled? fetch not done; skip heavy
      weekPace = {
        enclosingMonth,
        monthElapsedPct,
        livingUsedOfMonthAllocatedPct: null,
      };
    }

    return {
      grain: period.grain,
      periodKey: period.periodKey,
      label: period.label,
      start: period.start,
      end: period.end,
      previousPeriodKey: prevPeriod.periodKey,
      currency: settings?.currency ?? 'VND',
      summary: {
        incomeVnd,
        expensesVnd: spendingVnd,
        debtPaidVnd,
        netCashflowVnd,
        livingUsageVnd: usedExpense.LIVING,
        growthUsageVnd: usedExpense.GROWTH,
        safetyAllocatedVnd: allocated.SAFETY,
        funUsageVnd: usedExpense.FUN,
      },
      planVsActual,
      rates,
      spendingByCategory,
      growthBreakdown,
      incomeBySource: incomeBySourceWithDelta,
      incomeConcentrationPct,
      cashflowTrend: {
        seriesGrain: period.seriesGrain,
        points: series,
      },
      debt: {
        openingOutstandingVnd: openingDebtVnd,
        paymentsVnd: debtPaidVnd,
        closingOutstandingVnd: outstandingDebtVnd,
        monthlyRequiredVnd: monthlyDebtRequiredVnd,
        remainingRequiredVnd: debtRemainingRequiredVnd,
        /** Assumption: opening = closing + payments (new debt events not tracked). */
        openingAssumption: 'closing_plus_payments' as const,
        trend: debtTrend,
      },
      resilience: {
        coreMonthlyBurnVnd,
        fixedEssentialVnd,
        variableEssentialAvgVnd: varEssentialAvg,
        safetyBalanceVnd,
        safetyTargetMonths,
        safetyTargetAmountVnd,
        safetyRunwayMonths,
        safetyTargetProgressPct,
        mandatoryObligationsVnd,
        projectedSurplusVnd,
      },
      comparison,
      insights,
      weekPace,
      navigation: {
        previousPeriodKey: prevKey,
        nextPeriodKey: shiftPeriod(grain, period.periodKey, 1),
        currentPeriodKey: resolvePeriod(grain, undefined).periodKey,
      },
    };
  }
}
