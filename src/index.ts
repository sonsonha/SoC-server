import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { closeDb, createDb } from './infrastructure/db/client.js';
import { runMigrations } from './infrastructure/db/migrate.js';
import { resolveLlmProviderName } from './infrastructure/providers/llm/index.js';

async function main() {
  const config = loadConfig();
  await runMigrations(config.DATABASE_URL);
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

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`Listening on ${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
