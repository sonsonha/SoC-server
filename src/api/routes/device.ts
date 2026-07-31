import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeviceService } from '../../application/deviceService.js';
import type { AppConfig } from '../../config.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';

const registerBody = z.object({
  label: z.string().min(1).max(128).optional(),
  force: z.boolean().optional().default(false),
});

export async function deviceRoutes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; config: AppConfig },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.post('/v1/device/register', async (request, reply) => {
    if (deps.config.NODE_ENV === 'production' && deps.config.REGISTER_TOKEN) {
      const token = request.headers['x-register-token'];
      if (token !== deps.config.REGISTER_TOKEN) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Invalid register token' },
        });
      }
    }

    const body = registerBody.parse(request.body ?? {});
    try {
      // Personal single-device CoS: allow force replace so a phone can reclaim the slot.
      // Optional REGISTER_TOKEN still gates who may call this endpoint in production.
      const result = await deps.deviceService.register({
        label: body.label,
        force: body.force === true,
      });
      return reply.code(201).send(result);
    } catch (err) {
      const e = err as Error & { statusCode?: number; code?: string };
      if (e.statusCode === 409) {
        return reply.code(409).send({
          error: {
            code: e.code ?? 'DEVICE_EXISTS',
            message:
              'This cloud backend already has a phone linked. Tap Connect again to replace it with this phone.',
          },
        });
      }
      throw err;
    }
  });

  app.get('/v1/ping', { preHandler: auth }, async (request, reply) => {
    return reply.send({
      ok: true,
      deviceId: request.deviceId,
      serverTime: new Date().toISOString(),
    });
  });
}
