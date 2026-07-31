import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Db = PostgresJsDatabase<typeof schema>;

let sqlClient: ReturnType<typeof postgres> | null = null;
let dbInstance: Db | null = null;

export function createDb(databaseUrl: string): Db {
  // Defensive: strip accidental "DATABASE_URL=" pasted into Railway Value field.
  const url = databaseUrl.replace(/^DATABASE_URL=/i, '').trim();
  // Railway Postgres often requires TLS on the public URL; internal URL may not.
  const needsSsl =
    /sslmode=require/i.test(url) ||
    /\.rlwy\.net/i.test(url) ||
    /\.railway\.app/i.test(url);
  sqlClient = postgres(url, {
    max: 10,
    connect_timeout: 10,
    ssl: needsSsl ? 'require' : undefined,
  });
  dbInstance = drizzle(sqlClient, { schema });
  return dbInstance;
}

export function getDb(): Db {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call createDb first.');
  }
  return dbInstance;
}

export async function checkDb(): Promise<boolean> {
  if (!sqlClient) return false;
  try {
    await sqlClient`select 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
    dbInstance = null;
  }
}
