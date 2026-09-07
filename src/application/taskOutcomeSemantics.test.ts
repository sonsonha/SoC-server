import { describe, expect, it } from 'vitest';
import {
  deriveTaskProgressFromSessions,
  directTaskCompletePolicy,
  resolveMaintainRepeatUntilEpochMs,
  resolveTaskStatusFromEvidence,
  taskRequiresOutcomeConfirm,
} from './sessionEvidence.js';

describe('Definition of Done outcome vs Sessions', () => {
  it('does not treat all Sessions done as Task DONE when DoD is set', () => {
    const sessions = deriveTaskProgressFromSessions([
      { id: '1', status: 'DONE' },
      { id: '2', status: 'DONE' },
    ]);
    expect(sessions.derivedTaskStatus).toBe('DONE');
    expect(resolveTaskStatusFromEvidence({
      definitionOfDone: '- essay written\n- reviewed',
      outcomeAchieved: false,
      sessionDerived: sessions.derivedTaskStatus,
    })).toBe('SCHEDULED');
  });

  it('marks Task DONE when outcome is confirmed without mutating Sessions', () => {
    expect(resolveTaskStatusFromEvidence({
      definitionOfDone: '- shipped',
      outcomeAchieved: true,
      sessionDerived: 'SCHEDULED',
    })).toBe('DONE');
  });

  it('keeps Session-based completion for Tasks without DoD', () => {
    expect(taskRequiresOutcomeConfirm(null)).toBe(false);
    expect(resolveTaskStatusFromEvidence({
      definitionOfDone: null,
      outcomeAchieved: false,
      sessionDerived: 'DONE',
    })).toBe('DONE');
  });

  it('blocks direct Mark Complete when DoD is required', () => {
    const policy = directTaskCompletePolicy([{ id: 'a', status: 'PLANNED' }], {
      definitionOfDone: '- done criteria',
    });
    expect(policy).toEqual({ allow: false, reason: 'REQUIRES_OUTCOME' });
  });

  it('allows adding Sessions after all prior Sessions complete while outcome open', () => {
    const before = resolveTaskStatusFromEvidence({
      definitionOfDone: '- criteria',
      outcomeAchieved: false,
      sessionDerived: 'DONE',
    });
    expect(before).toBe('SCHEDULED');
    const afterMoreSessions = deriveTaskProgressFromSessions([
      { id: '1', status: 'DONE' },
      { id: '2', status: 'DONE' },
      { id: '3', status: 'PLANNED' },
    ]);
    expect(afterMoreSessions.derivedTaskStatus).toBe('SCHEDULED');
  });
});

describe('Maintain repeat horizon', () => {
  it('caps at now + ~3 months when no Goal deadline', () => {
    const now = Date.parse('2026-09-07T00:00:00+07:00');
    const until = resolveMaintainRepeatUntilEpochMs({ nowEpochMs: now });
    expect(until - now).toBe(92 * 86_400_000);
  });

  it('uses earlier Goal deadline when sooner than 3 months', () => {
    const now = Date.parse('2026-09-07T00:00:00+07:00');
    const deadline = Date.parse('2026-10-01T23:59:59+07:00');
    const until = resolveMaintainRepeatUntilEpochMs({
      nowEpochMs: now,
      goalTargetDateEpochMs: deadline,
    });
    expect(until).toBe(deadline);
  });
});
