import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PreparationService } from '../../application/preparationService.js';
import type { FeedbackService } from '../../modules/preparation/feedbackService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';
import { feedbackRequestSchema } from '../../domain/feedback.js';

export async function preparationRoutes(
  app: FastifyInstance,
  deps: {
    deviceService: DeviceService;
    preparationService: PreparationService;
    feedbackService: FeedbackService;
  },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.get('/v1/preparations', { preHandler: auth }, async (request, reply) => {
    const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(request.query);
    const items = await deps.preparationService.listForDate(query.date);
    return reply.send({ preparations: items });
  });

  app.get('/v1/preparations/:id', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const detail = await deps.preparationService.getById(params.id);
    if (!detail) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Preparation not found' },
      });
    }
    return reply.send(detail);
  });

  app.post('/v1/preparations/:id/start', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const detail = await deps.preparationService.getById(params.id);
    if (!detail) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Preparation not found' },
      });
    }
    const result = await deps.preparationService.start(params.id);
    return reply.send(result);
  });

  app.post('/v1/preparations/:id/feedback', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = feedbackRequestSchema.parse(request.body ?? {});
    const detail = await deps.preparationService.getById(params.id);
    if (!detail) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Preparation not found' },
      });
    }
    await deps.feedbackService.submitFeedback(params.id, body.reason, body.note);
    const updated = await deps.preparationService.getById(params.id);
    return reply.send(updated);
  });

  app.post('/v1/preparations/:id/refresh', { preHandler: auth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await deps.preparationService.refresh(params.id);
    const detail = await deps.preparationService.getById(params.id);
    return reply.send({ ...result, preparation: detail?.preparation, resource: detail?.resource });
  });
}
