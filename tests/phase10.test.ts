import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import {
  goals,
  opportunities,
  profileStatus,
  skillLevels,
  travelEdges,
} from '../src/infrastructure/db/schema/index.js';
import { getActiveProfile } from '../src/application/syncService.js';
import { IntakeService } from '../src/application/intakeService.js';
import { FakeLlmProvider } from '../src/infrastructure/providers/llm/fakeLlmProvider.js';
import { JobQueue } from '../src/infrastructure/jobs/jobQueue.js';
import { OpportunitySuggestService } from '../src/modules/opportunities/suggestService.js';
import { FakeSearchProvider } from '../src/infrastructure/providers/search/fakeSearchProvider.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Phase 10 — user model + clarify + suggestions', () => {
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
      .insert(goals)
      .values({
        id: 'goal-test-short',
        title: 'Ship rover demo',
        lifeArea: 'CORE_WORK',
        seasonId: null,
        description: 'test',
        horizon: 'SHORT',
        status: 'ACTIVE',
        targetDate: null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: goals.id,
        set: { title: 'Ship rover demo', status: 'ACTIVE', updatedAt: now, deletedAt: null },
      });

    await db
      .insert(skillLevels)
      .values({
        id: 'skill-test-cv',
        domain: 'computer vision',
        level: 3,
        notes: null,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: skillLevels.id,
        set: { domain: 'computer vision', level: 3, updatedAt: now, deletedAt: null },
      });

    await db
      .insert(profileStatus)
      .values({
        id: 'profile-status',
        chapter: 'WORKING',
        summary: 'Building proof',
        usualLeaveHome: '07:20',
        preferredCountries: '[]',
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: profileStatus.id,
        set: {
          chapter: 'WORKING',
          usualLeaveHome: '07:20',
          preferredCountries: '[]',
          updatedAt: now,
          deletedAt: null,
        },
      });

    await db
      .insert(travelEdges)
      .values({
        id: 'travel-loc-home-loc-work',
        fromLocationId: 'loc-home',
        toLocationId: 'loc-work',
        typicalMinutes: 40,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: travelEdges.id,
        set: { typicalMinutes: 40, updatedAt: now, deletedAt: null },
      });

    await db
      .insert(opportunities)
      .values({
        id: 'opp-fulbright-test',
        title: 'Fulbright Scholar Program',
        description: 'Research fellowship abroad',
        deadlineEpochMs: Date.now() + 30 * 86_400_000,
        lastTouchedEpochMs: Date.now(),
        active: true,
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: opportunities.id,
        set: {
          title: 'Fulbright Scholar Program',
          description: 'Research fellowship abroad',
          active: true,
          updatedAt: now,
          deletedAt: null,
        },
      });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('context pack includes goals and skills', async () => {
    const profile = await getActiveProfile(db);
    expect(profile.goals.some((g) => g.title.includes('rover'))).toBe(true);
    expect(profile.skills.some((s) => s.domain.includes('vision'))).toBe(true);
    expect(profile.profile?.usualLeaveHome).toBe('07:20');
    expect(
      profile.travel.some(
        (t) =>
          t.fromLocationId === 'loc-home' &&
          t.toLocationId === 'loc-work' &&
          t.typicalMinutes === 40,
      ),
    ).toBe(true);

    const jobs = new JobQueue();
    const intake = new IntakeService(db, new FakeLlmProvider(), jobs);
    // Access via process of a learning item — pack is private; sync pull + getActiveProfile covers data.
    // Soft assert: learning intake does not ask for full profile.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: {
        text: 'Schedule 45 minutes to learn TCP reliability retransmission basics',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().interpretation.needsConfirm).toBeFalsy();
    void intake;
  });

  it('clarify endpoint updates travel then continues', async () => {
    await db
      .update(profileStatus)
      .set({
        chapter: 'WORKING',
        preferredCountries: '[]',
        updatedAt: new Date(),
        deletedAt: null,
      })
      .where(eq(profileStatus.id, 'profile-status'));

    // Soft-delete all home→work edges so commute clarify can also be exercised
    await db
      .update(travelEdges)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(travelEdges.fromLocationId, 'loc-home'));

    // Use opportunity + scholarship language — heuristic, no live LLM
    const first = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: {
        text: 'Prepare for scholarships abroad this month',
      },
    });
    expect(first.statusCode).toBe(201);
    const body = first.json();
    expect(body.interpretation.needsConfirm).toBe(true);
    expect(body.interpretation.clarificationQuestions?.length).toBeGreaterThan(0);

    const clarified = await app.inject({
      method: 'POST',
      url: '/v1/intake/clarify',
      headers: authHeaders(),
      payload: {
        text: 'Prepare for scholarships abroad this month',
        inboxItemId: body.inboxItemId,
        answers: [
          { field: 'chapter', value: 'APPLYING_ABROAD' },
          { field: 'preferred_countries', value: 'US, Singapore' },
          { field: 'commute_home_work_minutes', value: '40' },
        ],
      },
    });
    expect(clarified.statusCode).toBe(201);
    expect(clarified.json().interpretation.needsConfirm).toBeFalsy();

    const edges = await db.select().from(travelEdges);
    const homeWork = edges.find(
      (e) => e.fromLocationId === 'loc-home' && e.toLocationId === 'loc-work' && !e.deletedAt,
    );
    expect(homeWork?.typicalMinutes).toBe(40);
  });

  it('suggestions return profile-aligned opportunities when APPLYING_ABROAD', async () => {
    await db
      .update(profileStatus)
      .set({
        chapter: 'APPLYING_ABROAD',
        preferredCountries: JSON.stringify(['US']),
        updatedAt: new Date(),
        deletedAt: null,
      })
      .where(eq(profileStatus.id, 'profile-status'));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/opportunities/suggestions',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const suggestions = res.json().suggestions as Array<{ title: string; score: number }>;
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s) => /fulbright|fellowship|scholarship/i.test(s.title))).toBe(true);

    const service = new OpportunitySuggestService(db, new FakeSearchProvider());
    const scored = await service.suggest();
    expect(scored[0].score).toBeGreaterThanOrEqual(4);
  });

  it('sync pull includes goal and skill_level', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sync/pull',
      headers: authHeaders(),
      payload: { since: '0' },
    });
    expect(res.statusCode).toBe(200);
    const types = (res.json().entities as Array<{ entityType: string }>).map((e) => e.entityType);
    expect(types).toContain('goal');
    expect(types).toContain('skill_level');
    expect(types).toContain('profile_status');
  });
});
