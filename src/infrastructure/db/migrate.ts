import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';
import { loadConfig, normalizeDatabaseUrl } from '../../config.js';

export async function runMigrations(databaseUrl: string): Promise<void> {
  const url = normalizeDatabaseUrl(databaseUrl);
  const needsSsl =
    /sslmode=require/i.test(url) ||
    /\.rlwy\.net/i.test(url) ||
    /\.railway\.app/i.test(url);
  const client = postgres(url, {
    max: 1,
    ssl: needsSsl ? 'require' : undefined,
  });
  const db = drizzle(client);
  const migrationsFolder =
    process.env.MIGRATIONS_FOLDER ?? path.resolve(process.cwd(), 'drizzle');
  await migrate(db, { migrationsFolder });
  await client.end({ timeout: 5 });
}

async function main() {
  // Release/migrate on Railway only needs DATABASE_URL — do not require full app config
  // (DEVICE_AUTH_PEPPER etc.) or deploys fail before the service ever starts.
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    // Fall back for local runs that rely on .env via loadConfig()
    const config = loadConfig();
    await runMigrations(config.DATABASE_URL);
  } else {
    await runMigrations(raw);
  }
  console.log('Migrations applied.');
}

const entry = process.argv[1] ?? '';
if (entry.includes('migrate')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
