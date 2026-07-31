import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { FakePushProvider } from '../src/infrastructure/notifications/fcm.js';
import { NotificationService } from '../src/infrastructure/notifications/notificationService.js';
import { allowedTypesForAutonomy } from '../src/infrastructure/notifications/types.js';
import {
  dailyPlans,
  deviceFcmTokens,
  notificationLog,
  planBlocks,
  preparations,
  waitingItems,
} from '../src/infrastructure/db/schema/index.js';
import { ProactiveScanService } from '../src/modules/proactive/scanService.js';
import { JobQueue } from '../src/infrastructure/jobs/jobQueue.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe('Autonomy gating', () => {
  it('SUGGEST suppresses PLAN_UPDATED', () => {
    const allowed = allowedTypesForAutonomy('SUGGEST');
    expect(allowed.has('PREP_READY')).toBe(true);
    expect(allowed.has('PLAN_UPDATED')).toBe(false);
    expect(allowed.has('WAITING_FOLLOW_UP')).toBe(false);
  });

  it('INTERNAL_PLAN allows PLAN_UPDATED but not WAITING_FOLLOW_UP', () => {
    const allowed = allowedTypesForAutonomy('INTERNAL_PLAN');
    expect(allowed.has('PLAN_UPDATED')).toBe(true);
    expect(allowed.has('WAITING_FOLLOW_UP')).toBe(false);
  });

  it('PROACTIVE_REPLAN allows all types', () => {
    const allowed = allowedTypesForAutonomy('PROACTIVE_REPLAN');
    expect(allowed.has('WAITING_FOLLOW_UP')).toBe(true);
    expect(allowed.has('DEADLINE')).toBe(true);
  });
});

