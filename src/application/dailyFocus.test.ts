import { describe, expect, it } from 'vitest';
import {
  isDailyFocusForDate,
  normalizeDailyFocusDate,
  resolveDailyFocusReplacement,
} from './dailyFocus.js';

describe('dailyFocus', () => {
  it('normalizes YYYY-MM-DD and rejects invalid values', () => {
    expect(normalizeDailyFocusDate('2026-09-07')).toBe('2026-09-07');
    expect(normalizeDailyFocusDate(null)).toBe(null);
    expect(normalizeDailyFocusDate('')).toBe(null);
    expect(() => normalizeDailyFocusDate('09/07/2026')).toThrow(/YYYY-MM-DD/);
  });

  it('scopes Daily Focus to a specific date', () => {
    expect(isDailyFocusForDate({ dailyFocusDate: '2026-09-07' }, '2026-09-07')).toBe(true);
    expect(isDailyFocusForDate({ dailyFocusDate: '2026-09-07' }, '2026-09-08')).toBe(false);
    expect(isDailyFocusForDate({ dailyFocusDate: null }, '2026-09-07')).toBe(false);
  });

  it('replacement clears the previous focus task id', () => {
    expect(resolveDailyFocusReplacement({
      existingFocusTaskId: 'a',
      nextTaskId: 'b',
    })).toEqual({ clearTaskId: 'a', focusTaskId: 'b' });
    expect(resolveDailyFocusReplacement({
      existingFocusTaskId: 'a',
      nextTaskId: 'a',
    })).toEqual({ clearTaskId: null, focusTaskId: 'a' });
  });

  it('priority remains independent of Daily Focus designation', () => {
    const task = { priority: 'P2', dailyFocusDate: '2026-09-07' };
    expect(task.priority).toBe('P2');
    expect(isDailyFocusForDate(task, '2026-09-07')).toBe(true);
  });
});
