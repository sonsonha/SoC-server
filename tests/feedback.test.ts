import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { PreparationService } from '../src/application/preparationService.js';
import { FeedbackService } from '../src/modules/preparation/feedbackService.js';
import { FakeLlmProvider } from '../src/infrastructure/providers/llm/fakeLlmProvider.js';
import { FakeSearchProvider } from '../src/infrastructure/providers/search/fakeSearchProvider.js';
import { preparations, resources, resourcePreferences } from '../src/infrastructure/db/schema/index.js';
import { GLOBAL_PREFERENCE_ID } from '../src/infrastructure/db/schema/resourcePreferences.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Resource feedback and replace', () => {
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

  it('feedback creates row and replace yields different resource', async () => {
    const prepService = new PreparationService(db, new FakeSearchProvider(), new FakeLlmProvider());
    const feedbackService = new FeedbackService(db, jobQueue);
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

    await prepService.run(prepId);
    await jobQueue.flush(10_000);

    const first = await db.select().from(preparations).where(eq(preparations.id, prepId)).limit(1);
    const firstResourceId = first[0]?.selectedResourceId;
    expect(first[0]?.status).toBe('READY');
    expect(firstResourceId).toBeTruthy();

    const firstRes = await db
      .select()
      .from(resources)
      .where(eq(resources.id, firstResourceId!))
      .limit(1);
    const firstUrl = firstRes[0]?.url;

    await feedbackService.submitFeedback(prepId, 'TOO_LONG', 'Need something under 20 minutes');
    await jobQueue.flush(10_000);

    const second = await db.select().from(preparations).where(eq(preparations.id, prepId)).limit(1);
    expect(second[0]?.status).toBe('READY');
    expect(second[0]?.selectedResourceId).not.toBe(firstResourceId);

    const secondRes = await db
      .select()
      .from(resources)
      .where(eq(resources.id, second[0]!.selectedResourceId!))
      .limit(1);
    expect(secondRes[0]?.url).not.toBe(firstUrl);
    expect(second[0]?.provenance).toMatchObject({
      rankReasons: expect.any(Array),
      candidateCount: expect.any(Number),
    });
  });

  it('POST /v1/preparations/:id/feedback returns PREPARING then READY after job', async () => {
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
    await jobQueue.flush(10_000);

    const pull = await app.inject({
      method: 'POST',
      url: '/v1/sync/pull',
      headers: auth,
      payload: { since: '0' },
    });
    const entities = pull.json().entities as Array<{
      entityType: string;
      entityId: string;
      payload: { status?: string };
    }>;
    const readyPrep = entities.find(
      (e) => e.entityType === 'preparation' && e.payload.status === 'READY',
    );
    expect(readyPrep).toBeTruthy();
    const prepId = readyPrep!.entityId;

    const detailBefore = await app.inject({
      method: 'GET',
      url: `/v1/preparations/${prepId}`,
      headers: auth,
    });
    const resourceIdBefore = detailBefore.json().preparation.selectedResourceId;
    expect(resourceIdBefore).toBeTruthy();

    const feedback = await app.inject({
      method: 'POST',
      url: `/v1/preparations/${prepId}/feedback`,
      headers: auth,
      payload: { reason: 'TOO_LONG', note: 'Under 20 minutes' },
    });
    expect(feedback.statusCode).toBe(200);
    expect(feedback.json().preparation.status).toBe('PREPARING');

    await jobQueue.flush(10_000);

    const detailAfter = await app.inject({
      method: 'GET',
      url: `/v1/preparations/${prepId}`,
      headers: auth,
    });
    expect(detailAfter.json().preparation.status).toBe('READY');
    expect(detailAfter.json().preparation.selectedResourceId).not.toBe(resourceIdBefore);
    expect(detailAfter.json().preparation.provenance?.rankReasons?.length).toBeGreaterThan(0);
  });
});
