/**
 * Production-only audit + seed for owner real plan.
 * Expects DATABASE_URL in env (Railway production). Never seeds without the owner user.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { goals, projects, tasks, timeBlocks, users } from '../src/infrastructure/db/schema/index.js';
import { findUserByEmail } from '../src/modules/identity/plannerOwnership.js';
import {
  OWNER_REAL_PLAN_EMAIL,
  seedOwnerRealPlan,
} from '../src/modules/planner/seedOwnerRealPlan.js';

loadDotEnv();

const OWNER = OWNER_REAL_PLAN_EMAIL;
const mode = process.argv.includes('--mutate') ? 'mutate' : 'audit';

function hostHint(url: string): string {
  try {
    const u = new URL(url.replace(/^postgres(ql)?:\/\//, 'https://'));
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL required');
  if (/localhost|127\.0\.0\.1/.test(dbUrl)) {
    throw new Error('Refusing local DATABASE_URL — production Railway only');
  }

  console.log('MODE', mode);
  console.log('DB_HOST', hostHint(dbUrl));

  const db = createDb(dbUrl);
  try {
    const matches = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(sql`lower(btrim(${users.email})) = ${OWNER}`);
    if (matches.length === 0) {
      throw new Error(`User not found: ${OWNER}. STOP`);
    }
    if (matches.length !== 1) {
      throw new Error(`Multiple users match ${OWNER} (${matches.length}). STOP`);
    }
    const user = await findUserByEmail(db, OWNER);
    if (!user) throw new Error(`User not found after resolve: ${OWNER}. STOP`);
    console.log('USER', { id: user.id, email: user.email, aiContextLen: user.aiContext?.length ?? 0 });

    const mig = await db.execute(sql`
      SELECT id, hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at DESC
      LIMIT 15
    `);
    const migRows = (mig as { rows?: Array<Record<string, unknown>> }).rows ?? (mig as unknown as Array<Record<string, unknown>>);
    console.log('RECENT_MIGRATIONS', migRows.map((r) => r.hash ?? r.id ?? r));

    const col = await db.execute(sql`
      SELECT column_name, column_default, data_type
      FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'project_context'
    `);
    const colRows = (col as { rows?: unknown[] }).rows ?? (col as unknown as unknown[]);
    console.log('PROJECT_CONTEXT_COLUMN', colRows);

    const g = await db
      .select({
        id: goals.id,
        title: goals.title,
        focusType: goals.focusType,
        status: goals.status,
        outcomeStatus: goals.outcomeStatus,
        targetDate: goals.targetDate,
        deletedAt: goals.deletedAt,
      })
      .from(goals)
      .where(eq(goals.userId, user.id));
    console.log('GOALS_ALL', g.length);
    for (const row of g) console.log(JSON.stringify(row));

    const p = await db
      .select({
        id: projects.id,
        title: projects.title,
        goalId: projects.goalId,
        projectType: projects.projectType,
        projectContext: projects.projectContext,
        active: projects.active,
        deletedAt: projects.deletedAt,
      })
      .from(projects)
      .where(eq(projects.userId, user.id));
    console.log('PROJECTS_ALL', p.length);
    for (const row of p) console.log(JSON.stringify(row));

    const [taskCount] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.userId, user.id), isNull(tasks.deletedAt)));
    const [blockCount] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(and(eq(timeBlocks.userId, user.id), isNull(timeBlocks.deletedAt)));
    console.log('LIVE_TASKS', taskCount?.c ?? 0);
    console.log('LIVE_BLOCKS', blockCount?.c ?? 0);

    if (mode === 'audit') {
      console.log('\nPLAN: apply migration 0029 if project_context missing; then seedOwnerRealPlan (idempotent). No Tasks/TimeBlocks.');
      return;
    }

    if (!colRows || (Array.isArray(colRows) && colRows.length === 0)) {
      console.log('Applying migrations (0029_project_context)…');
      await runMigrations(dbUrl);
    } else {
      console.log('Migration 0029 already present (project_context column exists).');
      // Still run migrate — idempotent tracking
      await runMigrations(dbUrl);
    }

    const beforeTasks = taskCount?.c ?? 0;
    const beforeBlocks = blockCount?.c ?? 0;
    const report = await seedOwnerRealPlan(db, OWNER);
    console.log('SEED_REPORT', JSON.stringify(report, null, 2));

    const [taskAfter] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.userId, user.id), isNull(tasks.deletedAt)));
    const [blockAfter] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(and(eq(timeBlocks.userId, user.id), isNull(timeBlocks.deletedAt)));
    console.log('TASKS_DELTA', (taskAfter?.c ?? 0) - beforeTasks);
    console.log('BLOCKS_DELTA', (blockAfter?.c ?? 0) - beforeBlocks);

    // Verify serialize path
    const sample = await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, user.id), isNull(projects.deletedAt)))
      .limit(3);
    console.log('SAMPLE_PROJECT_CONTEXT', sample.map((s) => ({ title: s.title, projectContext: s.projectContext, goalId: s.goalId })));
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
