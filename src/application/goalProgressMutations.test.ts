/**
 * End-to-end Goal Progress mutations through PlannerV2Service —
 * the same methods PATCH /v2/tasks, PATCH /v2/time-blocks, DELETE /v2/time-blocks,
 * and PATCH /v2/goals use. Aggregation is always getGoalProgress → buildGoalProgress.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../config.js';
import { closeDb, createDb, type Db } from '../infrastructure/db/client.js';
import { runMigrations } from '../infrastructure/db/migrate.js';
import { goals, projects, tasks, timeBlocks, users } from '../infrastructure/db/schema/index.js';
import { FakeCalendarProvider } from '../infrastructure/providers/calendar/fakeCalendarProvider.js';
import { addDays, startOfWeek } from './goalProgress.js';
import { PlannerV2Service } from './plannerV2Service.js';

loadDotEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

function vnIso(ms: number) {
  return new Date(ms).toISOString();
}

function processNamed(progress: { processes: Array<{ name: string; thisWeek: { completed: number; planned: number; target: number } }> }, name: string) {
  const found = progress.processes.find((item) => item.name === name);
  if (!found) throw new Error(`Missing process ${name}`);
  return found.thisWeek;
}

describe.skipIf(!hasDb)('Goal Progress mutations (PlannerV2Service)', () => {
  let db: Db;
  let planner: PlannerV2Service;
  const now = new Date();
  const nowIso = now.toISOString();
  const weekStart = startOfWeek(now);
  const userId = 'gp-mut-user';
  const ids = {
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

    await db.insert(users).values({
      id: userId,
      googleSub: 'gp-mut-sub',
      email: 'gp-mut@example.com',
      name: 'GP Mut',
      avatarUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null,
    }).onConflictDoNothing();
  });

  afterAll(async () => {
    if (ids.blocks.length) await db.delete(timeBlocks).where(inArray(timeBlocks.id, ids.blocks));
    if (ids.tasks.length) await db.delete(tasks).where(inArray(tasks.id, ids.tasks));
    if (ids.projects.length) await db.delete(projects).where(inArray(projects.id, ids.projects));
    if (ids.goals.length) await db.delete(goals).where(inArray(goals.id, ids.goals));
    await db.delete(users).where(inArray(users.id, [userId]));
    await closeDb();
  });

  async function trackTask(title: string, input: Parameters<PlannerV2Service['createTask']>[1]) {
    const created = await planner.createTask(userId, { title, ...input });
    ids.tasks.push(created.id);
    return created;
  }

  async function trackBlock(input: Parameters<PlannerV2Service['createTimeBlock']>[1]) {
    const created = await planner.createTimeBlock(userId, input);
    ids.blocks.push(created.id);
    return created;
  }

  it('COUNT: complete then reopen Apply — SaaS Backend Engineer (4/5 → 5/5 → 4/5)', async () => {
    const procId = 'proc-apps';
    const goal = await planner.createGoal(userId, {
      title: 'Mutation lab — applications',
      processes: [{ id: procId, name: 'Quality Applications', measurementType: 'COUNT', targetValue: 5, period: 'WEEK', active: true }],
    });
    ids.goals.push(goal.id);
    const project = await planner.createProject(userId, {
      title: 'Job Applications',
      goalId: goal.id,
      defaultGoalProcessId: procId,
    });
    ids.projects.push(project.id);

    const processesJsonBefore = (await db.select().from(goals).where(inArray(goals.id, [goal.id])))[0]!.processesJson;

    for (let index = 0; index < 4; index += 1) {
      const task = await trackTask(`Apply done ${index + 1}`, {
        projectId: project.id,
        goalId: goal.id,
        goalProcessId: procId,
        dueHorizon: 'WEEK',
        dueAt: vnIso(weekStart.getTime()),
      });
      await planner.patchTask(userId, task.id, { status: 'DONE' });
    }
    const open = await trackTask('Apply — SaaS Backend Engineer', {
      projectId: project.id,
      goalId: goal.id,
      goalProcessId: procId,
      dueHorizon: 'WEEK',
      dueAt: vnIso(weekStart.getTime()),
    });
    expect(open.status).not.toBe('DONE');

    let snapshot = await planner.getGoalProgress(userId, goal.id, nowIso);
    expect(processNamed(snapshot.progress, 'Quality Applications')).toMatchObject({ completed: 4, target: 5 });

    await planner.patchTask(userId, open.id, { status: 'DONE' });
    snapshot = await planner.getGoalProgress(userId, goal.id, nowIso);
    expect(processNamed(snapshot.progress, 'Quality Applications').completed).toBe(5);

    const processesJsonAfter = (await db.select().from(goals).where(inArray(goals.id, [goal.id])))[0]!.processesJson;
    expect(processesJsonAfter).toBe(processesJsonBefore);

    await planner.patchTask(userId, open.id, { status: 'INBOX' });
    snapshot = await planner.getGoalProgress(userId, goal.id, nowIso);
    expect(processNamed(snapshot.progress, 'Quality Applications').completed).toBe(4);
  });

  it('COUNT: complete remaining Speaking Practice task (2/3 → 3/3)', async () => {
    const procId = 'proc-speak';
    const goal = await planner.createGoal(userId, {
      title: 'Mutation lab — speaking',
      processes: [{ id: procId, name: 'Speaking Practice', measurementType: 'COUNT', targetValue: 3, period: 'WEEK', active: true }],
    });
    ids.goals.push(goal.id);
    for (let index = 0; index < 2; index += 1) {
      const task = await trackTask(`Speaking done ${index + 1}`, {
        goalId: goal.id,
        goalProcessId: procId,
        dueHorizon: 'WEEK',
        dueAt: vnIso(weekStart.getTime()),
      });
      await planner.patchTask(userId, task.id, { status: 'DONE' });
    }
    const open = await trackTask('IELTS Speaking Part 3 — Education', {
      goalId: goal.id,
      goalProcessId: procId,
      dueHorizon: 'WEEK',
      dueAt: vnIso(weekStart.getTime()),
    });

    let snapshot = await planner.getGoalProgress(userId, goal.id, nowIso);
    expect(processNamed(snapshot.progress, 'Speaking Practice')).toMatchObject({ completed: 2, target: 3 });

    await planner.patchTask(userId, open.id, { status: 'DONE' });
    snapshot = await planner.getGoalProgress(userId, goal.id, nowIso);
    expect(processNamed(snapshot.progress, 'Speaking Practice').completed).toBe(3);
  });

  it('DURATION: resize planned block +1h without changing completed, then complete adds 2h', async () => {
    const procId = 'proc-tech';
    const goal = await planner.createGoal(userId, {
      title: 'Mutation lab — duration',
      processes: [{ id: procId, name: 'Technical Preparation', measurementType: 'DURATION', targetValue: 3, unit: 'h', period: 'WEEK', active: true }],
    });
    ids.goals.push(goal.id);

    for (let index = 0; index < 2; index += 1) {
      const start = addDays(weekStart, index + 1).getTime() + 19 * 3_600_000;
      const task = await trackTask(`Tech done ${index + 1}`, {
        goalId: goal.id,
        goalProcessId: procId,
        dueHorizon: 'WEEK',
        durationMinutes: 90,
      });
      await trackBlock({
        taskId: task.id,
        title: task.title,
        startAt: vnIso(start),
        endAt: vnIso(start + 90 * 60_000),
      });
      await planner.patchTask(userId, task.id, { status: 'DONE' });
    }

    const openStart = addDays(weekStart, 5).getTime() + 14 * 3_600_000;
    const open = await trackTask('Review transactions and isolation', {
      goalId: goal.id,
      goalProcessId: procId,
      dueHorizon: 'WEEK',
      durationMinutes: 60,
    });
    const block = await trackBlock({
      taskId: open.id,
      title: open.title,
      startAt: vnIso(openStart),
      endAt: vnIso(openStart + 60 * 60_000),
    });

    let snapshot = await planner.getGoalProgress(userId, goal.id, nowIso);
    const before = processNamed(snapshot.progress, 'Technical Preparation');
    expect(before.completed).toBe(3);
    expect(before.planned).toBe(4);
    expect(before.target).toBe(3);

    await planner.patchTimeBlock(userId, block.id, { endAt: vnIso(openStart + 120 * 60_000) });
    snapshot = await planner.getGoalProgress(userId, goal.id, nowIso);
    const resized = processNamed(snapshot.progress, 'Technical Preparation');
    expect(resized.planned).toBe(before.planned + 1);
    expect(resized.completed).toBe(before.completed);

    await planner.patchTask(userId, open.id, { status: 'DONE' });
    snapshot = await planner.getGoalProgress(userId, goal.id, nowIso);
    const done = processNamed(snapshot.progress, 'Technical Preparation');
    expect(done.completed).toBe(before.completed + 2);
    expect(done.planned).toBe(resized.planned);
  });

  it('unschedule removes the block, keeps task/process links, drops planned not completed', async () => {
    const procId = 'proc-tech';
    const goal = await planner.createGoal(userId, {
      title: 'Mutation lab — unschedule',
      processes: [{ id: procId, name: 'Technical Preparation', measurementType: 'DURATION', targetValue: 3, unit: 'h', period: 'WEEK', active: true }],
    });
    ids.goals.push(goal.id);

    const doneStart = addDays(weekStart, 1).getTime() + 19 * 3_600_000;
    const doneTask = await trackTask('SQL review', {
      goalId: goal.id,
      goalProcessId: procId,
      dueHorizon: 'WEEK',
      durationMinutes: 90,
    });
    await trackBlock({
      taskId: doneTask.id,
      title: doneTask.title,
      startAt: vnIso(doneStart),
      endAt: vnIso(doneStart + 90 * 60_000),
    });
    await planner.patchTask(userId, doneTask.id, { status: 'DONE' });

    const openStart = addDays(weekStart, 5).getTime() + 14 * 3_600_000;
    const open = await trackTask('Review transactions and isolation', {
      goalId: goal.id,
      goalProcessId: procId,
      dueHorizon: 'WEEK',
      durationMinutes: 60,
    });
    const block = await trackBlock({
      taskId: open.id,
      title: open.title,
      startAt: vnIso(openStart),
      endAt: vnIso(openStart + 60 * 60_000),
    });

    const before = processNamed((await planner.getGoalProgress(userId, goal.id, nowIso)).progress, 'Technical Preparation');
    expect(before.completed).toBe(1.5);
    expect(before.planned).toBe(2.5);

    await planner.deleteTimeBlock(userId, block.id);
    await planner.patchTask(userId, open.id, { status: 'INBOX' });

    const remaining = await planner.getTaskTimeBlocks(userId, open.id);
    expect(remaining).toHaveLength(0);
    const afterTask = (await planner.getPlanner(userId, vnIso(weekStart.getTime()), vnIso(addDays(weekStart, 7).getTime())))
      .tasks.find((item) => item.id === open.id);
    expect(afterTask?.status).toBe('INBOX');
    expect(afterTask?.goalId).toBe(goal.id);
    expect(afterTask?.goalProcessId).toBe(procId);
    expect(afterTask?.dueHorizon).toBe('WEEK');

    const after = processNamed((await planner.getGoalProgress(userId, goal.id, nowIso)).progress, 'Technical Preparation');
    expect(after.completed).toBe(before.completed);
    expect(after.planned).toBe(before.planned - 1);
  });

  it('WEEK dueHorizon does not count until completion; scheduling alone gives zero credit', async () => {
    const procId = 'proc-apps';
    const goal = await planner.createGoal(userId, {
      title: 'Mutation lab — week horizon',
      processes: [{ id: procId, name: 'Quality Applications', measurementType: 'COUNT', targetValue: 5, period: 'WEEK', active: true }],
    });
    ids.goals.push(goal.id);
    const weekTask = await trackTask('Research 3 target companies', {
      goalId: goal.id,
      goalProcessId: procId,
      dueHorizon: 'WEEK',
      dueAt: vnIso(weekStart.getTime()),
    });
    expect(weekTask.dueHorizon).toBe('WEEK');
    expect(weekTask.status).toBe('INBOX');

    let snapshot = await planner.getGoalProgress(userId, goal.id, nowIso);
    expect(processNamed(snapshot.progress, 'Quality Applications').completed).toBe(0);

    const wednesday = addDays(weekStart, 2).getTime() + 10 * 3_600_000;
    const block = await trackBlock({
      taskId: weekTask.id,
      title: weekTask.title,
      startAt: vnIso(wednesday),
      endAt: vnIso(wednesday + 30 * 60_000),
    });
    const scheduled = (await planner.getPlanner(userId, vnIso(weekStart.getTime()), vnIso(addDays(weekStart, 7).getTime())))
      .tasks.find((item) => item.id === weekTask.id);
    expect(scheduled?.status).toBe('SCHEDULED');
    expect(scheduled?.goalId).toBe(goal.id);
    expect(scheduled?.goalProcessId).toBe(procId);
    expect(block.id).toBeTruthy();

    snapshot = await planner.getGoalProgress(userId, goal.id, nowIso);
    expect(processNamed(snapshot.progress, 'Quality Applications').completed).toBe(0);

    await planner.patchTask(userId, weekTask.id, { status: 'DONE' });
    snapshot = await planner.getGoalProgress(userId, goal.id, nowIso);
    expect(processNamed(snapshot.progress, 'Quality Applications').completed).toBe(1);
  });

  it('reflection round-trip persists ACHIEVED_LATE and review fields', async () => {
    const goal = await planner.createGoal(userId, {
      title: 'Complete Backend CV Refresh',
      targetDate: '2026-07-31',
      outcomeStatus: 'ACTIVE',
    });
    ids.goals.push(goal.id);

    const updated = await planner.patchGoal(userId, goal.id, {
      status: 'COMPLETED',
      outcomeStatus: 'ACHIEVED_LATE',
      achievedAt: '2026-08-03',
      closedAt: '2026-08-03',
      reflection: {
        seriousAttempt: 'YES',
        worked: 'Clear task breakdown.',
        didntWork: 'Underestimated polish.',
        outsideControl: 'Reviewer delay.',
        learned: 'Reserve a review buffer.',
        differently: 'Start peer review earlier.',
        nextAction: 'ARCHIVE',
        reviewedAt: '2026-08-03T10:00:00.000Z',
      },
      reviewSnapshot: {
        generatedAt: '2026-08-03T10:00:00.000Z',
        outcomeStatus: 'ACHIEVED_LATE',
        targetDate: '2026-07-31',
        achievedAt: '2026-08-03',
        processSummary: [],
        consistency: { metWeeks: 0, totalWeeks: 0, threshold: 0.8 },
        milestones: [],
      },
    });

    expect(updated.outcomeStatus).toBe('ACHIEVED_LATE');
    expect(updated.targetDate).toBe('2026-07-31');
    expect(updated.achievedAt).toBe('2026-08-03');
    expect(updated.reflection.seriousAttempt).toBe('YES');
    expect(updated.reflection.worked).toBe('Clear task breakdown.');
    expect(updated.reflection.didntWork).toBe('Underestimated polish.');
    expect(updated.reflection.outsideControl).toBe('Reviewer delay.');
    expect(updated.reflection.learned).toBe('Reserve a review buffer.');
    expect(updated.reflection.nextAction).toBe('ARCHIVE');

    const reread = await planner.getGoalProgress(userId, goal.id, nowIso);
    expect(reread.goal.outcomeStatus).toBe('ACHIEVED_LATE');
    expect(reread.goal.targetDate).toBe('2026-07-31');
    expect(reread.goal.achievedAt).toBe('2026-08-03');
    expect(reread.goal.reflection.seriousAttempt).toBe('YES');
    expect(reread.goal.reviewSnapshot?.outcomeStatus).toBe('ACHIEVED_LATE');
  });

  it('milestone transition stays internally consistent after reload', async () => {
    const milestones = [
      { id: 'ms-1', title: 'CV / profile ready', status: 'done' as const },
      { id: 'ms-2', title: 'Application pipeline started', status: 'done' as const },
      { id: 'ms-3', title: 'Interview pipeline', status: 'current' as const },
      { id: 'ms-4', title: 'Technical readiness proven', status: 'pending' as const },
      { id: 'ms-5', title: 'Receive suitable offer', status: 'pending' as const },
    ];
    const goal = await planner.createGoal(userId, {
      title: 'Mutation lab — milestones',
      currentMilestoneId: 'ms-3',
      milestones,
    });
    ids.goals.push(goal.id);
    expect(goal.milestones.map((item) => item.status)).toEqual(['done', 'done', 'current', 'pending', 'pending']);

    const updated = await planner.patchGoal(userId, goal.id, {
      currentMilestoneId: 'ms-4',
      milestones: milestones.map((item) => (
        item.id === 'ms-3' ? { ...item, status: 'done' } : item
      )),
    });
    expect(updated.currentMilestoneId).toBe('ms-4');
    expect(updated.milestones.map((item) => `${item.title}:${item.status}`)).toEqual([
      'CV / profile ready:done',
      'Application pipeline started:done',
      'Interview pipeline:done',
      'Technical readiness proven:current',
      'Receive suitable offer:pending',
    ]);

    const reread = await planner.getGoalProgress(userId, goal.id, nowIso);
    expect(reread.goal.currentMilestoneId).toBe('ms-4');
    expect(reread.goal.milestones.map((item) => item.status)).toEqual(['done', 'done', 'done', 'current', 'pending']);
  });
});
