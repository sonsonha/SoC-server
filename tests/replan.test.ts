import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { planBlocks, tasks } from '../src/infrastructure/db/schema/index.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('POST /v1/plans/replan', () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let deviceId = '';
  let deviceSecret = '';
  const date = '2026-07-29';
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

  it('NEW_MEETING inserts EXTERNAL block and moves COS blocks', async () => {
    const gen = await app.inject({
      method: 'POST',
      url: '/v1/plans/day/generate',
      headers: authHeaders(),
      payload: { date },
    });
    expect(gen.statusCode).toBe(201);

    const from = '2026-07-29T14:00:00.000Z';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/plans/replan',
      headers: authHeaders(),
      payload: {
        date,
        from,
        disruption: {
          type: 'NEW_MEETING',
          title: 'Sync with team',
          startAt: '2026-07-29T15:00:00.000Z',
          endAt: '2026-07-29T17:00:00.000Z',
          ownership: 'EXTERNAL',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toContain('NEW_MEETING');
    expect(body.impact.blocksInserted).toBeGreaterThanOrEqual(1);
    expect(body.adjustments.some((a: { kind: string }) => a.kind === 'INSERTED')).toBe(true);

    const blocks = await db
      .select()
      .from(planBlocks)
      .where(and(eq(planBlocks.date, date), isNull(planBlocks.deletedAt)));
    const external = blocks.filter((b) => b.ownership === 'EXTERNAL');
    expect(external.length).toBeGreaterThanOrEqual(1);
    expect(external.some((b) => b.title === 'Sync with team')).toBe(true);
  });

  it('never deletes existing EXTERNAL blocks', async () => {
    const extId = 'ext-standup-test';
    await db
      .insert(planBlocks)
      .values({
        id: extId,
        dailyPlanId: `plan-${date}`,
        date,
        startEpochMs: Date.UTC(2026, 6, 29, 9, 0, 0),
        endEpochMs: Date.UTC(2026, 6, 29, 9, 30, 0),
        type: 'COMMITMENT',
        ownership: 'EXTERNAL',
        title: 'Standup',
        taskId: null,
        habitId: null,
        commitmentId: extId,
        locationId: 'loc-work',
        locked: true,
        preparationId: null,
        revision: 1,
        updatedAt: new Date(),
        deletedAt: null,
      })
      .onConflictDoNothing();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/plans/replan',
      headers: authHeaders(),
      payload: {
        date,
        from: '2026-07-29T14:00:00.000Z',
        disruption: {
          type: 'NEW_MEETING',
          title: 'Afternoon sync',
          startAt: '2026-07-29T15:00:00.000Z',
          endAt: '2026-07-29T16:00:00.000Z',
          ownership: 'EXTERNAL',
        },
      },
    });
    expect(res.statusCode).toBe(200);

    const ext = await db.select().from(planBlocks).where(eq(planBlocks.id, extId)).limit(1);
    expect(ext[0]?.deletedAt).toBeNull();
  });

  it('OVERRUN sets task IN_PROGRESS with nextAction', async () => {
    const taskId = 'task-hard-stop';
    await db
      .insert(tasks)
      .values({
        id: taskId,
        title: 'Deploy rover',
        description: '',
        projectId: null,
        lifeArea: 'LEARNING',
        priority: 2,
        deadlineEpochMs: null,
        estimatedMinutes: 60,
        actualMinutes: null,
        energyRequirement: 2,
        locationRequirements: '[]',
        dependencyIds: '[]',
        preferredTime: null,
        earliestStartEpochMs: null,
        deadlineFlexible: true,
        interruptible: true,
        deepWork: false,
        nextAction: null,
        rescheduleCount: 0,
        status: 'SCHEDULED',
        verificationLevel: 'SELF_REPORTED',
        isAnchorCandidate: true,
        estimateBiasFactor: 1,
        revision: 1,
        updatedAt: new Date(),
        deletedAt: null,
      })
      .onConflictDoNothing();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/plans/replan',
      headers: authHeaders(),
      payload: {
        date,
        from: '2026-07-29T14:30:00.000Z',
        disruption: {
          type: 'OVERRUN',
          taskId,
          nextAction: 'Finish config push',
          note: 'Hard stop',
        },
      },
    });
    expect(res.statusCode).toBe(200);

    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    expect(task[0]?.status).toBe('IN_PROGRESS');
    expect(task[0]?.nextAction).toBe('Finish config push');
  });
});
