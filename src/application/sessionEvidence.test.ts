import { describe, expect, it } from 'vitest';
import {
  appendCarryOverNote,
  buildCarryOverNote,
  deriveTaskProgressFromSessions,
  directTaskCompletePolicy,
  futureWeekOffsets,
  resolveRepeatWeekCount,
  shiftEpochByWeeks,
} from './sessionEvidence.js';

describe('session evidence', () => {
  it('derives multi-session progress and DONE only when all sessions complete', () => {
    const blocks = [
      { id: '1', status: 'DONE' },
      { id: '2', status: 'DONE' },
      { id: '3', status: 'PLANNED' },
      { id: '4', status: 'PLANNED' },
      { id: '5', status: 'PLANNED' },
    ];
    expect(deriveTaskProgressFromSessions(blocks)).toMatchObject({
      completedCount: 2,
      activeCount: 5,
      progressPercent: 40,
      progressState: 'PARTIAL',
      derivedTaskStatus: 'SCHEDULED',
    });

    const allDone = blocks.map((b) => ({ ...b, status: 'DONE' }));
    expect(deriveTaskProgressFromSessions(allDone).derivedTaskStatus).toBe('DONE');
    expect(deriveTaskProgressFromSessions(allDone).progressPercent).toBe(100);
  });

  it('reopens when one session is undone from full completion', () => {
    const blocks = [
      { id: '1', status: 'DONE' },
      { id: '2', status: 'DONE' },
      { id: '3', status: 'DONE' },
      { id: '4', status: 'DONE' },
      { id: '5', status: 'PLANNED' },
    ];
    expect(deriveTaskProgressFromSessions(blocks)).toMatchObject({
      completedCount: 4,
      progressPercent: 80,
      progressState: 'PARTIAL',
      derivedTaskStatus: 'SCHEDULED',
    });
  });

  it('gates direct Task complete: zero / one / many sessions', () => {
    expect(directTaskCompletePolicy([]).allow).toBe(false);
    expect(directTaskCompletePolicy([{ id: '1', status: 'PLANNED' }])).toEqual({
      allow: true,
      mode: 'SINGLE_SESSION',
    });
    expect(directTaskCompletePolicy([
      { id: '1', status: 'PLANNED' },
      { id: '2', status: 'PLANNED' },
    ]).allow).toBe(false);
  });

  it('zero sessions are unscheduled', () => {
    expect(deriveTaskProgressFromSessions([])).toMatchObject({
      progressState: 'UNSCHEDULED',
      derivedTaskStatus: 'INBOX',
    });
  });
});

describe('repeat range', () => {
  it('caps weeks and builds future offsets excluding source week', () => {
    expect(resolveRepeatWeekCount({ weeks: 4, fromEpochMs: 0 })).toBe(4);
    expect(resolveRepeatWeekCount({ weeks: 999, fromEpochMs: 0 })).toBe(52);
    expect(futureWeekOffsets(4)).toEqual([1, 2, 3, 4]);
    expect(shiftEpochByWeeks(1_000, 2)).toBe(1_000 + 14 * 86_400_000);
  });
});

describe('carry-over note', () => {
  it('appends without overwriting existing notes', () => {
    const note = buildCarryOverNote({ completedCount: 3, activeCount: 4, progressPercent: 75 });
    expect(note).toContain('3/4');
    expect(appendCarryOverNote('User plan', note)).toBe(`User plan\n\n${note}`);
    expect(appendCarryOverNote(note, note)).toBe(note);
  });
});
