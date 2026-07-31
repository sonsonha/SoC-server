import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import {
  decisions,
  decisionOptions,
  people,
  planBlocks,
  tasks,
  waitingItems,
} from '../src/infrastructure/db/schema/index.js';
import { isSchedulableTaskStatus } from '../src/domain/planning/schedulable.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Phase 04 — people, waiting, decisions', () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
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

  it('intake WAITING creates person, waiting item, and WAITING task', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: {
        text: 'Waiting on Alex to send the API spec before I can integrate billing',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.interpretation.kind).toBe('WAITING');
    expect(body.interpretation.creates?.person?.name).toBe('Alex');
    expect(body.interpretation.creates?.waitingItem?.title).toBeTruthy();
    expect(body.interpretation.creates?.task?.status).toBe('WAITING');

    const taskId = body.interpretation.creates?.task?.id as string;
    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    expect(task[0]?.status).toBe('WAITING');
    expect(isSchedulableTaskStatus(task[0]!.status)).toBe(false);

    const waiting = await db.select().from(waitingItems).limit(5);
    expect(waiting.some((w) => w.taskId === taskId)).toBe(true);

    const personRows = await db.select().from(people).where(eq(people.name, 'Alex')).limit(1);
    expect(personRows.length).toBeGreaterThanOrEqual(1);
  });

  it('intake DECISION creates decision with options', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: {
        text: 'Need to decide: stay in current role vs apply to PhD program by September',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.interpretation.kind).toBe('DECISION');
    const decisionId = body.interpretation.creates?.decision?.id as string;
    expect(decisionId).toBeTruthy();

    const opts = await db
      .select()
      .from(decisionOptions)
      .where(eq(decisionOptions.decisionId, decisionId));
    expect(opts.length).toBeGreaterThanOrEqual(2);
  });

  it('WAITING task excluded from day plan generation', async () => {
    const date = '2026-08-01';
    const intake = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: { text: 'Waiting on Sam to approve budget' },
    });
    const waitingTaskId = intake.json().interpretation.creates?.task?.id as string;

    const gen = await app.inject({
      method: 'POST',
      url: '/v1/plans/day/generate',
      headers: authHeaders(),
      payload: { date },
    });
    expect(gen.statusCode).toBe(201);
    const genTaskId = gen.json().blockId;

    const blocks = await db.select().from(planBlocks).where(eq(planBlocks.date, date));
    const waitingBlocks = blocks.filter((b) => b.taskId === waitingTaskId);
    expect(waitingBlocks.length).toBe(0);
    expect(blocks.some((b) => b.taskId === waitingTaskId)).toBe(false);
    expect(genTaskId).toBeTruthy();
  });

  it('resolve waiting restores task to TODO', async () => {
    const intake = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: { text: 'Waiting on Jordan to send contract' },
    });
    const taskId = intake.json().interpretation.creates?.task?.id as string;

    const waitingRes = await app.inject({
      method: 'GET',
      url: '/v1/waiting',
      headers: authHeaders(),
    });
    const item = waitingRes.json().items.find((w: { taskId: string }) => w.taskId === taskId);
    expect(item).toBeTruthy();

    await app.inject({
      method: 'POST',
      url: `/v1/waiting/${item.id}/resolve`,
      headers: authHeaders(),
    });

    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    expect(task[0]?.status).toBe('TODO');
    expect(isSchedulableTaskStatus(task[0]!.status)).toBe(true);
  });

  it('resolve decision via API', async () => {
    const intake = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: { text: 'Need to decide: remote work vs office return' },
    });
    const decisionId = intake.json().interpretation.creates?.decision?.id as string;
    const optionId = intake.json().interpretation.creates?.decision?.optionIds[0] as string;

    const resolve = await app.inject({
      method: 'POST',
      url: `/v1/decisions/${decisionId}/resolve`,
      headers: authHeaders(),
      payload: { optionId },
    });
    expect(resolve.statusCode).toBe(200);

    const row = await db.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1);
    expect(row[0]?.status).toBe('RESOLVED');
    expect(row[0]?.resolvedOptionId).toBe(optionId);
  });
});
