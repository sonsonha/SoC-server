import type { FastifyInstance } from 'fastify';
import type { WeekService } from '../../modules/opportunities/weekService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';

export async function weekRoutes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; weekService: WeekService },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.get('/v1/week', { preHandler: auth }, async (request, reply) => {
    const weekStart = (request.query as { start?: string }).start;
    const start =
      weekStart ??
      new Date().toISOString().slice(0, 10);
    const summary = await deps.weekService.getWeekSummary(start);
    return reply.send(summary);
  });
}
