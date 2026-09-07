/**
 * Idempotent allocation for the first real Weekly Plan week:
 * Mon 2026-09-07 → Sun 2026-09-13 (Asia/Ho_Chi_Minh).
 *
 * Creates finite Job/IELTS/Reading Sessions + Session-level Daily Focus.
 * Does not recreate routine foundation series.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../infrastructure/db/client.js';
import { projects, tasks, timeBlocks } from '../../infrastructure/db/schema/index.js';
import {
  PlannerV2Service,
  priorityToHex,
} from '../../application/plannerV2Service.js';
import { productDateFromEpoch } from '../../application/dailyFocus.js';
import { findUserByEmail } from '../identity/plannerOwnership.js';
import { OWNER_REAL_PLAN_EMAIL, normalizePlanTitle } from './seedOwnerRealPlan.js';
import type { CalendarProvider } from '../../infrastructure/providers/calendar/types.js';

const WEEK_START = '2026-09-07';
const WEEK_END_EXCLUSIVE = '2026-09-14';
const PRODUCT_TZ = '+07:00';

function localIso(date: string, hour: number, minute: number) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date}T${pad(hour)}:${pad(minute)}:00${PRODUCT_TZ}`;
}

type SessionSpec = {
  key: string;
  taskTitle: string;
  date: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  notes: string;
  isDailyFocus: boolean;
};

const SESSION_SPECS: SessionSpec[] = [
  {
    key: 'mon-role',
    taskTitle: 'Finalize target role profile and shortlist 15–20 suitable roles',
    date: '2026-09-07',
    startHour: 19,
    startMinute: 30,
    endHour: 20,
    endMinute: 30,
    notes:
      'Define target role criteria and produce the initial 15–20 role/company shortlist.',
    isDailyFocus: true,
  },
  {
    key: 'mon-outreach-1',
    taskTitle: 'Send 2 meaningful professional outreaches',
    date: '2026-09-07',
    startHour: 20,
    startMinute: 30,
    endHour: 21,
    endMinute: 0,
    notes: 'Send personalized professional outreach #1.',
    isDailyFocus: false,
  },
  {
    key: 'tue-cv',
    taskTitle: 'Ship backend-focused CV v1',
    date: '2026-09-08',
    startHour: 8,
    startMinute: 0,
    endHour: 9,
    endMinute: 30,
    notes:
      'Produce a version that is ready to send to a real SWE/backend employer. Do not optimize for perfection.',
    isDailyFocus: true,
  },
  {
    key: 'tue-outreach-2',
    taskTitle: 'Send 2 meaningful professional outreaches',
    date: '2026-09-08',
    startHour: 9,
    startMinute: 30,
    endHour: 10,
    endMinute: 0,
    notes: 'Send personalized professional outreach #2 and complete the 2-message output.',
    isDailyFocus: false,
  },
  {
    key: 'wed-apps-1',
    taskTitle: 'Submit 4 quality applications to suitable roles',
    date: '2026-09-09',
    startHour: 8,
    startMinute: 0,
    endHour: 10,
    endMinute: 0,
    notes:
      'Application batch 1. Use only roles that pass the agreed target-fit criteria. Aim to submit approximately the first half of the weekly 4-application output.',
    isDailyFocus: true,
  },
  {
    key: 'thu-interview',
    taskTitle: 'Run backend interview calibration and identify top 3 gaps',
    date: '2026-09-10',
    startHour: 8,
    startMinute: 0,
    endHour: 10,
    endMinute: 0,
    notes:
      '- solve representative DSA problems\n- test one high-leverage backend topic\n- answer representative interview questions\n- synthesize the top 3 gaps',
    isDailyFocus: true,
  },
  {
    key: 'fri-apps-2',
    taskTitle: 'Submit 4 quality applications to suitable roles',
    date: '2026-09-11',
    startHour: 8,
    startMinute: 0,
    endHour: 10,
    endMinute: 0,
    notes:
      'Application batch 2. Finish the weekly output and reach 4 real submitted quality applications if possible.',
    isDailyFocus: true,
  },
  {
    key: 'sat-ielts-1',
    taskTitle: 'Establish IELTS diagnostic baseline',
    date: '2026-09-12',
    startHour: 7,
    startMinute: 0,
    endHour: 10,
    endMinute: 0,
    notes:
      'Diagnostic Part 1:\n- Listening\n- Reading\n- timed Writing Task 2\n- record raw results / observations',
    isDailyFocus: true,
  },
  {
    key: 'sun-ielts-2',
    taskTitle: 'Establish IELTS diagnostic baseline',
    date: '2026-09-13',
    startHour: 7,
    startMinute: 0,
    endHour: 8,
    endMinute: 0,
    notes:
      'Diagnostic Part 2:\n- representative Speaking answers\n- synthesize approximate baseline\n- record major weaknesses\n- identify first 2 highest-leverage improvement areas',
    isDailyFocus: true,
  },
  {
    key: 'sun-reading',
    taskTitle: 'Read one meaningful chapter and capture 5 useful ideas',
    date: '2026-09-13',
    startHour: 8,
    startMinute: 15,
    endHour: 9,
    endMinute: 30,
    notes: 'Read one meaningful chapter and capture the five ideas worth retaining.',
    isDailyFocus: false,
  },
];

const READING_TASK = {
  title: 'Read one meaningful chapter and capture 5 useful ideas',
  projectTitle: 'Reading',
  priority: 'P2' as const,
  durationMinutes: 75,
  definitionOfDone:
    '- one meaningful chapter from the current book is completed\n- 5 useful ideas / insights are captured in notes',
  notes: 'Deliberately generic to the current book. Not a recurring Reading quota.',
};

export type SeedOwnerWeekPlanReport = {
  ownerEmail: string;
  week: string;
  createdReadingTask: boolean;
  reusedReadingTask: boolean;
  createdSessions: string[];
  reusedSessions: string[];
  dailyFocusByDay: Record<string, string>;
  routineTitlesPresent: string[];
  googleSynced: number;
  googlePending: number;
  googleFailed: number;
};

function weekBounds() {
  return {
    fromMs: new Date(`${WEEK_START}T00:00:00${PRODUCT_TZ}`).getTime(),
    toMs: new Date(`${WEEK_END_EXCLUSIVE}T00:00:00${PRODUCT_TZ}`).getTime(),
  };
}

export async function seedOwnerWeekPlan(
  db: Db,
  resolveCalendar: (userId: string) => Promise<CalendarProvider> | CalendarProvider,
  ownerEmail: string = OWNER_REAL_PLAN_EMAIL,
): Promise<SeedOwnerWeekPlanReport> {
  const email = ownerEmail.trim().toLowerCase();
  if (email !== OWNER_REAL_PLAN_EMAIL) {
    throw new Error(`Refusing week plan seed for ${ownerEmail}`);
  }
  const user = await findUserByEmail(db, email);
  if (!user) throw Object.assign(new Error(`User not found: ${email}`), { code: 'OWNER_NOT_FOUND' });

  const planner = new PlannerV2Service(db, resolveCalendar);
  const { fromMs, toMs } = weekBounds();

  const projectRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, user.id), isNull(projects.deletedAt)));
  const projectByTitle = new Map(projectRows.map((p) => [normalizePlanTitle(p.title), p]));

  let existingTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, user.id), isNull(tasks.deletedAt)));

  const weekBlocks = await db
    .select()
    .from(timeBlocks)
    .where(and(eq(timeBlocks.userId, user.id), isNull(timeBlocks.deletedAt)));

  const createdSessions: string[] = [];
  const reusedSessions: string[] = [];
  let createdReadingTask = false;
  let reusedReadingTask = false;

  // Ensure Reading Task exists.
  const readingProject = projectByTitle.get(normalizePlanTitle(READING_TASK.projectTitle));
  if (!readingProject) throw new Error(`Missing project: ${READING_TASK.projectTitle}`);
  let readingTask = existingTasks.find(
    (t) => normalizePlanTitle(t.title) === normalizePlanTitle(READING_TASK.title),
  );
  if (!readingTask) {
    const created = await planner.createTask(user.id, {
      title: READING_TASK.title,
      notes: READING_TASK.notes,
      definitionOfDone: READING_TASK.definitionOfDone,
      projectId: readingProject.id,
      goalId: readingProject.goalId,
      dueHorizon: 'WEEK',
      dueAt: new Date(`${WEEK_END_EXCLUSIVE}T00:00:00${PRODUCT_TZ}`).toISOString(),
      durationMinutes: READING_TASK.durationMinutes,
      priority: READING_TASK.priority,
    });
    createdReadingTask = true;
    existingTasks = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, user.id), isNull(tasks.deletedAt)));
    readingTask = existingTasks.find((t) => t.id === created.id)!;
  } else {
    reusedReadingTask = true;
    await planner.patchTask(user.id, readingTask.id, {
      notes: READING_TASK.notes,
      definitionOfDone: READING_TASK.definitionOfDone,
      priority: READING_TASK.priority,
      durationMinutes: READING_TASK.durationMinutes,
      dueHorizon: 'WEEK',
    });
  }

  const taskByTitle = new Map(
    existingTasks.map((t) => [normalizePlanTitle(t.title), t]),
  );

  for (const spec of SESSION_SPECS) {
    const task = taskByTitle.get(normalizePlanTitle(spec.taskTitle));
    if (!task) throw new Error(`Missing task for week plan: ${spec.taskTitle}`);

    const startAt = localIso(spec.date, spec.startHour, spec.startMinute);
    const endAt = localIso(spec.date, spec.endHour, spec.endMinute);
    const startMs = new Date(startAt).getTime();
    const endMs = new Date(endAt).getTime();

    const existing = weekBlocks.find(
      (b) =>
        b.taskId === task.id
        && !b.deletedAt
        && Math.abs(b.startEpochMs - startMs) < 60_000
        && Math.abs(b.endEpochMs - endMs) < 60_000,
    );

    if (existing) {
      reusedSessions.push(spec.key);
      await planner.patchTimeBlock(user.id, existing.id, {
        notes: spec.notes,
        isDailyFocus: spec.isDailyFocus,
        replaceDailyFocus: true,
      });
      continue;
    }

    const color = priorityToHex(
      task.priority <= 1 ? 'P1' : task.priority === 3 ? 'P3' : task.priority >= 4 ? 'P4' : 'P2',
    );
    await planner.createTimeBlock(user.id, {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      color,
      notes: spec.notes,
      status: 'PLANNED',
      isDailyFocus: spec.isDailyFocus,
      replaceDailyFocus: true,
    });
    createdSessions.push(spec.key);
  }

  const afterBlocks = await db
    .select()
    .from(timeBlocks)
    .where(and(eq(timeBlocks.userId, user.id), isNull(timeBlocks.deletedAt)));

  const inWeek = afterBlocks.filter(
    (b) => b.startEpochMs >= fromMs && b.startEpochMs < toMs,
  );
  const dailyFocusByDay: Record<string, string> = {};
  for (const block of inWeek) {
    if (!block.isDailyFocus) continue;
    const day = productDateFromEpoch(block.startEpochMs);
    dailyFocusByDay[day] = block.title;
  }

  const routineTitlesPresent = [...new Set(
    inWeek
      .map((b) => b.title)
      .filter((title) =>
        /Wake-up Checkpoint|Bedtime Checkpoint|Daily Review|Weekly Review|Exercise & Movement/i.test(
          title,
        ),
      ),
  )].sort();

  return {
    ownerEmail: user.email,
    week: `${WEEK_START} → 2026-09-13`,
    createdReadingTask,
    reusedReadingTask,
    createdSessions,
    reusedSessions,
    dailyFocusByDay,
    routineTitlesPresent,
    googleSynced: inWeek.filter((b) => b.syncStatus === 'SYNCED').length,
    googlePending: inWeek.filter((b) => b.syncStatus === 'PENDING').length,
    googleFailed: inWeek.filter((b) => b.syncStatus === 'FAILED').length,
  };
}

export const OWNER_WEEK_PLAN_SESSION_SPECS = SESSION_SPECS;
export const OWNER_WEEK_PLAN_READING_TASK = READING_TASK;
