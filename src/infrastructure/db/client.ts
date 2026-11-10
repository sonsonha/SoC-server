import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';
import { normalizeDatabaseUrl, postgresConnectionOptions } from '../../config.js';

export type Db = PostgresJsDatabase<typeof schema>;

let sqlClient: ReturnType<typeof postgres> | null = null;
let dbInstance: Db | null = null;

export function createDb(databaseUrl: string): Db {
  const url = normalizeDatabaseUrl(databaseUrl);
  sqlClient = postgres(url, {
    max: 10,
    connect_timeout: 10,
    ...postgresConnectionOptions(url),
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
