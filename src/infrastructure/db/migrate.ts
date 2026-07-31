import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';
import { loadConfig } from '../../config.js';

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  const migrationsFolder =
    process.env.MIGRATIONS_FOLDER ?? path.resolve(process.cwd(), 'drizzle');
  await migrate(db, { migrationsFolder });
  await client.end({ timeout: 5 });
}

async function main() {
  const config = loadConfig();
  await runMigrations(config.DATABASE_URL);
  console.log('Migrations applied.');
}

const entry = process.argv[1] ?? '';
if (entry.includes('migrate')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
