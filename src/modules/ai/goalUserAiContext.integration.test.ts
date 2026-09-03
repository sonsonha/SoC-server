import { beforeEach, describe, expect, it } from 'vitest';
import type { LlmProvider } from '../../infrastructure/providers/llm/types.js';
import { clearGoalStructureRateLimits, GoalStructuringService } from './goalStructuringService.js';

const validIeltsSuggestion = {
  outcome: { statement: 'Achieve IELTS 7.0', confidence: 'HIGH' },
  metrics: [{
    name: 'IELTS overall band',
    metricType: 'NUMBER',
    currentValue: null,
    targetValue: 7,
    unit: 'band',
    confidence: 'HIGH',
  }],
  milestones: [{ title: 'Baseline measured' }, { title: 'Target band demonstrated' }],
  processes: [{
    name: 'IELTS deliberate practice',
    metricType: 'DURATION',
    targetValue: 240,
    period: 'WEEK',
    unit: 'min',
    confidence: 'HIGH',
  }],
  projects: [{ title: 'IELTS preparation plan' }],
  nextActions: [{ title: 'Complete a diagnostic test', estimatedMinutes: 180 }],
  assumptions: [],
};

function emptyPlannerDb() {
  return {
    select: () => ({ from: () => ({ where: async () => [] }) }),
  } as never;
}

describe('Goal Structuring resolved AI Context', () => {
  beforeEach(() => clearGoalStructureRateLimits());

  it('puts the owner fallback into the DeepSeek prompt for an IELTS Goal', async () => {
    let prompt = '';
    const llm: Pick<LlmProvider, 'structureGoal'> = {
      structureGoal: async (value) => {
        prompt = value;
        return validIeltsSuggestion;
      },
    };
    const service = new GoalStructuringService(
      emptyPlannerDb(),
      {
        getUserById: async () => ({ id: 'owner', email: 'OWNER@example.com' }),
        getAiContext: async () => null,
        getInitialOwnerEmail: () => 'owner@example.com',
      } as never,
      {} as never,
      llm as never,
    );

    const result = await service.suggest('owner', { title: 'Achieve IELTS 7.0' });
    expect(prompt).toContain('Computer Engineering graduate from HCMUT');
    expect(prompt).toContain('Improve English / IELTS');
    expect(prompt).toContain('Treat User AI Context as background');
    expect(prompt).toContain('Title: Achieve IELTS 7.0');
    expect(JSON.stringify(result)).not.toMatch(/WordNote|Drone \/ Remote ID|Robotics/i);
  });

  it('does not put any owner context into the prompt for empty User B', async () => {
    let prompt = '';
    const service = new GoalStructuringService(
      emptyPlannerDb(),
      {
        getUserById: async () => ({ id: 'user-b', email: 'b@example.com' }),
        getAiContext: async () => null,
        getInitialOwnerEmail: () => 'owner@example.com',
      } as never,
      {} as never,
      {
        structureGoal: async (value: string) => {
          prompt = value;
          return validIeltsSuggestion;
        },
      } as never,
    );

    await service.suggest('user-b', { title: 'Achieve IELTS 7.0' });
    expect(prompt).toContain('USER AI CONTEXT\n(none provided)');
    expect(prompt).not.toContain('HCMUT');
    expect(prompt).not.toContain('WordNote');
    expect(prompt).not.toContain('Drone / Remote ID');
  });
});
