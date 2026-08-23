export const DEV_DATA_RESET_OVERRIDE = 'I_UNDERSTAND_THIS_IS_DESTRUCTIVE';

const REMOTE_HOST_RE =
  /railway|rlwy\.net|neon\.tech|supabase\.co|amazonaws\.com|render\.com|heroku|cloudsql|azure|digitalocean/i;

export type DatabaseTarget = {
  host: string;
  port: string;
  database: string;
  user: string;
};

export function describeDatabaseTarget(databaseUrl: string): DatabaseTarget {
  const parsed = new URL(databaseUrl);
  return {
    host: parsed.hostname,
    port: parsed.port || (parsed.protocol.startsWith('postgres') ? '5432' : ''),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    user: decodeURIComponent(parsed.username),
  };
}

export function isLocalDatabaseHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'postgres' || host === 'db';
}

export function assertSafeDevelopmentDatabase(input: {
  databaseUrl: string;
  nodeEnv: string;
  railwayEnvironment?: string | null;
  allowOverride?: string | null;
}): DatabaseTarget {
  if (input.nodeEnv === 'production') {
    throw new Error('Refusing to reset/seed development data: NODE_ENV=production.');
  }
  if (input.railwayEnvironment) {
    throw new Error('Refusing to reset/seed development data: RAILWAY_ENVIRONMENT is set.');
  }

  const target = describeDatabaseTarget(input.databaseUrl);
  const override = input.allowOverride === DEV_DATA_RESET_OVERRIDE;
  const remote = REMOTE_HOST_RE.test(input.databaseUrl) || REMOTE_HOST_RE.test(target.host);

  if (remote && !override) {
    throw new Error(
      `Refusing to reset/seed against a remote database host (${target.host}). ` +
        `Use a dedicated local Postgres URL, or set ALLOW_DEV_DATA_RESET=${DEV_DATA_RESET_OVERRIDE} only for a non-production remote you own.`,
    );
  }
  if (!isLocalDatabaseHost(target.host) && !override) {
    throw new Error(
      `Refusing to reset/seed against non-local host ${target.host}. ` +
        `Point DATABASE_URL at localhost, or set ALLOW_DEV_DATA_RESET=${DEV_DATA_RESET_OVERRIDE}.`,
    );
  }
  return target;
}
