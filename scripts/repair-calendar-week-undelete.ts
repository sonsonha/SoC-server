/**
 * Repair: undelete canonical Sep 7–13 Sessions soft-deleted by foundation
 * --reset-partial (kept Google events; Personal OS hid the rows).
 *
 * Default: dry-run. Pass --mutate to apply.
 * Does NOT create Google events, Tasks, or new Sessions.
 */
import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { timeBlocks } from '../src/infrastructure/db/schema/index.js';
import { findUserByEmail } from '../src/modules/identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL } from '../src/modules/planner/seedOwnerRealPlan.js';

loadDotEnv();

const WEEK_START = Date.parse('2026-09-07T00:00:00+07:00');
const WEEK_END = Date.parse('2026-09-14T00:00:00+07:00');
const mutate = process.argv.includes('--mutate');

async function main() {
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl || /localhost|127\.0\.0\.1/.test(dbUrl)) {
    throw new Error('production DATABASE_URL required');
  }

  const db = createDb(dbUrl);
  try {
    const user = await findUserByEmail(db, OWNER_REAL_PLAN_EMAIL);
    if (!user) throw new Error(`User not found: ${OWNER_REAL_PLAN_EMAIL}`);

    const soft = await db
      .select({
        id: timeBlocks.id,
        taskId: timeBlocks.taskId,
        title: timeBlocks.title,
        start: timeBlocks.startEpochMs,
        end: timeBlocks.endEpochMs,
        focus: timeBlocks.isDailyFocus,
        gid: timeBlocks.googleEventId,
        deletedAt: timeBlocks.deletedAt,
      })
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, user.id),
          sql`${timeBlocks.startEpochMs} >= ${WEEK_START}`,
          sql`${timeBlocks.startEpochMs} < ${WEEK_END}`,
          isNotNull(timeBlocks.deletedAt),
          sql`google_event_id is not null and google_event_id not like 'cos-%'`,
        ),
      );

    const liveSlots = new Set(
      (
        await db
          .select({
            start: timeBlocks.startEpochMs,
            end: timeBlocks.endEpochMs,
          })
          .from(timeBlocks)
          .where(
            and(
              eq(timeBlocks.userId, user.id),
              sql`${timeBlocks.startEpochMs} >= ${WEEK_START}`,
              sql`${timeBlocks.startEpochMs} < ${WEEK_END}`,
              isNull(timeBlocks.deletedAt),
            ),
          )
      ).map((r) => `${r.start}|${r.end}`),
    );

    const bySlot = new Map<string, typeof soft>();
    for (const row of soft) {
      const key = `${row.start}|${row.end}`;
      const list = bySlot.get(key) ?? [];
      list.push(row);
      bySlot.set(key, list);
    }

    const picks: typeof soft = [];
    for (const [key, list] of bySlot) {
      if (liveSlots.has(key)) continue;
      list.sort((a, b) => {
        if (Number(b.focus) !== Number(a.focus)) return Number(b.focus) - Number(a.focus);
        return (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0);
      });
      picks.push(list[0]!);
    }

    const beforeGids = picks.map((p) => p.gid).sort();
    console.log(
      JSON.stringify(
        {
          mode: mutate ? 'mutate' : 'dry-run',
          restoreCount: picks.length,
          focusCount: picks.filter((p) => p.focus).length,
          sample: picks.slice(0, 5).map((p) => ({
            id: p.id,
            title: p.title,
            local: new Date(p.start).toLocaleString('en-GB', {
              timeZone: 'Asia/Ho_Chi_Minh',
              hour12: false,
            }),
            focus: Boolean(p.focus),
            gid: p.gid,
          })),
          gidsBefore: beforeGids,
        },
        null,
        2,
      ),
    );

    if (!mutate) {
      console.log('Dry-run only. Re-run with --mutate to undelete.');
      return;
    }

    const now = new Date();
    const ids = picks.map((p) => p.id);
    if (ids.length) {
      await db
        .update(timeBlocks)
        .set({ deletedAt: null, updatedAt: now })
        .where(and(eq(timeBlocks.userId, user.id), inArray(timeBlocks.id, ids)));
    }

    const after = await db
      .select({
        id: timeBlocks.id,
        gid: timeBlocks.googleEventId,
        deletedAt: timeBlocks.deletedAt,
        focus: timeBlocks.isDailyFocus,
      })
      .from(timeBlocks)
      .where(and(eq(timeBlocks.userId, user.id), inArray(timeBlocks.id, ids)));

    const stillDeleted = after.filter((r) => r.deletedAt != null);
    const gidChanged = after.filter((r) => {
      const before = picks.find((p) => p.id === r.id);
      return before && before.gid !== r.gid;
    });

    const [weekLive] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, user.id),
          isNull(timeBlocks.deletedAt),
          sql`${timeBlocks.startEpochMs} >= ${WEEK_START}`,
          sql`${timeBlocks.startEpochMs} < ${WEEK_END}`,
        ),
      );

    console.log(
      JSON.stringify(
        {
          restored: after.filter((r) => r.deletedAt == null).length,
          stillDeleted: stillDeleted.length,
          gidChanged: gidChanged.length,
          gidsAfter: after.map((r) => r.gid).sort(),
          weekLiveAfter: weekLive?.c ?? 0,
          focusRestored: after.filter((r) => r.focus && !r.deletedAt).length,
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
