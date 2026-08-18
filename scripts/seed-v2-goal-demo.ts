#!/usr/bin/env tsx
/**
 * Development-only seed: creates two realistic Goals with full evidence chain.
 * Idempotent — safe to rerun (uses deterministic IDs based on SEED_PREFIX).
 *
 * Usage:
 *   npm run seed:v2-goal-demo          # seed data
 *   npm run seed:v2-goal-demo:reset    # remove seeded data
 */
import { inArray } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDb, closeDb } from '../src/infrastructure/db/client.js';
import { runMigrations } from '../src/infrastructure/db/migrate.js';
import {
  goals,
  projects,
  tasks,
  timeBlocks,
} from '../src/infrastructure/db/schema/index.js';

const RESET = process.argv.includes('--reset');
const SEED = 'v2demo';

function sid(suffix: string) {
  return `${SEED}-${suffix}`;
}

/** Epoch ms for a Vietnam-local datetime (UTC+7). */
function vn(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 7, minute);
}

/** Hours in ms — for building timestamps relative to a VN midnight epoch. */
const H = 3_600_000;

// Current week: Mon Aug 17 – Sun Aug 23 2026 (Aug 18 is Tuesday)
const CURRENT_WEEK_MON = vn(2026, 8, 17);

function weekMonday(offset: number) {
  return CURRENT_WEEK_MON + offset * 7 * 86_400_000;
}

const NOW_MS = vn(2026, 8, 18, 14, 0);
const now = new Date(NOW_MS);

// ── Goal IDs ────────────────────────────────────────────────────────────────

const IELTS_GOAL_ID = sid('goal-ielts');
const BACKEND_GOAL_ID = sid('goal-backend');
const CV_GOAL_ID = sid('goal-cv-refresh');

// ── Process IDs (embedded in processesJson) ─────────────────────────────────

const IELTS_PROC_SPEAKING = sid('proc-ielts-speaking');
const IELTS_PROC_WRITING = sid('proc-ielts-writing');
const IELTS_PROC_STUDY = sid('proc-ielts-study');

const BE_PROC_APPS = sid('proc-be-apps');
const BE_PROC_TECH = sid('proc-be-tech');
const BE_PROC_MOCK = sid('proc-be-mock');

// ── Project IDs ─────────────────────────────────────────────────────────────

const IELTS_PROJECT_ID = sid('proj-ielts-prep');
const IELTS_WRITING_PROJECT_ID = sid('proj-ielts-writing');
const BE_APPS_PROJECT_ID = sid('proj-be-apps');
const BE_INTERVIEW_PROJECT_ID = sid('proj-be-interview');
const BE_CV_PROJECT_ID = sid('proj-be-cv');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(
  id: string,
  title: string,
  opts: {
    projectId?: string;
    goalId?: string;
    goalProcessId?: string;
    status?: string;
    completedAtEpochMs?: number | null;
    dueHorizon?: string | null;
    deadlineEpochMs?: number | null;
    estimatedMinutes?: number;
  } = {},
) {
  return {
    id: sid(id),
    title,
    description: '',
    projectId: opts.projectId ?? null,
    goalId: opts.goalId ?? null,
    goalProcessId: opts.goalProcessId ?? null,
    lifeArea: 'LEARNING',
    priority: 2,
    deadlineEpochMs: opts.deadlineEpochMs ?? null,
    estimatedMinutes: opts.estimatedMinutes ?? 30,
    actualMinutes: null,
    energyRequirement: 2,
    locationRequirements: '[]',
    dependencyIds: '[]',
    preferredTime: opts.dueHorizon ?? null,
    earliestStartEpochMs: null,
    deadlineFlexible: true,
    interruptible: true,
    deepWork: false,
    nextAction: null,
    rescheduleCount: 0,
    status: opts.status ?? 'TODO',
    completedAtEpochMs: opts.completedAtEpochMs ?? null,
    verificationLevel: 'SELF',
    isAnchorCandidate: false,
    estimateBiasFactor: 1,
    revision: 1,
    updatedAt: now,
    deletedAt: null,
  };
}

