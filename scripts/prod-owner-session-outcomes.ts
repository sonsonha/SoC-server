/**
 * Patch Session Outcome metadata onto existing Sep 7–13 owner Sessions.
 * Does NOT create Sessions, Tasks, or Google events.
 *
 *   --mutate   apply migration + patches
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { closeDb, createDb } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import { tasks, timeBlocks } from '../src/infrastructure/db/schema/index.js';
import { checklistItem } from '../src/domain/sessionOutcome.js';
import { findUserByEmail } from '../src/modules/identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL } from '../src/modules/planner/seedOwnerRealPlan.js';

loadDotEnv();

const mutate = process.argv.includes('--mutate');
const WEEK_START = Date.parse('2026-09-07T00:00:00+07:00');
const WEEK_END = Date.parse('2026-09-14T00:00:00+07:00');

type Patch = {
  matchTitle: string;
  day: string; // YYYY-MM-DD product date
  hour: number;
  outcome:
    | { type: 'CHECKLIST'; items: string[] }
    | { type: 'QUANTITY'; target: number; actual: number; unit: string };
};

const PATCHES: Patch[] = [
  {
    matchTitle: 'Finalize target role profile',
    day: '2026-09-07',
    hour: 19,
    outcome: {
      type: 'CHECKLIST',
      items: [
        'target SWE/backend role criteria defined',
        'must-have vs nice-to-have criteria written',
        '15–20 suitable roles/companies shortlisted',
      ],
    },
  },
  {
    matchTitle: 'Send 2 meaningful professional outreaches',
    day: '2026-09-07',
    hour: 20,
    outcome: { type: 'QUANTITY', target: 1, actual: 0, unit: 'message' },
  },
  {
    matchTitle: 'Ship backend-focused CV',
    day: '2026-09-08',
    hour: 8,
    outcome: {
      type: 'CHECKLIST',
      items: [
        'coherent SWE/backend story',
        'strongest measurable impact visible',
        'unnecessary technology listing reduced',
        'ready to send to a real employer',
      ],
    },
  },
  {
    matchTitle: 'Send 2 meaningful professional outreaches',
    day: '2026-09-08',
    hour: 9,
    outcome: { type: 'QUANTITY', target: 1, actual: 0, unit: 'message' },
  },
  {
    matchTitle: 'Submit 4 quality applications',
    day: '2026-09-09',
    hour: 8,
    outcome: { type: 'QUANTITY', target: 2, actual: 0, unit: 'applications' },
  },
  {
    matchTitle: 'Run backend interview calibration',
    day: '2026-09-10',
    hour: 8,
    outcome: {
      type: 'CHECKLIST',
      items: [
        'solve 2 representative medium DSA problems',
        'explain 1 high-leverage backend topic without notes',
        'answer 3 representative interview questions',
        'record top 3 weaknesses',
      ],
    },
  },
  {
    matchTitle: 'Submit 4 quality applications',
    day: '2026-09-11',
    hour: 8,
    outcome: { type: 'QUANTITY', target: 2, actual: 0, unit: 'applications' },
  },
  {
    matchTitle: 'Establish IELTS diagnostic baseline',
    day: '2026-09-12',
    hour: 7,
    outcome: {
      type: 'CHECKLIST',
      items: [
        'Listening diagnostic',
        'Reading diagnostic',
        'Timed Writing Task 2',
        'Record raw results / observations',
      ],
    },
  },
  {
    matchTitle: 'Establish IELTS diagnostic baseline',
    day: '2026-09-13',
    hour: 7,
    outcome: {
      type: 'CHECKLIST',
      items: [
        'Record representative Speaking answers',
        'Synthesize approximate baseline',
        'Record major weaknesses',
        'Identify first 2 highest-leverage improvement areas',
      ],
    },
  },
  {
    matchTitle: 'Read one meaningful chapter',
    day: '2026-09-13',
    hour: 8,
    outcome: {
      type: 'CHECKLIST',
      items: [
        'meaningful chapter completed',
        '5 useful ideas captured',
      ],
    },
  },
];

function productLocalParts(epochMs: number) {
  const shifted = new Date(epochMs + 7 * 3600_000);
  return {
    day: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
  };
}

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.DATABASE_URL;
  if (!dbUrl || /localhost|127\.0\.0\.1/.test(dbUrl)) {
    throw new Error('production DATABASE_URL required');
  }
  const db = createDb(dbUrl);
  try {
    const user = await findUserByEmail(db, OWNER_REAL_PLAN_EMAIL);
    if (!user) throw new Error('owner not found');

    if (mutate) {
      await runMigrations(dbUrl);
    }

    const rows = await db
      .select({
        id: timeBlocks.id,
        title: tasks.title,
        start: timeBlocks.startEpochMs,
        googleEventId: timeBlocks.googleEventId,
      })
      .from(timeBlocks)
      .leftJoin(tasks, eq(tasks.id, timeBlocks.taskId))
      .where(
        and(
          eq(timeBlocks.userId, user.id),
          isNull(timeBlocks.deletedAt),
          sql`${timeBlocks.startEpochMs} >= ${WEEK_START}`,
          sql`${timeBlocks.startEpochMs} < ${WEEK_END}`,
        ),
      );

    const plan = PATCHES.map((patch) => {
      const hit = rows.find((row) => {
        const title = row.title ?? '';
        if (!title.includes(patch.matchTitle)) return false;
        const parts = productLocalParts(row.start);
        return parts.day === patch.day && parts.hour === patch.hour;
      });
      return { patch, hit };
    });

    console.log(JSON.stringify({
      mode: mutate ? 'mutate' : 'audit',
      matched: plan.filter((p) => p.hit).length,
      missing: plan.filter((p) => !p.hit).map((p) => `${p.patch.day} ${p.patch.hour}h ${p.patch.matchTitle}`),
      ids: plan.filter((p) => p.hit).map((p) => ({
        id: p.hit!.id,
        title: p.hit!.title,
        googleEventId: p.hit!.googleEventId,
        next: p.patch.outcome.type,
      })),
    }, null, 2));

    if (!mutate) {
      console.log('Dry-run only. Re-run with --mutate to migrate + patch.');
      return;
    }

    const now = new Date();
    for (const { patch, hit } of plan) {
      if (!hit) continue;
      if (patch.outcome.type === 'CHECKLIST') {
        const items = patch.outcome.items.map((text) => checklistItem(text, false));
        await db.update(timeBlocks).set({
          sessionOutcomeType: 'CHECKLIST',
          sessionOutcomeItems: items,
          sessionOutcomeTarget: null,
          sessionOutcomeActual: null,
          sessionOutcomeUnit: null,
          updatedAt: now,
        }).where(and(eq(timeBlocks.id, hit.id), eq(timeBlocks.userId, user.id)));
      } else {
        await db.update(timeBlocks).set({
          sessionOutcomeType: 'QUANTITY',
          sessionOutcomeItems: null,
          sessionOutcomeTarget: patch.outcome.target,
          sessionOutcomeActual: patch.outcome.actual,
          sessionOutcomeUnit: patch.outcome.unit,
          updatedAt: now,
        }).where(and(eq(timeBlocks.id, hit.id), eq(timeBlocks.userId, user.id)));
      }
    }
    console.log(JSON.stringify({ patched: plan.filter((p) => p.hit).length }, null, 2));
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
