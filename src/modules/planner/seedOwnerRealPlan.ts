/**
 * Idempotent reconciliation of the real owner Goal/Project plan.
 * Resolves user by email at runtime. Never creates a user.
 * Does not create Tasks or TimeBlocks.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../infrastructure/db/client.js';
import { goals, projects, users } from '../../infrastructure/db/schema/index.js';
import { FakeCalendarProvider } from '../../infrastructure/providers/calendar/fakeCalendarProvider.js';
import {
  PlannerV2Service,
  type GoalMilestone,
  type ProjectContext,
  type ProjectType,
} from '../../application/plannerV2Service.js';
import { INITIAL_OWNER_AI_CONTEXT_DEFAULT } from '../ai/ownerAiContextDefault.js';
import { findUserByEmail } from '../identity/plannerOwnership.js';

export const OWNER_REAL_PLAN_EMAIL = 'sonha2002.12@gmail.com';

export function normalizePlanTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

type GoalSpec = {
  key: string;
  title: string;
  aliases: string[];
  focusType: 'FOCUS' | 'MAINTAIN' | 'EXPLORE';
  targetDate: string | null;
  lifeArea: string;
  outcome: string;
  why: string;
  metric: string;
  successCriteria: string;
  milestoneTitles?: string[];
};

type ProjectSpec = {
  key: string;
  title: string;
  aliases: string[];
  goalKey: string | null;
  projectType: ProjectType;
  projectContext: ProjectContext;
  lifeArea: string;
  description: string;
  color: string;
};

const GOAL_SPECS: GoalSpec[] = [
  {
    key: 'job',
    title: 'Obtain a strong Software Engineer / Backend-focused job',
    aliases: [
      'obtain a strong software engineer backend focused job',
      'obtain a backend developer job by 2026 11 01',
      'get a backend developer job',
      'get a backend focused software engineer job',
      'backend job',
      'backend developer job',
    ],
    focusType: 'FOCUS',
    targetDate: '2026-11-01',
    lifeArea: 'CAREER',
    outcome:
      'Obtain and sign at least one suitable Software Engineer / Backend-focused engineering offer by 2026-11-01.',
    why:
      'Primary current career outcome. Backend is the main direction, but compatible generalist Software Engineer roles with meaningful backend scope should not automatically be excluded.',
    metric: 'Signed suitable offers: current 0 / target >= 1',
    successCriteria: 'At least one suitable SWE/Backend offer signed by 2026-11-01.',
    milestoneTitles: [
      'Target role profile and company criteria defined',
      'Candidate profile ready for active applications',
      'Interview-readiness baseline established',
      'Active application/interview pipeline established',
      'Final-round process reached at a suitable company',
      'Suitable offer signed',
    ],
  },
  {
    key: 'ielts',
    title: 'Achieve IELTS 7.0',
    aliases: [
      'achieve ielts 7 0',
      'ielts 7 0',
      'ielts 6 5',
      'achieve ielts 6 5',
    ],
    focusType: 'FOCUS',
    targetDate: '2027-05-31',
    lifeArea: 'LEARNING',
    outcome: 'Achieve IELTS Overall Band 7.0.',
    why:
      'Planning deadline representing Achieve/take IELTS 7.0 within May 2027. Not necessarily the booked exam date — replace with the exact date once booked. Do not split skills into separate Goals.',
    metric: 'IELTS Overall Band — target 7.0 (no invented baseline)',
    successCriteria: 'IELTS Overall Band 7.0',
  },
  {
    key: 'health',
    title: 'Maintain Good Health',
    aliases: ['maintain good health', 'health', 'good health'],
    focusType: 'MAINTAIN',
    targetDate: null,
    lifeArea: 'HEALTH',
    outcome:
      'Maintain sustainable physical health, exercise, sleep discipline, routine and recovery without allowing health to collapse while Focus Goals are active.',
    why:
      'One broad Health Goal. Sleep, gym, running, basketball belong underneath as Habit Projects/Tasks — not separate Goals.',
    metric: 'Health maintained (qualitative + habit adherence over time)',
    successCriteria: 'Health habits stay sustainable alongside Focus work.',
  },
  {
    key: 'learning',
    title: 'Continuous Learning & Intellectual Development',
    aliases: [
      'continuous learning intellectual development',
      'continuous learning',
      'intellectual development',
    ],
    focusType: 'MAINTAIN',
    targetDate: null,
    lifeArea: 'LEARNING',
    outcome:
      'Maintain continuous intellectual and professional development beyond only short-term interview preparation.',
    why:
      'Books, long-form reading, engineering fundamentals, AI/robotics and broader knowledge — not each technology as its own Goal.',
    metric: 'Ongoing reading and professional learning continuity',
    successCriteria: 'Learning continues without competing aggressively with Focus Goals.',
  },
  {
    key: 'finance',
    title: 'Maintain Personal Financial Awareness & Control',
    aliases: [
      'maintain personal financial awareness control',
      'personal finance',
      'financial awareness',
    ],
    focusType: 'MAINTAIN',
    targetDate: null,
    lifeArea: 'FINANCE',
    outcome:
      'Keep personal finances sufficiently recorded, reviewed and understood so spending does not silently drift out of control.',
    why:
      'Awareness and discipline, not arbitrary wealth-maximizing productivity. Income is typically 1–2×/month; spending is more frequent. Future stale threshold: 5 days without expense or finance review activity.',
    metric: 'Finance tracking freshness (future: lastFinanceActivity within 5 days)',
    successCriteria: 'Finances remain visible and reviewable.',
  },
  {
    key: 'explore-edu',
    title: 'Education & Opportunity Exploration',
    aliases: [
      'education opportunity exploration',
      'scholarship',
      'scholarships',
      'education exploration',
    ],
    focusType: 'EXPLORE',
    targetDate: null,
    lifeArea: 'OPPORTUNITY',
    outcome:
      "Continue exploring Master's programs, scholarships, research, overseas opportunities and longer-term education/career possibilities without assuming further study is already the chosen primary path.",
    why:
      'Lower priority than FOCUS and MAINTAIN. Do not convert into Get a Master\'s / Win a scholarship unless the user commits to a concrete opportunity.',
    metric: 'Occasional exploration without aggressive quota',
    successCriteria: 'Opportunities stay visible without forcing commitment.',
  },
];

const PROJECT_SPECS: ProjectSpec[] = [
  {
    key: 'job-interview',
    title: 'Backend Interview Preparation',
    aliases: ['backend interview preparation', 'interview preparation', 'backend interview prep'],
    goalKey: 'job',
    projectType: 'STANDARD',
    projectContext: 'PERSONAL',
    lifeArea: 'CAREER',
    color: '#4f46e5',
    description:
      'Reach the technical level required for targeted backend/SWE interviews (DSA, databases, backend architecture, systems/system design, engineering fundamentals). Not separate Goals.',
  },
  {
    key: 'job-profile',
    title: 'Candidate Profile Positioning',
    aliases: ['candidate profile positioning', 'portfolio cv polish', 'cv polish', 'backend cv'],
    goalKey: 'job',
    projectType: 'STANDARD',
    projectContext: 'PERSONAL',
    lifeArea: 'CAREER',
    color: '#6366f1',
    description:
      'Produce and refine a coherent candidate package (SWE/backend CV, LinkedIn, experience narratives, portfolio/GitHub). Not a blocking prerequisite before applying — profile improvement and market feedback can run in parallel.',
  },
  {
    key: 'job-pipeline',
    title: 'Targeted Job Search & Interview Pipeline',
    aliases: [
      'targeted job search interview pipeline',
      'job search application pipeline',
      'job applications',
      'job search',
      'interview pipeline',
    ],
    goalKey: 'job',
    projectType: 'STANDARD',
    projectContext: 'PERSONAL',
    lifeArea: 'CAREER',
    color: '#4338ca',
    description:
      'Identify suitable roles, submit quality applications, outreach/referrals, track responses, and move opportunities through interviews toward an accepted offer.',
  },
  {
    key: 'ielts-writing',
    title: 'IELTS Writing Improvement',
    aliases: ['ielts writing improvement', 'ielts writing'],
    goalKey: 'ielts',
    projectType: 'STANDARD',
    projectContext: 'PERSONAL',
    lifeArea: 'LEARNING',
    color: '#0f766e',
    description: 'Improve IELTS Writing performance sufficiently for the overall 7.0 target.',
  },
  {
    key: 'ielts-speaking',
    title: 'IELTS Speaking Improvement',
    aliases: ['ielts speaking improvement', 'ielts speaking'],
    goalKey: 'ielts',
    projectType: 'STANDARD',
    projectContext: 'PERSONAL',
    lifeArea: 'LEARNING',
    color: '#0d9488',
    description: 'Improve IELTS Speaking performance sufficiently for the overall 7.0 target.',
  },
  {
    key: 'ielts-exam',
    title: 'IELTS Exam Preparation & Registration',
    aliases: [
      'ielts exam preparation registration',
      'ielts preparation',
      'ielts exam prep',
    ],
    goalKey: 'ielts',
    projectType: 'STANDARD',
    projectContext: 'PERSONAL',
    lifeArea: 'LEARNING',
    color: '#14b8a6',
    description:
      'Integrated IELTS exam preparation, mock/exam readiness, Listening and Reading as needed, and exam registration/logistics. Listening/Reading do not need separate Projects initially.',
  },
  {
    key: 'health-exercise',
    title: 'Exercise & Movement',
    aliases: ['exercise movement', 'exercise', 'gym'],
    goalKey: 'health',
    projectType: 'HABIT',
    projectContext: 'PERSONAL',
    lifeArea: 'HEALTH',
    color: '#059669',
    description:
      'Maintain regular physical activity. Initial intended target: 3 exercise/movement sessions per week (gym, running, basketball, etc. under one Habit). Do not create separate sport Projects initially. No repeat Tasks in this seed batch.',
  },
  {
    key: 'health-sleep',
    title: 'Sleep Routine',
    aliases: ['sleep routine', 'sleep'],
    goalKey: 'health',
    projectType: 'HABIT',
    projectContext: 'PERSONAL',
    lifeArea: 'HEALTH',
    color: '#0284c7',
    description:
      'Build and maintain disciplined sleep/wake timing.\n\nCurrent operational target (judge against this now):\n- Bedtime 22:30\n- Wake 06:00\n\nOfficial long-term target:\n- Bedtime 22:00\n- Wake 05:00\n\nFuture sleep tracking should separately measure bedtime lateness, wake lateness, and combined discipline trends using Session/checkpoint timestamps. No sleep Calendar checkpoints in this seed batch.',
  },
  {
    key: 'learning-reading',
    title: 'Reading',
    aliases: ['reading'],
    goalKey: 'learning',
    projectType: 'HABIT',
    projectContext: 'PERSONAL',
    lifeArea: 'LEARNING',
    color: '#7c3aed',
    description:
      'Maintain regular book / long-form reading and broader intellectual development. No strict quota yet. No separate News Project for now.',
  },
  {
    key: 'learning-pro',
    title: 'Professional Learning',
    aliases: ['professional learning', 'technical learning'],
    goalKey: 'learning',
    projectType: 'HABIT',
    projectContext: 'PERSONAL',
    lifeArea: 'LEARNING',
    color: '#8b5cf6',
    description:
      'Long-term professional/technical learning beyond immediate interview prep (software engineering, databases, systems, AI, robotics, engineering knowledge). No strict weekly quota yet.',
  },
  {
    key: 'finance-review',
    title: 'Financial Tracking & Review',
    aliases: ['financial tracking review', 'financial review', 'finance tracking'],
    goalKey: 'finance',
    projectType: 'HABIT',
    projectContext: 'PERSONAL',
    lifeArea: 'FINANCE',
    color: '#ca8a04',
    description:
      'Maintain sufficient visibility into income, spending, allocation and financial behavior.\n\nIncome is typically recorded 1–2×/month; spending is more frequent. Do not require daily income entries.\n\nFuture freshness heuristic (not implemented in this seed):\nlastFinanceActivity = max(lastExpenseRecordedAt, lastFinanceReviewAt)\nIf older than 5 days → surface "Finance tracking may be stale — check Finance." (reminder heuristic, not proof of forgotten spending).',
  },
  {
    key: 'explore-opp',
    title: 'Opportunity Exploration',
    aliases: ['opportunity exploration', 'scholarship research'],
    goalKey: 'explore-edu',
    projectType: 'HABIT',
    projectContext: 'PERSONAL',
    lifeArea: 'OPPORTUNITY',
    color: '#64748b',
    description:
      "Occasionally investigate Master's opportunities, scholarships, research, and overseas study/career opportunities. HABIT for ongoing scanning — not an aggressive recurring schedule. No Task recurrence or weekly quota in this seed.",
  },
  {
    key: 'work-rover',
    title: 'Landfill Rover',
    aliases: ['landfill rover', 'rover'],
    goalKey: null,
    projectType: 'STANDARD',
    projectContext: 'WORK',
    lifeArea: 'WORK',
    color: '#c2410c',
    description:
      'Current employment Work Project (not a personal Goal). Weekly deliverables are Work Tasks. Prefer scheduling during Mon–Fri 10:00–18:00. Do not invent personal Goals from Rover work.',
  },
  {
    key: 'work-drone',
    title: 'Drone / Remote ID',
    aliases: ['drone remote id', 'dronetag remote id', 'drone', 'remote id'],
    goalKey: null,
    projectType: 'STANDARD',
    projectContext: 'WORK',
    lifeArea: 'WORK',
    color: '#ea580c',
    description:
      'Current employment Work Project (not a personal Goal). Prefer Mon–Fri 10:00–18:00. Ordinary Drone work must not automatically consume personal Focus/Health/development time.',
  },
  {
    key: 'pos-review',
    title: 'Personal OS Review & Planning',
    aliases: ['personal os review planning', 'personal os review', 'weekly review'],
    goalKey: null,
    projectType: 'HABIT',
    projectContext: 'PERSONAL',
    lifeArea: 'LIFE',
    color: '#334155',
    description:
      'Keystone Habit for lightweight Daily and Weekly reviews, especially on low-energy days. Consistency > difficulty.\n\nFuture Tasks (NOT created in this seed):\n- Daily Review & Tomorrow Prep — normal 15–20 min; minimum viable 1–5 min\n- Weekly Review & Next Week Prep — normal 30–60 min; minimum viable ~10 min',
  },
];

/** Demo/test titles to soft-archive when not reused by the real plan. */
const DEMO_GOAL_ARCHIVE_TITLES = [
  'move to a quieter apartment',
  'complete backend cv refresh',
];

