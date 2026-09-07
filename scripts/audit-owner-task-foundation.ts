/**
 * Read-only audit of owner task foundation on production.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { tasks, timeBlocks } from '../src/infrastructure/db/schema/index.js';
import { findUserByEmail } from '../src/modules/identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL } from '../src/modules/planner/seedOwnerRealPlan.js';

loadDotEnv();

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL required');
  const db = createDb(dbUrl);
  try {
    const user = await findUserByEmail(db, OWNER_REAL_PLAN_EMAIL);
    if (!user) throw new Error(`User not found: ${OWNER_REAL_PLAN_EMAIL}`);

    const taskRows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        projectId: tasks.projectId,
        repeatSeriesId: tasks.repeatSeriesId,
        dailyFocusDate: tasks.dailyFocusDate,
        definitionOfDone: tasks.definitionOfDone,
        deadlineEpochMs: tasks.deadlineEpochMs,
        priority: tasks.priority,
        status: tasks.status,
      })
      .from(tasks)
      .where(and(eq(tasks.userId, user.id), isNull(tasks.deletedAt)));

    const [bc] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(and(eq(timeBlocks.userId, user.id), isNull(timeBlocks.deletedAt)));

    const [gcal] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, user.id),
          isNull(timeBlocks.deletedAt),
          sql`google_event_id is not null and google_event_id not like 'cos-%'`,
        ),
      );

    const titles = [...new Set(taskRows.map((t) => t.title))].sort();
    const countsByTitle = Object.fromEntries(
      titles.map((t) => [t, taskRows.filter((x) => x.title === t).length]),
    );
    const series = [...new Set(taskRows.map((t) => t.repeatSeriesId).filter(Boolean))];

    const maxDeadlineByTitle: Record<string, string | null> = {};
    for (const t of titles) {
      const rows = taskRows.filter((x) => x.title === t && x.deadlineEpochMs != null);
      if (!rows.length) {
        maxDeadlineByTitle[t] = null;
        continue;
      }
      const max = Math.max(...rows.map((r) => r.deadlineEpochMs!));
      maxDeadlineByTitle[t] = new Date(max).toISOString();
    }

    console.log(
      JSON.stringify(
        {
          userId: user.id,
          taskCount: taskRows.length,
          blockCount: bc?.c ?? 0,
          realGoogleEventBlocks: gcal?.c ?? 0,
          distinctTitles: titles,
          countsByTitle,
          seriesCount: series.length,
          maxDeadlineByTitle,
          withDailyFocus: taskRows
            .filter((t) => t.dailyFocusDate)
            .map((t) => ({ title: t.title, date: t.dailyFocusDate })),
          withDoD: [...new Set(taskRows.filter((t) => t.definitionOfDone).map((t) => t.title))],
        },
        null,
        2,
      ),
    );
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
