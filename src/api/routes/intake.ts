import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  clarifyRequestSchema,
  intakeRequestSchema,
} from '../../domain/intake.js';
import type { IntakeService } from '../../application/intakeService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';

export async function intakeRoutes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; intakeService: IntakeService },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.post('/v1/intake', { preHandler: auth }, async (request, reply) => {
    const body = intakeRequestSchema.parse(request.body ?? {});
    const result = await deps.intakeService.process({
      text: body.text,
      capturedAt: body.capturedAt ?? undefined,
      locationId: body.locationId ?? undefined,
    });
    return reply.code(201).send(result);
  });

  app.post('/v1/intake/clarify', { preHandler: auth }, async (request, reply) => {
    const body = clarifyRequestSchema.parse(request.body ?? {});
    const result = await deps.intakeService.clarify({
      text: body.text,
      capturedAt: body.capturedAt ?? undefined,
      locationId: body.locationId ?? undefined,
      inboxItemId: body.inboxItemId ?? undefined,
      answers: body.answers,
    });
    return reply.code(201).send(result);
  });
}
