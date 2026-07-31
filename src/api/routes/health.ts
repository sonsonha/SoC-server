import type { FastifyInstance } from 'fastify';
import { checkDb } from '../../infrastructure/db/client.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Liveness for Railway / load balancers.
   * Always return 200 once the process is listening so deploys are not
   * killed by a transient DB blip. DB status is reported in the body.
   */
  app.get('/health', async (_request, reply) => {
    const dbOk = await checkDb();
    return reply.code(200).send({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      // Bump when deploy behavior changes — used to confirm Railway is on latest code.
      build: '2026-07-31-force-register-v2',
      time: new Date().toISOString(),
    });
  });

  /** Readiness: 503 when Postgres is unreachable. */
  app.get('/ready', async (_request, reply) => {
    const dbOk = await checkDb();
    return reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ready' : 'not_ready',
      db: dbOk ? 'ok' : 'error',
      time: new Date().toISOString(),
    });
  });
}
