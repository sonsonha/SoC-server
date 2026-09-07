import { describe, expect, it } from 'vitest';
import {
  findDailyFocusSession,
  isSessionDailyFocusOnDate,
  productDateFromEpoch,
  resolveFocusOnSessionMove,
  resolveSessionDailyFocusReplacement,
} from '../application/dailyFocus.js';
import { OWNER_WEEK_PLAN_SESSION_SPECS } from '../modules/planner/seedOwnerWeekPlan.js';

describe('Session-level Daily Focus', () => {
  const wed = Date.parse('2026-09-09T08:00:00+07:00');
  const fri = Date.parse('2026-09-11T08:00:00+07:00');

  it('derives local focus date from Session start', () => {
    expect(productDateFromEpoch(wed)).toBe('2026-09-09');
    expect(productDateFromEpoch(fri)).toBe('2026-09-11');
  });

  it('allows the same Task to have Daily Focus Sessions on multiple dates', () => {
    const sessions = [
      { id: 'w', isDailyFocus: true, startEpochMs: wed, taskId: 'apps' },
      { id: 'f', isDailyFocus: true, startEpochMs: fri, taskId: 'apps' },
    ];
    expect(isSessionDailyFocusOnDate(sessions[0]!, '2026-09-09')).toBe(true);
    expect(isSessionDailyFocusOnDate(sessions[1]!, '2026-09-11')).toBe(true);
    expect(findDailyFocusSession(sessions, '2026-09-09')?.id).toBe('w');
    expect(findDailyFocusSession(sessions, '2026-09-11')?.id).toBe('f');
  });

  it('soft-enforces one focus Session per local date via replacement', () => {
    const decision = resolveSessionDailyFocusReplacement({
      existingFocusSessionId: 'old',
      nextSessionId: 'new',
    });
    expect(decision.clearSessionId).toBe('old');
    expect(decision.focusSessionId).toBe('new');
  });

  it('keeps focus when moving within the same day', () => {
    expect(
      resolveFocusOnSessionMove({
        wasDailyFocus: true,
        sourceDate: '2026-09-09',
        destDate: '2026-09-09',
        destExistingFocusSessionId: 'self',
        movingSessionId: 'self',
      }).action,
    ).toBe('KEEP');
  });

  it('keeps focus when moving onto an empty day', () => {
    expect(
      resolveFocusOnSessionMove({
        wasDailyFocus: true,
        sourceDate: '2026-09-09',
        destDate: '2026-09-10',
        destExistingFocusSessionId: null,
        movingSessionId: 'self',
      }).action,
    ).toBe('KEEP_ON_EMPTY_DAY');
  });

  it('conflicts when moving onto a day that already has focus', () => {
    const result = resolveFocusOnSessionMove({
      wasDailyFocus: true,
      sourceDate: '2026-09-09',
      destDate: '2026-09-10',
      destExistingFocusSessionId: 'other',
      movingSessionId: 'self',
    });
    expect(result).toEqual({ action: 'CONFLICT', existingFocusSessionId: 'other' });
  });

  it('copy/repeat defaults do not inherit focus (specs start false unless explicit)', () => {
    const nonFocus = OWNER_WEEK_PLAN_SESSION_SPECS.filter((s) => !s.isDailyFocus);
    expect(nonFocus.length).toBeGreaterThan(0);
    // Explicit week plan marks focus only on intended Sessions.
    const focusDays = OWNER_WEEK_PLAN_SESSION_SPECS.filter((s) => s.isDailyFocus).map((s) => s.date);
    expect(new Set(focusDays).size).toBe(7);
  });

  it('week plan has exactly one Daily Focus Session per day', () => {
    const byDay = new Map<string, number>();
    for (const spec of OWNER_WEEK_PLAN_SESSION_SPECS) {
      if (!spec.isDailyFocus) continue;
      byDay.set(spec.date, (byDay.get(spec.date) ?? 0) + 1);
    }
    expect([...byDay.values()].every((n) => n === 1)).toBe(true);
    expect(byDay.size).toBe(7);
  });

  it('applications Task has focus on both Wednesday and Friday', () => {
    const apps = OWNER_WEEK_PLAN_SESSION_SPECS.filter(
      (s) => s.taskTitle.includes('Submit 4 quality applications') && s.isDailyFocus,
    );
    expect(apps.map((s) => s.date).sort()).toEqual(['2026-09-09', '2026-09-11']);
  });
});
