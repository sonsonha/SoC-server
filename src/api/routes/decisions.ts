import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DecisionService } from '../../modules/decisions/decisionService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';

const resolveBody = z.object({
  optionId: z.string().min(1),
});

export async function decisionRoutes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; decisionService: DecisionService },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.get('/v1/decisions', { preHandler: auth }, async (request, reply) => {
    const status = (request.query as { status?: string }).status ?? 'OPEN';
    if (status === 'OPEN') {
      const decisions = await deps.decisionService.listOpen();
      return reply.send({ decisions });
    }
    return reply.send({ decisions: [] });
  });

  app.get('/v1/decisions/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await deps.decisionService.getWithOptions(id);
    if (!result) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Decision not found' } });
    }
    return reply.send(result);
  });

  app.post('/v1/decisions/:id/resolve', { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = resolveBody.parse(request.body ?? {});
    await deps.decisionService.resolve(id, body.optionId);
    return reply.send({ ok: true });
  });
}
