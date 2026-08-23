#!/usr/bin/env tsx
/**
 * Wipe local/dev planner work so dogfooding is not polluted by tests or old seeds.
 * Never runs automatically. Refuses production and Railway hosts.
 *
 *   npm run dev:data:reset
 */
import { loadConfig } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { assertSafeDevelopmentDatabase } from '../src/application/devDataSafety.js';
import { PLANNER_WORK_TABLES, PRESERVED_TABLES, previewPlannerWork, wipePlannerWork } from './wipePlannerWork.js';

async function main() {
  const config = loadConfig();
  const target = assertSafeDevelopmentDatabase({
    databaseUrl: config.DATABASE_URL,
    nodeEnv: config.NODE_ENV,
    railwayEnvironment: process.env.RAILWAY_ENVIRONMENT,
    allowOverride: process.env.ALLOW_DEV_DATA_RESET,
  });

  console.log('Development data reset');
  console.log(`  host:     ${target.host}:${target.port || '5432'}`);
  console.log(`  database: ${target.database}`);
  console.log(`  user:     ${target.user}`);
  console.log(`  NODE_ENV: ${config.NODE_ENV}`);
  console.log('  will delete rows in:');
  for (const table of PLANNER_WORK_TABLES) console.log(`    - ${table}`);
  console.log('  will preserve:');
  for (const table of PRESERVED_TABLES) console.log(`    - ${table}`);

  await runMigrations(config.DATABASE_URL);
  const db = createDb(config.DATABASE_URL);
  const before = await previewPlannerWork(db);
  const total = Object.values(before).filter((n) => n > 0).reduce((sum, n) => sum + n, 0);
  console.log('  current row counts:');
  for (const [table, count] of Object.entries(before)) {
    if (count !== 0) console.log(`    ${table}: ${count}`);
  }
  console.log(`  deleting ${total} planner/demo rows…`);

  await wipePlannerWork(db);

  const after = await previewPlannerWork(db);
  const remaining = Object.values(after).filter((n) => n > 0).reduce((sum, n) => sum + n, 0);
  console.log(`  remaining planner/demo rows: ${remaining}`);
  await closeDb();
  console.log('Done. Schema and credentials were not dropped.');
  console.log('Next: npm run seed:v2-goal-demo');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
