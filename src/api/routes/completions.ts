import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CompletionService } from '../../application/completionService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';

const completionBody = z.object({
  preparationId: z.string().uuid().optional(),
  taskId: z.string().optional(),
  grade: z.enum(['FULL', 'PARTIAL', 'FLOOR']).default('FULL'),
  minutes: z.number().int().positive().max(600),
  note: z.string().max(2000).optional(),
});

export async function completionRoutes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; completionService: CompletionService },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.post('/v1/completions', { preHandler: auth }, async (request, reply) => {
    const body = completionBody.parse(request.body ?? {});
    const result = await deps.completionService.record(body);
    return reply.code(result.idempotent ? 200 : 201).send(result);
  });
}
