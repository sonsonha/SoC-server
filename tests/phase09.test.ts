import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { FakeCalendarProvider } from '../src/infrastructure/providers/calendar/fakeCalendarProvider.js';
import { FakeDistanceMatrixProvider } from '../src/infrastructure/providers/maps/distanceMatrix.js';
import {
  calendarCommitments,
  planBlocks,
} from '../src/infrastructure/db/schema/index.js';
import {
  externalBlocksUntouched,
} from '../src/modules/integrations/calendarPullService.js';
import { encryptSecret, decryptSecret } from '../src/infrastructure/crypto/tokenEncryption.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe('Token encryption', () => {
  it('round-trips secrets', () => {
    const enc = encryptSecret('access-token-value', 'pepper-abcdefgh');
    expect(decryptSecret(enc, 'pepper-abcdefgh')).toBe('access-token-value');
  });
});

describe('EXTERNAL ownership helper', () => {
  it('detects untouched EXTERNAL blocks', () => {
    const before = [
      { id: 'ext-1', ownership: 'EXTERNAL', startEpochMs: 1, endEpochMs: 2 },
      { id: 'cos-1', ownership: 'COS', startEpochMs: 3, endEpochMs: 4 },
    ];
    const after = [
      { id: 'ext-1', ownership: 'EXTERNAL', startEpochMs: 1, endEpochMs: 2 },
      { id: 'cos-2', ownership: 'COS', startEpochMs: 5, endEpochMs: 6 },
    ];
    expect(externalBlocksUntouched(before, after)).toBe(true);
  });

  it('fails when EXTERNAL moves', () => {
    const before = [{ id: 'ext-1', ownership: 'EXTERNAL', startEpochMs: 1, endEpochMs: 2 }];
    const after = [{ id: 'ext-1', ownership: 'EXTERNAL', startEpochMs: 9, endEpochMs: 10 }];
    expect(externalBlocksUntouched(before, after)).toBe(false);
  });
});

describe('Distance matrix fake', () => {
  it('returns positive minutes', async () => {
    const dm = new FakeDistanceMatrixProvider(20);
    const minutes = await dm.travelMinutes({
      originLat: 1.3,
      originLng: 103.8,
      destLat: 1.31,
      destLng: 103.82,
    });
    expect(minutes).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasDb)('Phase 09 — calendar + maps', () => {
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
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('connects fake Google Calendar', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/integrations/google/connect',
      headers: authHeaders(),
      payload: { mode: 'fake' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().connected).toBe(true);

    const status = await app.inject({
      method: 'GET',
      url: '/v1/integrations/status',
      headers: authHeaders(),
    });
    expect(status.json().providers[0].connected).toBe(true);
  });

  it('accepts connect body with explicit null OAuth fields (Android)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/integrations/google/connect',
      headers: authHeaders(),
      payload: {
        mode: 'fake',
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        code: null,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: true, mode: 'fake' });
  });

  it('calendar sync upserts EXTERNAL blocks idempotently', async () => {
    const start = Date.now() + 2 * 86_400_000;
    const end = start + 3_600_000;
    calendar.seed([
      {
        eventId: 'meet-idempotent-1',
        title: 'Design review',
        startEpochMs: start,
        endEpochMs: end,
        calendarId: 'primary',
      },
    ]);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/calendar/sync',
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().summary.upserted).toBeGreaterThanOrEqual(1);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/calendar/sync',
      headers: authHeaders(),
    });
    expect(second.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(calendarCommitments)
      .where(
        and(
          eq(calendarCommitments.externalCalendarEventId, 'meet-idempotent-1'),
          isNull(calendarCommitments.deletedAt),
        ),
      );
    expect(rows).toHaveLength(1);

    const blocks = await db
      .select()
      .from(planBlocks)
      .where(
        and(eq(planBlocks.id, 'ext-meet-idempotent-1'), isNull(planBlocks.deletedAt)),
      );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].ownership).toBe('EXTERNAL');
    expect(blocks[0].locked).toBe(true);
  });

  it('lists calendar events after sync', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/calendar/events',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events.length).toBeGreaterThan(0);
    expect(res.json().events.every((e: { ownership: string }) => e.ownership === 'EXTERNAL')).toBe(
      true,
    );
  });

  it('COS write does not mutate EXTERNAL seed on fake provider', async () => {
    const before = await calendar.listEvents(0, Number.MAX_SAFE_INTEGER);
    await calendar.upsertCosEvent({
      title: 'Deep work',
      startEpochMs: Date.now(),
      endEpochMs: Date.now() + 3_600_000,
    });
    const after = await calendar.listEvents(0, Number.MAX_SAFE_INTEGER);
    expect(after).toEqual(before);
    expect(calendar.cosEvents().size).toBeGreaterThan(0);
  });

  it('calendar.pull job runs', async () => {
    jobQueue.enqueue('calendar.pull', {});
    await jobQueue.flush();
    const status = await app.inject({
      method: 'GET',
      url: '/v1/integrations/status',
      headers: authHeaders(),
    });
    expect(status.json().providers[0].connected).toBe(true);
  });
});
