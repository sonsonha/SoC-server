import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OpportunityService } from '../../modules/opportunities/opportunityService.js';
import type { OpportunitySuggestService } from '../../modules/opportunities/suggestService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';

const patchBody = z.object({
  done: z.boolean(),
});

export async function opportunityRoutes(
  app: FastifyInstance,
  deps: {
    deviceService: DeviceService;
    opportunityService: OpportunityService;
    suggestService: OpportunitySuggestService;
  },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.get('/v1/opportunities/suggestions', { preHandler: auth }, async (_request, reply) => {
    const suggestions = await deps.suggestService.suggest();
    return reply.send({ suggestions });
  });

  app.get('/v1/opportunities', { preHandler: auth }, async (_request, reply) => {
    const opportunities = await deps.opportunityService.list();
    return reply.send({ opportunities });
  });

  app.get('/v1/opportunities/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await deps.opportunityService.getById(id);
    if (!result) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Opportunity not found' } });
    }
    return reply.send(result);
  });

  app.patch('/v1/opportunity-requirements/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = patchBody.parse(request.body ?? {});
    await deps.opportunityService.toggleRequirement(id, body.done);
    return reply.send({ ok: true });
  });
}
