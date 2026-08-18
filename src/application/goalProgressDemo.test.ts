import { describe, expect, it } from 'vitest';
import { buildGoalProgress, type GoalBlockEvidence, type GoalMetricObservation, type GoalProcess, type GoalTaskEvidence } from './goalProgress.js';

const SEED = 'v2demo';
function sid(s: string) { return `${SEED}-${s}`; }

function vn(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 7, minute);
}

const H = 3_600_000;
const CURRENT_WEEK_MON = vn(2026, 8, 17);
function weekMonday(offset: number) { return CURRENT_WEEK_MON + offset * 7 * 86_400_000; }

const NOW = new Date(vn(2026, 8, 18, 14, 0));

function doneTask(id: string, processId: string | null, completedMs: number): GoalTaskEvidence {
  return { id: sid(id), title: id, goalId: 'g', goalProcessId: processId ? sid(processId) : null, projectId: null, status: 'DONE', dueAt: null, completedAt: new Date(completedMs).toISOString() };
}

function todoTask(id: string, processId: string | null): GoalTaskEvidence {
  return { id: sid(id), title: id, goalId: 'g', goalProcessId: processId ? sid(processId) : null, projectId: null, status: 'INBOX', dueAt: null, completedAt: null };
}

function block(id: string, taskId: string, startMs: number, endMs: number): GoalBlockEvidence {
  return { id: sid(id), taskId: sid(taskId), startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString(), durationMinutes: Math.round((endMs - startMs) / 60_000) };
}

describe('IELTS Goal Progress — current week', () => {
  const processes: GoalProcess[] = [
    { id: sid('proc-ielts-speaking'), name: 'Speaking Practice', measurementType: 'COUNT', targetValue: 3, period: 'WEEK', active: true },
    { id: sid('proc-ielts-writing'), name: 'Writing Practice', measurementType: 'COUNT', targetValue: 2, period: 'WEEK', active: true },
    { id: sid('proc-ielts-study'), name: 'English Study', measurementType: 'DURATION', targetValue: 3, unit: 'h', period: 'WEEK', active: true },
  ];

  const tasks: GoalTaskEvidence[] = [
    doneTask('speak-1', 'proc-ielts-speaking', vn(2026, 8, 17, 19, 0)),
    doneTask('speak-2', 'proc-ielts-speaking', vn(2026, 8, 18, 11, 0)),
    todoTask('speak-3', 'proc-ielts-speaking'),
    doneTask('write-1', 'proc-ielts-writing', vn(2026, 8, 18, 10, 0)),
    todoTask('write-2', 'proc-ielts-writing'),
    doneTask('study-1', 'proc-ielts-study', vn(2026, 8, 17, 21, 0)),
    doneTask('study-2', 'proc-ielts-study', vn(2026, 8, 19, 21, 30)),
    todoTask('study-3', 'proc-ielts-study'),
  ];

  const blocks: GoalBlockEvidence[] = [
    block('blk-1', 'study-1', vn(2026, 8, 17, 20, 0), vn(2026, 8, 17, 21, 0)),
    block('blk-2', 'study-2', vn(2026, 8, 19, 20, 0), vn(2026, 8, 19, 21, 30)),
    block('blk-3', 'study-3', vn(2026, 8, 22, 9, 0), vn(2026, 8, 22, 10, 0)),
  ];

  const observations: GoalMetricObservation[] = [
    { id: '1', observedAt: '2026-07-15T00:00:00Z', value: 6.0 },
    { id: '2', observedAt: '2026-08-10T00:00:00Z', value: 6.0 },
  ];

  const result = buildGoalProgress(processes, observations, tasks, blocks, NOW);

  it('Speaking: 2 completed / 3 target', () => {
    const s = result.processes.find(p => p.name === 'Speaking Practice')!;
    expect(s.thisWeek.completed).toBe(2);
    expect(s.thisWeek.target).toBe(3);
  });

  it('Writing: 1 completed / 2 target', () => {
    const w = result.processes.find(p => p.name === 'Writing Practice')!;
    expect(w.thisWeek.completed).toBe(1);
    expect(w.thisWeek.target).toBe(2);
  });

  it('English Study: 2.5h completed / 3h target, 3.5h planned', () => {
    const e = result.processes.find(p => p.name === 'English Study')!;
    expect(e.thisWeek.completed).toBe(2.5);
    expect(e.thisWeek.target).toBe(3);
    expect(e.thisWeek.planned).toBe(3.5);
  });

  it('completing speak-3 changes Speaking to 3/3', () => {
    const updatedTasks = tasks.map(t =>
      t.id === sid('speak-3')
        ? { ...t, status: 'DONE' as const, completedAt: new Date(vn(2026, 8, 20, 10, 0)).toISOString() }
        : t,
    );
    const r2 = buildGoalProgress(processes, observations, updatedTasks, blocks, NOW);
    expect(r2.processes.find(p => p.name === 'Speaking Practice')!.thisWeek.completed).toBe(3);
  });

  it('observation trend is stable (6.0 → 6.0)', () => {
    expect(result.observationTrend).toBe('stable');
  });
});

