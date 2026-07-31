import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { FakeCalendarProvider } from '../src/infrastructure/providers/calendar/fakeCalendarProvider.js';
import { planBlocks, seasons, tasks } from '../src/infrastructure/db/schema/index.js';

loadDotEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

/** Drain COS/calendar jobs; ignore prep retry noise that can exceed flush timeout. */
async function softFlush(jobQueue: { flush: (ms?: number) => Promise<void> }, ms = 12_000) {
  await jobQueue.flush(ms).catch(() => undefined);
}

describe.skipIf(!hasDb)('Core Day — prepare tomorrow + COS calendar', () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let jobQueue: Awaited<ReturnType<typeof buildApp>>['jobQueue'];
  let calendar: FakeCalendarProvider;
  let deviceId = '';
  let deviceSecret = '';
  const authHeaders = () => ({ authorization: `Device ${deviceId}:${deviceSecret}` });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEVICE_AUTH_PEPPER ??= 'test-pepper-abcdefgh';
    process.env.USE_FAKE_PROVIDERS = 'true';
    process.env.LOG_LEVEL = 'error';
    process.env.WORKER_ENABLED = 'false';
    const config = loadConfig();
    await runMigrations(config.DATABASE_URL);
    db = createDb(config.DATABASE_URL);
    calendar = new FakeCalendarProvider();
    const built = await buildApp({ config, db, calendarProvider: calendar });
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

    await db
      .insert(seasons)
      .values({
        id: 'season-core-day',
        title: 'Ship the morning brief',
        narrative: 'Core day UX',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        priorityGoalIds: [],
        active: true,
        revision: 1,
        updatedAt: new Date(),
        deletedAt: null,
      })
      .onConflictDoNothing();

    await db
      .insert(tasks)
      .values({
        id: 'task-core-day-1',
        title: 'Deep work on CoS',
        description: '',
        status: 'TODO',
        priority: 1,
        estimatedMinutes: 60,
        revision: 1,
        updatedAt: new Date(),
        deletedAt: null,
      })
      .onConflictDoNothing();

    await app.inject({
      method: 'PATCH',
      url: '/v1/planning/preferences',
      headers: authHeaders(),
      payload: { autonomy: 'COS_CALENDAR_WRITE' },
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it(
    'prepare_tomorrow creates a multi-block day',
    async () => {
      const date = '2030-03-15';
      calendar.clear();
      calendar.seed([
        {
          eventId: 'ext-meet-core',
          title: 'External standup',
          startEpochMs: Date.UTC(2030, 2, 15, 2, 0, 0), // 09:00 ICT (+7)
          endEpochMs: Date.UTC(2030, 2, 15, 3, 0, 0),
        },
      ]);

      await app.inject({
        method: 'POST',
        url: '/v1/integrations/google/connect',
        headers: authHeaders(),
        payload: { mode: 'fake' },
      });
      await app.inject({
        method: 'POST',
        url: '/v1/calendar/sync',
        headers: authHeaders(),
        payload: {},
      });
      await softFlush(jobQueue);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/plans/prepare-tomorrow',
        headers: authHeaders(),
        payload: { date },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.blockCount).toBeGreaterThan(1);
      expect(body.preparationIds.length).toBeGreaterThan(0);

      const blocks = await db
        .select()
        .from(planBlocks)
        .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));
      expect(blocks.length).toBeGreaterThan(1);
      expect(blocks.some((b) => b.ownership === 'COS')).toBe(true);
    },
    60_000,
  );

  it(
    'accept enqueues COS upsert; EXTERNAL untouched',
    async () => {
      const date = '2030-03-16';
      calendar.clear();
      const externalBefore = [
        {
          eventId: 'ext-keep',
          title: 'Keep me',
          startEpochMs: Date.UTC(2030, 2, 16, 4, 0, 0),
          endEpochMs: Date.UTC(2030, 2, 16, 5, 0, 0),
        },
      ];
      calendar.seed(externalBefore);

      await app.inject({
        method: 'POST',
        url: '/v1/plans/prepare-tomorrow',
        headers: authHeaders(),
        payload: { date },
      });
      await softFlush(jobQueue);

      const accept = await app.inject({
        method: 'POST',
        url: `/v1/plans/${date}/accept`,
        headers: authHeaders(),
        payload: {},
      });
      expect(accept.statusCode).toBe(200);
      expect(accept.json().status).toBe('ACCEPTED');
      await softFlush(jobQueue);

      expect(calendar.cosEvents().size).toBeGreaterThan(0);
      expect(calendar.externalEvents()).toEqual(externalBefore);
    },
    60_000,
  );

  it(
    'replan then COS upsert; EXTERNAL blocks stay put',
    async () => {
      const date = '2030-03-17';
      calendar.clear();
      calendar.seed([
        {
          eventId: 'ext-fixed',
          title: 'Fixed external',
          startEpochMs: Date.UTC(2030, 2, 17, 6, 0, 0),
          endEpochMs: Date.UTC(2030, 2, 17, 7, 0, 0),
        },
      ]);

      await app.inject({
        method: 'POST',
        url: '/v1/calendar/sync',
        headers: authHeaders(),
        payload: {},
      });
      await softFlush(jobQueue);

      await app.inject({
        method: 'POST',
        url: '/v1/plans/prepare-tomorrow',
        headers: authHeaders(),
        payload: { date },
      });
      await app.inject({
        method: 'POST',
        url: `/v1/plans/${date}/accept`,
        headers: authHeaders(),
        payload: {},
      });
      await softFlush(jobQueue);

      const beforeBlocks = await db
        .select()
        .from(planBlocks)
        .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));
      const external = beforeBlocks.filter((b) => b.ownership === 'EXTERNAL');

      const replan = await app.inject({
        method: 'POST',
        url: '/v1/plans/replan',
        headers: authHeaders(),
        payload: {
          date,
          disruption: { type: 'ENERGY_CRASH', detail: 'Low energy', mode: 'LOW' },
        },
      });
      expect(replan.statusCode).toBe(200);
      await softFlush(jobQueue);

      expect(calendar.cosEvents().size).toBeGreaterThanOrEqual(1);
      expect(calendar.externalEvents().some((e) => e.eventId === 'ext-fixed')).toBe(true);

      const afterBlocks = await db
        .select()
        .from(planBlocks)
        .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));
      for (const ext of external) {
        const still = afterBlocks.find((b) => b.id === ext.id);
        expect(still).toBeTruthy();
        expect(still!.startEpochMs).toBe(ext.startEpochMs);
        expect(still!.ownership).toBe('EXTERNAL');
      }
    },
    60_000,
  );
});
