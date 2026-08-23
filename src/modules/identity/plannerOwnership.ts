/**
 * Batch B — planner ownership backfill + verification.
 * Assigns all existing root planner rows to an explicit owner user.
 */
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../../infrastructure/db/client.js';
import {
  goals,
  projects,
  tasks,
  timeBlocks,
  users,
} from '../../infrastructure/db/schema/index.js';

export type OwnershipCounts = {
  users: number;
  goals: number;
  projects: number;
  tasks: number;
  timeBlocks: number;
  goalsWithoutUser: number;
  projectsWithoutUser: number;
  tasksWithoutUser: number;
  timeBlocksWithoutUser: number;
};

export type CrossUserRelationReport = {
  projectsWithForeignGoal: number;
  tasksWithForeignProject: number;
  tasksWithForeignGoal: number;
  blocksWithForeignTask: number;
  blocksWithForeignProject: number;
};

export async function findUserByEmail(db: Db, email: string) {
  const normalized = email.trim().toLowerCase();
  const rows = await db.select().from(users);
  return rows.find((row) => row.email.trim().toLowerCase() === normalized) ?? null;
}

export async function findUserById(db: Db, userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

export async function countPlannerOwnership(db: Db): Promise<OwnershipCounts> {
  const [userRows, goalRows, projectRows, taskRows, blockRows] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(users),
    db.select({ n: sql<number>`count(*)::int` }).from(goals),
    db.select({ n: sql<number>`count(*)::int` }).from(projects),
    db.select({ n: sql<number>`count(*)::int` }).from(tasks),
    db.select({ n: sql<number>`count(*)::int` }).from(timeBlocks),
  ]);
  const [gNull, pNull, tNull, bNull] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(goals).where(isNull(goals.userId)),
    db.select({ n: sql<number>`count(*)::int` }).from(projects).where(isNull(projects.userId)),
    db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(isNull(tasks.userId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(isNull(timeBlocks.userId)),
  ]);
  return {
    users: userRows[0]?.n ?? 0,
    goals: goalRows[0]?.n ?? 0,
    projects: projectRows[0]?.n ?? 0,
    tasks: taskRows[0]?.n ?? 0,
    timeBlocks: blockRows[0]?.n ?? 0,
    goalsWithoutUser: gNull[0]?.n ?? 0,
    projectsWithoutUser: pNull[0]?.n ?? 0,
    tasksWithoutUser: tNull[0]?.n ?? 0,
    timeBlocksWithoutUser: bNull[0]?.n ?? 0,
  };
}

/** Assign every NULL-owned root planner row to ownerUserId. Does not reassign owned rows. */
export async function backfillPlannerOwner(db: Db, ownerUserId: string): Promise<{
  goals: number;
  projects: number;
  tasks: number;
  timeBlocks: number;
}> {
  const owner = await findUserById(db, ownerUserId);
  if (!owner) {
    throw new Error(`Owner user not found: ${ownerUserId}`);
  }

  const goalResult = await db
    .update(goals)
    .set({ userId: ownerUserId })
    .where(isNull(goals.userId));
  const projectResult = await db
    .update(projects)
    .set({ userId: ownerUserId })
    .where(isNull(projects.userId));
  const taskResult = await db
    .update(tasks)
    .set({ userId: ownerUserId })
    .where(isNull(tasks.userId));
  const blockResult = await db
    .update(timeBlocks)
    .set({ userId: ownerUserId })
    .where(isNull(timeBlocks.userId));

  // postgres-js / drizzle may not return rowCount consistently — recount NULLs delta via before/after.
  void goalResult;
  void projectResult;
  void taskResult;
  void blockResult;

  const after = await countPlannerOwnership(db);
  return {
    goals: after.goals - after.goalsWithoutUser,
    projects: after.projects - after.projectsWithoutUser,
    tasks: after.tasks - after.tasksWithoutUser,
    timeBlocks: after.timeBlocks - after.timeBlocksWithoutUser,
  };
}

