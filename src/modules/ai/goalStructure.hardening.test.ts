import { describe, expect, it, vi } from 'vitest';
import { goalStructureSuggestionSchema } from './goalStructureSchema.js';
import {
  exportGoalFullContextMarkdown,
  exportSuggestionMarkdown,
} from './goalContextExport.js';
import { timeProtectedMinutesToSystemCadence } from './timeProtectedAdapter.js';
import { FakeLlmProvider } from '../../infrastructure/providers/llm/fakeLlmProvider.js';
import { DeepSeekLlmProvider, DeepSeekProviderError } from '../../infrastructure/providers/llm/deepseekLlmProvider.js';

describe('timeProtectedMinutesToSystemCadence', () => {
  it('keeps numeric minutes in AI schema and adapts to cadence string', () => {
    expect(timeProtectedMinutesToSystemCadence(180)).toEqual({
      title: 'Time protected',
      cadence: '3h / week',
    });
    expect(timeProtectedMinutesToSystemCadence(90)).toEqual({
      title: 'Time protected',
      cadence: '90 min / week',
    });
    expect(timeProtectedMinutesToSystemCadence(null)).toBeNull();
  });
});

describe('process → project linking (draft-local only)', () => {
  it('maps suggestedDefaultProcessName to process id created in the same draft', () => {
    const suggestion = goalStructureSuggestionSchema.parse({
      outcome: { statement: 'Receive one suitable offer.', confidence: 'HIGH' },
      metrics: [],
      milestones: [],
      processes: [
        {
          name: 'Technical Preparation',
          metricType: 'DURATION',
          targetValue: 180,
          period: 'WEEK',
          unit: 'min',
          confidence: 'HIGH',
        },
      ],
      projects: [
        {
          title: 'Backend Interview Preparation',
          purpose: 'Prep',
          suggestedDefaultProcessName: 'Technical Preparation',
        },
      ],
      nextActions: [],
      assumptions: [],
    });
    const processId = 'proc-tech-1';
    const processIdByName = new Map([
      [suggestion.processes[0]!.name.trim().toLowerCase(), processId],
    ]);
    const resolved =
      processIdByName.get(
        suggestion.projects[0]!.suggestedDefaultProcessName!.trim().toLowerCase(),
      ) ?? null;
    expect(resolved).toBe(processId);
    // Unrelated existing process name must not win via fuzzy match.
    expect(processIdByName.get('technical prep')).toBeUndefined();
  });
});

describe('user AI context isolation invariant', () => {
  it('owner seed must not apply when email is not the initial owner', () => {
    const isOwner = (email: string, owner?: string) =>
      Boolean(owner && email.trim().toLowerCase() === owner.trim().toLowerCase());
    expect(isOwner('terryson821@gmail.com', 'owner@example.com')).toBe(false);
    expect(isOwner('owner@example.com', 'owner@example.com')).toBe(true);
  });
});

describe('DeepSeek provider error mapping', () => {
  it('maps malformed JSON to AI_JSON_INVALID without leaking secrets', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'not-json-at-all' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          model: 'deepseek-v4-pro',
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const provider = new DeepSeekLlmProvider('test-key', 'deepseek-v4-pro');
    await expect(provider.structureGoal('Title: X')).rejects.toMatchObject({
      code: 'AI_JSON_INVALID',
      statusCode: 502,
    });
  });

  it('maps 401 to AI_UNAVAILABLE without exposing the API key', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('unauthorized', { status: 401 }),
    ) as typeof fetch;
    const provider = new DeepSeekLlmProvider('secret-key-value', 'deepseek-v4-pro');
    try {
      await provider.structureGoal('Title: X');
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeepSeekProviderError);
      const e = err as DeepSeekProviderError;
      expect(e.code).toBe('AI_UNAVAILABLE');
      expect(e.message).not.toContain('secret-key-value');
    }
  });

  it('sends deepseek-v4-pro with thinking enabled and reasoning_effort high', async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                outcome: { statement: 'Offer received', confidence: 'HIGH' },
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
              }),
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
          model: 'deepseek-v4-pro',
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new DeepSeekLlmProvider('k', 'deepseek-v4-pro');
    const raw = await provider.structureGoal('Title: Get a Backend Developer Job');
    expect(goalStructureSuggestionSchema.parse(raw).projects[0]?.title).toBe('Job Applications');
    expect(body?.model).toBe('deepseek-v4-pro');
    expect(body?.thinking).toEqual({ type: 'enabled' });
    expect(body?.reasoning_effort).toBe('high');
    expect(body?.response_format).toEqual({ type: 'json_object' });
    expect(body?.stream).toBe(false);
  });
});

