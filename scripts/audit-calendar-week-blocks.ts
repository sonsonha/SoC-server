/**
 * Read-only audit: owner time_blocks for product week 2026-09-07..13 (Asia/Ho_Chi_Minh).
 * Does not mutate production.
 */
import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { projects, tasks, timeBlocks } from '../src/infrastructure/db/schema/index.js';
import { productDateFromEpoch } from '../src/application/dailyFocus.js';
import { findUserByEmail } from '../src/modules/identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL } from '../src/modules/planner/seedOwnerRealPlan.js';

loadDotEnv();

const OWNER = OWNER_REAL_PLAN_EMAIL;
const WEEK_START = Date.parse('2026-09-07T00:00:00+07:00');
const WEEK_END = Date.parse('2026-09-14T00:00:00+07:00');

const EXPECTED = [
  'Exercise',
  'Role profile',
  'Outreach',
  'Daily Review',
  'Bedtime',
  'Wake',
  'CV',
  'Applications',
  'Interview',
  'IELTS',
  'Reading',
  'Weekly Review',
];

async function main() {
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) throw new Error('DATABASE_URL required');
  if (/localhost|127\.0\.0\.1/.test(dbUrl)) {
    throw new Error('Refusing local DATABASE_URL — production Railway only');
  }

  const db = createDb(dbUrl);
  try {
    const user = await findUserByEmail(db, OWNER);
    if (!user) throw new Error(`User not found: ${OWNER}`);

    const rows = await db
      .select({
        id: timeBlocks.id,
        taskId: timeBlocks.taskId,
        title: timeBlocks.title,
        taskTitle: tasks.title,
        projectTitle: projects.title,
        start: timeBlocks.startEpochMs,
        end: timeBlocks.endEpochMs,
        status: timeBlocks.status,
        deletedAt: timeBlocks.deletedAt,
        isDailyFocus: timeBlocks.isDailyFocus,
        googleEventId: timeBlocks.googleEventId,
        syncStatus: timeBlocks.syncStatus,
        updatedAt: timeBlocks.updatedAt,
        userId: timeBlocks.userId,
      })
      .from(timeBlocks)
      .leftJoin(tasks, eq(tasks.id, timeBlocks.taskId))
      .leftJoin(projects, eq(projects.id, timeBlocks.projectId))
      .where(
        and(
          eq(timeBlocks.userId, user.id),
          sql`${timeBlocks.startEpochMs} >= ${WEEK_START}`,
          sql`${timeBlocks.startEpochMs} < ${WEEK_END}`,
        ),
      )
      .orderBy(asc(timeBlocks.startEpochMs));

    const live = rows.filter((r) => r.deletedAt == null);
    const soft = rows.filter((r) => r.deletedAt != null);

    const overlap = await db
      .select({
        id: timeBlocks.id,
        title: timeBlocks.title,
        taskTitle: tasks.title,
        start: timeBlocks.startEpochMs,
        end: timeBlocks.endEpochMs,
        isDailyFocus: timeBlocks.isDailyFocus,
        googleEventId: timeBlocks.googleEventId,
        syncStatus: timeBlocks.syncStatus,
      })
      .from(timeBlocks)
      .leftJoin(tasks, eq(tasks.id, timeBlocks.taskId))
      .where(
        and(
          eq(timeBlocks.userId, user.id),
          isNull(timeBlocks.deletedAt),
          lt(timeBlocks.startEpochMs, WEEK_END),
          gt(timeBlocks.endEpochMs, WEEK_START),
        ),
      )
      .orderBy(asc(timeBlocks.startEpochMs));

    const [totalActive] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(and(eq(timeBlocks.userId, user.id), isNull(timeBlocks.deletedAt)));
    const [totalDeleted] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(timeBlocks)
      .where(and(eq(timeBlocks.userId, user.id), sql`deleted_at is not null`));

    const byDay: Record<
      string,
      Array<{
        id: string;
        title: string;
        local: string;
        focus: boolean;
        sync: string | null;
        gid: string | null;
        status: string | null;
        taskId: string | null;
      }>
    > = {};
    for (const b of live) {
      const day = productDateFromEpoch(b.start);
      const title = b.taskTitle ?? b.title ?? '';
      (byDay[day] ??= []).push({
        id: b.id,
        title,
        local: new Date(b.start).toLocaleString('en-GB', {
          timeZone: 'Asia/Ho_Chi_Minh',
          hour12: false,
        }),
        focus: Boolean(b.isDailyFocus),
        sync: b.syncStatus,
        gid: b.googleEventId,
        status: b.status,
        taskId: b.taskId,
      });
    }

    const titles = live.map((b) => (b.taskTitle ?? b.title ?? '').toLowerCase());
    const expectedHits = EXPECTED.map((label) => ({
      label,
      count: titles.filter((t) => t.includes(label.toLowerCase())).length,
    }));

    // Finite job/IELTS sessions (non-routine anchors roughly matching week seed)
    const finite = live.filter((b) => {
      const t = (b.taskTitle ?? b.title ?? '').toLowerCase();
      return (
        t.includes('cv') ||
        t.includes('role profile') ||
        t.includes('outreach') ||
        t.includes('application') ||
        t.includes('interview') ||
        t.includes('ielts') ||
        t.includes('reading')
      );
    });

    console.log(
      JSON.stringify(
        {
          userId: user.id,
          email: user.email,
          weekLive: live.length,
          weekSoftDeleted: soft.length,
          overlapLikeGetPlanner: overlap.length,
          totalActiveBlocks: totalActive?.c ?? 0,
          totalDeletedBlocks: totalDeleted?.c ?? 0,
          expectedHits,
          finiteCount: finite.length,
          finite: finite.map((b) => ({
            id: b.id,
            title: b.taskTitle ?? b.title,
            start: new Date(b.start).toISOString(),
            local: new Date(b.start).toLocaleString('en-GB', {
              timeZone: 'Asia/Ho_Chi_Minh',
              hour12: false,
            }),
            focus: Boolean(b.isDailyFocus),
            sync: b.syncStatus,
            googleEventId: b.googleEventId,
            deleted: b.deletedAt != null,
          })),
          softDeletedSample: soft.slice(0, 20).map((b) => ({
            id: b.id,
            title: b.taskTitle ?? b.title,
            local: new Date(b.start).toLocaleString('en-GB', {
              timeZone: 'Asia/Ho_Chi_Minh',
              hour12: false,
            }),
            deletedAt: b.deletedAt,
          })),
          byDay,
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
