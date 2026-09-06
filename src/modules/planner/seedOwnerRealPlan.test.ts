import { describe, expect, it } from 'vitest';
import {
  normalizePlanTitle,
  OWNER_REAL_PLAN_GOAL_SPECS,
  OWNER_REAL_PLAN_PROJECT_SPECS,
} from './seedOwnerRealPlan.js';

describe('seedOwnerRealPlan matching helpers', () => {
  it('normalizes titles for alias matching', () => {
    expect(normalizePlanTitle('IELTS 7.0')).toBe('ielts 7 0');
    expect(normalizePlanTitle('Drone / Remote ID')).toBe('drone remote id');
  });

  it('defines exactly six Goals and fifteen Projects', () => {
    expect(OWNER_REAL_PLAN_GOAL_SPECS).toHaveLength(6);
    expect(OWNER_REAL_PLAN_PROJECT_SPECS).toHaveLength(15);
  });

  it('keeps Work projects unlinked and FOCUS Goals intentionally small', () => {
    const focus = OWNER_REAL_PLAN_GOAL_SPECS.filter((g) => g.focusType === 'FOCUS');
    expect(focus.map((g) => g.key).sort()).toEqual(['ielts', 'job']);
    const work = OWNER_REAL_PLAN_PROJECT_SPECS.filter((p) => p.projectContext === 'WORK');
    expect(work.every((p) => p.goalKey === null)).toBe(true);
    expect(work.map((p) => p.title).sort()).toEqual(['Drone / Remote ID', 'Landfill Rover']);
  });

  it('tags Habit projects correctly (Opportunity Exploration is STANDARD)', () => {
    const habits = OWNER_REAL_PLAN_PROJECT_SPECS.filter((p) => p.projectType === 'HABIT');
    expect(habits.map((p) => p.title).sort()).toEqual([
      'Exercise & Movement',
      'Financial Tracking & Review',
      'Personal OS Review & Planning',
      'Professional Learning',
      'Reading',
      'Sleep Routine',
    ]);
    const opportunity = OWNER_REAL_PLAN_PROJECT_SPECS.find((p) => p.title === 'Opportunity Exploration');
    expect(opportunity?.projectType).toBe('STANDARD');
  });

  it('defines IELTS milestones with first as current checkpoint semantics in seed titles', () => {
    const ielts = OWNER_REAL_PLAN_GOAL_SPECS.find((g) => g.key === 'ielts');
    expect(ielts?.milestoneTitles).toEqual([
      'Diagnostic baseline established',
      'Writing and Speaking weaknesses identified',
      'Mock performance reaches approximately Band 6.5 readiness',
      'Full mock reaches target-level readiness',
      'IELTS exam booked',
      'IELTS exam completed',
      'IELTS Overall Band 7.0 achieved',
    ]);
    expect(ielts?.metric).toMatch(/Baseline:\s*Not set/i);
    expect(ielts?.metric).toMatch(/Target:\s*7\.0/);
  });

  it('does not treat finance stale threshold as an outcome target string', () => {
    const finance = OWNER_REAL_PLAN_GOAL_SPECS.find((g) => g.key === 'finance');
    expect(finance?.metric.toLowerCase()).toMatch(/integration pending|tracking status/);
    expect(finance?.metric).not.toMatch(/^\s*0\s*\/\s*5/);
  });
});