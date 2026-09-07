import { describe, expect, it } from 'vitest';
import {
  OWNER_WEEK_PLAN_READING_TASK,
  OWNER_WEEK_PLAN_SESSION_SPECS,
} from './seedOwnerWeekPlan.js';

describe('owner week plan specs', () => {
  it('does not place personal Sessions inside Mon–Fri 10:00–18:00', () => {
    for (const spec of OWNER_WEEK_PLAN_SESSION_SPECS) {
      const weekday = new Date(`${spec.date}T12:00:00+07:00`).getUTCDay();
      // getUTCDay with +07 noon: Mon=1 … Fri=5
      const isWeekday = weekday >= 1 && weekday <= 5;
      if (!isWeekday) continue;
      const start = spec.startHour * 60 + spec.startMinute;
      const end = spec.endHour * 60 + spec.endMinute;
      const workStart = 10 * 60;
      const workEnd = 18 * 60;
      expect(end <= workStart || start >= workEnd, `${spec.key} overlaps 10–18`).toBe(true);
    }
  });

  it('creates one Reading Task with Definition of Done', () => {
    expect(OWNER_WEEK_PLAN_READING_TASK.title).toMatch(/chapter/i);
    expect(OWNER_WEEK_PLAN_READING_TASK.definitionOfDone).toMatch(/5 useful ideas/i);
  });

  it('is idempotent by stable task+time keys', () => {
    const keys = OWNER_WEEK_PLAN_SESSION_SPECS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
