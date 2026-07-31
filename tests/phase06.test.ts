import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { closeDb, createDb, type Db } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { PreparationService } from '../src/application/preparationService.js';
import { FakeLlmProvider } from '../src/infrastructure/providers/llm/fakeLlmProvider.js';
import { FakeSearchProvider } from '../src/infrastructure/providers/search/fakeSearchProvider.js';
import { FakePlacesProvider } from '../src/infrastructure/providers/maps/fakePlacesProvider.js';
import { preparations, resources } from '../src/infrastructure/db/schema/index.js';
import { computeDepartBy, rankVenues } from '../src/modules/preparation/venueRanker.js';
import type { VenueCandidate } from '../src/infrastructure/providers/maps/types.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe('Venue ranker', () => {
  const candidates: VenueCandidate[] = [
    {
      placeId: 'closed',
      title: 'Closed Spot',
      address: 'X',
      mapsUrl: 'https://maps.google.com/?q=closed',
      rating: 5,
      openAtTarget: false,
      hoursSummary: 'Closed',
      cuisineTags: ['japanese'],
      vibeTags: ['quiet'],
      provider: 'test',
      travelMinutesEstimate: 10,
    },
    {
      placeId: 'open-a',
      title: 'Open A',
      address: 'A',
      mapsUrl: 'https://maps.google.com/?q=a',
      rating: 4.2,
      openAtTarget: true,
      hoursSummary: 'Open',
      cuisineTags: ['japanese'],
      vibeTags: ['quiet'],
      provider: 'test',
      travelMinutesEstimate: 25,
    },
    {
      placeId: 'open-b',
      title: 'Open B',
      address: 'B',
      mapsUrl: 'https://maps.google.com/?q=b',
      rating: 4.8,
      openAtTarget: true,
      hoursSummary: 'Open',
      cuisineTags: ['italian'],
      vibeTags: ['loud'],
      provider: 'test',
      travelMinutesEstimate: 20,
    },
  ];

  it('excludes closed venue at target time', () => {
    const ranked = rankVenues(candidates, { cuisine: ['japanese'], vibe: ['quiet'] });
    expect(ranked.every((v) => v.openAtTarget)).toBe(true);
    expect(ranked.find((v) => v.placeId === 'closed')).toBeUndefined();
  });

  it('prefers cuisine/vibe match among open venues', () => {
    const ranked = rankVenues(candidates, { cuisine: ['japanese'], vibe: ['quiet'] });
    expect(ranked[0]?.placeId).toBe('open-a');
  });

  it('departBy = blockStart - travelMinutes - buffer', () => {
    const start = new Date('2026-07-31T11:00:00.000Z'); // Friday 7pm SGT
    const depart = computeDepartBy(start, 25, 10);
    expect(depart.toISOString()).toBe('2026-07-31T10:25:00.000Z');
  });
});

describe.skipIf(!hasDb)('Phase 06 — social / date logistics', () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let jobQueue: Awaited<ReturnType<typeof buildApp>>['jobQueue'];
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
    if (app) await app.close();
    await closeDb();
  });

  it('social intake → SOCIAL READY with primary + backup venues', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: {
        text: 'Date night Friday 7pm, Japanese, quiet, near Marina Bay',
        locationId: 'loc-home',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.interpretation.kind).toBe('SOCIAL');
    expect(body.interpretation.creates?.preparation?.targetType).toBe('SOCIAL');

    await jobQueue.flush(10_000);

    const prepId = body.interpretation.creates?.preparation?.id as string;
    const prep = await db.select().from(preparations).where(eq(preparations.id, prepId)).limit(1);
    expect(prep[0]?.status).toBe('READY');
    expect(prep[0]?.freshnessPolicy).toBe('EVENT_BOUND');
    expect(prep[0]?.selectedResourceId).toBeTruthy();
    expect(prep[0]?.backupResourceIds?.length).toBeGreaterThanOrEqual(1);

    const primaryId = prep[0]!.selectedResourceId!;
    const backupId = (prep[0]!.backupResourceIds as string[])[0];
    expect(backupId).not.toBe(primaryId);

    const primary = await db.select().from(resources).where(eq(resources.id, primaryId)).limit(1);
    expect(primary[0]?.format).toBe('VENUE');
    expect(primary[0]?.metadata?.placeId).toBeTruthy();
    expect(primary[0]?.metadata?.mapsUrl).toBeTruthy();

    const provenance = prep[0]?.provenance as Record<string, unknown>;
    expect(provenance.departBy).toBeTruthy();
    expect(provenance.primaryVenue).toBeTruthy();
    expect(provenance.backupVenue).toBeTruthy();
    expect((provenance.primaryVenue as { placeId: string }).placeId).not.toBe(
      (provenance.backupVenue as { placeId: string }).placeId,
    );
  });

  it('day-of refresh promotes backup when primary closed', async () => {
    const places = new FakePlacesProvider();
    const service = new PreparationService(db, new FakeSearchProvider(), new FakeLlmProvider(), places);
    const prepId = randomUUID();
    const now = new Date();
    const start = new Date(now.getTime() + 86_400_000);

    await db.insert(preparations).values({
      id: prepId,
      targetType: 'SOCIAL',
      targetId: `social-${prepId}`,
      status: 'PENDING',
      scheduledStartAt: start,
      timeBudgetMinutes: 90,
      goal: 'Date night near Marina Bay',
      practicePrompt: '',
      doneCriteria: [],
      selectedResourceId: null,
      backupResourceIds: [],
      provenance: {
        occasion: 'Date night',
        area: 'Marina Bay',
        cuisine: ['japanese'],
        vibe: ['quiet'],
      },
      freshnessPolicy: 'EVENT_BOUND',
      lastPreparedAt: null,
      failureReason: null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    await service.run(prepId);
    const ready = await db.select().from(preparations).where(eq(preparations.id, prepId)).limit(1);
    expect(ready[0]?.status).toBe('READY');
    const primaryPlaceId = (ready[0]?.provenance as { primaryVenue: { placeId: string } }).primaryVenue
      .placeId;
    const backupPlaceId = (ready[0]?.provenance as { backupVenue: { placeId: string } }).backupVenue
      .placeId;
    expect(primaryPlaceId).not.toBe(backupPlaceId);

    places.forceClosed(primaryPlaceId);
    const result = await service.refresh(prepId);
    expect(result.action).toBe('promoted_backup');

    const after = await db.select().from(preparations).where(eq(preparations.id, prepId)).limit(1);
    expect(after[0]?.status).toBe('READY');
    const newPrimary = (after[0]?.provenance as { primaryVenue: { placeId: string } }).primaryVenue
      .placeId;
    expect(newPrimary).toBe(backupPlaceId);
  });

  it('POST /v1/preparations/:id/refresh works for SOCIAL', async () => {
    const intake = await app.inject({
      method: 'POST',
      url: '/v1/intake',
      headers: authHeaders(),
      payload: { text: 'Plan Saturday coffee with Lin at a quiet cafe near Jurong' },
    });
    await jobQueue.flush(10_000);
    const prepId = intake.json().interpretation.creates?.preparation?.id as string;

    const refresh = await app.inject({
      method: 'POST',
      url: `/v1/preparations/${prepId}/refresh`,
      headers: authHeaders(),
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().status).toBe('READY');
  });
});
