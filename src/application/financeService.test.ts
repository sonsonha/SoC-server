import { describe, expect, it } from 'vitest';
import {
  allocateAmountVnd,
  monthBounds,
  rescaleAllocations,
} from './financeService.js';

describe('allocateAmountVnd (6 buckets)', () => {
  it('splits 10_000_000 with 40/5/30/10/10/5 and sums to total', () => {
    const rows = allocateAmountVnd(10_000_000, {
      livingPct: 40,
      safetyPct: 5,
      investingPct: 30,
      opportunityPct: 10,
      learningPct: 10,
      funPct: 5,
    });
    expect(rows.find((r) => r.bucket === 'LIVING')?.amountVnd).toBe(4_000_000);
    expect(rows.find((r) => r.bucket === 'SAFETY')?.amountVnd).toBe(500_000);
    expect(rows.find((r) => r.bucket === 'INVESTING')?.amountVnd).toBe(3_000_000);
    expect(rows.find((r) => r.bucket === 'OPPORTUNITY')?.amountVnd).toBe(1_000_000);
    expect(rows.find((r) => r.bucket === 'LEARNING')?.amountVnd).toBe(1_000_000);
    expect(rows.find((r) => r.bucket === 'FUN')?.amountVnd).toBe(500_000);
    expect(rows).toHaveLength(6);
    expect(rows.reduce((s, r) => s + r.amountVnd, 0)).toBe(10_000_000);
  });

  it('puts remainder on Fun for awkward amounts', () => {
    const rows = allocateAmountVnd(100, {
      livingPct: 40,
      safetyPct: 5,
      investingPct: 30,
      opportunityPct: 10,
      learningPct: 10,
      funPct: 5,
    });
    expect(rows.reduce((s, r) => s + r.amountVnd, 0)).toBe(100);
    expect(rows.find((r) => r.bucket === 'LIVING')?.amountVnd).toBe(40);
  });

  it('rejects percentages that do not sum to 100', () => {
    expect(() =>
      allocateAmountVnd(1000, {
        livingPct: 40,
        safetyPct: 5,
        investingPct: 30,
        opportunityPct: 10,
        learningPct: 10,
        funPct: 0,
      }),
    ).toThrow(/100/);
  });
});

describe('rescaleAllocations', () => {
  it('preserves pcts when income amount changes', () => {
    const rows = rescaleAllocations(20_000_000, [
      { bucket: 'LIVING', pctApplied: 40 },
      { bucket: 'SAFETY', pctApplied: 5 },
      { bucket: 'INVESTING', pctApplied: 30 },
      { bucket: 'OPPORTUNITY', pctApplied: 10 },
      { bucket: 'LEARNING', pctApplied: 10 },
      { bucket: 'FUN', pctApplied: 5 },
    ]);
    expect(rows.find((r) => r.bucket === 'LIVING')?.amountVnd).toBe(8_000_000);
    expect(rows.reduce((s, r) => s + r.amountVnd, 0)).toBe(20_000_000);
  });

  it('maps legacy COMPOUND to INVESTING', () => {
    const rows = rescaleAllocations(10_000_000, [
      { bucket: 'LIVING', pctApplied: 40 },
      { bucket: 'SAFETY', pctApplied: 5 },
      { bucket: 'COMPOUND', pctApplied: 30 },
      { bucket: 'OPPORTUNITY', pctApplied: 10 },
      { bucket: 'LEARNING', pctApplied: 10 },
      { bucket: 'FUN', pctApplied: 5 },
    ]);
    expect(rows.find((r) => r.bucket === 'INVESTING')?.amountVnd).toBe(3_000_000);
  });
});

describe('monthBounds', () => {
  it('computes September 2026 bounds and previous month', () => {
    const b = monthBounds('2026-09');
    expect(b.start).toBe('2026-09-01');
    expect(b.end).toBe('2026-09-30');
    expect(b.prevMonth).toBe('2026-08');
  });
});
