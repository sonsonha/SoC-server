/**
 * Read-only: classify soft-deleted Sep 7–13 blocks vs live duplicates.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { tasks, timeBlocks } from '../src/infrastructure/db/schema/index.js';
import { findUserByEmail } from '../src/modules/identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL } from '../src/modules/planner/seedOwnerRealPlan.js';

loadDotEnv();

const WEEK_START = Date.parse('2026-09-07T00:00:00+07:00');
const WEEK_END = Date.parse('2026-09-14T00:00:00+07:00');

async function main() {
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl || /localhost|127\.0\.0\.1/.test(dbUrl)) {
    throw new Error('production DATABASE_URL required');
  }
  const db = createDb(dbUrl);
  try {
    const user = await findUserByEmail(db, OWNER_REAL_PLAN_EMAIL);
    if (!user) throw new Error('no user');

    const rows = await db
      .select({
        id: timeBlocks.id,
        taskId: timeBlocks.taskId,
        title: timeBlocks.title,
        taskTitle: tasks.title,
        start: timeBlocks.startEpochMs,
        end: timeBlocks.endEpochMs,
        status: timeBlocks.status,
        deletedAt: timeBlocks.deletedAt,
        isDailyFocus: timeBlocks.isDailyFocus,
        googleEventId: timeBlocks.googleEventId,
        syncStatus: timeBlocks.syncStatus,
        updatedAt: timeBlocks.updatedAt,
        repeatSeriesId: timeBlocks.repeatSeriesId,
      })
      .from(timeBlocks)
      .leftJoin(tasks, eq(tasks.id, timeBlocks.taskId))
      .where(
        and(
          eq(timeBlocks.userId, user.id),
          sql`${timeBlocks.startEpochMs} >= ${WEEK_START}`,
          sql`${timeBlocks.startEpochMs} < ${WEEK_END}`,
        ),
      )
      .orderBy(asc(timeBlocks.startEpochMs));

    type Key = string;
    const groups = new Map<Key, typeof rows>();
    for (const r of rows) {
      const key = `${r.start}|${r.end}|${(r.taskTitle ?? r.title ?? '').slice(0, 40)}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }

    const classified = [...groups.entries()].map(([key, list]) => {
      const live = list.filter((r) => r.deletedAt == null);
      const soft = list.filter((r) => r.deletedAt != null);
      // Prefer: has real google id, isDailyFocus, latest updated among soft
      const scored = [...soft].sort((a, b) => {
        const aReal = a.googleEventId && !a.googleEventId.startsWith('cos-') ? 1 : 0;
        const bReal = b.googleEventId && !b.googleEventId.startsWith('cos-') ? 1 : 0;
        if (bReal !== aReal) return bReal - aReal;
        if (Number(b.isDailyFocus) !== Number(a.isDailyFocus)) {
          return Number(b.isDailyFocus) - Number(a.isDailyFocus);
        }
        return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
      });
      return {
        key,
        liveCount: live.length,
        softCount: soft.length,
        pick: scored[0]
          ? {
              id: scored[0].id,
              title: scored[0].taskTitle ?? scored[0].title,
              focus: Boolean(scored[0].isDailyFocus),
              sync: scored[0].syncStatus,
              gid: scored[0].googleEventId,
              deletedAt: scored[0].deletedAt,
              taskId: scored[0].taskId,
              start: scored[0].start,
              end: scored[0].end,
            }
          : null,
        all: list.map((r) => ({
          id: r.id,
          deleted: r.deletedAt != null,
          deletedAt: r.deletedAt,
          focus: Boolean(r.isDailyFocus),
          sync: r.syncStatus,
          gid: r.googleEventId,
          fake: r.googleEventId?.startsWith('cos-') ?? false,
        })),
      };
    });

    const toRestore = classified
      .filter((c) => c.liveCount === 0 && c.pick)
      .map((c) => c.pick!);

    const deleteWaves = new Map<string, number>();
    for (const r of rows.filter((x) => x.deletedAt)) {
      const k = r.deletedAt!.toISOString().slice(0, 19);
      deleteWaves.set(k, (deleteWaves.get(k) ?? 0) + 1);
    }

    console.log(
      JSON.stringify(
        {
          totalWeekRows: rows.length,
          live: rows.filter((r) => !r.deletedAt).length,
          soft: rows.filter((r) => r.deletedAt).length,
          groupCount: classified.length,
          needRestore: toRestore.length,
          deleteWaves: Object.fromEntries([...deleteWaves.entries()].sort()),
          toRestore,
          ambiguous: classified.filter((c) => c.softCount > 1 || (c.liveCount > 0 && c.softCount > 0)),
        },
        null,
        2,
      ),
    );
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
