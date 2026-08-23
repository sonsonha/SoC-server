#!/usr/bin/env tsx
/**
 * Phase 2: SET user_id NOT NULL on planner roots after successful backfill.
 * Kept out of automatic drizzle migrate so production can:
 *   migrate 0017 → backfill → enforce → deploy ownership-enforcing code
 *
 *   npm run planner:enforce-ownership-not-null
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import {
  assertNoNullOwnership,
  countCrossUserRelations,
  countPlannerOwnership,
} from '../src/modules/identity/plannerOwnership.js';

loadDotEnv();

async function main() {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  try {
    console.log('Preflight:', await countPlannerOwnership(db));
    await assertNoNullOwnership(db);
    const cross = await countCrossUserRelations(db);
    console.log('Cross-user relations:', cross);
    if (Object.values(cross).some((n) => n > 0)) {
      throw new Error('Fix cross-user relations before enforcing NOT NULL.');
    }
  } finally {
    await closeDb();
  }

  const sqlPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../drizzle/0018_planner_ownership_not_null.sql',
  );
  const body = readFileSync(sqlPath, 'utf8');
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  try {
    await sql.unsafe(body);
    console.log('Enforced user_id NOT NULL on goals, projects, tasks, time_blocks.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
