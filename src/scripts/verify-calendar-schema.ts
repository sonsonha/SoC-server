/**
 * Production schema probe for Batch C Calendar OAuth persistence.
 * Safe: no token values printed.
 *
 *   npm run calendar:verify-schema
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
    let journalTags: string[] = [];
    try {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
      journalTags = journal.entries.map((e) => e.tag);
    } catch {
      journalTags = [];
    }

    const migrations = await sql`
      SELECT id, hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at
    `.catch(async () =>
      sql`SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at`.catch(() => [] as never),
    );

    const appliedCount = Array.isArray(migrations) ? migrations.length : 0;
    console.log('=== drizzle migrations (applied count) ===', appliedCount);
    console.log('=== drizzle journal tags (repo) ===', journalTags.length);
    for (const tag of journalTags) console.log(`  journal: ${tag}`);

    const tag0022 = '0022_calendar_token_ownership_repair';
    const journalHas0022 = journalTags.includes(tag0022);
    // Drizzle stores content hashes, not tags. Infer 0022 applied when applied count
    // covers the journal entry index for 0022 (idx 20 → at least 21 migrations).
    const idx0022 = journalTags.indexOf(tag0022);
    const migration0022LikelyApplied = idx0022 >= 0 && appliedCount > idx0022;
    console.log('=== migration 0022 in journal ===', journalHas0022);
    console.log('=== migration 0022 likely applied (count > journal idx) ===', migration0022LikelyApplied);
    console.log('=== applied migration hashes (order) ===');
    if (Array.isArray(migrations)) {
      for (const m of migrations) {
        console.log(`  id=${m.id} hash=${String(m.hash).slice(0, 12)}… at=${m.created_at}`);
      }
    }

    const cols = await sql`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'integration_tokens'
      ORDER BY ordinal_position
    `;
    console.log('=== integration_tokens columns ===');
    for (const c of cols) console.log(`  ${c.column_name} nullable=${c.is_nullable} ${c.data_type}`);

    const indexes = await sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('integration_tokens', 'oauth_connection_states', 'calendar_commitments', 'calendar_sync_state')
      ORDER BY tablename, indexname
    `;
    console.log('=== indexes ===');
    for (const i of indexes) console.log(`  ${i.indexname}: ${i.indexdef}`);

    const constraints = await sql`
      SELECT conname, contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'public.integration_tokens'::regclass
      ORDER BY conname
    `;
    console.log('=== integration_tokens constraints ===');
    for (const c of constraints) console.log(`  ${c.conname} (${c.contype}): ${c.def}`);

    const oauthTable = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'oauth_connection_states'
      ) AS exists
    `;
    console.log('=== oauth_connection_states exists ===', oauthTable[0]?.exists);

    const tokenRows = await sql`
      SELECT
        id,
        user_id IS NOT NULL AS has_user_id,
        provider,
        refresh_token_enc IS NOT NULL AS has_refresh,
        google_account_email IS NOT NULL AS has_email,
        write_calendar_id IS NOT NULL AS has_write_cal,
        status,
        last_error_code,
        updated_at
      FROM integration_tokens
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 20
    `;
    console.log('=== integration_tokens rows (safe) ===');
    console.log(JSON.stringify(tokenRows, null, 2));

    const oauthRecent = await sql`
      SELECT
        id,
        user_id,
        expires_at,
        consumed_at IS NOT NULL AS consumed,
        created_at
      FROM oauth_connection_states
      ORDER BY created_at DESC
      LIMIT 10
    `.catch(() => [] as never);
    console.log('=== recent oauth_connection_states ===');
    console.log(JSON.stringify(oauthRecent, null, 2));

    const nullUsers = await sql`
      SELECT COUNT(*)::int AS n FROM integration_tokens WHERE user_id IS NULL
    `;
    console.log('=== tokens with NULL user_id ===', nullUsers[0]?.n);

    const providerOnlyUnique = indexes.filter((i) =>
      String(i.indexdef).includes('(provider)') && !String(i.indexdef).includes('user_id'),
    );
    console.log('=== leftover provider-only unique indexes ===', providerOnlyUnique.length);
    for (const i of providerOnlyUnique) console.log(`  ${i.indexname}: ${i.indexdef}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
