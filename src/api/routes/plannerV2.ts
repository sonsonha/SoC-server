import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PlannerV2Service } from '../../application/plannerV2Service.js';
import type { DeviceService } from '../../application/deviceService.js';
import { createPlannerAuthHook } from '../middleware/plannerAuth.js';

const isoDateTime = z.string().datetime({ offset: true });
const priority = z.enum(['LOW', 'NORMAL', 'HIGH']);

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(10_000).optional(),
  projectId: z.string().min(1).nullable().optional(),
  dueAt: isoDateTime.nullable().optional(),
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

export async function plannerV2Routes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; planner: PlannerV2Service; webToken?: string },
): Promise<void> {
  const auth = createPlannerAuthHook(deps.deviceService, deps.webToken);

  app.get('/v2/planner', { preHandler: auth }, async (request, reply) => {
    const query = z.object({ from: isoDateTime, to: isoDateTime }).parse(request.query);
    if (new Date(query.to).getTime() <= new Date(query.from).getTime()) {
      return reply.code(400).send({
        error: { code: 'INVALID_RANGE', message: 'to must be after from' },
      });
    }
    return reply.send(await deps.planner.getPlanner(query.from, query.to));
  });

  app.post('/v2/tasks', { preHandler: auth }, async (request, reply) => {
    const body = createTaskSchema.parse(request.body ?? {});
    return reply.code(201).send(await deps.planner.createTask(body));
  });

  app.patch('/v2/tasks/:id', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = createTaskSchema.partial().extend({
      status: z.enum(['INBOX', 'SCHEDULED', 'DONE']).optional(),
    }).parse(request.body ?? {});
    return reply.send(await deps.planner.patchTask(params.id, body));
  });

  app.post('/v2/time-blocks', { preHandler: auth }, async (request, reply) => {
    const body = createTimeBlockSchema.parse(request.body ?? {});
    return reply.code(201).send(await deps.planner.createTimeBlock(body));
  });

  app.patch('/v2/time-blocks/:id', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = createTimeBlockSchema.partial().parse(request.body ?? {});
    return reply.send(await deps.planner.patchTimeBlock(params.id, body));
  });

  app.delete('/v2/time-blocks/:id', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return reply.send(await deps.planner.deleteTimeBlock(params.id));
  });
}
