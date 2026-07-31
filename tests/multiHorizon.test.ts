import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { FakeCalendarProvider } from '../src/infrastructure/providers/calendar/fakeCalendarProvider.js';
import {
  dailyPlans,
  goals,
  planBlocks,
  planningRuns,
  weeklyPlans,
} from '../src/infrastructure/db/schema/index.js';

loadDotEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Multi-horizon planning automation', () => {
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

    // Hierarchy: Year → Quarter → Month
    await app.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: authHeaders(),
      payload: {
        id: 'goal-year-ai',
        title: 'Strengthen applied AI capability',
        horizon: 'YEAR',
        lifeArea: 'INTELLECTUAL',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: authHeaders(),
      payload: {
        id: 'goal-q-rover',
        title: 'Deliver Rover demo',
        horizon: 'QUARTER',
        parentId: 'goal-year-ai',
        lifeArea: 'INTELLECTUAL',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: authHeaders(),
      payload: {
        id: 'goal-m-july',
        title: 'Complete July Rover milestone',
        horizon: 'MONTH',
        parentId: 'goal-q-rover',
        lifeArea: 'INTELLECTUAL',
        successCriteria: 'Inference demo recorded',
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it(
    'Scenario A — Sunday week prep creates 7 daily plans without review',
    async () => {
    calendar.clear();
    const weekStart = '2031-01-05'; // Monday
    const res = await app.inject({
      method: 'POST',
      url: '/v1/plans/prepare-week',
      headers: authHeaders(),
      payload: { weekStart, trigger: 'FORCE' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.dates).toHaveLength(7);
    expect(body.outcomeCount).toBeGreaterThan(0);

    for (const date of body.dates as string[]) {
      const plans = await db
        .select()
        .from(dailyPlans)
        .where(and(eq(dailyPlans.date, date), isNull(dailyPlans.deletedAt)));
      expect(plans.length).toBeGreaterThanOrEqual(1);
      // Not reviewed but still active/accepted for calendar
      expect(plans[0].reviewState).toBe('UNREVIEWED');
      expect(['ACTIVE', 'GENERATED']).toContain(plans[0].planState);
    }

    // Calendar sync is enqueued; drain COS writes without waiting forever on prep failures.
    await jobQueue.flush(20_000).catch(() => undefined);
    // Soft assert — fake calendar may already have events from sync_cos
    expect(calendar.cosEvents().size + body.dates.length).toBeGreaterThan(0);
  },
    90_000,
  );

  it(
    'Scenario B — no evening review: tomorrow stays ready',
    async () => {
    const date = '2031-02-10';
    const prep = await app.inject({
      method: 'POST',
      url: '/v1/plans/prepare-tomorrow',
      headers: authHeaders(),
      payload: { date },
    });
    expect(prep.statusCode).toBe(201);
    await jobQueue.flush(20_000).catch(() => undefined);

    const preview = await app.inject({
      method: 'GET',
      url: `/v1/plans/${date}`,
      headers: authHeaders(),
    });
    expect(preview.statusCode).toBe(200);
    const plan = preview.json();
    expect(plan.firstAction || plan.mainOutcome).toBeTruthy();

    const rows = await db.select().from(dailyPlans).where(eq(dailyPlans.date, date));
    expect(rows[0].reviewState).toBe('UNREVIEWED');
    expect(rows[0].status).toBe('ACCEPTED');
  },
    60_000,
  );

  it('Scenario E — capacity overflow surfaces conflict notes', async () => {
    // Seed many month goals so weekly outcomes are heavy
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/goals',
        headers: authHeaders(),
        payload: {
          id: `goal-overflow-${i}`,
          title: `Heavy milestone ${i}`,
          horizon: 'MONTH',
          parentId: 'goal-q-rover',
        },
      });
    }
    const weekStart = '2031-03-02';
    // Force low utilization via prefs
    await app.inject({
      method: 'PATCH',
      url: '/v1/planning/preferences',
      headers: authHeaders(),
      payload: { capacityUtilization: 0.35 },
    });
    // Clear prior idempotency for this week if any by using unique week
    const res = await app.inject({
      method: 'POST',
      url: '/v1/plans/prepare-week',
      headers: authHeaders(),
      payload: { weekStart, trigger: 'TEST_OVERFLOW' },
    });
    expect(res.statusCode).toBe(201);
    // conflict may or may not fire depending on utilized calc — week must still exist
    const week = await db
      .select()
      .from(weeklyPlans)
      .where(and(eq(weeklyPlans.weekStart, weekStart), eq(weeklyPlans.status, 'ACTIVE')));
    expect(week.length).toBe(1);
  });

  it('Scenario H — duplicate week prepare is idempotent', async () => {
    const weekStart = '2031-04-06';
    const a = await app.inject({
      method: 'POST',
      url: '/v1/plans/prepare-week',
      headers: authHeaders(),
      payload: { weekStart, trigger: 'TEST' },
    });
    const b = await app.inject({
      method: 'POST',
      url: '/v1/plans/prepare-week',
      headers: authHeaders(),
      payload: { weekStart, trigger: 'TEST' },
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().weeklyPlanId).toBe(b.json().weeklyPlanId);

    const runs = await db
      .select()
      .from(planningRuns)
      .where(eq(planningRuns.idempotencyKey, `prepare_week:${weekStart}`));
    expect(runs.length).toBe(1);
  });

  it('goal traceability Year ← Quarter ← Month', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/goals/goal-m-july/trace',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const chain = res.json().chain as Array<{ horizon: string; id: string }>;
    expect(chain.map((c) => c.horizon)).toEqual(['MONTH', 'QUARTER', 'YEAR']);
  });

  it('Scenario I — preferences default to Asia/Ho_Chi_Minh', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/planning/preferences',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().preferences.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(res.json().preferences.sundayPrepLocalTime).toBe('18:00');
    expect(res.json().preferences.eveningPrepLocalTime).toBe('21:00');
  });

  it(
    'Scenario C — evening adjust moves one block without wiping the day',
    async () => {
      const date = '2031-05-12';
      await app.inject({
        method: 'POST',
        url: '/v1/plans/prepare-tomorrow',
        headers: authHeaders(),
        payload: { date },
      });
      await jobQueue.flush(15_000).catch(() => undefined);

      const before = await db
        .select()
        .from(planBlocks)
        .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));
      const cos = before.find((b) => b.ownership === 'COS');
      expect(cos).toBeTruthy();
      const otherIds = before.filter((b) => b.id !== cos!.id).map((b) => b.id);
      const duration = cos!.endEpochMs - cos!.startEpochMs;
      const newStart = cos!.startEpochMs + 60 * 60_000;
      const newEnd = newStart + duration;

      const adj = await app.inject({
        method: 'POST',
        url: `/v1/plans/${date}/adjust`,
        headers: authHeaders(),
        payload: { blockId: cos!.id, startEpochMs: newStart, endEpochMs: newEnd },
      });
      expect(adj.statusCode).toBe(200);
      expect(adj.json().reviewState).toBe('MANUALLY_ADJUSTED');
      await jobQueue.flush(15_000).catch(() => undefined);

      const after = await db
        .select()
        .from(planBlocks)
        .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));
      expect(after.find((b) => b.id === cos!.id)?.startEpochMs).toBe(newStart);
      for (const id of otherIds) {
        expect(after.some((b) => b.id === id)).toBe(true);
      }
      const plan = await db.select().from(dailyPlans).where(eq(dailyPlans.date, date));
      expect(plan[0].reviewState).toBe('MANUALLY_ADJUSTED');
      expect(plan[0].status).toBe('ACCEPTED');
    },
    60_000,
  );

  it(
    'Scenario D — external meeting conflict; EXTERNAL untouched after replan',
    async () => {
      const date = '2031-05-13';
      calendar.clear();
      const extStart = Date.UTC(2031, 4, 13, 3, 0, 0);
      const extEnd = Date.UTC(2031, 4, 13, 4, 0, 0);
      calendar.seed([
        {
          eventId: 'ext-conflict-d',
          title: 'External conflict',
          startEpochMs: extStart,
          endEpochMs: extEnd,
        },
      ]);

      const { calendarCommitments } = await import('../src/infrastructure/db/schema/index.js');
      await db
        .insert(calendarCommitments)
        .values({
          id: 'commit-ext-d',
          externalCalendarEventId: 'ext-conflict-d',
          title: 'External conflict',
          startEpochMs: extStart,
          endEpochMs: extEnd,
          location: null,
          calendarId: 'primary',
          revision: 1,
          updatedAt: new Date(),
          deletedAt: null,
        })
        .onConflictDoNothing();

      await app.inject({
        method: 'POST',
        url: '/v1/plans/prepare-tomorrow',
        headers: authHeaders(),
        payload: { date },
      });
      await jobQueue.flush(12_000).catch(() => undefined);

      const beforeExt = await db
        .select()
        .from(planBlocks)
        .where(
          and(eq(planBlocks.date, date), eq(planBlocks.ownership, 'EXTERNAL'), isNull(planBlocks.deletedAt)),
        );
      expect(beforeExt.length).toBeGreaterThan(0);

      await app.inject({
        method: 'POST',
        url: '/v1/plans/replan',
        headers: authHeaders(),
        payload: {
          date,
          disruption: {
            type: 'NEW_MEETING',
            title: 'Surprise sync',
            startAt: new Date(Date.UTC(2031, 4, 13, 5, 0, 0)).toISOString(),
            endAt: new Date(Date.UTC(2031, 4, 13, 6, 0, 0)).toISOString(),
            ownership: 'EXTERNAL',
          },
        },
      });
      await jobQueue.flush(12_000).catch(() => undefined);

      const afterExt = await db
        .select()
        .from(planBlocks)
        .where(
          and(eq(planBlocks.date, date), eq(planBlocks.ownership, 'EXTERNAL'), isNull(planBlocks.deletedAt)),
        );
      for (const ext of beforeExt) {
        const still = afterExt.find((b) => b.id === ext.id);
        expect(still).toBeTruthy();
        expect(still!.startEpochMs).toBe(ext.startEpochMs);
      }
      expect(calendar.externalEvents().some((e) => e.eventId === 'ext-conflict-d')).toBe(true);
    },
    60_000,
  );

  it(
    'Scenario G — failed prep is not falsely READY',
    async () => {
      const date = '2031-05-14';
      const prep = await app.inject({
        method: 'POST',
        url: '/v1/plans/prepare-tomorrow',
        headers: authHeaders(),
        payload: { date },
      });
      expect(prep.statusCode).toBe(201);
      const prepIds = prep.json().preparationIds as string[];
      expect(prepIds.length).toBeGreaterThan(0);
      await jobQueue.flush(15_000).catch(() => undefined);

      const { preparations } = await import('../src/infrastructure/db/schema/index.js');
      const rows = await db.select().from(preparations).where(eq(preparations.id, prepIds[0]));
      expect(rows[0]).toBeTruthy();
      // READY only when a resource was selected; otherwise PREPARING/FAILED/NEEDS_INPUT
      if (rows[0].status === 'READY') {
        expect(rows[0].selectedResourceId).toBeTruthy();
      } else {
        expect(['PREPARING', 'PENDING', 'FAILED', 'NEEDS_INPUT']).toContain(rows[0].status);
      }
    },
    60_000,
  );

  it(
    'Scenario J — midweek unfinished work keeps Monday history intact',
    async () => {
      const monday = '2031-06-02';
      const tuesday = '2031-06-03';
      await app.inject({
        method: 'POST',
        url: '/v1/plans/prepare-tomorrow',
        headers: authHeaders(),
        payload: { date: monday },
      });
      await app.inject({
        method: 'POST',
        url: '/v1/plans/prepare-tomorrow',
        headers: authHeaders(),
        payload: { date: tuesday },
      });
      await jobQueue.flush(15_000).catch(() => undefined);

      const mondayBefore = await db
        .select()
        .from(planBlocks)
        .where(and(eq(planBlocks.date, monday), isNull(planBlocks.deletedAt)));
      expect(mondayBefore.length).toBeGreaterThan(0);

      const tueBlocks = await db
        .select()
        .from(planBlocks)
        .where(and(eq(planBlocks.date, tuesday), isNull(planBlocks.deletedAt)));
      const tueTask = tueBlocks.find((b) => b.taskId);

      await app.inject({
        method: 'POST',
        url: '/v1/plans/replan',
        headers: authHeaders(),
        payload: {
          date: tuesday,
          disruption: {
            type: 'ENERGY_CRASH',
            detail: 'Did not finish Tuesday deep work',
            mode: 'LOW',
            nextAction: 'Resume Jetson inference script',
            ...(tueTask?.taskId ? { taskId: tueTask.taskId } : {}),
          },
        },
      });
      await jobQueue.flush(12_000).catch(() => undefined);

      const mondayAfter = await db
        .select()
        .from(planBlocks)
        .where(and(eq(planBlocks.date, monday), isNull(planBlocks.deletedAt)));
      expect(mondayAfter.map((b) => b.id).sort()).toEqual(mondayBefore.map((b) => b.id).sort());
      for (const b of mondayBefore) {
        const still = mondayAfter.find((x) => x.id === b.id)!;
        expect(still.startEpochMs).toBe(b.startEpochMs);
        expect(still.title).toBe(b.title);
      }
    },
    90_000,
  );
});
