import { describe, expect, it } from 'vitest';
import { exportGoalFullContextMarkdown, exportSuggestionMarkdown } from './goalContextExport.js';
import { INITIAL_OWNER_AI_CONTEXT_DEFAULT } from './ownerAiContextDefault.js';
import { resolveUserAiContext } from './userAiContext.js';

const ownerEmail = 'owner@example.com';

describe('resolveUserAiContext', () => {
  it('returns the approved default for owner + NULL context', () => {
    const resolved = resolveUserAiContext({
      userEmail: ' Owner@Example.com ',
      savedContext: null,
      initialOwnerEmail: ownerEmail,
    });
    expect(resolved).toEqual({
      aiContext: INITIAL_OWNER_AI_CONTEXT_DEFAULT,
      isDefaultSeed: true,
    });
  });

  it('lets the owner saved context override the default', () => {
    const resolved = resolveUserAiContext({
      userEmail: ownerEmail,
      savedContext: 'OWNER SAVED CONTEXT',
      initialOwnerEmail: ownerEmail,
    });
    expect(resolved).toEqual({ aiContext: 'OWNER SAVED CONTEXT', isDefaultSeed: false });
  });

  it('returns empty for User B + NULL context, including when owner config is missing', () => {
    expect(resolveUserAiContext({
      userEmail: 'b@example.com',
      savedContext: null,
      initialOwnerEmail: ownerEmail,
    })).toEqual({ aiContext: '', isDefaultSeed: false });
    expect(resolveUserAiContext({
      userEmail: 'b@example.com',
      savedContext: null,
      initialOwnerEmail: undefined,
    })).toEqual({ aiContext: '', isDefaultSeed: false });
  });

  it("returns User B's own saved context", () => {
    const resolved = resolveUserAiContext({
      userEmail: 'b@example.com',
      savedContext: 'USER B CONTEXT',
      initialOwnerEmail: ownerEmail,
    });
    expect(resolved).toEqual({ aiContext: 'USER B CONTEXT', isDefaultSeed: false });
    expect(resolved.aiContext).not.toContain('HCMUT');
  });
});

describe('AI context export regressions', () => {
  const suggestion = {
    outcome: { statement: 'Achieve IELTS 7.0', confidence: 'HIGH' as const },
    metrics: [],
    milestones: [{ title: 'Complete a full diagnostic test' }],
    processes: [{
      name: 'IELTS deliberate practice',
      metricType: 'DURATION' as const,
      targetValue: 240,
      period: 'WEEK' as const,
      unit: 'min',
      confidence: 'HIGH' as const,
    }],
    projects: [{ title: 'IELTS preparation plan' }],
    nextActions: [{ title: 'Book a diagnostic test', estimatedMinutes: 30 }],
    assumptions: [],
  };

  it('Copy Context for owner IELTS Goal contains the resolved context, not (none)', () => {
    const { aiContext } = resolveUserAiContext({
      userEmail: ownerEmail,
      savedContext: null,
      initialOwnerEmail: ownerEmail,
    });
    const markdown = exportGoalFullContextMarkdown({
      aiContext,
      goal: { title: 'Achieve IELTS 7.0', focusType: 'FOCUS' },
      milestones: suggestion.milestones.map((item) => ({ ...item, status: 'current' })),
      processes: [{ name: 'IELTS deliberate practice', target: 240, unit: 'min' }],
      projects: [{ title: 'IELTS preparation plan' }],
      tasks: [{ title: 'Book a diagnostic test', scheduled: false, done: false }],
    });
    expect(markdown).toContain('Computer Engineering graduate from HCMUT');
    expect(markdown).toContain('Improve English / IELTS');
    expect(markdown).not.toMatch(/## User Context\s+\(none\)/);
  });

  it('Copy Context for empty User B remains (none)', () => {
    const { aiContext } = resolveUserAiContext({
      userEmail: 'b@example.com',
      savedContext: null,
      initialOwnerEmail: ownerEmail,
    });
    const markdown = exportGoalFullContextMarkdown({
      aiContext,
      goal: { title: 'Run a half marathon', focusType: 'FOCUS' },
      milestones: [],
      processes: [],
      projects: [],
      tasks: [],
    });
    expect(markdown).toMatch(/## User Context\s+\(none\)/);
    expect(markdown).not.toContain('HCMUT');
    expect(markdown).not.toContain('WordNote');
  });

  it('Copy Suggestion for owner uses the same resolved context', () => {
    const resolved = resolveUserAiContext({
      userEmail: ownerEmail,
      savedContext: null,
      initialOwnerEmail: ownerEmail,
    });
    const markdown = exportSuggestionMarkdown({
      title: 'Achieve IELTS 7.0',
      aiContext: resolved.aiContext,
      suggestion,
    });
    expect(markdown).toContain('Computer Engineering graduate from HCMUT');
    expect(markdown).toContain('Improve English / IELTS');
    expect(markdown).not.toMatch(/## User Context\s+\(none\)/);
  });
});
