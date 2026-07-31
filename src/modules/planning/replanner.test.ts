import { describe, expect, it } from 'vitest';
import {
  applyDisruptionToBlocks,
  assertExternalPreserved,
  replanFromNow,
} from './replanner.js';
import type { PlanBlockRecord } from '../../domain/planning/disruption.js';

const planId = 'plan-2026-07-29';
const date = '2026-07-29';
const fromMs = Date.UTC(2026, 6, 29, 14, 0, 0);

function block(partial: Partial<PlanBlockRecord> & Pick<PlanBlockRecord, 'id' | 'title'>): PlanBlockRecord {
  return {
    dailyPlanId: planId,
    date,
    startEpochMs: Date.UTC(2026, 6, 29, 10, 0, 0),
    endEpochMs: Date.UTC(2026, 6, 29, 11, 0, 0),
    type: 'TASK',
    ownership: 'COS',
    taskId: null,
    habitId: null,
    commitmentId: null,
    locationId: 'loc-home',
    locked: false,
    preparationId: null,
    revision: 1,
    ...partial,
  };
}

describe('replanner', () => {
  it('NEW_MEETING inserts EXTERNAL block and moves COS blocks', () => {
    const blocks = [
      block({
        id: 'b1',
        title: 'Rover deploy',
        startEpochMs: Date.UTC(2026, 6, 29, 15, 0, 0),
        endEpochMs: Date.UTC(2026, 6, 29, 16, 30, 0),
        taskId: 't1',
      }),
    ];
    const meetingStart = new Date('2026-07-29T15:00:00.000Z').getTime();
    const meetingEnd = new Date('2026-07-29T17:00:00.000Z').getTime();

    const result = replanFromNow(
      blocks,
      {
        type: 'NEW_MEETING',
        title: 'Sync with team',
        startAt: '2026-07-29T15:00:00.000Z',
        endAt: '2026-07-29T17:00:00.000Z',
        ownership: 'EXTERNAL',
      },
      fromMs,
      date,
      ['t1'],
    );

    const external = result.blocks.find((b) => b.ownership === 'EXTERNAL');
    expect(external).toBeTruthy();
    expect(external!.startEpochMs).toBe(meetingStart);
    expect(external!.endEpochMs).toBe(meetingEnd);
    expect(external!.locked).toBe(true);
    expect(result.adjustments.some((a) => a.kind === 'INSERTED')).toBe(true);
    expect(result.impact.blocksInserted).toBe(1);
    assertExternalPreserved(blocks, result.blocks);
  });

  it('never deletes existing EXTERNAL blocks', () => {
    const existingExternal = block({
      id: 'ext-1',
      title: 'Standup',
      ownership: 'EXTERNAL',
      locked: true,
      type: 'COMMITMENT',
      startEpochMs: Date.UTC(2026, 6, 29, 9, 0, 0),
      endEpochMs: Date.UTC(2026, 6, 29, 9, 30, 0),
    });
    const cos = block({
      id: 'b2',
      title: 'Deep work',
      startEpochMs: Date.UTC(2026, 6, 29, 16, 0, 0),
      endEpochMs: Date.UTC(2026, 6, 29, 17, 0, 0),
    });

    const result = replanFromNow(
      [existingExternal, cos],
      {
        type: 'NEW_MEETING',
        title: 'Afternoon sync',
        startAt: '2026-07-29T15:00:00.000Z',
        endAt: '2026-07-29T16:00:00.000Z',
        ownership: 'EXTERNAL',
      },
      fromMs,
      date,
      [],
    );

    expect(result.blocks.filter((b) => b.ownership === 'EXTERNAL').length).toBeGreaterThanOrEqual(2);
    assertExternalPreserved([existingExternal], result.blocks);
  });

  it('LOW energy shrinks habit blocks', () => {
    const habit = block({
      id: 'h1',
      title: 'English',
      type: 'HABIT',
      habitId: 'habit-en',
      startEpochMs: Date.UTC(2026, 6, 29, 18, 0, 0),
      endEpochMs: Date.UTC(2026, 6, 29, 18, 30, 0),
    });

    const result = replanFromNow(
      [habit],
      { type: 'ENERGY_CRASH', mode: 'LOW', note: 'Low energy' },
      fromMs,
      date,
      [],
    );

    const shrunk = result.blocks.find((b) => b.id === 'h1');
    expect(shrunk).toBeTruthy();
    expect(shrunk!.endEpochMs - shrunk!.startEpochMs).toBeLessThan(30 * 60_000);
    expect(result.adjustments.some((a) => a.kind === 'SHRUNK')).toBe(true);
  });

  it('adjustments array reflects block diff', () => {
    const blocks = [
      block({
        id: 'learn',
        title: 'TCP study',
        startEpochMs: Date.UTC(2026, 6, 29, 14, 30, 0),
        endEpochMs: Date.UTC(2026, 6, 29, 15, 30, 0),
      }),
    ];
    const result = replanFromNow(
      blocks,
      {
        type: 'NEW_MEETING',
        title: 'Meeting',
        startAt: '2026-07-29T14:30:00.000Z',
        endAt: '2026-07-29T15:30:00.000Z',
        ownership: 'EXTERNAL',
      },
      fromMs,
      date,
      [],
    );
    expect(result.adjustments.length).toBeGreaterThan(0);
    expect(result.summary).toContain('NEW_MEETING');
  });
});

describe('applyDisruptionToBlocks', () => {
  it('creates meeting block with EXTERNAL ownership', () => {
    const { blocks, inserted } = applyDisruptionToBlocks([], {
      type: 'NEW_MEETING',
      title: 'Team sync',
      startAt: '2026-07-29T15:00:00.000Z',
      endAt: '2026-07-29T16:00:00.000Z',
      ownership: 'EXTERNAL',
    }, fromMs, date, planId);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].ownership).toBe('EXTERNAL');
    expect(inserted[0].kind).toBe('INSERTED');
  });
});
