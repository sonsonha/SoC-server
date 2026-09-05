import { describe, expect, it } from 'vitest';
import {
  allocateAmountVnd,
  allocateFromAmounts,
  canonicalizeBucket,
  monthBounds,
  rescaleAllocations,
} from './financeService.js';

describe('allocateAmountVnd (4 buckets)', () => {
  it('splits 20_000_000 with 50/15/30/5 and sums to total', () => {
    const rows = allocateAmountVnd(20_000_000, {
      livingPct: 50,
      safetyPct: 15,
      growthPct: 30,
      funPct: 5,
    });
    expect(rows.find((r) => r.bucket === 'LIVING')?.amountVnd).toBe(10_000_000);
    expect(rows.find((r) => r.bucket === 'SAFETY')?.amountVnd).toBe(3_000_000);
    expect(rows.find((r) => r.bucket === 'GROWTH')?.amountVnd).toBe(6_000_000);
    expect(rows.find((r) => r.bucket === 'FUN')?.amountVnd).toBe(1_000_000);
    expect(rows).toHaveLength(4);
    expect(rows.reduce((s, r) => s + r.amountVnd, 0)).toBe(20_000_000);
  });

  it('puts remainder on Fun for awkward amounts', () => {
    const rows = allocateAmountVnd(100, {
      livingPct: 50,
      safetyPct: 15,
      growthPct: 30,
      funPct: 5,
    });
    expect(rows.reduce((s, r) => s + r.amountVnd, 0)).toBe(100);
    expect(rows.find((r) => r.bucket === 'LIVING')?.amountVnd).toBe(50);
  });

  it('rejects percentages that do not sum to 100', () => {
    expect(() =>
      allocateAmountVnd(1000, {
        livingPct: 50,
        safetyPct: 15,
        growthPct: 30,
        funPct: 0,
      }),
    ).toThrow(/100/);
  });
});

describe('allocateFromAmounts', () => {
  it('accepts per-income override amounts that sum to income', () => {
    const rows = allocateFromAmounts(10_000_000, {
      LIVING: 0,
      SAFETY: 0,
      GROWTH: 10_000_000,
      FUN: 0,
    });
    expect(rows.find((r) => r.bucket === 'GROWTH')?.amountVnd).toBe(10_000_000);
    expect(rows.reduce((s, r) => s + r.amountVnd, 0)).toBe(10_000_000);
  });

  it('rejects amounts that do not sum to income', () => {
    expect(() =>
      allocateFromAmounts(1000, { LIVING: 500, SAFETY: 0, GROWTH: 0, FUN: 0 }),
    ).toThrow(/sum/);
  });
});

describe('rescaleAllocations', () => {
  it('preserves pcts when income amount changes', () => {
    const rows = rescaleAllocations(20_000_000, [
      { bucket: 'LIVING', pctApplied: 50 },
      { bucket: 'SAFETY', pctApplied: 15 },
      { bucket: 'GROWTH', pctApplied: 30 },
      { bucket: 'FUN', pctApplied: 5 },
    ]);
    expect(rows.find((r) => r.bucket === 'LIVING')?.amountVnd).toBe(10_000_000);
    expect(rows.reduce((s, r) => s + r.amountVnd, 0)).toBe(20_000_000);
  });

  it('merges INVESTING + OPPORTUNITY + LEARNING into GROWTH', () => {
    const rows = rescaleAllocations(10_000_000, [
      { bucket: 'LIVING', pctApplied: 40 },
      { bucket: 'SAFETY', pctApplied: 5 },
      { bucket: 'INVESTING', pctApplied: 30 },
      { bucket: 'OPPORTUNITY', pctApplied: 10 },
      { bucket: 'LEARNING', pctApplied: 10 },
      { bucket: 'FUN', pctApplied: 5 },
    ]);
    expect(rows.find((r) => r.bucket === 'GROWTH')?.amountVnd).toBe(5_000_000);
    expect(rows.find((r) => r.bucket === 'INVESTING')).toBeUndefined();
    expect(rows).toHaveLength(4);
  });

  it('maps legacy COMPOUND into GROWTH', () => {
    expect(canonicalizeBucket('COMPOUND')).toBe('GROWTH');
    const rows = rescaleAllocations(10_000_000, [
      { bucket: 'LIVING', pctApplied: 55 },
      { bucket: 'SAFETY', pctApplied: 15 },
      { bucket: 'COMPOUND', pctApplied: 20 },
      { bucket: 'FUN', pctApplied: 10 },
    ]);
    expect(rows.find((r) => r.bucket === 'GROWTH')?.amountVnd).toBe(2_000_000);
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
