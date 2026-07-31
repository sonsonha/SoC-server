import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NotificationService } from '../../infrastructure/notifications/notificationService.js';
import type { AutonomyLevel } from '../../infrastructure/notifications/types.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';

const fcmBody = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(['android', 'ios']).optional().default('android'),
  autonomy: z
    .enum(['SUGGEST', 'INTERNAL_PLAN', 'COS_CALENDAR_WRITE', 'PROACTIVE_REPLAN'])
    .optional(),
});

const autonomyBody = z.object({
  autonomy: z.enum(['SUGGEST', 'INTERNAL_PLAN', 'COS_CALENDAR_WRITE', 'PROACTIVE_REPLAN']),
});

export async function deviceFcmRoutes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; notificationService: NotificationService },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.post('/v1/devices/fcm-token', { preHandler: auth }, async (request, reply) => {
    const body = fcmBody.parse(request.body ?? {});
    const deviceId = request.deviceId!;
    await deps.notificationService.registerToken(deviceId, body.token, {
      platform: body.platform,
      autonomy: body.autonomy as AutonomyLevel | undefined,
    });
    return reply.send({ ok: true });
  });

  app.delete('/v1/devices/fcm-token', { preHandler: auth }, async (request, reply) => {
    await deps.notificationService.clearToken(request.deviceId!);
    return reply.send({ ok: true });
  });

  app.patch('/v1/devices/autonomy', { preHandler: auth }, async (request, reply) => {
    const body = autonomyBody.parse(request.body ?? {});
    await deps.notificationService.setAutonomy(request.deviceId!, body.autonomy);
    return reply.send({ ok: true, autonomy: body.autonomy });
  });
}
