import { describe, expect, it } from 'vitest';
import {
  buildInsights,
  previousPeriodKey,
  quarterBounds,
  resolvePeriod,
  shiftPeriod,
  weekBounds,
  yearBounds,
} from './financeAnalyticsService.js';

describe('analytics period bounds', () => {
  it('resolves ISO week Mon–Sun', () => {
    // 2026-09-05 is Saturday → week Sep 1–7
    const b = weekBounds('2026-09-05');
    expect(b.start).toBe('2026-08-31'); // Monday of that week
    expect(b.end).toBe('2026-09-06');
  });

  it('resolves quarter from YYYY-Qn', () => {
    const b = quarterBounds('2026-Q3');
    expect(b.start).toBe('2026-07-01');
    expect(b.end).toBe('2026-09-30');
    expect(b.label).toBe('Q3 2026');
  });

  it('resolves year', () => {
    const b = yearBounds('2026');
    expect(b.start).toBe('2026-01-01');
    expect(b.end).toBe('2026-12-31');
  });

  it('shifts periods', () => {
    expect(shiftPeriod('month', '2026-09', -1)).toBe('2026-08');
    expect(shiftPeriod('quarter', '2026-Q1', -1)).toBe('2025-Q4');
    expect(shiftPeriod('year', '2026', 1)).toBe('2027');
  });

  it('resolvePeriod defaults month', () => {
    const p = resolvePeriod('month', '2026-09');
    expect(p.start).toBe('2026-09-01');
    expect(p.end).toBe('2026-09-30');
    expect(previousPeriodKey('month', p.periodKey)).toBe('2026-08');
  });
});

describe('buildInsights', () => {
  it('emits factual living overrun and runway', () => {
    const insights = buildInsights({
      incomeVnd: 20_000_000,
      planVsActual: [
        {
          bucket: 'LIVING',
          targetVnd: 10_000_000,
          allocatedVnd: 10_000_000,
          usedExpenseVnd: 12_000_000,
        },
        {
          bucket: 'FUN',
          targetVnd: 1_000_000,
          allocatedVnd: 1_000_000,
          usedExpenseVnd: 950_000,
        },
        {
          bucket: 'SAFETY',
          targetVnd: 3_000_000,
          allocatedVnd: 3_000_000,
          usedExpenseVnd: 0,
        },
        {
          bucket: 'GROWTH',
          targetVnd: 6_000_000,
          allocatedVnd: 6_000_000,
          usedExpenseVnd: 1_000_000,
        },
      ],
      safetyRunwayMonths: 2.8,
      safetyTargetMonths: 6,
      debtPaidVnd: 1_000_000,
      outstandingDebtDeltaVnd: -1_000_000,
      incomeConcentrationPct: 90,
      prevGrowthAllocatedVnd: 5_000_000,
      growthAllocatedVnd: 6_000_000,
    });
    expect(insights.some((s) => /Living spending is 20% above/.test(s))).toBe(true);
    expect(insights.some((s) => /2\.8 months/.test(s))).toBe(true);
    expect(insights.length).toBeLessThanOrEqual(5);
  });

  it('suppresses living insight under 10% overrun', () => {
    const insights = buildInsights({
      incomeVnd: 10_000_000,
      planVsActual: [
        {
          bucket: 'LIVING',
          targetVnd: 5_000_000,
          allocatedVnd: 5_000_000,
          usedExpenseVnd: 5_200_000,
        },
      ],
      safetyRunwayMonths: null,
      safetyTargetMonths: 6,
      debtPaidVnd: 0,
      outstandingDebtDeltaVnd: 0,
      incomeConcentrationPct: null,
      prevGrowthAllocatedVnd: 0,
      growthAllocatedVnd: 0,
    });
    expect(insights.some((s) => /Living/.test(s))).toBe(false);
  });
});
