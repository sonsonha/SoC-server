/**
 * Cross-user isolation for Batch B planner ownership.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../config.js';
import { closeDb, createDb, type Db } from '../infrastructure/db/client.js';
import { runMigrations } from '../infrastructure/db/migrate.js';
import { goals, projects, tasks, timeBlocks, users } from '../infrastructure/db/schema/index.js';
import { FakeCalendarProvider } from '../infrastructure/providers/calendar/fakeCalendarProvider.js';
import { PlannerV2Service } from './plannerV2Service.js';

loadDotEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Planner ownership isolation (User A vs User B)', () => {
  let db: Db;
  let planner: PlannerV2Service;
  const userA = 'own-iso-a';
  const userB = 'own-iso-b';
  const cleanup = {
    goals: [] as string[],
    projects: [] as string[],
    tasks: [] as string[],
    blocks: [] as string[],
  };

  beforeAll(async () => {
    process.env.USE_FAKE_PROVIDERS = 'true';
    process.env.WORKER_ENABLED = 'false';
    process.env.LOG_LEVEL = 'error';
    const config = loadConfig();
    await runMigrations(config.DATABASE_URL);
    db = createDb(config.DATABASE_URL);
    planner = new PlannerV2Service(db, async () => new FakeCalendarProvider());

    const now = new Date();
    for (const [id, email, sub] of [
      [userA, 'a-iso@example.com', 'sub-iso-a'],
      [userB, 'b-iso@example.com', 'sub-iso-b'],
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
    if (cleanup.blocks.length) await db.delete(timeBlocks).where(inArray(timeBlocks.id, cleanup.blocks));
    if (cleanup.tasks.length) await db.delete(tasks).where(inArray(tasks.id, cleanup.tasks));
    if (cleanup.projects.length) await db.delete(projects).where(inArray(projects.id, cleanup.projects));
    if (cleanup.goals.length) await db.delete(goals).where(inArray(goals.id, cleanup.goals));
    await db.delete(users).where(inArray(users.id, [userA, userB]));
    await closeDb();
  });

  async function seedUser(userId: string, label: string) {
    const goal = await planner.createGoal(userId, {
      title: `${label} goal`,
      processes: [{
        id: `${label}-proc`,
        name: 'Work',
        measurementType: 'COUNT',
        targetValue: 3,
        period: 'WEEK',
        active: true,
      }],
    });
    cleanup.goals.push(goal.id);
    const project = await planner.createProject(userId, {
      title: `${label} project`,
      goalId: goal.id,
      defaultGoalProcessId: `${label}-proc`,
    });
    cleanup.projects.push(project.id);
    const task = await planner.createTask(userId, {
      title: `${label} task`,
      projectId: project.id,
      goalId: goal.id,
      goalProcessId: `${label}-proc`,
      dueHorizon: 'WEEK',
    });
    cleanup.tasks.push(task.id);
    const start = Date.UTC(2026, 7, 18, 2, 0);
    const block = await planner.createTimeBlock(userId, {
      taskId: task.id,
      title: `${label} block`,
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + 3_600_000).toISOString(),
    });
    cleanup.blocks.push(block.id);
    return { goal, project, task, block };
  }

  it('lists only the authenticated user planner roots', async () => {
    const a = await seedUser(userA, 'A');
    const b = await seedUser(userB, 'B');
    const from = '2026-08-17T00:00:00.000Z';
    const to = '2026-08-24T00:00:00.000Z';
    const plannerA = await planner.getPlanner(userA, from, to);
    const plannerB = await planner.getPlanner(userB, from, to);
    expect(plannerA.goals.map((g) => g.id)).toContain(a.goal.id);
    expect(plannerA.goals.map((g) => g.id)).not.toContain(b.goal.id);
    expect(plannerA.projects.map((p) => p.id)).not.toContain(b.project.id);
    expect(plannerA.tasks.map((t) => t.id)).not.toContain(b.task.id);
    expect(plannerA.timeBlocks.map((t) => t.id)).not.toContain(b.block.id);
    expect(plannerB.goals.map((g) => g.id)).toContain(b.goal.id);
    expect(plannerB.goals.map((g) => g.id)).not.toContain(a.goal.id);
  });

  it('returns 404 for foreign goal/project/task/block access', async () => {
    const a = await seedUser(userA, 'A2');
    const b = await seedUser(userB, 'B2');

    await expect(planner.getGoalProgress(userA, b.goal.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
    await expect(planner.patchGoal(userA, b.goal.id, { title: 'hack' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(planner.deleteGoal(userA, b.goal.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(planner.patchProject(userA, b.project.id, { title: 'hack' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(planner.patchTask(userA, b.task.id, { status: 'DONE' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(planner.deleteTask(userA, b.task.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(planner.patchTimeBlock(userA, b.block.id, {
      title: 'hack',
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(planner.deleteTimeBlock(userA, b.block.id)).rejects.toMatchObject({
      statusCode: 404,
    });

    // A data still intact
    const still = await planner.getGoalProgress(userB, b.goal.id);
    expect(still.goal.id).toBe(b.goal.id);
    void a;
  });

  it('rejects cross-user relationship assignment', async () => {
    const a = await seedUser(userA, 'A3');
    const b = await seedUser(userB, 'B3');
    await expect(
      planner.createTask(userA, {
        title: 'steal project',
        projectId: b.project.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      planner.createTask(userA, {
        title: 'steal goal',
        goalId: b.goal.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      planner.createProject(userA, {
        title: 'steal goal link',
        goalId: b.goal.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      planner.createTimeBlock(userA, {
        title: 'steal task block',
        taskId: b.task.id,
        startAt: '2026-08-18T03:00:00.000Z',
        endAt: '2026-08-18T04:00:00.000Z',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    void a;
  });

  it('isolates goal progress aggregation', async () => {
    const a = await seedUser(userA, 'A4');
    const b = await seedUser(userB, 'B4');
    await planner.patchTask(userB, b.task.id, { status: 'DONE' });
    const progressA = await planner.getGoalProgress(userA, a.goal.id);
    const progressB = await planner.getGoalProgress(userB, b.goal.id);
    expect(progressA.progress.processes[0]?.thisWeek.completed).toBe(0);
    expect(progressB.progress.processes[0]?.thisWeek.completed).toBeGreaterThanOrEqual(1);
  });

  it('second user starts empty when owner has data', async () => {
    await seedUser(userA, 'A5');
    const stranger = randomUUID();
    await db.insert(users).values({
      id: stranger,
      googleSub: `sub-${stranger}`,
      email: `${stranger}@example.com`,
      name: 'Stranger',
      avatarUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null,
    });
    try {
      const empty = await planner.getPlanner(
        stranger,
        '2026-08-17T00:00:00.000Z',
        '2026-08-24T00:00:00.000Z',
      );
      expect(empty.goals).toEqual([]);
      expect(empty.projects).toEqual([]);
      expect(empty.tasks).toEqual([]);
      expect(empty.timeBlocks).toEqual([]);
      expect(empty.externalEvents).toEqual([]);
    } finally {
      await db.delete(users).where(eq(users.id, stranger));
    }
  });
});
