#!/usr/bin/env tsx
/**
 * Enforce NOT NULL on Google Calendar ownership columns after backfill.
 *   npm run calendar:enforce-ownership-not-null
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { isNull, sql } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { calendarCommitments, integrationTokens } from '../src/infrastructure/db/schema/index.js';

loadDotEnv();

async function main() {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  try {
    const [t, c] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(integrationTokens).where(isNull(integrationTokens.userId)),
      db.select({ n: sql<number>`count(*)::int` }).from(calendarCommitments).where(isNull(calendarCommitments.userId)),
    ]);
    if ((t[0]?.n ?? 0) > 0 || (c[0]?.n ?? 0) > 0) {
      throw new Error(`NULL ownership remains tokens=${t[0]?.n} commitments=${c[0]?.n}`);
    }
  } finally {
    await closeDb();
  }

  const sqlPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../drizzle/0020_google_calendar_ownership_not_null.sql',
  );
  const body = readFileSync(sqlPath, 'utf8');
  const client = postgres(config.DATABASE_URL, { max: 1 });
  try {
    await client.unsafe(body);
    console.log('Enforced Google Calendar user_id NOT NULL.');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
