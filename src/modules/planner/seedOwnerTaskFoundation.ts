/**
 * Idempotent seed of the MINIMUM real Task foundation for the owner account.
 * Creates routine/habit foundations + initial Job/IELTS Tasks.
 * Does not invent Explore/Finance/Learning Tasks or arbitrary Daily Focus dates.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../infrastructure/db/client.js';
import { goals, projects, tasks, timeBlocks } from '../../infrastructure/db/schema/index.js';
import { FakeCalendarProvider } from '../../infrastructure/providers/calendar/fakeCalendarProvider.js';
import {
  PlannerV2Service,
  priorityToHex,
} from '../../application/plannerV2Service.js';
import { resolveMaintainRepeatUntilEpochMs } from '../../application/sessionEvidence.js';
import { findUserByEmail } from '../identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL, normalizePlanTitle } from './seedOwnerRealPlan.js';

const PRODUCT_OFFSET_MS = 7 * 60 * 60 * 1000;

function productParts(epochMs: number) {
  const shifted = new Date(epochMs + PRODUCT_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function productLocalIso(y: number, m: number, d: number, hour: number, minute: number) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(m + 1)}-${pad(d)}T${pad(hour)}:${pad(minute)}:00+07:00`;
}

function startOfProductDayEpoch(now = Date.now()) {
  const p = productParts(now);
  return new Date(productLocalIso(p.y, p.m, p.d, 0, 0)).getTime();
}

function nextSundayEpoch(fromEpoch: number) {
  const p = productParts(fromEpoch);
  const add = p.weekday === 0 ? 0 : 7 - p.weekday;
  return startOfProductDayEpoch(fromEpoch) + add * 86_400_000;
}

type TaskSeedSpec = {
  key: string;
  title: string;
  projectTitle: string;
  priority: 'P1' | 'P2';
  durationMinutes: number;
  notes: string;
  definitionOfDone: string | null;
  dueHorizon: 'DAY' | 'WEEK' | null;
  kind: 'finite' | 'daily' | 'weekly';
  sessionPlan?: Array<{ hour: number; minute: number; durationMinutes: number; title?: string }>;
  /** Mon=0 … Sun=6 within the week that ends on the due Sunday. */
  weeklySessionDays?: number[];
};