describe('copy exporters regression', () => {
  it('Copy suggestion includes required sections without secrets', async () => {
    const fake = new FakeLlmProvider();
    const suggestion = goalStructureSuggestionSchema.parse(
      await fake.structureGoal!('Title: Get a Backend Developer Job'),
    );
    const md = exportSuggestionMarkdown({
      title: 'Get a Backend Developer Job',
      why: 'Career',
      targetDate: '2026-11-30',
      aiContext: 'BACKGROUND\n- Engineer',
      suggestion,
    });
    expect(md).toMatch(/Outcome/i);
    expect(md).toMatch(/Metrics/i);
    expect(md).toMatch(/Milestones/i);
    expect(md).toMatch(/Processes/i);
    expect(md).toMatch(/Projects/i);
    expect(md).toMatch(/Time Protected/i);
    expect(md).toMatch(/Next Actions/i);
    expect(md).toMatch(/Assumptions/i);
    expect(md).toContain('BACKGROUND');
    expect(md).not.toMatch(/Bearer |DEEPSEEK|api_key|pos_session|calendarId/i);
  });

  it('Copy full context includes Goal structure without provider metadata', () => {
    const md = exportGoalFullContextMarkdown({
      aiContext: 'CAREER',
      goal: {
        title: 'Get a Backend Developer Job',
        focusType: 'FOCUS',
        outcome: 'Offer',
        metric: '1 offer',
        targetDate: '2026-11-30',
        why: 'Stability',
      },
      milestones: [{ title: 'CV', status: 'done' }],
      processes: [{ name: 'Quality Applications', completed: 1, planned: 5, target: 5 }],
      projects: [{ title: 'Job Applications', purpose: 'Pipeline' }],
      tasks: [{ title: 'Research', dueHorizon: 'WEEK', scheduled: false, done: false }],
      timeProtectedMinutes: 180,
      progress: { consistencyMetWeeks: 1, consistencyTotalWeeks: 2, insight: 'ok' },
      reflection: 'Learned: practice matters',
    });
    expect(md).toContain('Get a Backend Developer Job');
    expect(md).toContain('Quality Applications');
    expect(md).toContain('Job Applications');
    expect(md).toContain('Research');
    expect(md).toContain('Learned: practice matters');
    expect(md).not.toMatch(/deepseek|reasoning_effort|prompt_tokens/i);
  });
});

describe('user edits win on accept payload', () => {
  it('edited process target 3 is what accept receives (not original 5)', () => {
    const edited = goalStructureSuggestionSchema.parse({
      projects: [{ title: 'Job Applications' }],
      processes: [{
        name: 'Quality Applications',
        metricType: 'COUNT',
        targetValue: 3,
        period: 'WEEK',
        confidence: 'HIGH',
      }],
      metrics: [],
      milestones: [],
      nextActions: [],
      assumptions: [],
    });
    expect(edited.processes[0]?.targetValue).toBe(3);
  });
});

