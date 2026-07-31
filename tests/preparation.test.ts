import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { PreparationService } from '../src/application/preparationService.js';
import { FakeLlmProvider } from '../src/infrastructure/providers/llm/fakeLlmProvider.js';
import {
  EmptySearchProvider,
  FakeSearchProvider,
} from '../src/infrastructure/providers/search/fakeSearchProvider.js';
import { preparations } from '../src/infrastructure/db/schema/index.js';
import { GLOBAL_PREFERENCE_ID, resourcePreferences } from '../src/infrastructure/db/schema/resourcePreferences.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Preparation pipeline', () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let jobQueue: Awaited<ReturnType<typeof buildApp>>['jobQueue'];
  let deviceId = '';
  let deviceSecret = '';

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

    await db.delete(resourcePreferences).where(eq(resourcePreferences.id, GLOBAL_PREFERENCE_ID));
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeDb();
  });

  it('runs preparation pipeline to READY with fake providers', async () => {
    const service = new PreparationService(db, new FakeSearchProvider(), new FakeLlmProvider());
    const prepId = randomUUID();
    const now = new Date();

    await db.insert(preparations).values({
      id: prepId,
      targetType: 'LEARNING',
      targetId: 'learn-networking',
      status: 'PENDING',
      scheduledStartAt: now,
      timeBudgetMinutes: 45,
      goal: '',
      practicePrompt: '',
      doneCriteria: [],
      selectedResourceId: null,
      backupResourceIds: [],
      provenance: null,
      freshnessPolicy: 'STATIC',
      lastPreparedAt: null,
      failureReason: null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    await service.run(prepId);

    const rows = await db.select().from(preparations).where(eq(preparations.id, prepId)).limit(1);
    expect(rows[0]?.status).toBe('READY');
    expect(rows[0]?.goal).toBeTruthy();
    expect(rows[0]?.doneCriteria.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.selectedResourceId).toBeTruthy();
  });

  it('sets NEEDS_INPUT when search returns empty', async () => {
    const service = new PreparationService(db, new EmptySearchProvider(), new FakeLlmProvider());
    const prepId = randomUUID();
    const now = new Date();

    await db.insert(preparations).values({
      id: prepId,
      targetType: 'LEARNING',
      targetId: 'learn-networking',
      status: 'PENDING',
      scheduledStartAt: now,
      timeBudgetMinutes: 30,
      goal: '',
      practicePrompt: '',
      doneCriteria: [],
      selectedResourceId: null,
      backupResourceIds: [],
      provenance: null,
      freshnessPolicy: 'STATIC',
      lastPreparedAt: null,
      failureReason: null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    await service.run(prepId);

    const rows = await db.select().from(preparations).where(eq(preparations.id, prepId)).limit(1);
    expect(rows[0]?.status).toBe('NEEDS_INPUT');
  });

  it('intake queues jobs and preparation becomes READY', async () => {
    const auth = { authorization: `Device ${deviceId}:${deviceSecret}` };
    const intake = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: auth,
      payload: {
        text: 'Schedule 45 minutes to learn TCP reliability for systems interviews',
        capturedAt: new Date().toISOString(),
      },
    });
    expect(intake.statusCode).toBe(201);
    expect(intake.json().interpretation.kind).toBe('LEARNING');

    await jobQueue.flush(10_000);

    const pull = await app.inject({
      method: 'POST',
      url: '/v1/sync/pull',
      headers: auth,
      payload: { since: '0' },
    });
    expect(pull.statusCode).toBe(200);
    const entities = pull.json().entities as Array<{ entityType: string; payload: { status?: string } }>;
    const readyPrep = entities.find(
      (e) => e.entityType === 'preparation' && e.payload.status === 'READY',
    );
    expect(readyPrep).toBeTruthy();
  });
});
