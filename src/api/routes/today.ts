import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TodayService } from '../../application/todayService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';

export async function todayRoutes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; todayService: TodayService },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.get('/v1/today', { preHandler: auth }, async (request, reply) => {
    const query = z
      .object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        locationId: z.string().optional(),
      })
      .parse(request.query);

    const date = query.date ?? new Date().toISOString().slice(0, 10);
    const result = await deps.todayService.getToday(date, query.locationId);
    return reply.send(result);
  });
}
