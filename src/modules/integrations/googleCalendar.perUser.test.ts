import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../../config.js';
import { closeDb, createDb, type Db } from '../../infrastructure/db/client.js';
import { runMigrations } from '../../infrastructure/db/migrate.js';
import {
  calendarCommitments,
  integrationTokens,
  oauthConnectionStates,
  users,
} from '../../infrastructure/db/schema/index.js';
import { FakeCalendarProvider } from '../../infrastructure/providers/calendar/fakeCalendarProvider.js';
import { PlannerV2Service } from '../../application/plannerV2Service.js';
import { IntegrationTokenService } from './tokenService.js';
import { OAuthConnectionStateService } from './oauthConnectionState.js';
import { JobQueue } from '../../infrastructure/jobs/jobQueue.js';
import { CalendarPullService } from './calendarPullService.js';

loadDotEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Per-user Google Calendar isolation', () => {
  let db: Db;
  let tokens: IntegrationTokenService;
  let oauthStates: OAuthConnectionStateService;
  let planner: PlannerV2Service;
  let pull: CalendarPullService;
  const userA = 'gcal-iso-a';
  const userB = 'gcal-iso-b';
  const encKey = 'test-calendar-isolation-key';

  beforeAll(async () => {
    process.env.USE_FAKE_PROVIDERS = 'true';
    process.env.WORKER_ENABLED = 'false';
    const config = loadConfig();
    await runMigrations(config.DATABASE_URL);
    db = createDb(config.DATABASE_URL);
    tokens = new IntegrationTokenService(db, encKey);
    oauthStates = new OAuthConnectionStateService(db);
    const fake = new FakeCalendarProvider();
    planner = new PlannerV2Service(db, async () => fake);
    pull = new CalendarPullService(
      db,
      async () => fake,
      new JobQueue(),
      null,
      async () => true,
    );
    const now = new Date();
    for (const [id, email, sub] of [
      [userA, 'gcal-a@example.com', 'sub-gcal-a'],
      [userB, 'gcal-b@example.com', 'sub-gcal-b'],
    ] as const) {
      await db.insert(users).values({
        id,
        googleSub: sub,
        email,
        name: email,
        avatarUrl: null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      }).onConflictDoNothing();
    }
  });

  afterAll(async () => {
    await db.delete(oauthConnectionStates).where(inArray(oauthConnectionStates.userId, [userA, userB]));
    await db.delete(calendarCommitments).where(inArray(calendarCommitments.userId, [userA, userB]));
    await db.delete(integrationTokens).where(inArray(integrationTokens.userId, [userA, userB]));
    await db.delete(users).where(inArray(users.id, [userA, userB]));
    await closeDb();
  });

  it('stores independent encrypted tokens per user', async () => {
    await tokens.saveGoogleCalendarTokens(userA, {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      googleAccountSub: 'sub-gcal-a',
      googleAccountEmail: 'gcal-a@example.com',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: 'openid email calendar',
    });
    await tokens.saveGoogleCalendarTokens(userB, {
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
      googleAccountSub: 'sub-gcal-b',
      googleAccountEmail: 'gcal-b@example.com',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: 'openid email calendar',
    });

    const a = await tokens.getGoogleCalendarTokens(userA);
    const b = await tokens.getGoogleCalendarTokens(userB);
    expect(a?.accessToken).toBe('access-a');
    expect(b?.accessToken).toBe('access-b');
    expect(a?.googleAccountEmail).toBe('gcal-a@example.com');

    const raw = await db.select().from(integrationTokens).where(eq(integrationTokens.userId, userA));
    expect(raw[0]?.accessTokenEnc).not.toContain('access-a');
    expect(a?.accessToken).toBe('access-a');
  });

  it('scopes external commitments and planner external events by user', async () => {
    await db.insert(calendarCommitments).values({
      id: randomUUID(),
      userId: userA,
      externalCalendarEventId: 'evt-a',
      title: 'A meeting',
      startEpochMs: Date.UTC(2026, 7, 18, 3),
      endEpochMs: Date.UTC(2026, 7, 18, 4),
      calendarId: 'primary',
      revision: 1,
      updatedAt: new Date(),
      deletedAt: null,
    });
    await db.insert(calendarCommitments).values({
      id: randomUUID(),
      userId: userB,
      externalCalendarEventId: 'evt-b',
      title: 'B meeting',
      startEpochMs: Date.UTC(2026, 7, 18, 5),
      endEpochMs: Date.UTC(2026, 7, 18, 6),
      calendarId: 'primary',
      revision: 1,
      updatedAt: new Date(),
      deletedAt: null,
    });

    const from = '2026-08-17T00:00:00.000Z';
    const to = '2026-08-24T00:00:00.000Z';
    const plannerA = await planner.getPlanner(userA, from, to);
    const plannerB = await planner.getPlanner(userB, from, to);
    expect(plannerA.externalEvents.map((e) => e.title)).toEqual(['A meeting']);
    expect(plannerB.externalEvents.map((e) => e.title)).toEqual(['B meeting']);

    const storedA = await pull.listStoredEvents(userA, Date.parse(from), Date.parse(to));
    expect(storedA.map((e) => e.eventId)).toEqual(['evt-a']);
  });

  it('disconnect clears only that user integration + commitments', async () => {
    await tokens.clearGoogleCalendar(userA);
    await pull.clearExternalCommitments(userA);
    expect(await tokens.getGoogleCalendarTokens(userA)).toBeNull();
    expect(await tokens.getGoogleCalendarTokens(userB)).not.toBeNull();
    const from = Date.UTC(2026, 7, 17);
    const to = Date.UTC(2026, 7, 24);
    expect(await pull.listStoredEvents(userA, from, to)).toEqual([]);
    expect((await pull.listStoredEvents(userB, from, to)).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasDb)('OAuth connection state binding', () => {
  let db: Db;
  let oauthStates: OAuthConnectionStateService;
  const userA = 'oauth-state-a';
  const userB = 'oauth-state-b';

  beforeAll(async () => {
    const config = loadConfig();
    await runMigrations(config.DATABASE_URL);
    db = createDb(config.DATABASE_URL);
    oauthStates = new OAuthConnectionStateService(db);
    const now = new Date();
    for (const [id, email, sub] of [
      [userA, 'oauth-a@example.com', 'sub-oauth-a'],
      [userB, 'oauth-b@example.com', 'sub-oauth-b'],
    ] as const) {
      await db.insert(users).values({
        id,
        googleSub: sub,
        email,
        name: email,
        avatarUrl: null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      }).onConflictDoNothing();
    }
  });

  afterAll(async () => {
    await db.delete(oauthConnectionStates).where(inArray(oauthConnectionStates.userId, [userA, userB]));
    await db.delete(users).where(inArray(users.id, [userA, userB]));
    await closeDb();
  });

  it('consumes one-time state for the bound user only', async () => {
    const { rawState } = await oauthStates.create(userA);
    expect(await oauthStates.consume(rawState)).toBe(userA);
    expect(await oauthStates.consume(rawState)).toBeNull(); // replay
  });

  it('rejects tampered state', async () => {
    const { rawState } = await oauthStates.create(userA);
    const tampered = `${rawState}x`;
    expect(await oauthStates.consume(tampered)).toBeNull();
    // original still valid until consumed
    expect(await oauthStates.consume(rawState)).toBe(userA);
  });

  it('rejects expired state', async () => {
    const rawState = 'expired-state-token-value';
    const stateHash = createHash('sha256').update(rawState).digest('hex');
    await db.insert(oauthConnectionStates).values({
      id: randomUUID(),
      stateHash,
      userId: userB,
      expiresAt: new Date(Date.now() - 60_000),
      consumedAt: null,
      createdAt: new Date(),
    });
    expect(await oauthStates.consume(rawState)).toBeNull();
  });
});
