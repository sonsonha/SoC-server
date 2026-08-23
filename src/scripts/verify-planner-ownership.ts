#!/usr/bin/env tsx
/**
 * Verify planner ownership integrity after Batch B migration.
 *
 *   npm run planner:verify-ownership
 */
import { loadConfig, loadDotEnv } from '../config.js';
import { closeDb, createDb } from '../infrastructure/db/client.js';
import {
  assertNoNullOwnership,
  countCrossUserRelations,
  countPlannerOwnership,
} from '../modules/identity/plannerOwnership.js';

loadDotEnv();

async function main() {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  try {
    const counts = await countPlannerOwnership(db);
    console.log(counts);
    await assertNoNullOwnership(db);
    const cross = await countCrossUserRelations(db);
    console.log('Cross-user relations:', cross);
    const bad = Object.values(cross).some((n) => n > 0);
    if (bad) {
      throw new Error('Cross-user relations detected — investigate before enabling multi-user traffic.');
    }
    console.log('Ownership verification OK.');
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
