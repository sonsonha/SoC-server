import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { closeDb, createDb } from './infrastructure/db/client.js';
import { runMigrations } from './infrastructure/db/migrate.js';
import { resolveLlmProviderName } from './infrastructure/providers/llm/index.js';

async function main() {
  const config = loadConfig();

  // Migrations run in Railway releaseCommand. Keep a best-effort startup migrate
  // for local/docker, but never block listen forever on Railway.
  try {
    await runMigrations(config.DATABASE_URL);
  } catch (err) {
    console.error('Startup migration failed (continuing to listen):', err);
  }

  const db = createDb(config.DATABASE_URL);
  const { app } = await buildApp({ config, db });

  const shutdown = async (signal: string) => {
    app.log.info(`Shutting down (${signal})`);
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  app.log.info(
    { llm: resolveLlmProviderName(config), fakeProviders: config.USE_FAKE_PROVIDERS },
    'Provider selection',
  );

  if (config.WORKER_ENABLED) {
    app.log.info(
      'In-process job queue active (plan.generate_day, preparation.*, proactive.scan every %dms)',
      config.PROACTIVE_SCAN_INTERVAL_MS,
    );
  }

  // Prefer Railway-injected PORT when present; fall back to config default (3000).
  const port = Number(process.env.PORT) || config.PORT;
  const host = config.HOST || '0.0.0.0';
  await app.listen({ port, host });
  app.log.info(`Listening on ${host}:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
