import { describe, expect, it } from 'vitest';
import {
  normalizeMilestoneStatus,
  parseGoalSystems,
  priorityFromDb,
  priorityToDb,
  reconcileMilestones,
  taskStatusFromDb,
} from './plannerV2Service.js';

describe('Planner V2 mappings', () => {
  it('maps Eisenhower priority levels and legacy aliases', () => {
    expect(priorityToDb('HIGH')).toBe(1);
    expect(priorityToDb('P1')).toBe(1);
    expect(priorityToDb('NORMAL')).toBe(2);
    expect(priorityToDb('P2')).toBe(2);
    expect(priorityToDb('LOW')).toBe(3);
    expect(priorityToDb('P3')).toBe(3);
    expect(priorityToDb('DROP')).toBe(4);
    expect(priorityToDb('P4')).toBe(4);
    expect(priorityFromDb(1)).toBe('P1');
    expect(priorityFromDb(2)).toBe('P2');
    expect(priorityFromDb(3)).toBe('P3');
    expect(priorityFromDb(4)).toBe('P4');
  });

  it('normalizes legacy task statuses for the calendar-first UI', () => {
    expect(taskStatusFromDb('TODO')).toBe('INBOX');
    expect(taskStatusFromDb('WAITING')).toBe('INBOX');
    expect(taskStatusFromDb('SCHEDULED')).toBe('SCHEDULED');
    expect(taskStatusFromDb('RESCHEDULED')).toBe('SCHEDULED');
    expect(taskStatusFromDb('DONE')).toBe('DONE');
  });

  it('normalizes milestone statuses and keeps currentMilestone consistent', () => {
    expect(normalizeMilestoneStatus('DONE')).toBe('done');
    expect(normalizeMilestoneStatus('ACTIVE')).toBe('current');
    expect(normalizeMilestoneStatus('PENDING')).toBe('pending');
    const reconciled = reconcileMilestones(
      [
        { id: 'm1', title: 'CV / profile ready', status: 'done' },
        { id: 'm2', title: 'Application pipeline started', status: 'done' },
        { id: 'm3', title: 'Interview pipeline', status: 'pending' },
        { id: 'm4', title: 'Offer', status: 'pending' },
      ],
      'm3',
    );
    expect(reconciled.map((item) => item.status)).toEqual(['done', 'done', 'current', 'pending']);
  });

  it('loads legacy and structured Goal systems without destructive rewriting', () => {
    const systems = parseGoalSystems(JSON.stringify([
      { id: 'legacy', title: 'Reading', cadence: '3h / week' },
      { id: 'structured', title: 'English Study', targetType: 'COUNT', targetValue: 5, unit: 'sessions', period: 'WEEK', durationWeeks: 8, preferredDays: null, status: 'PAUSED' },
    ]));
    expect(systems[0]).toMatchObject({ id: 'legacy', title: 'Reading', cadence: '3h / week', status: 'ACTIVE' });
    expect(systems[1]).toMatchObject({ id: 'structured', targetValue: 5, durationWeeks: 8, preferredDays: null, status: 'PAUSED' });
  });
});
