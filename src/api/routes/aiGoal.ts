import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceService } from '../../application/deviceService.js';
import type { AppConfig } from '../../config.js';
import { createPlannerAuthHook } from '../middleware/plannerAuth.js';
import { createPersonalOsUserHook } from '../middleware/personalOsAuth.js';
import type { IdentityService } from '../../modules/identity/identityService.js';
import type { GoalStructuringService } from '../../modules/ai/goalStructuringService.js';
import { goalStructureSuggestionSchema } from '../../modules/ai/goalStructureSchema.js';
import {
  exportGoalFullContextMarkdown,
  exportSuggestionMarkdown,
} from '../../modules/ai/goalContextExport.js';
import type { PlannerV2Service } from '../../application/plannerV2Service.js';

const suggestBody = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().max(4_000).optional(),
  why: z.string().max(4_000).optional(),
  targetDate: z.string().max(32).nullable().optional(),
});

const acceptBody = z.object({
  title: z.string().trim().min(1).max(240),
  why: z.string().max(10_000).optional(),
  targetDate: z.string().max(32).nullable().optional(),
  focusType: z.enum(['FOCUS', 'MAINTAIN', 'EXPLORE']).optional(),
  suggestion: goalStructureSuggestionSchema,
  selectedNextActionIndexes: z.array(z.number().int().nonnegative()).max(20).optional(),
});

const aiContextBody = z.object({
  aiContext: z.string().max(20_000),
});

function requireUserId(request: FastifyRequest): string {
  const userId = request.posUser?.id;
  if (!userId) {
    throw Object.assign(new Error('Sign in with Google to continue'), {
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    });
  }
  return userId;
}

function sendServiceError(reply: FastifyReply, err: unknown) {
  const e = err as { statusCode?: number; code?: string; message?: string };
  const status = e.statusCode ?? 500;
  return reply.code(status).send({
    error: {
      code: e.code ?? 'INTERNAL',
      message:
        e.message
        ?? 'AI suggestions are unavailable right now. You can continue manually.',
    },
  });
}

export async function aiGoalRoutes(
  app: FastifyInstance,
  deps: {
    deviceService: DeviceService;
    config: AppConfig;
    identity: IdentityService;
    goalAi: GoalStructuringService;
    planner: PlannerV2Service;
  },
) {
  const serviceAuth = createPlannerAuthHook(
    deps.deviceService,
    deps.config.PLANNER_WEB_TOKEN,
  );
  const userAuth = createPersonalOsUserHook(deps.identity);
  const auth = [serviceAuth, userAuth];

  app.get('/v2/ai/context', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const result = await deps.goalAi.getAiContext(userId);
      return reply.send(result);
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.put('/v2/ai/context', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const body = aiContextBody.parse(request.body ?? {});
      const result = await deps.goalAi.setAiContext(userId, body.aiContext);
      return reply.send(result);
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.post('/v2/ai/context/reset', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const result = await deps.goalAi.resetAiContext(userId);
      return reply.send(result);
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.post('/v2/ai/goal-structure', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const body = suggestBody.parse(request.body ?? {});
      const suggestion = await deps.goalAi.suggest(userId, body);
      // Never persist during generation.
      return reply.send({ suggestion });
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.post('/v2/ai/goal-structure/accept', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const body = acceptBody.parse(request.body ?? {});
      const result = await deps.goalAi.accept(userId, body);
      return reply.code(201).send(result);
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.post('/v2/ai/goal-structure/export', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const body = z
        .object({
          title: z.string().trim().min(1).max(240),
          why: z.string().max(10_000).optional(),
          targetDate: z.string().max(32).nullable().optional(),
          suggestion: goalStructureSuggestionSchema,
        })
        .parse(request.body ?? {});
      const { aiContext } = await deps.goalAi.getAiContext(userId);
      const markdown = exportSuggestionMarkdown({
        title: body.title,
        why: body.why,
        targetDate: body.targetDate,
        aiContext,
        suggestion: body.suggestion,
      });
      return reply.send({ markdown });
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.get('/v2/goals/:id/context-export', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const goalId = (request.params as { id: string }).id;
      const { goal, progress } = await deps.planner.getGoalProgress(userId, goalId);
      const { aiContext } = await deps.goalAi.getAiContext(userId);

      const planner = await deps.planner.getPlanner(
        userId,
        new Date(Date.now() - 7 * 86_400_000).toISOString(),
        new Date(Date.now() + 30 * 86_400_000).toISOString(),
        { includeExternalEvents: false },
      );
      const linkedProjects = planner.projects.filter(
        (p: { goalId?: string | null; active?: boolean }) => p.goalId === goalId && p.active !== false,
      );
      const linkedTasks = planner.tasks.filter((t: {
        goalId?: string | null;
        projectId?: string | null;
        status?: string;
      }) => {
        if (t.goalId === goalId) return true;
        return Boolean(t.projectId && linkedProjects.some((p: { id: string }) => p.id === t.projectId));
      });

      const reflectionParts = goal.reflection
        ? [
            goal.reflection.worked ? `Worked: ${goal.reflection.worked}` : '',
            goal.reflection.didntWork ? `Didn't work: ${goal.reflection.didntWork}` : '',
            goal.reflection.learned ? `Learned: ${goal.reflection.learned}` : '',
          ].filter(Boolean)
        : [];

      const markdown = exportGoalFullContextMarkdown({
        aiContext,
        goal: {
          title: goal.title,
          focusType: goal.focusType,
          outcome: goal.outcome,
          why: goal.why,
          metric: goal.metric,
          targetDate: goal.targetDate,
          status: goal.status,
        },
        milestones: (goal.milestones ?? []).map((m: { title: string; status: string }) => ({
          title: m.title,
          status: m.status,
        })),
        processes: progress.processes.map((p) => ({
          name: p.name,
          completed: p.thisWeek.completed,
          planned: p.thisWeek.planned,
          target: p.thisWeek.target,
          unit: p.unit,
        })),
        systems: (goal.systems ?? []).map((s: { title: string; targetValue?: number; unit?: string | null; durationWeeks?: number; status?: string }) => s),
        projects: linkedProjects.map((p: { title: string; description?: string }) => ({
          title: p.title,
          purpose: p.description ?? null,
          nextAction:
            linkedTasks.find((t: { projectId?: string | null; status?: string; title: string }) =>
              t.status !== 'DONE' && linkedProjects.find((lp: { id: string; title: string }) =>
                lp.title === p.title,
              )?.id === t.projectId,
            )?.title ?? null,
        })),
        tasks: linkedTasks.map((t: {
          title: string;
          dueHorizon?: string | null;
          status?: string;
        }) => ({
          title: t.title,
          dueHorizon: t.dueHorizon ?? null,
          scheduled: t.status === 'SCHEDULED',
          done: t.status === 'DONE',
        })),
        timeProtectedMinutes: null,
        progress: {
          consistencyMetWeeks: progress.consistency.metWeeks,
          consistencyTotalWeeks: progress.consistency.totalWeeks,
          insight: progress.insight.message,
        },
        reflection: reflectionParts.length ? reflectionParts.join('\n') : null,
      });
      return reply.send({ markdown });
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });
}
