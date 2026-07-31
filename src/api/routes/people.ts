import type { FastifyInstance } from 'fastify';
import type { PeopleService } from '../../modules/people/peopleService.js';
import { createDeviceAuthHook } from '../middleware/deviceAuth.js';
import type { DeviceService } from '../../application/deviceService.js';

export async function peopleRoutes(
  app: FastifyInstance,
  deps: { deviceService: DeviceService; peopleService: PeopleService },
): Promise<void> {
  const auth = createDeviceAuthHook(deps.deviceService);

  app.get('/v1/people', { preHandler: auth }, async (_request, reply) => {
    const people = await deps.peopleService.list();
    return reply.send({ people });
  });

  app.get('/v1/people/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await deps.peopleService.getById(id);
    if (!result) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Person not found' } });
    }
    return reply.send(result);
  });
}
