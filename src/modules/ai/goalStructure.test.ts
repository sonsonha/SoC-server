import { describe, expect, it } from 'vitest';
import {
  goalStructureSuggestionSchema,
} from './goalStructureSchema.js';
import {
  exportGoalFullContextMarkdown,
  exportSuggestionMarkdown,
} from './goalContextExport.js';
import { FakeLlmProvider } from '../../infrastructure/providers/llm/fakeLlmProvider.js';

describe('goalStructureSuggestionSchema', () => {
  it('accepts a valid job-style suggestion from FakeLlmProvider', async () => {
    const fake = new FakeLlmProvider();
    const raw = await fake.structureGoal!(
      'Title: Get a Backend Developer Job\nTarget date: 2026-11-30',
    );
    const parsed = goalStructureSuggestionSchema.parse(raw);
    expect(parsed.projects.length).toBeGreaterThan(0);
    expect(parsed.processes.every((p) => p.period === 'WEEK')).toBe(true);
  });

  it('rejects malformed model output', () => {
    const result = goalStructureSuggestionSchema.safeParse({
      projects: [],
      metrics: [],
      milestones: [],
      processes: [],
      nextActions: [],
      assumptions: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('goal context exporters', () => {
  it('exports suggestion markdown without ids or secrets', () => {
    const md = exportSuggestionMarkdown({
      title: 'Get a Backend Developer Job',
      why: 'Career stability',
      targetDate: '2026-11-30',
      aiContext: 'BACKGROUND\n- Engineer',
      suggestion: {
        outcome: { statement: 'Receive one suitable offer.', confidence: 'HIGH' },
        metrics: [{
          name: 'Offers',
          metricType: 'COUNT',
          currentValue: 0,
          targetValue: 1,
          confidence: 'HIGH',
        }],
        milestones: [{ title: 'CV ready' }],
        processes: [{
          name: 'Quality Applications',
          metricType: 'COUNT',
          targetValue: 5,
          period: 'WEEK',
          confidence: 'HIGH',
        }],
        projects: [{ title: 'Job Applications', purpose: 'Pipeline' }],
        timeProtectedMinutesPerWeek: 180,
        nextActions: [{ title: 'Research 3 companies' }],
        assumptions: ['Baseline experience exists'],
      },
    });
    expect(md).toContain('Get a Backend Developer Job');
    expect(md).toContain('Quality Applications');
    expect(md).toContain('Job Applications');
    expect(md).toContain('BACKGROUND');
    expect(md).not.toMatch(/Bearer |refresh_token|google_sub|pos_session/);
    expect(md).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('exports full Goal context with milestones processes projects tasks', () => {
    const md = exportGoalFullContextMarkdown({
      aiContext: 'CAREER\n- Backend',
      goal: {
        title: 'Get a Backend Developer Job',
        focusType: 'FOCUS',
        outcome: 'Receive one suitable offer',
        metric: 'Current: 0\nTarget: 1',
        targetDate: '2026-11-30',
        why: 'Stability',
      },
      milestones: [
        { title: 'CV ready', status: 'done' },
        { title: 'Interview pipeline', status: 'current' },
      ],
      processes: [{ name: 'Quality Applications', completed: 4, planned: 5, target: 5, unit: 'apps' }],
      projects: [{ title: 'Job Applications', purpose: 'Pipeline', nextAction: 'Apply to 2 roles' }],
      tasks: [{ title: 'Research 3 companies', dueHorizon: 'WEEK', scheduled: false, done: false }],
      timeProtectedMinutes: 180,
      progress: { consistencyMetWeeks: 7, consistencyTotalWeeks: 8, insight: 'Steady' },
      reflection: null,
    });
    expect(md).toContain('Classification:\nFOCUS');
    expect(md).toContain('[x] CV ready');
    expect(md).toContain('[>] Interview pipeline');
    expect(md).toContain('Quality Applications');
    expect(md).toContain('Job Applications');
    expect(md).toContain('Research 3 companies — WEEK — unscheduled');
    expect(md).toContain('7 / 8 weeks');
    expect(md).not.toMatch(/Bearer |token|calendarId/);
  });
});

describe('FakeLlmProvider.structureGoal isolation shape', () => {
  it('does not invent a million-dollar metric for vague independence goals', async () => {
    const fake = new FakeLlmProvider();
    const raw = await fake.structureGoal!('Title: Become financially independent');
    const parsed = goalStructureSuggestionSchema.parse(raw);
    const needsDecision = parsed.metrics.some((m) => m.needsUserDecision);
    expect(needsDecision).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/1000000|1,000,000/);
  });
});