function makeBlock(
  id: string,
  taskId: string,
  startMs: number,
  endMs: number,
  title: string,
  status = 'PLANNED',
) {
  return {
    id: sid(id),
    taskId: sid(taskId),
    projectId: null,
    title,
    startEpochMs: startMs,
    endEpochMs: endMs,
    color: '#705CF6',
    status,
    origin: 'PLANNER',
    calendarId: null,
    googleEventId: null,
    googleEtag: null,
    syncStatus: 'PENDING',
    reminderMinutes: null,
    recurrenceRule: null,
    revision: 1,
    updatedAt: now,
    deletedAt: null,
  };
}

async function main() {
  const config = loadConfig();
  await runMigrations(config.databaseUrl);
  const db = createDb(config.databaseUrl);

  const allSeedIds = (table: any) =>
    db.select({ id: table.id }).from(table).then((rows: any[]) =>
      rows.map((r: any) => r.id).filter((id: string) => id.startsWith(SEED + '-')),
    );

  if (RESET) {
    console.log('Resetting v2 goal demo data…');
    const goalIds = await allSeedIds(goals);
    const projectIds = await allSeedIds(projects);
    const taskIds = await allSeedIds(tasks);
    const blockIds = await allSeedIds(timeBlocks);
    if (blockIds.length) await db.delete(timeBlocks).where(inArray(timeBlocks.id, blockIds));
    if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
    if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
    if (goalIds.length) await db.delete(goals).where(inArray(goals.id, goalIds));
    console.log(`Removed ${goalIds.length} goals, ${projectIds.length} projects, ${taskIds.length} tasks, ${blockIds.length} blocks.`);
    await closeDb();
    return;
  }

  console.log('Seeding v2 goal demo data…');

  // Upsert helper: delete existing then insert
  async function upsert(table: any, rows: any[]) {
    const ids = rows.map((r) => r.id);
    await db.delete(table).where(inArray(table.id, ids));
    if (rows.length) await db.insert(table).values(rows);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GOAL 1: IELTS 6.5
  // ══════════════════════════════════════════════════════════════════════════

  const ieltsProcesses = [
    { id: IELTS_PROC_SPEAKING, name: 'Speaking Practice', measurementType: 'COUNT', targetValue: 3, period: 'WEEK', active: true },
    { id: IELTS_PROC_WRITING, name: 'Writing Practice', measurementType: 'COUNT', targetValue: 2, period: 'WEEK', active: true },
    { id: IELTS_PROC_STUDY, name: 'English Study', measurementType: 'DURATION', targetValue: 3, unit: 'h', period: 'WEEK', active: true },
  ];

  const ieltsMilestones = [
    { id: sid('ms-ielts-1'), title: 'Establish baseline — 5.5', status: 'DONE' },
    { id: sid('ms-ielts-2'), title: 'Reach 6.0', status: 'DONE' },
    { id: sid('ms-ielts-3'), title: 'Strengthen Speaking + Writing toward 6.5', status: 'ACTIVE' },
    { id: sid('ms-ielts-4'), title: 'Reach 6.5', status: 'PENDING' },
  ];

  const ieltsObservations = [
    { id: sid('obs-ielts-1'), observedAt: '2026-05-15T00:00:00Z', value: 5.5, label: 'May mock' },
    { id: sid('obs-ielts-2'), observedAt: '2026-06-15T00:00:00Z', value: 5.5, label: 'June mock' },
    { id: sid('obs-ielts-3'), observedAt: '2026-07-15T00:00:00Z', value: 6.0, label: 'July mock' },
    { id: sid('obs-ielts-4'), observedAt: '2026-08-10T00:00:00Z', value: 6.0, label: 'August mock' },
  ];

  const ieltsGoal = {
    id: IELTS_GOAL_ID,
    title: 'IELTS 6.5',
    lifeArea: 'LEARNING',
    seasonId: null,
    description: '',
    horizon: 'YEAR',
    status: 'ACTIVE',
    targetDate: '2026-12-31',
    parentId: null,
    successCriteria: '',
    capacityShare: null,
    outcome: 'Achieve an overall IELTS score of 6.5.',
    why: 'Improve English capability for international study, career and mobility opportunities.',
    metric: 'IELTS mock score',
    focusType: 'FOCUS',
    currentMilestoneId: sid('ms-ielts-3'),
    milestonesJson: JSON.stringify(ieltsMilestones),
    systemsJson: JSON.stringify([
      { id: sid('sys-ielts-1'), description: 'Speaking practice 3×/week' },
      { id: sid('sys-ielts-2'), description: 'Writing practice 2×/week' },
      { id: sid('sys-ielts-3'), description: 'English study 3h/week' },
    ]),
    outcomeStatus: 'ACTIVE',
    achievedAt: null,
    closedAt: null,
    processesJson: JSON.stringify(ieltsProcesses),
    metricObservationsJson: JSON.stringify(ieltsObservations),
    reflectionJson: '{}',
    reviewSnapshotJson: '{}',
    revision: 1,
    updatedAt: now,
    deletedAt: null,
  };

  // ── IELTS Projects ──

  const ieltsProjects = [
    {
      id: IELTS_PROJECT_ID,
      title: 'IELTS Preparation',
      goalId: IELTS_GOAL_ID,
      defaultGoalProcessId: null,
      color: '#3B82F6',
      lifeArea: 'LEARNING',
      description: 'Overall IELTS preparation plan',
      targetDate: '2026-12-31',
      active: true,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: IELTS_WRITING_PROJECT_ID,
      title: 'IELTS Writing Improvement',
      goalId: IELTS_GOAL_ID,
      defaultGoalProcessId: IELTS_PROC_WRITING,
      color: '#8B5CF6',
      lifeArea: 'LEARNING',
      description: 'Focused writing skill improvement',
      targetDate: '2026-12-31',
      active: true,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    },
  ];

  // ── IELTS Current-week Tasks ──

  const ieltsTasks: ReturnType<typeof makeTask>[] = [
    // Speaking (3 tasks, 2 completed)
    makeTask('ielts-speak-1', 'IELTS Speaking Part 2 — Technology', {
      projectId: IELTS_PROJECT_ID, goalId: IELTS_GOAL_ID, goalProcessId: IELTS_PROC_SPEAKING,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 17, 19, 0), dueHorizon: 'WEEK',
    }),
    makeTask('ielts-speak-2', 'IELTS Speaking Part 1 — Work & Study', {
      projectId: IELTS_PROJECT_ID, goalId: IELTS_GOAL_ID, goalProcessId: IELTS_PROC_SPEAKING,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 18, 11, 0), dueHorizon: 'WEEK',
    }),
    makeTask('ielts-speak-3', 'IELTS Speaking Part 3 — Education', {
      projectId: IELTS_PROJECT_ID, goalId: IELTS_GOAL_ID, goalProcessId: IELTS_PROC_SPEAKING,
      status: 'TODO', dueHorizon: 'WEEK',
    }),
    // Writing (2 tasks, 1 completed)
    makeTask('ielts-write-1', 'Writing Task 2 — Remote Work', {
      projectId: IELTS_WRITING_PROJECT_ID, goalId: IELTS_GOAL_ID, goalProcessId: IELTS_PROC_WRITING,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 18, 10, 0), dueHorizon: 'WEEK',
    }),
    makeTask('ielts-write-2', 'Writing Task 1 — Bar Chart Practice', {
      projectId: IELTS_WRITING_PROJECT_ID, goalId: IELTS_GOAL_ID, goalProcessId: IELTS_PROC_WRITING,
      status: 'TODO', dueHorizon: 'WEEK',
    }),
    // English Study duration tasks (3 blocks: Mon 1h done, Wed 1.5h done, Sat 1h not done)
    makeTask('ielts-study-1', 'English grammar + vocabulary', {
      projectId: IELTS_PROJECT_ID, goalId: IELTS_GOAL_ID, goalProcessId: IELTS_PROC_STUDY,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 17, 21, 0), dueHorizon: 'WEEK', estimatedMinutes: 60,
    }),
    makeTask('ielts-study-2', 'IELTS Writing analysis', {
      projectId: IELTS_PROJECT_ID, goalId: IELTS_GOAL_ID, goalProcessId: IELTS_PROC_STUDY,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 19, 21, 30), dueHorizon: 'WEEK', estimatedMinutes: 90,
    }),
    makeTask('ielts-study-3', 'IELTS review', {
      projectId: IELTS_PROJECT_ID, goalId: IELTS_GOAL_ID, goalProcessId: IELTS_PROC_STUDY,
      status: 'TODO', dueHorizon: 'WEEK', estimatedMinutes: 60,
    }),
    // Unscheduled WEEK task — no calendar, no process credit
    makeTask('ielts-vocab', 'Review 20 speaking vocabulary phrases', {
      projectId: IELTS_PROJECT_ID, goalId: IELTS_GOAL_ID,
      status: 'TODO', dueHorizon: 'WEEK',
    }),
  ];

  // Calendar blocks for English Study
  const ieltsBlocks = [
    makeBlock('ielts-blk-1', 'ielts-study-1', vn(2026, 8, 17, 20, 0), vn(2026, 8, 17, 21, 0), 'English grammar + vocabulary', 'PLANNED'),
    makeBlock('ielts-blk-2', 'ielts-study-2', vn(2026, 8, 19, 20, 0), vn(2026, 8, 19, 21, 30), 'IELTS Writing analysis', 'PLANNED'),
    makeBlock('ielts-blk-3', 'ielts-study-3', vn(2026, 8, 22, 9, 0), vn(2026, 8, 22, 10, 0), 'IELTS review', 'PLANNED'),
  ];

  // ── IELTS Historical Tasks (6 previous weeks) ──
  // Pattern: weeks -7 to -2 relative to current week
  // -7: met, -6: met, -5: met, -4: missed, -3: met, -2: met, -1: met
  // Consistency lookback is 8 weeks (indices 0–7 = weeks -7 to current)

  for (let w = -7; w <= -1; w++) {
    const wStart = weekMonday(w);
    const missed = w === -4;
    const suffix = `w${w}`;

    // Speaking: 3/week target. If missed week, only 1 completed.
    const speakCount = missed ? 1 : 3;
    for (let i = 0; i < speakCount; i++) {
      const completedMs = wStart + i * 2 * 86_400_000 + 19 * H;
      ieltsTasks.push(makeTask(`ielts-hist-speak-${suffix}-${i}`, `Speaking practice ${suffix}#${i + 1}`, {
        projectId: IELTS_PROJECT_ID, goalId: IELTS_GOAL_ID, goalProcessId: IELTS_PROC_SPEAKING,
        status: 'DONE', completedAtEpochMs: completedMs, dueHorizon: 'WEEK',
      }));
    }

    const writeCount = missed ? 0 : 2;
    for (let i = 0; i < writeCount; i++) {
      const completedMs = wStart + i * 3 * 86_400_000 + 20 * H;
      ieltsTasks.push(makeTask(`ielts-hist-write-${suffix}-${i}`, `Writing practice ${suffix}#${i + 1}`, {
        projectId: IELTS_WRITING_PROJECT_ID, goalId: IELTS_GOAL_ID, goalProcessId: IELTS_PROC_WRITING,
        status: 'DONE', completedAtEpochMs: completedMs, dueHorizon: 'WEEK',
      }));
    }

    const studyCount = missed ? 1 : 3;
    for (let i = 0; i < studyCount; i++) {
      const startMs = wStart + i * 2 * 86_400_000 + 20 * H;
      const endMs = startMs + H;
      const completedMs = endMs;
      const taskSuffix = `ielts-hist-study-${suffix}-${i}`;
      ieltsTasks.push(makeTask(taskSuffix, `English study ${suffix}#${i + 1}`, {
        projectId: IELTS_PROJECT_ID, goalId: IELTS_GOAL_ID, goalProcessId: IELTS_PROC_STUDY,
        status: 'DONE', completedAtEpochMs: completedMs, dueHorizon: 'WEEK', estimatedMinutes: 60,
      }));
      ieltsBlocks.push(makeBlock(`ielts-hist-blk-${suffix}-${i}`, taskSuffix, startMs, endMs, `English study ${suffix}#${i + 1}`));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GOAL 2: Get a Backend Developer Job
  // ══════════════════════════════════════════════════════════════════════════

  const beProcesses = [
    { id: BE_PROC_APPS, name: 'Quality Applications', measurementType: 'COUNT', targetValue: 5, period: 'WEEK', active: true },
    { id: BE_PROC_TECH, name: 'Technical Preparation', measurementType: 'DURATION', targetValue: 3, unit: 'h', period: 'WEEK', active: true },
    { id: BE_PROC_MOCK, name: 'Mock Interview', measurementType: 'COUNT', targetValue: 1, period: 'WEEK', active: true },
  ];

  const beMilestones = [
    { id: sid('ms-be-1'), title: 'CV / profile ready', status: 'DONE' },
    { id: sid('ms-be-2'), title: 'Application pipeline started', status: 'DONE' },
    { id: sid('ms-be-3'), title: 'Interview pipeline', status: 'ACTIVE' },
    { id: sid('ms-be-4'), title: 'Technical readiness proven', status: 'PENDING' },
    { id: sid('ms-be-5'), title: 'Receive suitable offer', status: 'PENDING' },
  ];

  const beObservations = [
    { id: sid('obs-be-1'), observedAt: '2026-07-01T00:00:00Z', value: 0, label: 'July — 0 offers' },
    { id: sid('obs-be-2'), observedAt: '2026-08-10T00:00:00Z', value: 0, label: 'August — 0 offers, 2 active interviews' },
  ];

  const backendGoal = {
    id: BACKEND_GOAL_ID,
    title: 'Get a Backend Developer Job',
    lifeArea: 'CAREER',
    seasonId: null,
    description: '',
    horizon: 'YEAR',
    status: 'ACTIVE',
    targetDate: '2026-11-30',
    parentId: null,
    successCriteria: '',
    capacityShare: null,
    outcome: 'Receive at least one suitable Backend Developer offer.',
    why: 'Build stable income, career capital and stronger professional opportunities.',
    metric: 'Suitable job offers',
    focusType: 'FOCUS',
    currentMilestoneId: sid('ms-be-3'),
    milestonesJson: JSON.stringify(beMilestones),
    systemsJson: JSON.stringify([
      { id: sid('sys-be-1'), description: '5 quality applications/week' },
      { id: sid('sys-be-2'), description: '3h technical preparation/week' },
      { id: sid('sys-be-3'), description: '1 mock interview/week' },
    ]),
    outcomeStatus: 'ACTIVE',
    achievedAt: null,
    closedAt: null,
    processesJson: JSON.stringify(beProcesses),
    metricObservationsJson: JSON.stringify(beObservations),
    reflectionJson: '{}',
    reviewSnapshotJson: '{}',
    revision: 1,
    updatedAt: now,
    deletedAt: null,
  };

  // ── Backend Projects ──

  const beProjects = [
    {
      id: BE_APPS_PROJECT_ID,
      title: 'Job Applications',
      goalId: BACKEND_GOAL_ID,
      defaultGoalProcessId: BE_PROC_APPS,
      color: '#EF4444',
      lifeArea: 'CAREER',
      description: 'Active job application pipeline',
      targetDate: '2026-11-30',
      active: true,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: BE_INTERVIEW_PROJECT_ID,
      title: 'Backend Interview Preparation',
      goalId: BACKEND_GOAL_ID,
      defaultGoalProcessId: BE_PROC_TECH,
      color: '#F59E0B',
      lifeArea: 'CAREER',
      description: 'Technical preparation for backend interviews',
      targetDate: '2026-11-30',
      active: true,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: BE_CV_PROJECT_ID,
      title: 'Portfolio / CV Polish',
      goalId: BACKEND_GOAL_ID,
      defaultGoalProcessId: null,
      color: '#10B981',
      lifeArea: 'CAREER',
      description: 'CV and portfolio maintenance',
      targetDate: null,
      active: true,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    },
  ];

  // ── Backend Current-week Tasks ──

  const beTasks: ReturnType<typeof makeTask>[] = [
    // 5 application tasks (4 completed, 1 open)
    makeTask('be-app-1', 'Apply — Anfin Backend Engineer', {
      projectId: BE_APPS_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_APPS,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 17, 10, 0), dueHorizon: 'WEEK',
    }),
    makeTask('be-app-2', 'Apply — Fintech Backend Engineer', {
      projectId: BE_APPS_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_APPS,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 17, 11, 0), dueHorizon: 'WEEK',
    }),
    makeTask('be-app-3', 'Apply — Golang Backend Developer', {
      projectId: BE_APPS_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_APPS,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 18, 9, 0), dueHorizon: 'WEEK',
    }),
    makeTask('be-app-4', 'Apply — Platform Backend Engineer', {
      projectId: BE_APPS_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_APPS,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 18, 10, 0), dueHorizon: 'WEEK',
    }),
    makeTask('be-app-5', 'Apply — SaaS Backend Engineer', {
      projectId: BE_APPS_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_APPS,
      status: 'TODO', dueHorizon: 'WEEK',
    }),
    // Technical preparation (2 completed blocks + 1 not-completed)
    makeTask('be-tech-1', 'Review SQL indexing', {
      projectId: BE_INTERVIEW_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_TECH,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 17, 20, 30), dueHorizon: 'WEEK', estimatedMinutes: 90,
    }),
    makeTask('be-tech-2', 'Backend system design practice', {
      projectId: BE_INTERVIEW_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_TECH,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 19, 20, 30), dueHorizon: 'WEEK', estimatedMinutes: 90,
    }),
    makeTask('be-tech-3', 'Review transactions and isolation', {
      projectId: BE_INTERVIEW_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_TECH,
      status: 'TODO', dueHorizon: 'WEEK', estimatedMinutes: 60,
    }),
    // Mock interview (1 completed)
    makeTask('be-mock-1', 'Mock Backend Interview', {
      projectId: BE_INTERVIEW_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_MOCK,
      status: 'DONE', completedAtEpochMs: vn(2026, 8, 18, 15, 0), dueHorizon: 'WEEK',
    }),
    // Unscheduled WEEK task — no false credit
    makeTask('be-research', 'Research 3 target companies', {
      projectId: BE_APPS_PROJECT_ID, goalId: BACKEND_GOAL_ID,
      status: 'TODO', dueHorizon: 'WEEK',
    }),
  ];

  // Calendar blocks for technical preparation
  const beBlocks = [
    makeBlock('be-blk-1', 'be-tech-1', vn(2026, 8, 17, 19, 0), vn(2026, 8, 17, 20, 30), 'Review SQL indexing', 'PLANNED'),
    makeBlock('be-blk-2', 'be-tech-2', vn(2026, 8, 19, 19, 0), vn(2026, 8, 19, 20, 30), 'Backend system design practice', 'PLANNED'),
    makeBlock('be-blk-3', 'be-tech-3', vn(2026, 8, 22, 14, 0), vn(2026, 8, 22, 15, 0), 'Review transactions and isolation', 'PLANNED'),
  ];

  // ── Backend Historical Tasks (8 previous weeks) ──
  // Pattern: weeks -8 to -1, week -5 missed

  for (let w = -8; w <= -1; w++) {
    const wStart = weekMonday(w);
    const missed = w === -5;
    const suffix = `w${w}`;

    // Apps: 5/week, missed: 2
    const appCount = missed ? 2 : 5;
    for (let i = 0; i < appCount; i++) {
      const completedMs = wStart + i * 86_400_000 + 10 * H;
      beTasks.push(makeTask(`be-hist-app-${suffix}-${i}`, `Application ${suffix}#${i + 1}`, {
        projectId: BE_APPS_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_APPS,
        status: 'DONE', completedAtEpochMs: completedMs, dueHorizon: 'WEEK',
      }));
    }

    const techCount = missed ? 1 : 3;
    for (let i = 0; i < techCount; i++) {
      const startMs = wStart + i * 2 * 86_400_000 + 19 * H;
      const endMs = startMs + H;
      const completedMs = endMs;
      const taskSuffix = `be-hist-tech-${suffix}-${i}`;
      beTasks.push(makeTask(taskSuffix, `Tech prep ${suffix}#${i + 1}`, {
        projectId: BE_INTERVIEW_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_TECH,
        status: 'DONE', completedAtEpochMs: completedMs, dueHorizon: 'WEEK', estimatedMinutes: 60,
      }));
      beBlocks.push(makeBlock(`be-hist-blk-${suffix}-${i}`, taskSuffix, startMs, endMs, `Tech prep ${suffix}#${i + 1}`));
    }

    if (!missed) {
      const completedMs = wStart + 4 * 86_400_000 + 14 * H;
      beTasks.push(makeTask(`be-hist-mock-${suffix}`, `Mock interview ${suffix}`, {
        projectId: BE_INTERVIEW_PROJECT_ID, goalId: BACKEND_GOAL_ID, goalProcessId: BE_PROC_MOCK,
        status: 'DONE', completedAtEpochMs: completedMs, dueHorizon: 'WEEK',
      }));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GOAL 3 (optional): CV Refresh — ACHIEVED_LATE for retrospective testing
  // ══════════════════════════════════════════════════════════════════════════

  const cvGoal = {
    id: CV_GOAL_ID,
    title: 'Complete Backend CV Refresh',
    lifeArea: 'CAREER',
    seasonId: null,
    description: '',
    horizon: 'QUARTER',
    status: 'ACHIEVED',
    targetDate: '2026-07-31',
    parentId: null,
    successCriteria: '',
    capacityShare: null,
    outcome: 'Publish a polished, up-to-date Backend Developer CV.',
    why: 'Foundation for job search.',
    metric: 'CV published and reviewed',
    focusType: 'FOCUS',
    currentMilestoneId: null,
    milestonesJson: JSON.stringify([
      { id: sid('ms-cv-1'), title: 'Draft CV', status: 'DONE' },
      { id: sid('ms-cv-2'), title: 'Peer review', status: 'DONE' },
      { id: sid('ms-cv-3'), title: 'Final polish', status: 'DONE' },
    ]),
    systemsJson: '[]',
    outcomeStatus: 'ACHIEVED_LATE',
    achievedAt: '2026-08-03',
    closedAt: '2026-08-03',
    processesJson: '[]',
    metricObservationsJson: '[]',
    reflectionJson: JSON.stringify({
      seriousAttempt: 'YES',
      worked: 'Clear task breakdown.',
      didntWork: 'Underestimated final polish time.',
      outsideControl: null,
      learned: 'Reserve review buffer before deadlines.',
      differently: 'Start peer review earlier.',
      nextAction: 'ARCHIVE',
      reviewedAt: '2026-08-03T10:00:00Z',
    }),
    reviewSnapshotJson: JSON.stringify({
      generatedAt: '2026-08-03T10:00:00Z',
      outcomeStatus: 'ACHIEVED_LATE',
      targetDate: '2026-07-31',
      achievedAt: '2026-08-03',
      processSummary: [],
      consistency: { metWeeks: 0, totalWeeks: 0, threshold: 0.8 },
      milestones: [
        { id: sid('ms-cv-1'), title: 'Draft CV', status: 'DONE' },
        { id: sid('ms-cv-2'), title: 'Peer review', status: 'DONE' },
        { id: sid('ms-cv-3'), title: 'Final polish', status: 'DONE' },
      ],
      latestObservation: null,
    }),
    revision: 1,
    updatedAt: now,
    deletedAt: null,
  };

  // ── Write everything ──

  await upsert(goals, [ieltsGoal, backendGoal, cvGoal]);
  await upsert(projects, [...ieltsProjects, ...beProjects]);

  const allTasks = [...ieltsTasks, ...beTasks];
  const allBlocks = [...ieltsBlocks, ...beBlocks];

  await upsert(tasks, allTasks);
  await upsert(timeBlocks, allBlocks);

  console.log(`Seeded:`);
  console.log(`  Goals:    3 (IELTS 6.5, Backend Job, CV Refresh)`);
  console.log(`  Projects: ${ieltsProjects.length + beProjects.length}`);
  console.log(`  Tasks:    ${allTasks.length}`);
  console.log(`  Blocks:   ${allBlocks.length}`);
  console.log(`  Historical weeks: IELTS 7 + Backend 8`);

  await closeDb();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