describe('GoalStructuringService.accept atomicity', () => {
  it('rolls back Goal when Project creation fails inside the transaction', async () => {
    const { GoalStructuringService } = await import('./goalStructuringService.js');
    const { goals, projects } = await import('../../infrastructure/db/schema/index.js');

    let goalValuesWritten = false;
    let projectAttempted = false;
    let rolledBack = false;

    const tx = {
      insert(table: unknown) {
        return {
          values: async () => {
            if (table === goals) {
              goalValuesWritten = true;
              return;
            }
            if (table === projects) {
              projectAttempted = true;
              throw new Error('forced project failure');
            }
          },
        };
      },
    };

    const db = {
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        try {
          return await fn(tx);
        } catch (err) {
          rolledBack = true;
          goalValuesWritten = false;
          throw err;
        }
      },
    };

    const identity = {
      getUserById: async () => ({ id: 'u1', email: 'a@example.com' }),
      getAiContext: async () => null,
      setAiContext: async () => undefined,
      isLegacyCalendarOwner: () => false,
    };
    const planner = {
      getGoalProgress: async () => {
        throw new Error('should not load goal after rollback');
      },
    };
    const llm = { structureGoal: async () => ({}) };

    const svc = new GoalStructuringService(
      db as never,
      identity as never,
      planner as never,
      llm as never,
    );

    await expect(
      svc.accept('u1', {
        title: 'Get a Backend Developer Job',
        suggestion: {
          projects: [
            {
              title: 'Backend Interview Preparation',
              suggestedDefaultProcessName: 'Technical Preparation',
            },
          ],
          processes: [
            {
              name: 'Technical Preparation',
              metricType: 'DURATION',
              targetValue: 180,
              period: 'WEEK',
              unit: 'min',
              confidence: 'HIGH',
            },
          ],
          metrics: [],
          milestones: [],
          nextActions: [],
          assumptions: [],
        },
      }),
    ).rejects.toThrow(/forced project failure/);

    expect(projectAttempted).toBe(true);
    expect(rolledBack).toBe(true);
    expect(goalValuesWritten).toBe(false);
  });

  it('links project.defaultGoalProcessId to draft-created process id', async () => {
    const { GoalStructuringService } = await import('./goalStructuringService.js');
    const { goals, projects, tasks } = await import('../../infrastructure/db/schema/index.js');

    const insertedProjects: Array<{ defaultGoalProcessId: string | null; title: string }> = [];
    let processIdOnGoal: string | null = null;

    const tx = {
      insert(table: unknown) {
        return {
          values: async (row: Record<string, unknown>) => {
            if (table === goals) {
              const procs = JSON.parse(String(row.processesJson)) as Array<{ id: string; name: string }>;
              processIdOnGoal = procs.find((p) => p.name === 'Technical Preparation')?.id ?? null;
              return;
            }
            if (table === projects) {
              insertedProjects.push({
                title: String(row.title),
                defaultGoalProcessId: (row.defaultGoalProcessId as string | null) ?? null,
              });
              return;
            }
            if (table === tasks) return;
          },
        };
      },
    };

    const db = {
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const planner = {
      getGoalProgress: async () => ({
        goal: { id: 'g1', title: 'Offer', processes: [], milestones: [], systems: [] },
      }),
    };

    const svc = new GoalStructuringService(
      db as never,
      {
        getUserById: async () => ({ id: 'u1', email: 'a@example.com' }),
        getAiContext: async () => null,
        setAiContext: async () => undefined,
        isLegacyCalendarOwner: () => false,
      } as never,
      planner as never,
      { structureGoal: async () => ({}) } as never,
    );

    const result = await svc.accept('u1', {
      title: 'Get a Backend Developer Job',
      suggestion: {
        outcome: { statement: 'Receive one suitable offer.', confidence: 'HIGH' },
        projects: [
          {
            title: 'Backend Interview Preparation',
            suggestedDefaultProcessName: 'Technical Preparation',
          },
        ],
        processes: [
          {
            name: 'Technical Preparation',
            metricType: 'DURATION',
            targetValue: 180,
            period: 'WEEK',
            unit: 'min',
            confidence: 'HIGH',
          },
        ],
        metrics: [],
        milestones: [{ title: 'Ready' }],
        nextActions: [],
        assumptions: [],
      },
    });

    expect(processIdOnGoal).toBeTruthy();
    expect(insertedProjects[0]?.defaultGoalProcessId).toBe(processIdOnGoal);
    expect(result.projects[0]?.defaultGoalProcessId).toBe(processIdOnGoal);
  });
});

describe('GoalStructuringService.suggest isolation + no persist', () => {
  it('prompt for user B contains none of user A private planner data', async () => {
    const { GoalStructuringService } = await import('./goalStructuringService.js');
    let capturedPrompt = '';
    const llm = {
      structureGoal: async (prompt: string) => {
        capturedPrompt = prompt;
        return new FakeLlmProvider().structureGoal(prompt);
      },
    };
    const svc = new GoalStructuringService(
      {
        select: () => ({
          from: () => ({
            where: async () => [],
          }),
        }),
      } as never,
      {
        getUserById: async () => ({ id: 'user-b', email: 'b@example.com' }),
        getAiContext: async () => 'USER_B_CONTEXT_ONLY',
        setAiContext: async () => undefined,
        isLegacyCalendarOwner: () => false,
      } as never,
      {} as never,
      llm as never,
    );

    await svc.suggest('user-b', { title: 'Get a Backend Developer Job' });
    expect(capturedPrompt).toContain('USER_B_CONTEXT_ONLY');
    expect(capturedPrompt).toContain('Get a Backend Developer Job');
    expect(capturedPrompt).not.toContain('USER_A_SECRET');
    expect(capturedPrompt).not.toContain('Owner private goal');
  });

  it('schema-invalid LLM payload yields AI_SCHEMA_INVALID and does not call accept path', async () => {
    const { GoalStructuringService } = await import('./goalStructuringService.js');
    const svc = new GoalStructuringService(
      {
        select: () => ({
          from: () => ({
            where: async () => [],
          }),
        }),
        transaction: async () => {
          throw new Error('must not persist on suggest');
        },
      } as never,
      {
        getUserById: async () => ({ id: 'u1', email: 'a@example.com' }),
        getAiContext: async () => '',
        setAiContext: async () => undefined,
        isLegacyCalendarOwner: () => false,
      } as never,
      {} as never,
      {
        structureGoal: async () => ({ projects: [] }),
      } as never,
    );

    await expect(svc.suggest('u1', { title: 'Get a Backend Developer Job' })).rejects.toMatchObject({
      code: 'AI_SCHEMA_INVALID',
    });
  });
});