export type SeedOwnerRealPlanReport = {
  ownerEmail: string;
  userId: string;
  before: {
    goals: Array<{ id: string; title: string; focusType: string; status: string; deleted: boolean }>;
    projects: Array<{
      id: string;
      title: string;
      goalId: string | null;
      projectType: string;
      active: boolean;
      deleted: boolean;
    }>;
    aiContextLen: number;
  };
  reusedGoals: string[];
  createdGoals: string[];
  archivedGoals: Array<{ id: string; title: string; reason: string }>;
  leftUntouched: Array<{ id: string; title: string; reason: string }>;
  reusedProjects: string[];
  createdProjects: string[];
  archivedProjects: Array<{ id: string; title: string; reason: string }>;
  goalsFinal: Array<{ id: string; title: string; focusType: string; targetDate: string | null }>;
  projectsFinal: Array<{
    id: string;
    title: string;
    goalTitle: string | null;
    projectType: string;
    projectContext: string;
  }>;
  aiContextUpdated: boolean;
  taskCountDelta: number;
  timeBlockCountDelta: number;
};

function matchSpecByTitle<T extends { key: string; title: string; aliases: string[] }>(
  specs: T[],
  title: string,
): T | null {
  const n = normalizePlanTitle(title);
  for (const spec of specs) {
    if (normalizePlanTitle(spec.title) === n) return spec;
    if (spec.aliases.some((a) => normalizePlanTitle(a) === n)) return spec;
  }
  return null;
}

