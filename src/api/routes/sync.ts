import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeviceService } from '../../application/deviceService.js';
import type { SyncService } from '../../application/syncService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';

const pullBody = z.object({
  since: z.string().default('0'),
});

const mutationSchema = z.object({
  mutationId: z.string().uuid(),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  operation: z.enum(['upsert', 'delete']),
  payload: z.record(z.unknown()).default({}),
  clientTimestamp: z.string().min(1),
});

const pushBody = z.object({
  mutations: z.array(mutationSchema).default([]),
});

export async function syncRoutes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; syncService: SyncService },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.post('/v1/sync/pull', { preHandler: auth }, async (request, reply) => {
    const body = pullBody.parse(request.body ?? {});
    const result = await deps.syncService.pull(request.deviceId!, body.since);
    return reply.send(result);
  });

  app.post('/v1/sync/push', { preHandler: auth }, async (request, reply) => {
    const body = pushBody.parse(request.body ?? {});
    const result = await deps.syncService.push(request.deviceId!, body.mutations);
    return reply.send(result);
  });
}