const TASK_SPECS: TaskSeedSpec[] = [
  {
    key: 'daily-review',
    title: 'Daily Review & Tomorrow Prep',
    projectTitle: 'Personal OS Review & Planning',
    priority: 'P2',
    durationMinutes: 20,
    kind: 'daily',
    dueHorizon: 'DAY',
    notes:
      'Keystone routine.\n\nNormal (15–20 min):\n- Review today\'s execution\n- Check whether today\'s Daily Focus outcome was achieved\n- Inspect tomorrow\'s ALREADY PLANNED work\n- Confirm tomorrow\'s already-selected Daily Focus\n- Check Finance status if needed (stale if >5 days without expense/review activity)\n- Replan ONLY if something materially unexpected changed\n\nMinimum viable (1–5 min):\n- Acknowledge today\n- Look at tomorrow\'s plan / Daily Focus\n- Adjust only if necessary\n\nDefault: KEEP TOMORROW\'S PLAN. Avoid day-to-day planning churn.',
    definitionOfDone: null,
    sessionPlan: [{ hour: 21, minute: 0, durationMinutes: 20 }],
  },
  {
    key: 'weekly-review',
    title: 'Weekly Review & Next Week Prep',
    projectTitle: 'Personal OS Review & Planning',
    priority: 'P2',
    durationMinutes: 45,
    kind: 'weekly',
    dueHorizon: 'WEEK',
    notes:
      'Keystone weekly planning point (preferred Sunday).\n\nNormal 30–60 min · Minimum ~10 min.\n\nReview:\n- Daily Focus adherence\n- FOCUS Goal outputs\n- Process misses\n- execution without concrete outcomes\n- neglected Goals\n- Work spillover into personal time\n- Health / Finance / intellectual learning\n- Explore notes if any (no Explore quota)\n\nThen PREPARE next week:\n- choose upcoming Tasks\n- 80/20 priorities\n- assign Daily Focus ahead of time\n- prepare intended schedule\n\nThis owns proactive planning — Daily Review does not invent tomorrow from scratch.',
    definitionOfDone: null,
    weeklySessionDays: [6],
    sessionPlan: [{ hour: 10, minute: 0, durationMinutes: 45 }],
  },
  {
    key: 'bedtime',
    title: 'Bedtime Checkpoint',
    projectTitle: 'Sleep Routine',
    priority: 'P2',
    durationMinutes: 5,
    kind: 'daily',
    dueHorizon: 'DAY',
    notes:
      'Current operational target: 22:30 bedtime.\nLong-term target: 22:00.\n\nComplete even if late — timestamp is the check-in evidence.\nCompletion ≠ good sleep adherence.\nContextual: no scrolling before sleep (not a completion prerequisite).\nFuture analytics derive lateness separately.',
    definitionOfDone: null,
    sessionPlan: [{ hour: 22, minute: 30, durationMinutes: 5 }],
  },
  {
    key: 'wakeup',
    title: 'Wake-up Checkpoint',
    projectTitle: 'Sleep Routine',
    priority: 'P2',
    durationMinutes: 5,
    kind: 'daily',
    dueHorizon: 'DAY',
    notes:
      'Current operational target: 06:00 wake.\nLong-term target: 05:00.\n\nComplete even if late — timestamp is the check-in evidence.\nCompletion ≠ good wake adherence.',
    definitionOfDone: null,
    sessionPlan: [{ hour: 6, minute: 0, durationMinutes: 5 }],
  },
  {
    key: 'exercise-week',
    title: 'Complete 3 Exercise & Movement sessions this week',
    projectTitle: 'Exercise & Movement',
    priority: 'P2',
    durationMinutes: 120,
    kind: 'weekly',
    dueHorizon: 'WEEK',
    notes:
      'Target: 3 movement sessions this week (gym, running, basketball, or other useful movement).\nDo not split into separate sport Projects.\nNo Definition of Done — Session completion is enough for this routine.',
    definitionOfDone: null,
    weeklySessionDays: [0, 2, 4],
    sessionPlan: [{ hour: 18, minute: 30, durationMinutes: 40 }],
  },
  {
    key: 'job-role-profile',
    title: 'Finalize target role profile and shortlist 15–20 suitable roles',
    projectTitle: 'Targeted Job Search & Interview Pipeline',
    priority: 'P1',
    durationMinutes: 75,
    kind: 'finite',
    dueHorizon: null,
    notes: 'High-leverage Job foundation Task. Schedule Sessions in the next planning phase.',
    definitionOfDone:
      '- target SWE/backend role criteria defined\n- must-have vs nice-to-have criteria written\n- 15–20 realistic roles/companies shortlisted\n- each candidate is plausibly worth applying to',
  },
  {
    key: 'job-cv-v1',
    title: 'Ship backend-focused CV v1',
    projectTitle: 'Candidate Profile Positioning',
    priority: 'P1',
    durationMinutes: 90,
    kind: 'finite',
    dueHorizon: null,
    notes: 'Ready to send is enough — do not optimize for perfection.',
    definitionOfDone:
      '- CV tells one coherent SWE/backend-focused story\n- strongest measurable impact is visible\n- unnecessary technology listing reduced\n- CV is ready to send to a real company',
  },
  {
    key: 'job-calibration',
    title: 'Run backend interview calibration and identify top 3 gaps',
    projectTitle: 'Backend Interview Preparation',
    priority: 'P2',
    durationMinutes: 120,
    kind: 'finite',
    dueHorizon: null,
    notes: 'Use evidence to select subsequent 80/20 interview-preparation Tasks.',
    definitionOfDone:
      '- solve 2 representative medium DSA problems\n- explain 1 high-leverage backend topic without notes\n- answer 3 representative interview questions\n- record the top 3 weaknesses to attack next',
  },
  {
    key: 'job-apps-4',
    title: 'Submit 4 quality applications to suitable roles',
    projectTitle: 'Targeted Job Search & Interview Pipeline',
    priority: 'P1',
    durationMinutes: 120,
    kind: 'finite',
    dueHorizon: null,
    notes: 'Browsing or preparing without submitting does NOT count as completion.',
    definitionOfDone:
      '- 4 real applications submitted\n- all 4 roles pass target-fit criteria',
  },
  {
    key: 'job-outreach-2',
    title: 'Send 2 meaningful professional outreaches',
    projectTitle: 'Targeted Job Search & Interview Pipeline',
    priority: 'P2',
    durationMinutes: 45,
    kind: 'finite',
    dueHorizon: null,
    notes: 'Engineers, recruiters, alumni, or useful contacts. Generic spam does not count.',
    definitionOfDone:
      '- 2 personalized, relevant professional messages actually sent',
  },
  {
    key: 'ielts-baseline',
    title: 'Establish IELTS diagnostic baseline',
    projectTitle: 'IELTS Exam Preparation & Registration',
    priority: 'P2',
    durationMinutes: 210,
    kind: 'finite',
    dueHorizon: null,
    notes: 'May span multiple Sessions. Result informs future Writing/Speaking/Exam Tasks. No full IELTS roadmap yet.',
    definitionOfDone:
      '- representative Listening diagnostic completed\n- representative Reading diagnostic completed\n- one timed Writing Task 2 response completed\n- representative Speaking answers recorded\n- approximate baseline / observed weaknesses recorded\n- first 2 highest-leverage improvement areas identified',
  },
];

