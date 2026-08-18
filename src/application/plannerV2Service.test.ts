import { describe, expect, it } from 'vitest';
import {
  priorityFromDb,
  priorityToDb,
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
});
