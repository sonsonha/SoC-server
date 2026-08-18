import { describe, expect, it } from 'vitest';
import { buildGoalProgress, type GoalBlockEvidence, type GoalMetricObservation, type GoalProcess, type GoalTaskEvidence } from './goalProgress.js';

const now = new Date('2026-08-20T09:00:00.000Z');

function task(overrides: Partial<GoalTaskEvidence>): GoalTaskEvidence {
  return {
    id: 'task-1',
    title: 'Task',
    goalId: 'goal-1',
    goalProcessId: 'proc-1',
    projectId: 'project-1',
    status: 'DONE',
    dueAt: null,
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

describe('buildGoalProgress', () => {
  it('aggregates weekly count processes from completed tasks', () => {
    const processes: GoalProcess[] = [
      { id: 'proc-1', name: 'Applications', measurementType: 'COUNT', targetValue: 5, period: 'WEEK', active: true },
    ];
    const tasks: GoalTaskEvidence[] = [
      task({ id: 'a' }),
      task({ id: 'b' }),
      task({ id: 'c' }),
      task({ id: 'd' }),
      task({ id: 'e', status: 'SCHEDULED', completedAt: null }),
    ];
    const blocks: GoalBlockEvidence[] = [
      block({ id: 'ba', taskId: 'a' }),
      block({ id: 'bb', taskId: 'b' }),
      block({ id: 'bc', taskId: 'c' }),
      block({ id: 'bd', taskId: 'd' }),
      block({ id: 'be', taskId: 'e' }),
    ];

    const progress = buildGoalProgress(processes, [], tasks, blocks, now);
    expect(progress.processes[0]?.thisWeek.completed).toBe(4);
    expect(progress.processes[0]?.thisWeek.target).toBe(5);
    expect(progress.processes[0]?.thisWeek.planned).toBe(5);
  });

  it('uses block duration for planned and completed duration', () => {
    const processes: GoalProcess[] = [
      { id: 'proc-1', name: 'Technical study', measurementType: 'DURATION', targetValue: 3, unit: 'h', period: 'WEEK', active: true },
    ];
    const tasks: GoalTaskEvidence[] = [
      task({ id: 'a', completedAt: '2026-08-18T11:00:00.000Z' }),
      task({ id: 'b', completedAt: '2026-08-20T11:00:00.000Z' }),
      task({ id: 'c', status: 'SCHEDULED', completedAt: null }),
    ];
    const blocks: GoalBlockEvidence[] = [
      block({ id: 'a1', taskId: 'a', durationMinutes: 90 }),
      block({ id: 'b1', taskId: 'b', startAt: '2026-08-20T09:00:00.000Z', endAt: '2026-08-20T10:00:00.000Z', durationMinutes: 60 }),
      block({ id: 'c1', taskId: 'c', startAt: '2026-08-22T09:00:00.000Z', endAt: '2026-08-22T10:00:00.000Z', durationMinutes: 60 }),
    ];

    const progress = buildGoalProgress(processes, [], tasks, blocks, now);
    expect(progress.processes[0]?.thisWeek.target).toBe(3);
    expect(progress.processes[0]?.thisWeek.planned).toBe(3.5);
    expect(progress.processes[0]?.thisWeek.completed).toBe(2.5);
  });

  it('tracks consistency and observation trend separately', () => {
    const processes: GoalProcess[] = [
      { id: 'proc-1', name: 'Speaking', measurementType: 'COUNT', targetValue: 1, period: 'WEEK', active: true },
    ];
    const tasks: GoalTaskEvidence[] = [
      task({ id: 'a', completedAt: '2026-08-18T09:00:00.000Z' }),
      task({ id: 'b', completedAt: '2026-08-11T09:00:00.000Z' }),
    ];
    const blocks: GoalBlockEvidence[] = [
      block({ id: 'a1', taskId: 'a' }),
      block({ id: 'b1', taskId: 'b', startAt: '2026-08-11T09:00:00.000Z', endAt: '2026-08-11T09:30:00.000Z', durationMinutes: 30 }),
    ];
    const observations: GoalMetricObservation[] = [
      { id: 'o1', observedAt: '2026-07-01T00:00:00.000Z', value: 6.0 },
      { id: 'o2', observedAt: '2026-08-15T00:00:00.000Z', value: 6.5 },
    ];

    const progress = buildGoalProgress(processes, observations, tasks, blocks, now);
    expect(progress.consistency.metWeeks).toBeGreaterThanOrEqual(2);
    expect(progress.observationTrend).toBe('improving');
    expect(progress.insight.processState).toBe('strong');
  });
});
