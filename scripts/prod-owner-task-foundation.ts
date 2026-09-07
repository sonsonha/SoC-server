/**
 * Production audit + seed for owner Task foundation.
 * Expects DATABASE_URL (Railway). Never seeds without the owner user.
 *
 * Flags:
 *   --mutate           apply migration + AI context + seed
 *   --reset-partial    soft-delete existing foundation titles first (owner only)
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { tasks, timeBlocks, users } from '../src/infrastructure/db/schema/index.js';
import { findUserByEmail } from '../src/modules/identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL } from '../src/modules/planner/seedOwnerRealPlan.js';
import {
  OWNER_TASK_FOUNDATION_SPECS,
  seedOwnerTaskFoundation,
} from '../src/modules/planner/seedOwnerTaskFoundation.js';
import { INITIAL_OWNER_AI_CONTEXT_DEFAULT } from '../src/modules/ai/ownerAiContextDefault.js';

loadDotEnv();

const OWNER = OWNER_REAL_PLAN_EMAIL;
const mode = process.argv.includes('--mutate') ? 'mutate' : 'audit';
const resetPartial = process.argv.includes('--reset-partial');

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL required');
  if (/localhost|127\.0\.0\.1/.test(dbUrl)) {
    throw new Error('Refusing local DATABASE_URL — production Railway only');
  }

  console.log('MODE', mode, { resetPartial });
  const db = createDb(dbUrl);
  try {
    const user = await findUserByEmail(db, OWNER);
    if (!user) throw new Error(`User not found: ${OWNER}`);
    console.log('USER', { id: user.id, email: user.email });

    const [beforeTasks] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.userId, user.id), isNull(tasks.deletedAt)));
    const [beforeBlocks] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(and(eq(timeBlocks.userId, user.id), isNull(timeBlocks.deletedAt)));
    console.log('BEFORE', { tasks: beforeTasks?.c ?? 0, blocks: beforeBlocks?.c ?? 0 });

    if (mode === 'audit') {
      console.log('PLAN: migrate 0031 + seedOwnerTaskFoundation + refresh AI context');
      return;
    }

    await runMigrations(dbUrl);
    await db
      .update(users)
      .set({ aiContext: INITIAL_OWNER_AI_CONTEXT_DEFAULT, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    if (resetPartial) {
      const titles = OWNER_TASK_FOUNDATION_SPECS.map((s) => s.title);
      const foundationTasks = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.userId, user.id),
            isNull(tasks.deletedAt),
            inArray(tasks.title, titles),
          ),
        );
      const ids = foundationTasks.map((t) => t.id);
      const now = new Date();
      if (ids.length) {
        await db
          .update(timeBlocks)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(timeBlocks.userId, user.id),
              isNull(timeBlocks.deletedAt),
              inArray(timeBlocks.taskId, ids),
            ),
          );
        await db
          .update(tasks)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(eq(tasks.userId, user.id), isNull(tasks.deletedAt), inArray(tasks.id, ids)),
          );
      }
      console.log('RESET_PARTIAL', { softDeletedTasks: ids.length });
    }

    const report = await seedOwnerTaskFoundation(db, OWNER);
    console.log(JSON.stringify(report, null, 2));

    const [afterTasks] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.userId, user.id), isNull(tasks.deletedAt)));
    const [afterBlocks] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(and(eq(timeBlocks.userId, user.id), isNull(timeBlocks.deletedAt)));
    console.log('AFTER', { tasks: afterTasks?.c ?? 0, blocks: afterBlocks?.c ?? 0 });
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
