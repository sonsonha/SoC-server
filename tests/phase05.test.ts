import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import {
  opportunityRequirements,
  preparations,
} from '../src/infrastructure/db/schema/index.js';
import { validateOpportunityPrimaryUrl } from '../src/modules/resources/opportunityUrlValidator.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe('Opportunity URL validator', () => {
  it('prefers official .gov/.edu when available in search results', () => {
    const candidates = [
      { title: 'Blog', url: 'https://example.com/fellowship', snippet: '', provider: 'fake' },
      { title: 'Official', url: 'https://fulbright.edu/eligibility', snippet: '', provider: 'fake' },
    ];
    const bad = validateOpportunityPrimaryUrl('https://example.com/fellowship', candidates);
    expect(bad.ok).toBe(false);
    const good = validateOpportunityPrimaryUrl('https://fulbright.edu/eligibility', candidates);
    expect(good.ok).toBe(true);
  });

  it('allows any URL when no official sources in results', () => {
    const candidates = [
      { title: 'Blog', url: 'https://example.com/guide', snippet: '', provider: 'fake' },
    ];
    const result = validateOpportunityPrimaryUrl('https://example.com/guide', candidates);
    expect(result.ok).toBe(true);
  });
});

describe.skipIf(!hasDb)('Phase 05 — opportunities and exploration', () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let jobQueue: Awaited<ReturnType<typeof buildApp>>['jobQueue'];
  let deviceId = '';
  let deviceSecret = '';
  const authHeaders = () => ({ authorization: `Device ${deviceId}:${deviceSecret}` });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEVICE_AUTH_PEPPER ??= 'test-pepper-abcdefgh';
    process.env.USE_FAKE_PROVIDERS = 'true';
    process.env.LOG_LEVEL = 'error';
    const config = loadConfig();
    await runMigrations(config.DATABASE_URL);
    db = createDb(config.DATABASE_URL);
    const built = await buildApp({ config, db });
    app = built.app;
    jobQueue = built.jobQueue;
    await app.ready();

    const reg = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      payload: { force: true },
    });
    deviceId = reg.json().deviceId;
    deviceSecret = reg.json().deviceSecret;
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeDb();
  });

  it('exploration intake → EXPLORATION preparation READY with ≥2 sources', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: {
        text: 'What should I know about Singapore tech scene before visiting?',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.interpretation.kind).toBe('EXPLORATION');
    expect(body.interpretation.creates?.preparation?.targetType).toBe('EXPLORATION');

    await jobQueue.flush(10_000);

    const prepId = body.interpretation.creates?.preparation?.id as string;
    const prep = await db.select().from(preparations).where(eq(preparations.id, prepId)).limit(1);
    expect(prep[0]?.status).toBe('READY');
    expect(prep[0]?.targetType).toBe('EXPLORATION');
    expect(prep[0]?.doneCriteria.length).toBeGreaterThanOrEqual(3);
    expect(prep[0]?.selectedResourceId).toBeTruthy();
  });

  it('opportunity intake populates requirements from official source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: {
        text: 'Prepare for applying to Fulbright fellowship this month',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.interpretation.kind).toBe('OPPORTUNITY_RESEARCH');

    await jobQueue.flush(10_000);

    const oppId = body.interpretation.creates?.opportunity?.id as string;
    const prepId = body.interpretation.creates?.preparation?.id as string;
    const prep = await db.select().from(preparations).where(eq(preparations.id, prepId)).limit(1);
    expect(prep[0]?.status).toBe('READY');
    expect(prep[0]?.targetType).toBe('OPPORTUNITY');

    const reqs = await db
      .select()
      .from(opportunityRequirements)
      .where(eq(opportunityRequirements.opportunityId, oppId));
    expect(reqs.length).toBeGreaterThanOrEqual(3);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/opportunities/${oppId}`,
      headers: authHeaders(),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().requirements.length).toBeGreaterThanOrEqual(3);
  });

  it('GET /v1/week returns deadlines with prep status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/week',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().weekStart).toBeTruthy();
    expect(Array.isArray(res.json().deadlines)).toBe(true);
  });

  it('PATCH /v1/opportunity-requirements/:id toggles done', async () => {
    const intake = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: { text: 'Prepare for NSF Graduate Research Fellowship application' },
    });
    await jobQueue.flush(10_000);
    const oppId = intake.json().interpretation.creates?.opportunity?.id as string;
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/opportunities/${oppId}`,
      headers: authHeaders(),
    });
    const reqId = detail.json().requirements[0]?.id as string;
    expect(reqId).toBeTruthy();

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/opportunity-requirements/${reqId}`,
      headers: authHeaders(),
      payload: { done: true },
    });
    expect(patch.statusCode).toBe(200);

    const after = await db
      .select()
      .from(opportunityRequirements)
      .where(eq(opportunityRequirements.id, reqId))
      .limit(1);
    expect(after[0]?.done).toBe(true);
  });
});
