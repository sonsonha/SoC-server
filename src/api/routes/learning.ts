import type { FastifyInstance } from 'fastify';
import { createTracksBodySchema } from '../../domain/learning.js';
import type { LearningCurriculumService } from '../../modules/learning/curriculumService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';

export async function learningRoutes(
  app: FastifyInstance,
  deps: {
    deviceService: DeviceService;
    learningService: LearningCurriculumService;
  },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.get('/v1/learning/recommendations', { preHandler: auth }, async (_request, reply) => {
    const recommendations = await deps.learningService.recommendations();
    return reply.send({ recommendations });
  });

  app.get('/v1/learning/tracks', { preHandler: auth }, async (_request, reply) => {
    const tracks = await deps.learningService.listTracksWithProgress();
    return reply.send({ tracks });
  });

  app.post('/v1/learning/tracks', { preHandler: auth }, async (request, reply) => {
    const body = createTracksBodySchema.parse(request.body ?? {});
    const result = await deps.learningService.createTracks(body);
    const tracks = await deps.learningService.listTracksWithProgress();
    return reply.code(201).send({ ...result, tracks });
  });

  app.post('/v1/learning/cadence/ensure', { preHandler: auth }, async (_request, reply) => {
    const result = await deps.learningService.ensureCadenceForWeek(
      // monday computed inside with default
      (() => {
        const d = new Date();
        const day = d.getUTCDay();
        const diff = day === 0 ? -6 : 1 - day;
        d.setUTCDate(d.getUTCDate() + diff);
        return d.toISOString().slice(0, 10);
      })(),
    );
    return reply.send(result);
  });
}
