import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .transform((v) => normalizeDatabaseUrl(v)),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // Railway / some hosts may set NODE_ENV=deployment; normalize to production.
  NODE_ENV: z
    .string()
    .default('development')
    .transform((v) => (v === 'deployment' || v === 'prod' ? 'production' : v))
    .pipe(z.enum(['development', 'test', 'production'])),
  LOG_LEVEL: z.string().default('info'),
  DEVICE_AUTH_PEPPER: z.string().min(8),
  // Optional server-to-server credential used by the private Personal OS web app.
  PLANNER_WEB_TOKEN: z.string().min(32).optional(),
  REGISTER_TOKEN: z.string().optional(),
  WORKER_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  GEMINI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  /** Prefer an LLM even when USE_FAKE_PROVIDERS=true (maps/search stay fake). */
  LLM_PROVIDER: z.enum(['auto', 'fake', 'gemini', 'deepseek']).default('auto'),
  SEARCH_API_KEY: z.string().optional(),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  MAPS_API_KEY: z.string().optional(),
  FCM_SERVER_KEY: z.string().optional(),
  INTEGRATION_ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),
  GOOGLE_COS_CALENDAR_ID: z.string().optional(),
  CALENDAR_PULL_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  NOTIFY_MAX_PER_DAY: z.coerce.number().int().positive().default(8),
  PROACTIVE_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(45 * 60_000),
  USE_FAKE_PROVIDERS: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Railway UI mistake: pasting `DATABASE_URL=postgresql://...` into the Value field
 * makes postgres.js throw Invalid URL. Strip accidental `KEY=` prefixes.
 */
export function normalizeDatabaseUrl(raw: string): string {
  let v = raw.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  // Strip accidental "DATABASE_URL=" pasted into the value box.
  v = v.replace(/^DATABASE_URL=/i, '').trim();
  return v;
}

/** Load backend/.env into process.env when keys are unset (no dotenv dependency). */
export function loadDotEnv(cwd: string = process.cwd()): void {
  const file = path.resolve(cwd, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) {
    loadDotEnv();
  }
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return parsed.data;
}
