import type { FastifyInstance } from 'fastify';
import { checkDb } from '../../infrastructure/db/client.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const dbOk = await checkDb();
    const status = dbOk ? 'ok' : 'degraded';
    return reply.code(dbOk ? 200 : 503).send({
      status,
      db: dbOk ? 'ok' : 'error',
      time: new Date().toISOString(),
    });
  });
}
