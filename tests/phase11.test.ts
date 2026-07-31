import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import {
  goals,
  learningItems,
  learningTracks,
  planBlocks,
  profileStatus,
  skillLevels,
} from '../src/infrastructure/db/schema/index.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Phase 11 — learning curriculum & cadence', () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let deviceId = '';
  let deviceSecret = '';
  const authHeaders = () => ({ authorization: `Device ${deviceId}:${deviceSecret}` });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEVICE_AUTH_PEPPER ??= 'test-pepper-abcdefgh';
    process.env.USE_FAKE_PROVIDERS = 'true';
    process.env.LLM_PROVIDER = 'fake';
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

    const now = new Date();
    await db
      .insert(skillLevels)
      .values({
        id: 'skill-english-p11',
        domain: 'english',
        level: 2,
        notes: null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: skillLevels.id,
        set: { level: 2, domain: 'english', updatedAt: now, deletedAt: null },
      });

    await db
      .insert(goals)
      .values({
        id: 'goal-english-p11',
        title: 'Raise English to professional level',
        lifeArea: 'INTELLECTUAL',
        seasonId: null,
        description: '',
        horizon: 'SHORT',
        status: 'ACTIVE',
        targetDate: null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: goals.id,
        set: { title: 'Raise English to professional level', status: 'ACTIVE', updatedAt: now, deletedAt: null },
      });

    await db
      .insert(profileStatus)
      .values({
        id: 'profile-status',
        chapter: 'WORKING',
        summary: 'p11',
        usualLeaveHome: '07:20',
        preferredCountries: '[]',
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: profileStatus.id,
        set: { chapter: 'WORKING', updatedAt: now, deletedAt: null },
      });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('recommendations respect skill gaps', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/learning/recommendations',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const recs = res.json().recommendations as Array<{ id: string; title: string; lifeArea: string }>;
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.some((r) => /english/i.test(r.title) || r.lifeArea === 'INTELLECTUAL')).toBe(true);
  });

  it('commit tracks then cadence schedules spaced sessions not daily', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/learning/tracks',
      headers: authHeaders(),
      payload: { recommendationIds: ['rec-english-interview'] },
    });
    expect(create.statusCode).toBe(201);
    const trackIds = create.json().trackIds as string[];
    expect(trackIds.length).toBe(1);

    const tracks = await db.select().from(learningTracks).where(eq(learningTracks.id, trackIds[0]));
    expect(tracks[0]?.status).toBe('ACTIVE');
    expect(tracks[0]?.targetPerWeek).toBeGreaterThanOrEqual(2);

    const items = await db.select().from(learningItems);
    const trackItems = items.filter((i) => i.id.startsWith(`li-${trackIds[0]}-`) && !i.deletedAt);
    expect(trackItems.length).toBe(tracks[0].targetPerWeek);
    expect(trackItems.length).toBeLessThan(7);

    const blocks = await db.select().from(planBlocks);
    const trackBlocks = blocks.filter((b) => b.id.includes(trackIds[0]) && !b.deletedAt);
    expect(trackBlocks.length).toBe(tracks[0].targetPerWeek);

    // Dates should be spaced (not 7 consecutive days)
    const dates = trackItems.map((i) => i.id.slice(`li-${trackIds[0]}-`.length)).sort();
    expect(dates[0]).not.toBe(dates[dates.length - 1]);
  });

  it('lists tracks with weekly progress', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/learning/tracks',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const tracks = res.json().tracks as Array<{
      scheduledThisWeek: number;
      targetPerWeek: number;
      completedThisWeek: number;
    }>;
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks[0].scheduledThisWeek).toBeGreaterThan(0);
    expect(tracks[0].scheduledThisWeek).toBeLessThanOrEqual(tracks[0].targetPerWeek);
  });
});
