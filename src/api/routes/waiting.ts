import type { FastifyInstance } from 'fastify';
import type { WaitingService } from '../../modules/waiting/waitingService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';

export async function waitingRoutes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; waitingService: WaitingService },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.get('/v1/waiting', { preHandler: auth }, async (_request, reply) => {
    const items = await deps.waitingService.listActive();
    return reply.send({ items });
  });

  app.post('/v1/waiting/:id/resolve', { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deps.waitingService.resolve(id);
    return reply.send({ ok: true });
  });
}
