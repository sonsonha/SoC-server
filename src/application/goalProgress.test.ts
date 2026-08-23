import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildGoalProgress,
  resolveEffectiveProcessId,
  startOfWeek,
  type GoalBlockEvidence,
  type GoalMetricObservation,
  type GoalProcess,
  type GoalTaskEvidence,
} from './goalProgress.js';

const now = new Date('2026-08-18T07:00:00.000Z'); // 14:00 Asia/Ho_Chi_Minh

function task(overrides: Partial<GoalTaskEvidence>): GoalTaskEvidence {
  return {
    id: 'task-1',
    title: 'Task',
    goalId: 'goal-1',
    goalProcessId: 'proc-1',
    projectId: 'project-1',
    status: 'DONE',
    dueAt: '2026-08-17T00:00:00.000+07:00',
    completedAt: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

function block(overrides: Partial<GoalBlockEvidence>): GoalBlockEvidence {
  return {
    id: 'block-1',
    taskId: 'task-1',
    startAt: '2026-08-18T09:00:00.000Z',
    endAt: '2026-08-18T10:30:00.000Z',
    durationMinutes: 90,
    ...overrides,
  };
}

describe('resolveEffectiveProcessId', () => {
  const allowed = new Set(['proc-1', 'proc-2']);

  it('prefers explicit task.goalProcessId over project default', () => {
    const defaults = new Map([['project-1', 'proc-2']]);
    expect(resolveEffectiveProcessId(
      { goalProcessId: 'proc-1', projectId: 'project-1' },
      defaults,
      allowed,
    )).toBe('proc-1');
  });

  it('inherits project defaultGoalProcessId when the task has none', () => {
    const defaults = new Map([['project-1', 'proc-2']]);
    expect(resolveEffectiveProcessId(
      { goalProcessId: null, projectId: 'project-1' },
      defaults,
      allowed,
    )).toBe('proc-2');
  });

  it('does not inherit a process that does not belong to the goal', () => {
    const defaults = new Map([['project-1', 'proc-other']]);
    expect(resolveEffectiveProcessId(
      { goalProcessId: null, projectId: 'project-1' },
      defaults,
      allowed,
    )).toBeNull();
  });
});

describe('buildGoalProgress', () => {
  it('aggregates weekly count processes from completed tasks without requiring calendar blocks', () => {
    const processes: GoalProcess[] = [
      { id: 'proc-1', name: 'Applications', measurementType: 'COUNT', targetValue: 5, period: 'WEEK', active: true },
    ];
    const tasks: GoalTaskEvidence[] = [
      task({ id: 'a', completedAt: '2026-08-17T03:00:00.000Z' }),
      task({ id: 'b', completedAt: '2026-08-17T04:00:00.000Z' }),
      task({ id: 'c', completedAt: '2026-08-18T02:00:00.000Z' }),
      task({ id: 'd', completedAt: '2026-08-18T03:00:00.000Z' }),
      task({ id: 'e', status: 'INBOX', completedAt: null }),
    ];

    const progress = buildGoalProgress(processes, [], tasks, [], now);
    expect(progress.processes[0]?.thisWeek.completed).toBe(4);
    expect(progress.processes[0]?.thisWeek.target).toBe(5);
    expect(progress.processes[0]?.thisWeek.planned).toBe(5);
  });

  it('does not count a WEEK task as completed until it is actually done', () => {
    const processes: GoalProcess[] = [
      { id: 'proc-1', name: 'Applications', measurementType: 'COUNT', targetValue: 5, period: 'WEEK', active: true },
    ];
    const tasks: GoalTaskEvidence[] = [
      task({ id: 'open', status: 'INBOX', completedAt: null, dueAt: '2026-08-16T17:00:00.000Z' }),
    ];
    const progress = buildGoalProgress(processes, [], tasks, [], now);
    expect(progress.processes[0]?.thisWeek.completed).toBe(0);
    expect(progress.processes[0]?.thisWeek.planned).toBe(1);
  });

  it('uses block duration for planned and completed duration', () => {
    const processes: GoalProcess[] = [
      { id: 'proc-1', name: 'Technical study', measurementType: 'DURATION', targetValue: 3, unit: 'h', period: 'WEEK', active: true },
    ];
    const tasks: GoalTaskEvidence[] = [
      task({ id: 'a', completedAt: '2026-08-17T13:30:00.000Z' }),
      task({ id: 'b', completedAt: '2026-08-19T13:30:00.000Z' }),
      task({ id: 'c', status: 'SCHEDULED', completedAt: null }),
    ];
    const blocks: GoalBlockEvidence[] = [
      block({ id: 'a1', taskId: 'a', startAt: '2026-08-17T12:00:00.000Z', endAt: '2026-08-17T13:30:00.000Z', durationMinutes: 90 }),
      block({ id: 'b1', taskId: 'b', startAt: '2026-08-19T12:00:00.000Z', endAt: '2026-08-19T13:30:00.000Z', durationMinutes: 90 }),
      block({ id: 'c1', taskId: 'c', startAt: '2026-08-22T07:00:00.000Z', endAt: '2026-08-22T08:00:00.000Z', durationMinutes: 60 }),
    ];

    const progress = buildGoalProgress(processes, [], tasks, blocks, now);
    expect(progress.processes[0]?.thisWeek.target).toBe(3);
    expect(progress.processes[0]?.thisWeek.planned).toBe(4);
    expect(progress.processes[0]?.thisWeek.completed).toBe(3);
  });

  it('increases planned duration when an incomplete block is resized, without changing completed', () => {
    const processes: GoalProcess[] = [
      { id: 'proc-1', name: 'Technical study', measurementType: 'DURATION', targetValue: 3, unit: 'h', period: 'WEEK', active: true },
    ];
    const tasks: GoalTaskEvidence[] = [
      task({ id: 'open', status: 'SCHEDULED', completedAt: null }),
    ];
    const original = [block({ id: 'open-block', taskId: 'open', startAt: '2026-08-22T07:00:00.000Z', endAt: '2026-08-22T08:00:00.000Z', durationMinutes: 60 })];
    const resized = [block({ id: 'open-block', taskId: 'open', startAt: '2026-08-22T07:00:00.000Z', endAt: '2026-08-22T09:00:00.000Z', durationMinutes: 120 })];

    const before = buildGoalProgress(processes, [], tasks, original, now);
    const after = buildGoalProgress(processes, [], tasks, resized, now);
    expect(before.processes[0]?.thisWeek.planned).toBe(1);
    expect(after.processes[0]?.thisWeek.planned).toBe(2);
    expect(after.processes[0]?.thisWeek.completed).toBe(0);

    const completed = buildGoalProgress(
      processes,
      [],
      [{ ...tasks[0]!, status: 'DONE', completedAt: '2026-08-22T09:00:00.000Z' }],
      resized,
      now,
    );
    expect(completed.processes[0]?.thisWeek.completed).toBe(2);
  });

  it('inherits project default process when aggregating', () => {
    const processes: GoalProcess[] = [
      { id: 'proc-1', name: 'Applications', measurementType: 'COUNT', targetValue: 5, period: 'WEEK', active: true },
    ];
    const tasks: GoalTaskEvidence[] = [
      task({ id: 'inherited', goalProcessId: null, projectId: 'project-1', completedAt: '2026-08-18T03:00:00.000Z' }),
    ];
    const progress = buildGoalProgress(
      processes,
      [],
      tasks,
      [],
      now,
      new Map([['project-1', 'proc-1']]),
    );
    expect(progress.processes[0]?.thisWeek.completed).toBe(1);
  });

  it('does not match process association from task titles', () => {
    const processes: GoalProcess[] = [
      { id: 'proc-1', name: 'Applications', measurementType: 'COUNT', targetValue: 5, period: 'WEEK', active: true },
    ];
    const tasks: GoalTaskEvidence[] = [
      task({ id: 'named', title: 'Apply Anfin', goalProcessId: null, projectId: null, completedAt: '2026-08-18T03:00:00.000Z' }),
    ];
    const progress = buildGoalProgress(processes, [], tasks, [], now);
    expect(progress.processes[0]?.thisWeek.completed).toBe(0);
  });

  it('uses Asia/Ho_Chi_Minh week boundaries', () => {
    const mondayVn = startOfWeek(now);
    expect(mondayVn.toISOString()).toBe('2026-08-16T17:00:00.000Z');
  });

  it('tracks consistency from the last 8 completed weeks and observation trend separately', () => {
    const processes: GoalProcess[] = [
      { id: 'proc-1', name: 'Speaking', measurementType: 'COUNT', targetValue: 1, period: 'WEEK', active: true },
    ];
    const tasks: GoalTaskEvidence[] = Array.from({ length: 8 }, (_, index) => {
      const weekStart = addDays(startOfWeek(now), (index - 8) * 7);
      return task({
        id: `hist-${index}`,
        completedAt: new Date(weekStart.getTime() + 10 * 3_600_000).toISOString(),
        dueAt: weekStart.toISOString(),
      });
    });
    const observations: GoalMetricObservation[] = [
      { id: 'o1', observedAt: '2026-07-01T00:00:00.000Z', value: 6.0 },
      { id: 'o2', observedAt: '2026-08-15T00:00:00.000Z', value: 6.5 },
    ];

    const progress = buildGoalProgress(processes, observations, tasks, [], now);
    expect(progress.consistency.totalWeeks).toBe(8);
    expect(progress.consistency.metWeeks).toBeGreaterThanOrEqual(7);
    expect(progress.observationTrend).toBe('improving');
  });

  it('emits no consistency weeks when the goal has no process', () => {
    const progress = buildGoalProgress([], [], [], [], now);
    expect(progress.insight.processState).toBe('none');
    expect(progress.consistency.totalWeeks).toBe(0);
    expect(progress.consistency.weeks).toEqual([]);
    expect(progress.insight.message).toBe('No recurring process is defined for this goal yet.');
  });

  it('describes the full observation series without strategy language', () => {
    const processes: GoalProcess[] = [
      { id: 'proc-1', name: 'Speaking', measurementType: 'COUNT', targetValue: 1, period: 'WEEK', active: true },
    ];
    const tasks: GoalTaskEvidence[] = Array.from({ length: 8 }, (_, index) => {
      const weekStart = addDays(startOfWeek(now), (index - 8) * 7);
      return task({
        id: `hist-${index}`,
        completedAt: new Date(weekStart.getTime() + 10 * 3_600_000).toISOString(),
        dueAt: weekStart.toISOString(),
      });
    });
    const observations: GoalMetricObservation[] = [
      { id: 'o1', observedAt: '2026-05-15T00:00:00.000Z', value: 5.5 },
      { id: 'o2', observedAt: '2026-06-15T00:00:00.000Z', value: 5.5 },
      { id: 'o3', observedAt: '2026-07-15T00:00:00.000Z', value: 6.0 },
      { id: 'o4', observedAt: '2026-08-10T00:00:00.000Z', value: 6.0 },
    ];
    const progress = buildGoalProgress(processes, observations, tasks, [], now);
    expect(progress.observationTrend).toBe('stable');
    expect(progress.insight.message).not.toMatch(/changed little|strategy/i);
    expect(progress.insight.message).toContain('of the last 8 weeks met the process threshold');
    expect(progress.insight.message).toContain('The outcome moved from 5.5 to 6');
    expect(progress.insight.message).toContain('since July');
  });
});
