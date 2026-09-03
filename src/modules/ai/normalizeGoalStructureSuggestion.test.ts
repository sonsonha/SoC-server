import { describe, expect, it } from 'vitest';
import { goalStructureSuggestionSchema } from './goalStructureSchema.js';
import { normalizeGoalStructureSuggestion } from './normalizeGoalStructureSuggestion.js';

function baseValid() {
  return {
    outcome: { statement: 'Receive a backend offer.', confidence: 'HIGH' },
    metrics: [],
    milestones: [{ title: 'CV ready' }],
    processes: [{
      name: 'Quality Applications',
      metricType: 'COUNT',
      targetValue: 5,
      period: 'WEEK',
      confidence: 'HIGH',
    }],
    projects: [{ title: 'Job Applications' }],
    nextActions: [],
    assumptions: [],
  };
}

describe('normalizeGoalStructureSuggestion', () => {
  it('accepts zero Systems for goals that only need finite Projects', () => {
    const parsed = goalStructureSuggestionSchema.parse(normalizeGoalStructureSuggestion({
      projects: [{ title: 'Submit application' }],
      systems: [],
    }));
    expect(parsed.systems).toEqual([]);
  });
  it('normalizes lowercase enums, weekly period, and numeric strings', () => {
    const raw = {
      outcome: { statement: 'Get hired', confidence: 'high' },
      metrics: [{
        name: 'Offers',
        metricType: 'count',
        currentValue: '0',
        targetValue: '1',
        confidence: 'medium',
      }],
      milestones: [{ title: 'Ready', description: '', rationale: null }],
      processes: [{
        name: 'Study',
        metricType: 'hours',
        targetValue: '180',
        period: 'weekly',
        unit: 'min',
        confidence: 'low',
      }],
      projects: [{ title: 'Prep', purpose: '', suggestedDefaultProcessName: '' }],
      timeProtectedMinutesPerWeek: '180',
      nextActions: [{ title: 'Apply', estimatedMinutes: '45', projectTitle: '' }],
      reviewCadence: 'weekly',
      assumptions: ['Has experience'],
    };
    const normalized = normalizeGoalStructureSuggestion(raw);
    const parsed = goalStructureSuggestionSchema.parse(normalized);
    expect(parsed.outcome?.confidence).toBe('HIGH');
    expect(parsed.metrics[0]?.metricType).toBe('COUNT');
    expect(parsed.metrics[0]?.currentValue).toBe(0);
    expect(parsed.processes[0]?.metricType).toBe('DURATION');
    expect(parsed.processes[0]?.period).toBe('WEEK');
    expect(parsed.processes[0]?.targetValue).toBe(180);
    expect(parsed.timeProtectedMinutesPerWeek).toBe(180);
    expect(parsed.nextActions[0]?.estimatedMinutes).toBe(45);
    expect(parsed.reviewCadence).toBe('WEEKLY');
    expect(parsed.projects[0]?.suggestedDefaultProcessName).toBeNull();
  });

  it('fills omitted optional arrays with [] but keeps missing projects invalid', () => {
    const withOmitted = normalizeGoalStructureSuggestion({
      outcome: { statement: 'X', confidence: 'HIGH' },
      projects: [{ title: 'P' }],
    });
    const ok = goalStructureSuggestionSchema.parse(withOmitted);
    expect(ok.metrics).toEqual([]);
    expect(ok.milestones).toEqual([]);
    expect(ok.processes).toEqual([]);
    expect(ok.nextActions).toEqual([]);
    expect(ok.assumptions).toEqual([]);

    const noProjects = normalizeGoalStructureSuggestion({
      outcome: { statement: 'X', confidence: 'HIGH' },
      metrics: [],
      projects: [],
    });
    expect(goalStructureSuggestionSchema.safeParse(noProjects).success).toBe(false);
  });

  it('accepts optional null fields', () => {
    const raw = {
      ...baseValid(),
      outcome: { statement: 'Offer', confidence: 'HIGH' },
      metrics: [{
        name: 'M',
        metricType: 'CUSTOM',
        currentValue: null,
        targetValue: null,
        unit: null,
        rationale: null,
        confidence: 'LOW',
      }],
      projects: [{
        title: 'P',
        purpose: null,
        suggestedDefaultProcessName: null,
        rationale: null,
      }],
      timeProtectedMinutesPerWeek: null,
      reviewCadence: null,
    };
    expect(goalStructureSuggestionSchema.parse(normalizeGoalStructureSuggestion(raw)).projects).toHaveLength(1);
  });

  it('rejects unknown enums after normalization', () => {
    const raw = {
      ...baseValid(),
      processes: [{
        name: 'X',
        metricType: 'SPRINTS',
        targetValue: 1,
        period: 'WEEK',
        confidence: 'HIGH',
      }],
    };
    const parsed = goalStructureSuggestionSchema.safeParse(normalizeGoalStructureSuggestion(raw));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join('.').includes('metricType'))).toBe(true);
    }
  });

  it('does not invent projects when key is omitted', () => {
    const normalized = normalizeGoalStructureSuggestion({
      outcome: { statement: 'X', confidence: 'HIGH' },
      metrics: [],
      milestones: [],
      processes: [],
    });
    expect(goalStructureSuggestionSchema.safeParse(normalized).success).toBe(false);
  });
});
