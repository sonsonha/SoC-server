/**
 * Seed / reconcile the real Personal OS Goal & Project plan for the owner account.
 *
 *   npm run seed:owner-real-plan
 *
 * Resolves sonha2002.12@gmail.com at runtime. Does not create a user.
 * Does not create Tasks or TimeBlocks. Idempotent.
 */
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import {
  OWNER_REAL_PLAN_EMAIL,
  seedOwnerRealPlan,
} from '../src/modules/planner/seedOwnerRealPlan.js';

loadDotEnv();

async function main() {
  const config = loadConfig();
  const email = (process.env.OWNER_REAL_PLAN_EMAIL ?? OWNER_REAL_PLAN_EMAIL).trim();
  if (email.toLowerCase() !== OWNER_REAL_PLAN_EMAIL) {
    throw new Error(`Refusing to seed unexpected email: ${email}`);
  }

  console.log('Applying migrations (including project_context if needed)…');
  await runMigrations(config.DATABASE_URL);

  const db = createDb(config.DATABASE_URL);
  try {
    console.log(`Resolving owner: ${email}`);
    const report = await seedOwnerRealPlan(db, email);
    console.log(JSON.stringify(report, null, 2));
    console.log('\nOK — owner real plan reconciled. No Tasks/TimeBlocks created.');
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
