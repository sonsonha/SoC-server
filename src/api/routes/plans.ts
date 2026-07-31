import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PlanService } from '../../application/planService.js';
import type { WeeklyPlanService } from '../../application/weeklyPlanService.js';
import type { GoalPlanningService } from '../../application/goalPlanningService.js';
import { replanRequestSchema } from '../../domain/planning/disruption.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';
import { getPlanningPreferences } from '../../modules/planning/planningPrefs.js';
import { eq } from 'drizzle-orm';
import { planningPreferences, planningRuns } from '../../infrastructure/db/schema/index.js';
import type { Db } from '../../infrastructure/db/client.js';

const generateBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  taskId: z.string().optional(),
  learningItemId: z.string().optional(),
  locationId: z.string().optional(),
  mode: z.enum(['NORMAL', 'LOW', 'FLOOR']).optional(),
});

const prepareBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const prepareWeekBody = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  trigger: z.string().optional(),
});

const goalBody = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  lifeArea: z.string().optional(),
  horizon: z.enum(['MISSION', 'YEAR', 'QUARTER', 'MONTH', 'WEEK', 'SHORT', 'LONG']),
  parentId: z.string().nullish(),
  description: z.string().optional(),
  successCriteria: z.string().optional(),
  targetDate: z.string().nullish(),
  seasonId: z.string().nullish(),
  capacityShare: z.number().nullish(),
});