export type SeedOwnerTaskFoundationReport = {
  ownerEmail: string;
  userId: string;
  createdTitles: string[];
  reusedTitles: string[];
  repeatedSeries: Array<{ title: string; cadence: string; createdCount: number; until: string }>;
  finiteWithoutDailyFocus: string[];
  skippedForbidden: string[];
  liveDistinctTitles: string[];
};

export async function seedOwnerTaskFoundation(
  db: Db,
  ownerEmail: string = OWNER_REAL_PLAN_EMAIL,
): Promise<SeedOwnerTaskFoundationReport> {
  const email = ownerEmail.trim().toLowerCase();
  if (email !== OWNER_REAL_PLAN_EMAIL) {
    throw new Error(`Refusing task foundation seed for ${ownerEmail}`);
  }
  const user = await findUserByEmail(db, email);
  if (!user) throw Object.assign(new Error(`User not found: ${email}`), { code: 'OWNER_NOT_FOUND' });

  const planner = new PlannerV2Service(db, async () => new FakeCalendarProvider());
  const projectRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, user.id), isNull(projects.deletedAt)));
  const goalRows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, user.id), isNull(goals.deletedAt)));
  let existingTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, user.id), isNull(tasks.deletedAt)));

  const projectByTitle = new Map(projectRows.map((p) => [normalizePlanTitle(p.title), p]));
  const goalById = new Map(goalRows.map((g) => [g.id, g]));

  const createdTitles: string[] = [];
  const reusedTitles: string[] = [];
  const repeatedSeries: SeedOwnerTaskFoundationReport['repeatedSeries'] = [];
  const finiteWithoutDailyFocus: string[] = [];
  const now = Date.now();

  for (const spec of TASK_SPECS) {
    const project = projectByTitle.get(normalizePlanTitle(spec.projectTitle));
    if (!project) throw new Error(`Missing project for seed: ${spec.projectTitle}`);

    const match = existingTasks.find(
      (t) => normalizePlanTitle(t.title) === normalizePlanTitle(spec.title) && t.projectId === project.id,
    );

    let taskId: string;
    if (match) {
      reusedTitles.push(spec.title);
      taskId = match.id;
      await planner.patchTask(user.id, match.id, {
        notes: spec.notes,
        definitionOfDone: spec.definitionOfDone,
        priority: spec.priority,
        durationMinutes: spec.durationMinutes,
        dailyFocusDate: null,
      });
      if (spec.kind === 'finite') finiteWithoutDailyFocus.push(spec.title);
    } else {
      const dayStart = startOfProductDayEpoch(now);
      const p = productParts(dayStart);
      let dueAt: string | null = null;
      if (spec.kind === 'daily') {
        dueAt = new Date(productLocalIso(p.y, p.m, p.d, 12, 0)).toISOString();
      } else if (spec.kind === 'weekly') {
        const sunday = nextSundayEpoch(now);
        const sp = productParts(sunday);
        dueAt = new Date(productLocalIso(sp.y, sp.m, sp.d, 12, 0)).toISOString();
      }

      const created = await planner.createTask(user.id, {
        title: spec.title,
        notes: spec.notes,
        definitionOfDone: spec.definitionOfDone,
        dailyFocusDate: null,
        projectId: project.id,
        goalId: project.goalId,
        dueAt,
        dueHorizon: spec.dueHorizon,
        durationMinutes: spec.durationMinutes,
        priority: spec.priority,
      });
      createdTitles.push(spec.title);
      taskId = created.id;
      if (spec.kind === 'finite') finiteWithoutDailyFocus.push(spec.title);
    }

    if (spec.kind === 'finite') continue;

    const taskRow = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]!;
    const existingBlocks = await db
      .select()
      .from(timeBlocks)
      .where(and(
        eq(timeBlocks.userId, user.id),
        eq(timeBlocks.taskId, taskId),
        isNull(timeBlocks.deletedAt),
      ));

    if (existingBlocks.length === 0 && spec.sessionPlan?.length) {
      const color = priorityToHex(spec.priority);
      if (spec.kind === 'daily') {
        const day0 = taskRow.deadlineEpochMs ?? startOfProductDayEpoch(now);
        const dp = productParts(day0);
        for (const session of spec.sessionPlan) {
          const startLocal = productLocalIso(dp.y, dp.m, dp.d, session.hour, session.minute);
          const startMs = new Date(startLocal).getTime();
          await planner.createTimeBlock(user.id, {
            taskId,
            projectId: project.id,
            title: session.title ?? spec.title,
            startAt: new Date(startMs).toISOString(),
            endAt: new Date(startMs + session.durationMinutes * 60_000).toISOString(),
            color,
            status: 'PLANNED',
            skipCalendarSync: true,
          });
        }
      } else {
        const due = taskRow.deadlineEpochMs ?? nextSundayEpoch(now);
        const mondayEpoch = startOfProductDayEpoch(due) - 6 * 86_400_000;
        const days = spec.weeklySessionDays ?? [6];
        const template = spec.sessionPlan[0]!;
        for (const dayOffset of days) {
          const dayEpoch = mondayEpoch + dayOffset * 86_400_000;
          const dp = productParts(dayEpoch);
          const startLocal = productLocalIso(dp.y, dp.m, dp.d, template.hour, template.minute);
          const startMs = new Date(startLocal).getTime();
          await planner.createTimeBlock(user.id, {
            taskId,
            projectId: project.id,
            title: spec.title,
            startAt: new Date(startMs).toISOString(),
            endAt: new Date(startMs + template.durationMinutes * 60_000).toISOString(),
            color,
            status: 'PLANNED',
            skipCalendarSync: true,
          });
        }
      }
    }

    if (!taskRow.repeatSeriesId) {
      const goal = taskRow.goalId ? goalById.get(taskRow.goalId) : null;
      const goalDeadline = goal?.targetDate
        ? new Date(`${goal.targetDate}T23:59:59+07:00`).getTime()
        : null;
      const until = resolveMaintainRepeatUntilEpochMs({
        nowEpochMs: now,
        goalTargetDateEpochMs: goalDeadline,
      });
      const untilStr = new Date(until).toISOString();
      const result = await planner.repeatTask(user.id, taskId, {
        cadence: spec.kind === 'daily' ? 'DAILY' : 'WEEKLY',
        until: untilStr,
        skipCalendarSync: true,
      });
      repeatedSeries.push({
        title: spec.title,
        cadence: spec.kind === 'daily' ? 'DAILY' : 'WEEKLY',
        createdCount: result.createdTaskIds.length,
        until: untilStr,
      });
    }
  }

  existingTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, user.id), isNull(tasks.deletedAt)));

  return {
    ownerEmail: user.email,
    userId: user.id,
    createdTitles,
    reusedTitles,
    repeatedSeries,
    finiteWithoutDailyFocus,
    skippedForbidden: [
      'Explore / Opportunity Exploration',
      'Daily Finance Review',
      'Reading / Professional Learning recurring',
      'Rover / Drone fake tasks',
    ],
    liveDistinctTitles: [...new Set(existingTasks.map((t) => t.title))].sort(),
  };
}

export const OWNER_TASK_FOUNDATION_SPECS = TASK_SPECS;
