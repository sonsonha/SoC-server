import type { FastifyInstance } from 'fastify';
import type { ProactiveScanService } from '../../modules/proactive/scanService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';

export async function proactiveRoutes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; scanService: ProactiveScanService },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.post('/v1/proactive/scan', { preHandler: auth }, async (_request, reply) => {
    const summary = await deps.scanService.run();
    return reply.send({ ok: true, summary });
  });
}
