import { describe, expect, it } from 'vitest';
import { directTaskCompletePolicy } from './sessionEvidence.js';

describe('Daily Focus does not bypass Session completion', () => {
  it('still blocks direct complete with zero sessions even if Daily Focus', () => {
    const dailyFocus = { dailyFocusDate: '2026-09-07', priority: 'P2' };
    const policy = directTaskCompletePolicy([]);
    expect(dailyFocus.dailyFocusDate).toBe('2026-09-07');
    expect(policy.allow).toBe(false);
    expect(policy.reason).toBe('ZERO_SESSIONS');
  });

  it('still blocks multi-session direct complete', () => {
    const policy = directTaskCompletePolicy([
      { id: 'a', status: 'PLANNED' },
      { id: 'b', status: 'PLANNED' },
    ]);
    expect(policy.allow).toBe(false);
    expect(policy.reason).toBe('MULTI_SESSION');
  });

  it('allows single-session complete regardless of Daily Focus', () => {
    const policy = directTaskCompletePolicy([{ id: 'a', status: 'PLANNED' }]);
    expect(policy.allow).toBe(true);
  });
});

describe('Definition of Done is optional', () => {
  it('allows null Definition of Done', () => {
    const task = { title: 'Buy toothpaste', definitionOfDone: null as string | null };
    expect(task.definitionOfDone).toBeNull();
    expect(task.title.length).toBeGreaterThan(0);
  });
});