export async function planRoutes(
  app: FastifyInstance,
  deps: {
    deviceService: DeviceService;
    planService: PlanService;
    weeklyPlanService: WeeklyPlanService;
    goalPlanningService: GoalPlanningService;
    db?: Db;
  },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.post('/v1/plans/day/generate', { preHandler: auth }, async (request, reply) => {
    const body = generateBody.parse(request.body ?? {});
    const result = await deps.planService.generateDay({
      date: body.date,
      taskId: body.taskId,
      learningItemId: body.learningItemId,
      locationId: body.locationId,
    });
    return reply.code(201).send(result);
  });

  app.post('/v1/plans/prepare-tomorrow', { preHandler: auth }, async (request, reply) => {
    const body = prepareBody.parse(request.body ?? {});
    const result = await deps.planService.prepareTomorrow({ date: body.date });
    return reply.code(201).send(result);
  });

  app.post('/v1/plans/prepare-week', { preHandler: auth }, async (request, reply) => {
    const body = prepareWeekBody.parse(request.body ?? {});
    const result = await deps.weeklyPlanService.prepareWeek({
      weekStart: body.weekStart,
      trigger: body.trigger ?? 'MANUAL',
    });
    return reply.code(201).send(result);
  });

  app.get('/v1/plans/week', { preHandler: auth }, async (request, reply) => {
    const q = z
      .object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(request.query ?? {});
    const week = await deps.weeklyPlanService.getActiveWeek(q.weekStart);
    if (!week) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active week' } });
    return reply.send(week);
  });

  app.post('/v1/plans/:date/accept', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(request.params);
    const result = await deps.planService.acceptPlan(params.date);
    return reply.send(result);
  });

  app.post('/v1/plans/:date/adjust', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(request.params);
    const body = z
      .object({
        blockId: z.string().min(1),
        startEpochMs: z.number().int(),
        endEpochMs: z.number().int(),
      })
      .parse(request.body ?? {});
    const result = await deps.planService.adjustPlanBlock({
      date: params.date,
      blockId: body.blockId,
      startEpochMs: body.startEpochMs,
      endEpochMs: body.endEpochMs,
    });
    return reply.send(result);
  });

  app.get('/v1/plans/:date', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(request.params);
    const preview = await deps.planService.getPlanPreview(params.date);
    if (!preview) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No plan' } });
    }
    return reply.send(preview);
  });

  app.post('/v1/plans/morning-refresh', { preHandler: auth }, async (request, reply) => {
    const body = prepareBody.parse(request.body ?? {});
    const result = await deps.planService.morningRefresh({ date: body.date });
    return reply.send(result);
  });

  app.post('/v1/plans/replan', { preHandler: auth }, async (request, reply) => {
    const body = replanRequestSchema.parse(request.body ?? {});
    const result = await deps.planService.replan({
      date: body.date,
      from: body.from ?? undefined,
      disruption: {
        ...body.disruption,
        title: body.disruption.title ?? undefined,
        startAt: body.disruption.startAt ?? undefined,
        endAt: body.disruption.endAt ?? undefined,
        ownership: body.disruption.ownership ?? undefined,
        locationId: body.disruption.locationId ?? undefined,
        taskId: body.disruption.taskId ?? undefined,
        nextAction: body.disruption.nextAction ?? undefined,
        mode: body.disruption.mode ?? undefined,
        note: body.disruption.note ?? undefined,
      },
    });
    return reply.send(result);
  });

  app.get('/v1/goals', { preHandler: auth }, async (request, reply) => {
    const q = z.object({ horizon: z.string().optional() }).parse(request.query ?? {});
    const goals = await deps.goalPlanningService.listGoals(q.horizon);
    return reply.send({ goals });
  });

  app.post('/v1/goals', { preHandler: auth }, async (request, reply) => {
    const body = goalBody.parse(request.body ?? {});
    const goal = await deps.goalPlanningService.upsertGoal(body);
    return reply.code(201).send({ goal });
  });

  app.get('/v1/goals/:id/trace', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const chain = await deps.goalPlanningService.traceUp(params.id);
    return reply.send({ chain });
  });

  app.post('/v1/plans/quarter/generate', { preHandler: auth }, async (request, reply) => {
    const body = z
      .object({ year: z.number().optional(), quarter: z.number().min(1).max(4).optional() })
      .parse(request.body ?? {});
    const result = await deps.goalPlanningService.generateQuarterPlan(body);
    return reply.code(201).send(result);
  });

  app.post('/v1/plans/month/generate', { preHandler: auth }, async (request, reply) => {
    const body = z
      .object({ year: z.number().optional(), month: z.number().min(1).max(12).optional() })
      .parse(request.body ?? {});
    const result = await deps.goalPlanningService.generateMonthPlan(body);
    return reply.code(201).send(result);
  });

  app.get('/v1/planning/preferences', { preHandler: auth }, async (_request, reply) => {
    if (!deps.db) return reply.send({ preferences: null });
    const preferences = await getPlanningPreferences(deps.db);
    return reply.send({ preferences });
  });

  app.patch('/v1/planning/preferences', { preHandler: auth }, async (request, reply) => {
    if (!deps.db) return reply.code(500).send({ error: { code: 'NO_DB' } });
    const body = z
      .object({
        timezone: z.string().optional(),
        sundayPrepLocalTime: z.string().optional(),
        eveningPrepLocalTime: z.string().optional(),
        morningRefreshOffsetMinutes: z.number().int().optional(),
        wakeLocalTime: z.string().optional(),
        capacityUtilization: z.number().min(0.3).max(0.95).optional(),
        autonomy: z
          .enum(['SUGGEST', 'INTERNAL_PLAN', 'COS_CALENDAR_WRITE', 'PROACTIVE_REPLAN'])
          .optional(),
      })
      .parse(request.body ?? {});
    await deps.db
      .insert(planningPreferences)
      .values({ id: 'default', ...body, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: planningPreferences.id,
        set: { ...body, updatedAt: new Date() },
      });
    const preferences = await getPlanningPreferences(deps.db);
    return reply.send({ preferences });
  });

  app.get('/v1/planning/runs', { preHandler: auth }, async (request, reply) => {
    if (!deps.db) return reply.send({ runs: [] });
    const q = z
      .object({
        runType: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
      })
      .parse(request.query ?? {});
    let query = deps.db.select().from(planningRuns).$dynamic();
    if (q.runType) {
      query = query.where(eq(planningRuns.runType, q.runType));
    }
    const runs = await query.limit(q.limit ?? 20);
    return reply.send({ runs });
  });
}