function milestonesFor(spec: GoalSpec, existing?: GoalMilestone[]): GoalMilestone[] {
  const titles = spec.milestoneTitles ?? [];
  if (titles.length === 0) return [];
  const byTitle = new Map(
    (existing ?? []).map((m) => [normalizePlanTitle(m.title), m]),
  );
  return titles.map((title, index) => {
    const prev = byTitle.get(normalizePlanTitle(title));
    return {
      id: prev?.id ?? randomUUID(),
      title,
      status: prev?.status === 'done' || prev?.status === 'current'
        ? prev.status
        : index === 0
          ? 'current'
          : 'pending',
    };
  });
}

export async function seedOwnerRealPlan(
  db: Db,
  ownerEmail: string = OWNER_REAL_PLAN_EMAIL,
): Promise<SeedOwnerRealPlanReport> {
  const email = ownerEmail.trim().toLowerCase();
  if (email !== OWNER_REAL_PLAN_EMAIL) {
    throw new Error(
      `Refusing to seed: expected ${OWNER_REAL_PLAN_EMAIL}, got ${ownerEmail}`,
    );
  }

  const user = await findUserByEmail(db, email);
  if (!user) {
    throw Object.assign(new Error(`User not found: ${email}. STOP — will not create an account.`), {
      code: 'OWNER_NOT_FOUND',
    });
  }

  const planner = new PlannerV2Service(db, async () => new FakeCalendarProvider());

  const existingGoals = await db.select().from(goals).where(eq(goals.userId, user.id));
  const existingProjects = await db.select().from(projects).where(eq(projects.userId, user.id));

  const before = {
    goals: existingGoals.map((g) => ({
      id: g.id,
      title: g.title,
      focusType: g.focusType,
      status: g.status,
      deleted: Boolean(g.deletedAt),
    })),
    projects: existingProjects.map((p) => ({
      id: p.id,
      title: p.title,
      goalId: p.goalId,
      projectType: p.projectType,
      active: p.active,
      deleted: Boolean(p.deletedAt),
    })),
    aiContextLen: user.aiContext?.length ?? 0,
  };

  const liveGoals = existingGoals.filter((g) => !g.deletedAt);
  const liveProjects = existingProjects.filter((p) => !p.deletedAt);

  const goalIdByKey = new Map<string, string>();
  const reusedGoals: string[] = [];
  const createdGoals: string[] = [];
  const archivedGoals: Array<{ id: string; title: string; reason: string }> = [];
  const leftUntouched: Array<{ id: string; title: string; reason: string }> = [];
  const claimedGoalIds = new Set<string>();

  for (const spec of GOAL_SPECS) {
    const match = liveGoals.find((g) => {
      if (claimedGoalIds.has(g.id)) return false;
      return Boolean(matchSpecByTitle([spec], g.title));
    });
    if (match) {
      claimedGoalIds.add(match.id);
      goalIdByKey.set(spec.key, match.id);
      const existingMilestones = (() => {
        try {
          return JSON.parse(match.milestonesJson || '[]') as GoalMilestone[];
        } catch {
          return [];
        }
      })();
      const milestones = milestonesFor(spec, existingMilestones);
      await planner.patchGoal(user.id, match.id, {
        title: spec.title,
        focusType: spec.focusType,
        targetDate: spec.targetDate,
        lifeArea: spec.lifeArea,
        outcome: spec.outcome,
        why: spec.why,
        metric: spec.metric,
        successCriteria: spec.successCriteria,
        status: 'ACTIVE',
        outcomeStatus: 'ACTIVE',
        milestones,
        currentMilestoneId: milestones.find((m) => m.status === 'current')?.id ?? milestones[0]?.id ?? null,
      });
      reusedGoals.push(spec.title);
    } else {
      const milestones = milestonesFor(spec);
      const created = await planner.createGoal(user.id, {
        title: spec.title,
        focusType: spec.focusType,
        targetDate: spec.targetDate,
        lifeArea: spec.lifeArea,
        outcome: spec.outcome,
        why: spec.why,
        metric: spec.metric,
        successCriteria: spec.successCriteria,
        milestones,
        currentMilestoneId: milestones.find((m) => m.status === 'current')?.id ?? milestones[0]?.id ?? null,
      });
      goalIdByKey.set(spec.key, created.id);
      createdGoals.push(spec.title);
    }
  }

  for (const g of liveGoals) {
    if (claimedGoalIds.has(g.id)) continue;
    const n = normalizePlanTitle(g.title);
    if (g.id.startsWith('v2demo-') || DEMO_GOAL_ARCHIVE_TITLES.includes(n)) {
      await planner.deleteGoal(user.id, g.id);
      archivedGoals.push({ id: g.id, title: g.title, reason: 'demo/test Goal superseded by real plan' });
      continue;
    }
    if (g.status === 'ARCHIVED' || g.outcomeStatus !== 'ACTIVE') {
      leftUntouched.push({ id: g.id, title: g.title, reason: 'inactive/archived — left untouched' });
      continue;
    }
    leftUntouched.push({
      id: g.id,
      title: g.title,
      reason: 'ambiguous active Goal — not archived automatically',
    });
  }

  const reusedProjects: string[] = [];
  const createdProjects: string[] = [];
  const archivedProjects: Array<{ id: string; title: string; reason: string }> = [];
  const claimedProjectIds = new Set<string>();

  for (const spec of PROJECT_SPECS) {
    const match = liveProjects.find((p) => {
      if (claimedProjectIds.has(p.id)) return false;
      return Boolean(matchSpecByTitle([spec], p.title));
    });
    const goalId = spec.goalKey ? goalIdByKey.get(spec.goalKey) ?? null : null;
    if (match) {
      claimedProjectIds.add(match.id);
      await planner.patchProject(user.id, match.id, {
        title: spec.title,
        goalId,
        projectType: spec.projectType,
        projectContext: spec.projectContext,
        lifeArea: spec.lifeArea,
        description: spec.description,
        color: spec.color,
        active: true,
      });
      reusedProjects.push(spec.title);
    } else {
      await planner.createProject(user.id, {
        title: spec.title,
        goalId,
        projectType: spec.projectType,
        projectContext: spec.projectContext,
        lifeArea: spec.lifeArea,
        description: spec.description,
        color: spec.color,
        active: true,
      });
      createdProjects.push(spec.title);
    }
  }

  for (const p of liveProjects) {
    if (claimedProjectIds.has(p.id)) continue;
    if (p.id.startsWith('v2demo-')) {
      await planner.deleteProject(user.id, p.id);
      archivedProjects.push({ id: p.id, title: p.title, reason: 'demo/test Project superseded by real plan' });
      continue;
    }
    // Older demo project titles under superseded goals — soft-archive if clearly demo-named
    const n = normalizePlanTitle(p.title);
    if (
      n === 'scholarship research'
      || n.includes('v2 demo')
    ) {
      await planner.deleteProject(user.id, p.id);
      archivedProjects.push({ id: p.id, title: p.title, reason: 'demo Project superseded' });
      continue;
    }
    leftUntouched.push({
      id: p.id,
      title: p.title,
      reason: 'ambiguous Project — not archived automatically',
    });
  }

  await db
    .update(users)
    .set({ aiContext: INITIAL_OWNER_AI_CONTEXT_DEFAULT, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  const goalsFinalRows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, user.id), isNull(goals.deletedAt), eq(goals.status, 'ACTIVE')));
  const projectsFinalRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, user.id), isNull(projects.deletedAt), eq(projects.active, true)));

  const goalTitleById = new Map(goalsFinalRows.map((g) => [g.id, g.title]));

  return {
    ownerEmail: user.email,
    userId: user.id,
    before,
    reusedGoals,
    createdGoals,
    archivedGoals,
    leftUntouched,
    reusedProjects,
    createdProjects,
    archivedProjects,
    goalsFinal: goalsFinalRows.map((g) => ({
      id: g.id,
      title: g.title,
      focusType: g.focusType,
      targetDate: g.targetDate,
    })),
    projectsFinal: projectsFinalRows.map((p) => ({
      id: p.id,
      title: p.title,
      goalTitle: p.goalId ? goalTitleById.get(p.goalId) ?? null : null,
      projectType: p.projectType,
      projectContext: p.projectContext,
    })),
    aiContextUpdated: true,
    taskCountDelta: 0,
    timeBlockCountDelta: 0,
  };
}

export const OWNER_REAL_PLAN_GOAL_SPECS = GOAL_SPECS;
export const OWNER_REAL_PLAN_PROJECT_SPECS = PROJECT_SPECS;
