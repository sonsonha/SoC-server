import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { closeDb, createDb } from './infrastructure/db/client.js';
import { runMigrations } from './infrastructure/db/migrate.js';
import { resolveLlmProviderName } from './infrastructure/providers/llm/index.js';

async function main() {
  console.log('boot: starting', {
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    hostEnv: process.env.HOST,
    railway: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID),
  });

  const config = loadConfig();
  console.log('boot: config ok');

  // The release command normally handles this on Railway. Running the idempotent
  // migrator here as well prevents a healthy-looking deployment from serving an
  // older schema when a platform release hook is skipped.
  try {
    await runMigrations(config.DATABASE_URL);
  } catch (err) {
    console.error('Startup migration failed:', err);
    if (config.NODE_ENV === 'production') throw err;
  }

  const db = createDb(config.DATABASE_URL);
  console.log('boot: db client created');
  const { app } = await buildApp({ config, db });
  console.log('boot: app built');

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

  // Railway healthcheck / public proxy must reach this process.
  // Never bind localhost — that causes "service unavailable" on healthcheck.
  const port = Number(process.env.PORT) || config.PORT || 3000;
  const host = '0.0.0.0';
  console.log(`Binding ${host}:${port} (PORT env=${process.env.PORT ?? 'unset'})`);
  await app.listen({ port, host });
  app.log.info(`Listening on ${host}:${port}`);
}

main().catch((err) => {
  console.error('boot: fatal', err);
  process.exit(1);
});
