/**
 * Account-match gate: Calendar OAuth Google sub must equal Personal OS login sub.
 */
import { describe, expect, it } from 'vitest';

export function assertSameGoogleAccount(opts: {
  personalOsSub: string;
  calendarSub: string | null | undefined;
}): { ok: true } | { ok: false; code: 'GOOGLE_ACCOUNT_MISMATCH' } {
  if (!opts.calendarSub || opts.calendarSub !== opts.personalOsSub) {
    return { ok: false, code: 'GOOGLE_ACCOUNT_MISMATCH' };
  }
  return { ok: true };
}

describe('Google account match for Calendar connect', () => {
  it('accepts matching subs', () => {
    expect(assertSameGoogleAccount({ personalOsSub: 'sub-1', calendarSub: 'sub-1' })).toEqual({
      ok: true,
    });
  });

  it('rejects mismatched or missing calendar identity', () => {
    expect(assertSameGoogleAccount({ personalOsSub: 'sub-1', calendarSub: 'sub-2' })).toEqual({
      ok: false,
      code: 'GOOGLE_ACCOUNT_MISMATCH',
    });
    expect(assertSameGoogleAccount({ personalOsSub: 'sub-1', calendarSub: null })).toEqual({
      ok: false,
      code: 'GOOGLE_ACCOUNT_MISMATCH',
    });
  });
});
