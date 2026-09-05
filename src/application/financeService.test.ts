import { describe, expect, it } from 'vitest';
import {
  allocateAmountVnd,
  monthBounds,
  rescaleAllocations,
} from './financeService.js';

describe('allocateAmountVnd', () => {
  it('splits 10_000_000 with 55/15/20/10 and sums to total', () => {
    const rows = allocateAmountVnd(10_000_000, {
      livingPct: 55,
      safetyPct: 15,
      compoundPct: 20,
      opportunityPct: 10,
    });
    expect(rows.find((r) => r.bucket === 'LIVING')?.amountVnd).toBe(5_500_000);
    expect(rows.find((r) => r.bucket === 'SAFETY')?.amountVnd).toBe(1_500_000);
    expect(rows.find((r) => r.bucket === 'COMPOUND')?.amountVnd).toBe(2_000_000);
    expect(rows.find((r) => r.bucket === 'OPPORTUNITY')?.amountVnd).toBe(1_000_000);
    expect(rows.reduce((s, r) => s + r.amountVnd, 0)).toBe(10_000_000);
  });

  it('puts remainder on Opportunity for awkward amounts', () => {
    const rows = allocateAmountVnd(100, {
      livingPct: 55,
      safetyPct: 15,
      compoundPct: 20,
      opportunityPct: 10,
    });
    expect(rows.reduce((s, r) => s + r.amountVnd, 0)).toBe(100);
    expect(rows.find((r) => r.bucket === 'LIVING')?.amountVnd).toBe(55);
    expect(rows.find((r) => r.bucket === 'OPPORTUNITY')?.amountVnd).toBe(10);
  });

  it('rejects percentages that do not sum to 100', () => {
    expect(() =>
      allocateAmountVnd(1000, {
        livingPct: 50,
        safetyPct: 10,
        compoundPct: 20,
        opportunityPct: 10,
      }),
    ).toThrow(/100/);
  });
});

describe('rescaleAllocations', () => {
  it('preserves pcts when income amount changes', () => {
    const rows = rescaleAllocations(20_000_000, [
      { bucket: 'LIVING', pctApplied: 55 },
      { bucket: 'SAFETY', pctApplied: 15 },
      { bucket: 'COMPOUND', pctApplied: 20 },
      { bucket: 'OPPORTUNITY', pctApplied: 10 },
    ]);
    expect(rows.find((r) => r.bucket === 'LIVING')?.amountVnd).toBe(11_000_000);
    expect(rows.reduce((s, r) => s + r.amountVnd, 0)).toBe(20_000_000);
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
