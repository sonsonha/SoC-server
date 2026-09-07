import { describe, expect, it } from 'vitest';
import {
  applySessionOutcomePatch,
  normalizeSessionOutcome,
  serializeSessionOutcome,
  sessionOutcomeProgress,
} from '../domain/sessionOutcome.js';

describe('sessionOutcome', () => {
  it('defaults to NONE', () => {
    expect(normalizeSessionOutcome({})).toEqual({
      type: 'NONE',
      items: [],
      target: null,
      actual: null,
      unit: null,
    });
  });

  it('normalizes checklist items and progress', () => {
    const outcome = normalizeSessionOutcome({
      type: 'CHECKLIST',
      items: [
        { id: 'a', text: 'Listening diagnostic', done: true },
        { text: '  ', done: true },
        { id: 'b', text: 'Reading diagnostic', done: false },
        { id: 'c', text: 'Writing', done: true },
        { id: 'd', text: 'Notes', done: false },
      ],
    });
    expect(outcome.items).toHaveLength(4);
    expect(sessionOutcomeProgress(outcome)).toEqual({
      completedCount: 2,
      totalCount: 4,
      progressLabel: '2 / 4',
    });
  });

  it('allows quantity actual greater than target', () => {
    const outcome = normalizeSessionOutcome({
      type: 'QUANTITY',
      target: 2,
      actual: 3,
      unit: 'applications',
    });
    expect(serializeSessionOutcome(outcome).progressLabel).toBe('3 / 2 applications');
  });

  it('keeps Session Done independent from checklist completion', () => {
    const partial = normalizeSessionOutcome({
      type: 'CHECKLIST',
      items: [
        { id: '1', text: 'A', done: true },
        { id: '2', text: 'B', done: false },
      ],
    });
    expect(sessionOutcomeProgress(partial).progressLabel).toBe('1 / 2');
    // Domain does not derive Session status — callers keep DONE separate.
    expect(partial.type).toBe('CHECKLIST');
  });

  it('patches checklist toggles and quantity after DONE without changing type wrongly', () => {
    const checklist = normalizeSessionOutcome({
      type: 'CHECKLIST',
      items: [
        { id: '1', text: 'A', done: false },
        { id: '2', text: 'B', done: false },
      ],
    });
    const toggled = applySessionOutcomePatch(checklist, {
      items: [
        { id: '1', text: 'A', done: true },
        { id: '2', text: 'B', done: false },
      ],
    });
    expect(sessionOutcomeProgress(toggled).progressLabel).toBe('1 / 2');

    const quantity = normalizeSessionOutcome({
      type: 'QUANTITY',
      target: 2,
      actual: 0,
      unit: 'applications',
    });
    const bumped = applySessionOutcomePatch(quantity, { actual: 1 });
    expect(bumped.actual).toBe(1);
    expect(bumped.target).toBe(2);
  });

  it('clears fields when switching to NONE', () => {
    const cleared = applySessionOutcomePatch(
      normalizeSessionOutcome({
        type: 'QUANTITY',
        target: 2,
        actual: 1,
        unit: 'applications',
      }),
      { type: 'NONE' },
    );
    expect(cleared).toEqual({
      type: 'NONE',
      items: [],
      target: null,
      actual: null,
      unit: null,
    });
  });
});
