import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PlannerV2Service } from '../../application/plannerV2Service.js';
import type { DeviceService } from '../../application/deviceService.js';
import type { IdentityService } from '../../modules/identity/identityService.js';
import { createPlannerAuthHook } from '../middleware/plannerAuth.js';
import { createPersonalOsUserHook } from '../middleware/personalOsAuth.js';

const isoDateTime = z.string().datetime({ offset: true });
const priority = z.enum(['LOW', 'NORMAL', 'HIGH', 'DROP', 'P1', 'P2', 'P3', 'P4']);

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(10_000).optional(),
  projectId: z.string().min(1).nullable().optional(),
  goalId: z.string().min(1).nullable().optional(),
  goalProcessId: z.string().min(1).nullable().optional(),
  dueAt: isoDateTime.nullable().optional(),
  dueHorizon: z.enum(['DAY', 'WEEK', 'MONTH']).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(24 * 60).optional(),
  priority: priority.optional(),
});

const createTimeBlockSchema = z.object({
  taskId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  title: z.string().trim().min(1).max(240),
  startAt: isoDateTime,
  endAt: isoDateTime,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  reminderMinutes: z.number().int().min(0).max(30 * 24 * 60).nullable().optional(),
});

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(240),
  goalId: z.string().min(1).nullable().optional(),
  defaultGoalProcessId: z.string().min(1).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  lifeArea: z.string().trim().min(1).max(64).optional(),
  description: z.string().max(10_000).optional(),
  active: z.boolean().optional(),
  targetDate: z.string().max(32).nullable().optional(),
});

const milestoneSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(240),
  status: z.enum(['pending', 'current', 'done']),
});

const systemSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(240),
  targetType: z.enum(['COUNT', 'DURATION']).optional(),
  targetValue: z.number().nonnegative().optional(),
  unit: z.string().max(32).nullable().optional(),
  period: z.literal('WEEK').optional(),
  durationWeeks: z.number().int().positive().max(520).optional(),
  startDate: z.string().max(32).nullable().optional(),
  preferredDays: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  preferredTime: z.string().max(32).nullable().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED']).optional(),
  cadence: z.string().max(120).optional(),
});

const processSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(240),
  measurementType: z.enum(['COUNT', 'DURATION', 'BINARY', 'CUSTOM_METRIC']),
  targetValue: z.number().nonnegative(),
  unit: z.string().max(32).optional(),
  period: z.enum(['DAY', 'WEEK', 'MONTH']),
  active: z.boolean(),
});

const metricObservationSchema = z.object({
  id: z.string().min(1),
  observedAt: isoDateTime,
  value: z.number(),
  note: z.string().max(2_000).optional(),
  label: z.string().max(120).optional(),
});

const reflectionSchema = z.object({
  seriousAttempt: z.enum(['NOT_REALLY', 'PARTLY', 'YES']).nullable().optional(),
  worked: z.string().max(10_000).optional(),
  didntWork: z.string().max(10_000).optional(),
  outsideControl: z.string().max(10_000).optional(),
  learned: z.string().max(10_000).optional(),
  differently: z.string().max(10_000).optional(),
  nextAction: z.enum(['ARCHIVE', 'EXTEND', 'REVISE', 'FOLLOW_UP', 'MAINTAIN', 'STOP']).nullable().optional(),
  reviewedAt: isoDateTime.nullable().optional(),
});

const reviewSnapshotSchema = z.object({
  generatedAt: isoDateTime,
  outcomeStatus: z.enum(['ACTIVE', 'ACHIEVED_ON_TIME', 'ACHIEVED_LATE', 'PARTIALLY_ACHIEVED', 'NOT_ACHIEVED', 'STOPPED_INTENTIONALLY', 'NO_LONGER_RELEVANT']),
  targetDate: z.string().max(32).nullable(),
  achievedAt: z.string().max(64).nullable(),
  processSummary: z.array(z.object({
    processId: z.string().min(1),
    name: z.string().trim().min(1).max(240),
    completed: z.number(),
    planned: z.number(),
    target: z.number(),
    unit: z.string().max(32).optional(),
  })),
  consistency: z.object({ metWeeks: z.number(), totalWeeks: z.number(), threshold: z.number() }),
  milestones: z.array(z.object({ id: z.string().min(1), title: z.string().trim().min(1).max(240), status: z.string().min(1) })),
  latestObservation: metricObservationSchema.nullish(),
});