describe.skipIf(!hasDb)('Phase 07 — proactive FCM', () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let jobQueue: Awaited<ReturnType<typeof buildApp>>['jobQueue'];
  let push: FakePushProvider;
  let notificationService: NotificationService;
  let deviceId = '';
  let deviceSecret = '';
  const authHeaders = () => ({ authorization: `Device ${deviceId}:${deviceSecret}` });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEVICE_AUTH_PEPPER ??= 'test-pepper-abcdefgh';
    process.env.USE_FAKE_PROVIDERS = 'true';
    process.env.NOTIFY_MAX_PER_DAY = '8';
    process.env.LOG_LEVEL = 'error';
    const config = loadConfig();
    await runMigrations(config.DATABASE_URL);
    db = createDb(config.DATABASE_URL);
    push = new FakePushProvider();
    const built = await buildApp({ config, db, pushProvider: push });
    app = built.app;
    jobQueue = built.jobQueue;
    notificationService = built.notificationService;
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

  it('FCM token register is idempotent', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/devices/fcm-token',
      headers: authHeaders(),
      payload: { token: 'token-abc', autonomy: 'INTERNAL_PLAN' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/devices/fcm-token',
      headers: authHeaders(),
      payload: { token: 'token-abc-updated', autonomy: 'SUGGEST' },
    });
    expect(second.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(deviceFcmTokens)
      .where(eq(deviceFcmTokens.deviceId, deviceId));
    expect(rows.length).toBe(1);
    expect(rows[0]?.token).toBe('token-abc-updated');
    expect(rows[0]?.autonomy).toBe('SUGGEST');
  });

  it('budget prevents > N notifications/day', async () => {
    push.clear();
    await notificationService.registerToken(deviceId, 'budget-token', {
      autonomy: 'PROACTIVE_REPLAN',
    });
    await db.delete(notificationLog).where(eq(notificationLog.deviceId, deviceId));

    let sentTotal = 0;
    for (let i = 0; i < 12; i++) {
      const result = await notificationService.notify({
        deviceId,
        type: 'PREP_READY',
        title: `Ready ${i}`,
        body: 'test',
        deepLink: `cos://prepared/${i}`,
        entityType: 'preparation',
        entityId: `prep-${i}`,
      });
      sentTotal += result.sent;
    }
    // Global max 8, but PREP_READY type cap is 4
    expect(sentTotal).toBeLessThanOrEqual(8);
    expect(sentTotal).toBe(4);
    expect(push.sent.length).toBe(4);
  });

  it('SUGGEST autonomy suppresses PLAN_UPDATED', async () => {
    push.clear();
    await notificationService.registerToken(deviceId, 'suggest-token', {
      autonomy: 'SUGGEST',
    });
    await db.delete(notificationLog).where(eq(notificationLog.deviceId, deviceId));

    const suppressed = await notificationService.notify({
      deviceId,
      type: 'PLAN_UPDATED',
      title: 'Plan updated',
      body: 'test',
      deepLink: 'cos://today',
      entityType: 'daily_plan',
      entityId: 'plan-1',
    });
    expect(suppressed.sent).toBe(0);

    const allowed = await notificationService.notify({
      deviceId,
      type: 'PREP_READY',
      title: 'Ready',
      body: 'test',
      deepLink: 'cos://prepared/x',
      entityType: 'preparation',
      entityId: 'x',
    });
    expect(allowed.sent).toBe(1);
  });

  it('scan detects block without READY prep and enqueues preparation.run', async () => {
    const prepId = randomUUID();
    const blockId = randomUUID();
    const planId = `plan-scan-${Date.now()}`;
    const now = new Date();
    const startMs = Date.now() + 2 * 3_600_000;

    await db.insert(dailyPlans).values({
      id: planId,
      date: now.toISOString().slice(0, 10),
      mainOutcome: 'Scan test',
      anchorTaskIds: [],
      briefing: null,
      bufferMinutes: 0,
      hardStopNotes: null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    await db.insert(preparations).values({
      id: prepId,
      targetType: 'LEARNING',
      targetId: 'learn-scan',
      status: 'PENDING',
      scheduledStartAt: new Date(startMs),
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

    await db.insert(planBlocks).values({
      id: blockId,
      dailyPlanId: planId,
      date: now.toISOString().slice(0, 10),
      startEpochMs: startMs,
      endEpochMs: startMs + 45 * 60_000,
      type: 'TASK',
      ownership: 'COS',
      title: 'Scan learning block',
      taskId: null,
      habitId: null,
      commitmentId: null,
      locationId: null,
      locked: false,
      preparationId: prepId,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    const localQueue = new JobQueue();
    const enqueued: string[] = [];
    localQueue.register('preparation.run', async (payload) => {
      enqueued.push(payload.preparationId);
    });
    // Register other required names as no-ops so enqueue typechecks
    localQueue.register('plan.generate_day', async () => undefined);
    localQueue.register('preparation.replace', async () => undefined);
    localQueue.register('preparation.refresh', async () => undefined);
    localQueue.register('proactive.opportunity_scan', async () => undefined);
    localQueue.register('proactive.scan', async () => undefined);

    const scan = new ProactiveScanService(db, localQueue, notificationService);
    const summary = await scan.run();
    await localQueue.flush(5_000);

    expect(summary.prepEnqueued).toBeGreaterThanOrEqual(1);
    expect(enqueued).toContain(prepId);
  });

  it('waiting follow-up notifies at PROACTIVE_REPLAN autonomy', async () => {
    push.clear();
    await notificationService.registerToken(deviceId, 'waiting-token', {
      autonomy: 'PROACTIVE_REPLAN',
    });
    await db.delete(notificationLog).where(eq(notificationLog.deviceId, deviceId));

    const waitingId = randomUUID();
    await db.insert(waitingItems).values({
      id: waitingId,
      taskId: null,
      title: 'API spec',
      waitingOnPersonId: null,
      waitingOnLabel: 'Alex',
      followUpAt: new Date(Date.now() - 60_000),
      status: 'ACTIVE',
      revision: 1,
      updatedAt: new Date(),
      deletedAt: null,
    });

    const scan = new ProactiveScanService(db, jobQueue, notificationService);
    const summary = await scan.run();
    expect(summary.waitingNotified).toBeGreaterThanOrEqual(1);
    expect(push.sent.some((s) => s.payload.type === 'WAITING_FOLLOW_UP')).toBe(true);
  });

  it('DELETE /v1/devices/fcm-token clears token', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/devices/fcm-token',
      headers: authHeaders(),
      payload: { token: 'to-delete' },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/devices/fcm-token',
      headers: authHeaders(),
    });
    expect(del.statusCode).toBe(200);
    const rows = await db
      .select()
      .from(deviceFcmTokens)
      .where(eq(deviceFcmTokens.deviceId, deviceId));
    expect(rows.length).toBe(0);
  });
});