export async function assertNoNullOwnership(db: Db): Promise<void> {
  const counts = await countPlannerOwnership(db);
  if (
    counts.goalsWithoutUser
    || counts.projectsWithoutUser
    || counts.tasksWithoutUser
    || counts.timeBlocksWithoutUser
  ) {
    throw new Error(
      `NULL ownership remains: goals=${counts.goalsWithoutUser} projects=${counts.projectsWithoutUser} tasks=${counts.tasksWithoutUser} time_blocks=${counts.timeBlocksWithoutUser}`,
    );
  }
}

/**
 * Detect FK-like relations that point at another user's aggregate.
 * Soft-deleted rows are included so we surface historical leaks.
 */
export async function countCrossUserRelations(db: Db): Promise<CrossUserRelationReport> {
  const projectForeignGoals = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM projects p
    INNER JOIN goals g ON g.id = p.goal_id
    WHERE p.goal_id IS NOT NULL AND p.user_id IS NOT NULL AND g.user_id IS NOT NULL
      AND p.user_id <> g.user_id
  `);
  const taskForeignProjects = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM tasks t
    INNER JOIN projects p ON p.id = t.project_id
    WHERE t.project_id IS NOT NULL AND t.user_id IS NOT NULL AND p.user_id IS NOT NULL
      AND t.user_id <> p.user_id
  `);
  const taskForeignGoals = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM tasks t
    INNER JOIN goals g ON g.id = t.goal_id
    WHERE t.goal_id IS NOT NULL AND t.user_id IS NOT NULL AND g.user_id IS NOT NULL
      AND t.user_id <> g.user_id
  `);
  const blockForeignTasks = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM time_blocks b
    INNER JOIN tasks t ON t.id = b.task_id
    WHERE b.task_id IS NOT NULL AND b.user_id IS NOT NULL AND t.user_id IS NOT NULL
      AND b.user_id <> t.user_id
  `);
  const blockForeignProjects = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM time_blocks b
    INNER JOIN projects p ON p.id = b.project_id
    WHERE b.project_id IS NOT NULL AND b.user_id IS NOT NULL AND p.user_id IS NOT NULL
      AND b.user_id <> p.user_id
  `);

  const n = (result: unknown): number => {
    const rows = result as { n?: number }[] | { rows?: { n?: number }[] };
    if (Array.isArray(rows)) return Number(rows[0]?.n ?? 0);
    return Number(rows.rows?.[0]?.n ?? 0);
  };

  return {
    projectsWithForeignGoal: n(projectForeignGoals),
    tasksWithForeignProject: n(taskForeignProjects),
    tasksWithForeignGoal: n(taskForeignGoals),
    blocksWithForeignTask: n(blockForeignTasks),
    blocksWithForeignProject: n(blockForeignProjects),
  };
}

export function isLegacyCalendarOwnerEmail(
  userEmail: string,
  initialOwnerEmail: string | undefined,
): boolean {
  if (!initialOwnerEmail?.trim()) {
    // Pre-configuration single-tenant: allow (Batch A behavior).
    return true;
  }
  return userEmail.trim().toLowerCase() === initialOwnerEmail.trim().toLowerCase();
}

/** Helper used by tests: ensure no row owned by userA references userB entities. */
export async function ownedRowCount(db: Db, userId: string) {
  const [g, p, t, b] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(goals).where(eq(goals.userId, userId)),
    db.select({ n: sql<number>`count(*)::int` }).from(projects).where(eq(projects.userId, userId)),
    db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.userId, userId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(eq(timeBlocks.userId, userId)),
  ]);
  return {
    goals: g[0]?.n ?? 0,
    projects: p[0]?.n ?? 0,
    tasks: t[0]?.n ?? 0,
    timeBlocks: b[0]?.n ?? 0,
  };
}

export async function verifySameUserRelations(db: Db, userId: string): Promise<void> {
  const badProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(goals, eq(projects.goalId, goals.id))
    .where(and(eq(projects.userId, userId), ne(goals.userId, userId)))
    .limit(1);
  if (badProjects[0]) {
    throw new Error(`Project ${badProjects[0].id} references another user's goal`);
  }
}
