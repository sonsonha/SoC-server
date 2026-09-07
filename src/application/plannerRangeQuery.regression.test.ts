/**
 * Regression: Calendar getPlanner must return ALL overlapping Sessions for a
 * requested week even when the owner has hundreds of future recurring blocks.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { loadDotEnv } from '../config.js';
import { closeDb, createDb, type Db } from '../infrastructure/db/client.js';
import { runMigrations } from '../infrastructure/db/migrate.js';
import { FakeCalendarProvider } from '../infrastructure/providers/calendar/fakeCalendarProvider.js';
import { tasks, timeBlocks, users } from '../infrastructure/db/schema/index.js';
import { PlannerV2Service } from './plannerV2Service.js';

loadDotEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

const WEEK_FROM = '2026-09-07T00:00:00.000+07:00';
const WEEK_TO = '2026-09-14T00:00:00.000+07:00';
const WEEK_START_MS = Date.parse(WEEK_FROM);
const DAY_MS = 86_400_000;

describe.skipIf(!hasDb)('getPlanner date-range with many materialized blocks', () => {
  let db: Db;
  let planner: PlannerV2Service;
  const userId = `range-${randomUUID().slice(0, 8)}`;
  const cleanupBlocks: string[] = [];
  const cleanupTasks: string[] = [];
  const weekBlockIds: string[] = [];

  beforeAll(async () => {
    process.env.USE_FAKE_PROVIDERS = 'true';
    process.env.WORKER_ENABLED = 'false';
    db = createDb(process.env.DATABASE_URL!);
    await runMigrations(process.env.DATABASE_URL!);
    planner = new PlannerV2Service(db, async () => new FakeCalendarProvider());

    const now = new Date();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.com`,
      name: 'Range Test',
      googleSub: `sub-${userId}`,
      avatarUrl: null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    });

    const taskId = randomUUID();
    cleanupTasks.push(taskId);
    await db.insert(tasks).values({
      id: taskId,
      userId,
      title: 'Range regression task',
      description: '',
      lifeArea: 'LIFE',
      priority: 2,
      status: 'TODO',
      revision: 1,
      updatedAt: now,
    });

    const rows: Array<typeof timeBlocks.$inferInsert> = [];

    for (let i = 0; i < 320; i++) {
      const start = WEEK_START_MS + 14 * DAY_MS + i * DAY_MS + 6 * 3600_000;
      const id = randomUUID();
      cleanupBlocks.push(id);
      rows.push({
        id,
        userId,
        taskId,
        title: `Future routine ${i}`,
        startEpochMs: start,
        endEpochMs: start + 30 * 60_000,
        color: '#2563eb',
        status: 'PLANNED',
        syncStatus: i % 2 === 0 ? 'SYNCED' : 'PENDING',
        isDailyFocus: false,
        googleEventId: i % 3 === 0 ? `real-future-${i}` : null,
        revision: 1,
        updatedAt: now,
      });
    }

    for (let day = 0; day < 7; day++) {
      const start = WEEK_START_MS + day * DAY_MS + 21 * 3600_000;
      const id = randomUUID();
      cleanupBlocks.push(id);
      weekBlockIds.push(id);
      rows.push({
        id,
        userId,
        taskId,
        title: `Week session day ${day}`,
        startEpochMs: start,
        endEpochMs: start + 20 * 60_000,
        color: '#2563eb',
        status: 'PLANNED',
        syncStatus: day % 2 === 0 ? 'SYNCED' : 'PENDING',
        isDailyFocus: day === 1,
        googleEventId: day === 2 ? 'real-week-gid' : null,
        revision: 1,
        updatedAt: now,
      });
    }

    const deletedId = randomUUID();
    cleanupBlocks.push(deletedId);
    rows.push({
      id: deletedId,
      userId,
      taskId,
      title: 'Soft-deleted week twin',
      startEpochMs: WEEK_START_MS + 3 * DAY_MS + 21 * 3600_000,
      endEpochMs: WEEK_START_MS + 3 * DAY_MS + 21 * 3600_000 + 20 * 60_000,
      color: '#2563eb',
      status: 'PLANNED',
      syncStatus: 'SYNCED',
      isDailyFocus: false,
      googleEventId: 'deleted-gid',
      revision: 1,
      updatedAt: now,
      deletedAt: now,
    });

    await db.insert(timeBlocks).values(rows);
  });

  afterAll(async () => {
    if (cleanupBlocks.length) {
      await db.delete(timeBlocks).where(inArray(timeBlocks.id, cleanupBlocks));
    }
    if (cleanupTasks.length) {
      await db.delete(tasks).where(inArray(tasks.id, cleanupTasks));
    }
    await db.delete(users).where(eq(users.id, userId));
    await closeDb();
  });

  it('returns every overlapping week block regardless of 300+ future rows', async () => {
    const allActive = await db
      .select({ id: timeBlocks.id })
      .from(timeBlocks)
      .where(and(eq(timeBlocks.userId, userId), isNull(timeBlocks.deletedAt)));
    expect(allActive.length).toBeGreaterThan(300);

    const result = await planner.getPlanner(userId, WEEK_FROM, WEEK_TO);
    expect(result.timeBlocks.map((b) => b.id).sort()).toEqual([...weekBlockIds].sort());
    expect(result.timeBlocks).toHaveLength(7);

    expect(result.timeBlocks.find((b) => b.id === weekBlockIds[1])?.isDailyFocus).toBe(true);
    expect(result.timeBlocks.some((b) => b.syncStatus === 'PENDING')).toBe(true);
    expect(result.timeBlocks.some((b) => b.syncStatus === 'SYNCED')).toBe(true);
    expect(result.timeBlocks.some((b) => b.title.includes('Soft-deleted'))).toBe(false);
    expect(result.timeBlocks.some((b) => b.googleEventId === 'real-week-gid')).toBe(true);
    expect(result.timeBlocks.some((b) => !b.googleEventId && b.syncStatus === 'PENDING')).toBe(true);
  });
});