const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(240),
  horizon: z.enum(['MISSION', 'YEAR', 'QUARTER', 'MONTH', 'WEEK', 'SHORT', 'LONG']).optional(),
  lifeArea: z.string().trim().min(1).max(64).optional(),
  parentId: z.string().min(1).nullable().optional(),
  targetDate: z.string().max(32).nullable().optional(),
  description: z.string().max(10_000).optional(),
  successCriteria: z.string().max(10_000).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']).optional(),
  outcome: z.string().max(10_000).optional(),
  why: z.string().max(10_000).optional(),
  metric: z.string().max(10_000).optional(),
  focusType: z.enum(['FOCUS', 'MAINTAIN', 'EXPLORE']).optional(),
  outcomeStatus: z.enum(['ACTIVE', 'ACHIEVED_ON_TIME', 'ACHIEVED_LATE', 'PARTIALLY_ACHIEVED', 'NOT_ACHIEVED', 'STOPPED_INTENTIONALLY', 'NO_LONGER_RELEVANT']).optional(),
  achievedAt: z.string().max(64).nullable().optional(),
  closedAt: z.string().max(64).nullable().optional(),
  currentMilestoneId: z.string().min(1).nullable().optional(),
  milestones: z.array(milestoneSchema).optional(),
  systems: z.array(systemSchema).optional(),
  processes: z.array(processSchema).optional(),
  metricObservations: z.array(metricObservationSchema).optional(),
  reflection: reflectionSchema.nullable().optional(),
  reviewSnapshot: reviewSnapshotSchema.nullable().optional(),
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

export async function plannerV2Routes(
  app: FastifyInstance,
  deps: {
    deviceService: DeviceService;
    planner: PlannerV2Service;
    webToken?: string;
    identity?: IdentityService;
  },
): Promise<void> {
  const serviceAuth = createPlannerAuthHook(deps.deviceService, deps.webToken);
  const userAuth = deps.identity
    ? createPersonalOsUserHook(deps.identity)
    : async () => undefined;
  const auth = [serviceAuth, userAuth];

  app.get('/v2/planner', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const query = z.object({ from: isoDateTime, to: isoDateTime }).parse(request.query);
    if (new Date(query.to).getTime() <= new Date(query.from).getTime()) {
      return reply.code(400).send({
        error: { code: 'INVALID_RANGE', message: 'to must be after from' },
      });
    }
    return reply.send(await deps.planner.getPlanner(userId, query.from, query.to));
  });

  app.post('/v2/tasks', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const body = createTaskSchema.parse(request.body ?? {});
    return reply.code(201).send(await deps.planner.createTask(userId, body));
  });

  app.patch('/v2/tasks/:id', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = createTaskSchema.partial().extend({
      status: z.enum(['INBOX', 'SCHEDULED', 'DONE']).optional(),
    }).parse(request.body ?? {});
    return reply.send(await deps.planner.patchTask(userId, params.id, body));
  });

  app.get('/v2/tasks/:id/time-blocks', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return reply.send(await deps.planner.getTaskTimeBlocks(userId, params.id));
  });

  app.delete('/v2/tasks/:id', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return reply.send(await deps.planner.deleteTask(userId, params.id));
  });

  app.post('/v2/time-blocks', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const body = createTimeBlockSchema.parse(request.body ?? {});
    return reply.code(201).send(await deps.planner.createTimeBlock(userId, body));
  });

  app.patch('/v2/time-blocks/:id', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = createTimeBlockSchema.partial().parse(request.body ?? {});
    return reply.send(await deps.planner.patchTimeBlock(userId, params.id, body));
  });

  app.delete('/v2/time-blocks/:id', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return reply.send(await deps.planner.deleteTimeBlock(userId, params.id));
  });

  app.post('/v2/projects', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const body = createProjectSchema.parse(request.body ?? {});
    return reply.code(201).send(await deps.planner.createProject(userId, body));
  });

  app.patch('/v2/projects/:id', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = createProjectSchema.partial().parse(request.body ?? {});
    return reply.send(await deps.planner.patchProject(userId, params.id, body));
  });

  app.delete('/v2/projects/:id', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return reply.send(await deps.planner.deleteProject(userId, params.id));
  });

  app.post('/v2/goals', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const body = createGoalSchema.parse(request.body ?? {});
    return reply.code(201).send(await deps.planner.createGoal(userId, body));
  });

  app.patch('/v2/goals/:id', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = createGoalSchema.partial().parse(request.body ?? {});
    return reply.send(await deps.planner.patchGoal(userId, params.id, body));
  });

  app.delete('/v2/goals/:id', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return reply.send(await deps.planner.deleteGoal(userId, params.id));
  });

  app.get('/v2/goals/:id/progress', { preHandler: auth }, async (request, reply) => {
    const userId = requireUserId(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const query = z.object({ now: isoDateTime.optional() }).parse(request.query);
    return reply.send(await deps.planner.getGoalProgress(userId, params.id, query.now));
  });
}
