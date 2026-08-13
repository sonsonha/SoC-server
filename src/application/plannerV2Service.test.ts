import { describe, expect, it } from 'vitest';
import {
  priorityFromDb,
  priorityToDb,
  taskStatusFromDb,
} from './plannerV2Service.js';

describe('Planner V2 mappings', () => {
  it('maps planner priority without leaking legacy integer semantics', () => {
    expect(priorityToDb('HIGH')).toBe(1);
    expect(priorityToDb('NORMAL')).toBe(2);
    expect(priorityToDb('LOW')).toBe(3);
    expect(priorityFromDb(1)).toBe('HIGH');
    expect(priorityFromDb(3)).toBe('LOW');
  });

  it('normalizes legacy task statuses for the calendar-first UI', () => {
    expect(taskStatusFromDb('TODO')).toBe('INBOX');
    expect(taskStatusFromDb('WAITING')).toBe('INBOX');
    expect(taskStatusFromDb('SCHEDULED')).toBe('SCHEDULED');
    expect(taskStatusFromDb('RESCHEDULED')).toBe('SCHEDULED');
    expect(taskStatusFromDb('DONE')).toBe('DONE');
  });
});