describe('Backend Job Goal Progress — current week', () => {
  const processes: GoalProcess[] = [
    { id: sid('proc-be-apps'), name: 'Quality Applications', measurementType: 'COUNT', targetValue: 5, period: 'WEEK', active: true },
    { id: sid('proc-be-tech'), name: 'Technical Preparation', measurementType: 'DURATION', targetValue: 3, unit: 'h', period: 'WEEK', active: true },
    { id: sid('proc-be-mock'), name: 'Mock Interview', measurementType: 'COUNT', targetValue: 1, period: 'WEEK', active: true },
  ];

  const tasks: GoalTaskEvidence[] = [
    doneTask('app-1', 'proc-be-apps', vn(2026, 8, 17, 10, 0)),
    doneTask('app-2', 'proc-be-apps', vn(2026, 8, 17, 11, 0)),
    doneTask('app-3', 'proc-be-apps', vn(2026, 8, 18, 9, 0)),
    doneTask('app-4', 'proc-be-apps', vn(2026, 8, 18, 10, 0)),
    todoTask('app-5', 'proc-be-apps'),
    doneTask('tech-1', 'proc-be-tech', vn(2026, 8, 17, 20, 30)),
    doneTask('tech-2', 'proc-be-tech', vn(2026, 8, 19, 20, 30)),
    todoTask('tech-3', 'proc-be-tech'),
    doneTask('mock-1', 'proc-be-mock', vn(2026, 8, 18, 15, 0)),
  ];

  const blocks: GoalBlockEvidence[] = [
    block('blk-1', 'tech-1', vn(2026, 8, 17, 19, 0), vn(2026, 8, 17, 20, 30)),
    block('blk-2', 'tech-2', vn(2026, 8, 19, 19, 0), vn(2026, 8, 19, 20, 30)),
    block('blk-3', 'tech-3', vn(2026, 8, 22, 14, 0), vn(2026, 8, 22, 15, 0)),
  ];

  const result = buildGoalProgress(processes, [], tasks, blocks, NOW);

  it('Applications: 4 completed / 5 target', () => {
    const a = result.processes.find(p => p.name === 'Quality Applications')!;
    expect(a.thisWeek.completed).toBe(4);
    expect(a.thisWeek.target).toBe(5);
  });

  it('Technical Preparation: 3h completed / 3h target, 4h planned', () => {
    const t = result.processes.find(p => p.name === 'Technical Preparation')!;
    expect(t.thisWeek.completed).toBe(3);
    expect(t.thisWeek.target).toBe(3);
    expect(t.thisWeek.planned).toBe(4);
  });

  it('Mock Interview: 1 completed / 1 target', () => {
    const m = result.processes.find(p => p.name === 'Mock Interview')!;
    expect(m.thisWeek.completed).toBe(1);
    expect(m.thisWeek.target).toBe(1);
  });

  it('completing app-5 changes Applications to 5/5', () => {
    const updatedTasks = tasks.map(t =>
      t.id === sid('app-5')
        ? { ...t, status: 'DONE' as const, completedAt: new Date(vn(2026, 8, 20, 10, 0)).toISOString() }
        : t,
    );
    const r2 = buildGoalProgress(processes, [], updatedTasks, blocks, NOW);
    expect(r2.processes.find(p => p.name === 'Quality Applications')!.thisWeek.completed).toBe(5);
  });

  it('changing tech block duration updates planned', () => {
    const updatedBlocks = blocks.map(b =>
      b.id === sid('blk-1')
        ? { ...b, endAt: new Date(vn(2026, 8, 17, 21, 0)).toISOString(), durationMinutes: 120 }
        : b,
    );
    const r2 = buildGoalProgress(processes, [], tasks, updatedBlocks, NOW);
    const t = r2.processes.find(p => p.name === 'Technical Preparation')!;
    expect(t.thisWeek.planned).toBe(4.5);
    expect(t.thisWeek.completed).toBe(3.5);
  });
});
