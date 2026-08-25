/**
 * Verify users.ai_context exists (migration 0023).
 * Usage: npm run ai:verify-schema
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { loadConfig, loadDotEnv } from '../config.js';

loadDotEnv();

type Journal = {
  entries: Array<{ idx: number; tag: string }>;
};

async function main() {
  const config = loadConfig();
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  try {
    const journalPath = path.resolve(process.cwd(), 'drizzle/meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
    const journalTags = journal.entries.map((e) => e.tag);
    const tag0023 = '0023_ai_user_context';
    const journalHas0023 = journalTags.includes(tag0023);
    const idx0023 = journalTags.indexOf(tag0023);

    const migrations = await sql`
      SELECT id, hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at
    `.catch(async () =>
      sql`SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at`.catch(() => [] as never),
    );
    const appliedCount = Array.isArray(migrations) ? migrations.length : 0;
    const migration0023LikelyApplied = idx0023 >= 0 && appliedCount > idx0023;

    console.log('=== migration 0023 in journal ===', journalHas0023);
    console.log('=== migration 0023 likely applied ===', migration0023LikelyApplied);

    const cols = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'ai_context'
    `;
    if (!Array.isArray(cols) || cols.length === 0) {
      console.error('FAIL: users.ai_context missing — run: npm run db:migrate');
      process.exit(1);
    }
    console.log('OK: users.ai_context present', cols[0]);
    if (!journalHas0023) {
      console.error('FAIL: 0023_ai_user_context missing from drizzle journal');
      process.exit(1);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
