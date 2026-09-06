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

  it('tags Habit projects correctly', () => {
    const habits = OWNER_REAL_PLAN_PROJECT_SPECS.filter((p) => p.projectType === 'HABIT');
    expect(habits.map((p) => p.title).sort()).toEqual([
      'Exercise & Movement',
      'Financial Tracking & Review',
      'Opportunity Exploration',
      'Personal OS Review & Planning',
      'Professional Learning',
      'Reading',
      'Sleep Routine',
    ]);
  });
});
