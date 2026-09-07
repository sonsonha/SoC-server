import { describe, expect, it } from 'vitest';
import { OWNER_TASK_FOUNDATION_SPECS } from './seedOwnerTaskFoundation.js';

describe('owner task foundation specs', () => {
  it('includes exactly the approved 11 foundation titles', () => {
    expect(OWNER_TASK_FOUNDATION_SPECS).toHaveLength(11);
    expect(OWNER_TASK_FOUNDATION_SPECS.map((s) => s.title)).toEqual([
      'Daily Review & Tomorrow Prep',
      'Weekly Review & Next Week Prep',
      'Bedtime Checkpoint',
      'Wake-up Checkpoint',
      'Complete 3 Exercise & Movement sessions this week',
      'Finalize target role profile and shortlist 15–20 suitable roles',
      'Ship backend-focused CV v1',
      'Run backend interview calibration and identify top 3 gaps',
      'Submit 4 quality applications to suitable roles',
      'Send 2 meaningful professional outreaches',
      'Establish IELTS diagnostic baseline',
    ]);
  });

  it('does not seed Explore, Finance daily, or Learning Tasks', () => {
    const blob = OWNER_TASK_FOUNDATION_SPECS.map((s) => `${s.title} ${s.projectTitle}`).join('\n').toLowerCase();
    expect(blob).not.toMatch(/opportunity exploration/);
    expect(blob).not.toMatch(/finance review/);
    expect(blob).not.toMatch(/\breading\b/);
    expect(blob).not.toMatch(/professional learning/);
    expect(blob).not.toMatch(/rover|drone/);
  });

  it('assigns Definition of Done only to Job/IELTS finite Tasks', () => {
    const withDod = OWNER_TASK_FOUNDATION_SPECS.filter((s) => s.definitionOfDone);
    expect(withDod.every((s) => s.kind === 'finite')).toBe(true);
    expect(withDod).toHaveLength(6);
  });

  it('does not invent Daily Focus dates in specs', () => {
    expect(OWNER_TASK_FOUNDATION_SPECS.every((s) => !('dailyFocusDate' in s))).toBe(true);
  });
});
