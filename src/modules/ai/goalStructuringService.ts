import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import { goals, projects } from '../../infrastructure/db/schema/index.js';
import type { LlmProvider } from '../../infrastructure/providers/llm/types.js';
import type { IdentityService } from '../identity/identityService.js';
import {
  parseGoalProcesses,
  type PlannerV2Service,
} from '../../application/plannerV2Service.js';
import {
  GOAL_STRUCTURE_JSON_PROMPT,
  goalStructureSuggestionSchema,
  type GoalStructureSuggestion,
} from './goalStructureSchema.js';
import { INITIAL_OWNER_AI_CONTEXT_DEFAULT } from './ownerAiContextDefault.js';

const MAX_TITLE = 240;
const MAX_WHY = 4_000;
const RATE_LIMIT_MS = 15_000;
const AI_TIMEOUT_MS = 45_000;

const lastRequestAt = new Map<string, number>();

export type PlannerAiSnapshot = {
  activeGoals: Array<{ title: string; focusType: string | null }>;
  activeProjects: Array<{ title: string; goalTitle: string | null }>;
  processes: Array<{ name: string; targetValue: number; period: string; unit?: string }>;
};

export type GoalStructureRequest = {
  title: string;
  description?: string;
  why?: string;
  targetDate?: string | null;
};

export class GoalStructuringService {
  constructor(
    private readonly db: Db,
    private readonly identity: IdentityService,
    private readonly planner: PlannerV2Service,
    private readonly llm: LlmProvider,
  ) {}

  async getAiContext(userId: string): Promise<{ aiContext: string; isDefaultSeed: boolean }> {
    const user = await this.identity.getUserById(userId);
    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }
    const stored = await this.identity.getAiContext(userId);
    if (stored != null && stored.trim()) {
      return { aiContext: stored, isDefaultSeed: false };
    }
    if (this.identity.isLegacyCalendarOwner(user.email)) {
      return { aiContext: INITIAL_OWNER_AI_CONTEXT_DEFAULT, isDefaultSeed: true };
    }
    return { aiContext: '', isDefaultSeed: false };
  }

  async setAiContext(userId: string, aiContext: string): Promise<{ aiContext: string }> {
    const trimmed = aiContext.slice(0, 20_000);
    await this.identity.setAiContext(userId, trimmed);
    return { aiContext: trimmed };
  }

  async resetAiContext(userId: string): Promise<{ aiContext: string }> {
    const user = await this.identity.getUserById(userId);
    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }
    if (this.identity.isLegacyCalendarOwner(user.email)) {
      await this.identity.setAiContext(userId, INITIAL_OWNER_AI_CONTEXT_DEFAULT);
      return { aiContext: INITIAL_OWNER_AI_CONTEXT_DEFAULT };
    }
    await this.identity.setAiContext(userId, '');
    return { aiContext: '' };
  }

  async buildPlannerSnapshot(userId: string): Promise<PlannerAiSnapshot> {
    const goalRows = await this.db
      .select()
      .from(goals)
      .where(and(eq(goals.userId, userId), isNull(goals.deletedAt)));
    const activeGoals = goalRows
      .filter((g) => g.status === 'ACTIVE')
      .slice(0, 12)
      .map((g) => ({
        title: g.title,
        focusType: g.focusType,
      }));

    const projectRows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), isNull(projects.deletedAt)));
    const goalTitleById = new Map(goalRows.map((g) => [g.id, g.title]));
    const activeProjects = projectRows
      .filter((p) => p.active)
      .slice(0, 20)
      .map((p) => ({
        title: p.title,
        goalTitle: p.goalId ? (goalTitleById.get(p.goalId) ?? null) : null,
      }));

    const processMap = new Map<string, PlannerAiSnapshot['processes'][number]>();
    for (const g of goalRows.filter((row) => row.status === 'ACTIVE')) {
      for (const proc of parseGoalProcesses(g.processesJson)) {
        if (!proc.active) continue;
        const key = `${proc.name}|${proc.period}|${proc.targetValue}`;
        if (!processMap.has(key)) {
          processMap.set(key, {
            name: proc.name,
            targetValue: proc.targetValue,
            period: proc.period,
            unit: proc.unit,
          });
        }
      }
    }

    return {
      activeGoals,
      activeProjects,
      processes: [...processMap.values()].slice(0, 20),
    };
  }

  async suggest(userId: string, input: GoalStructureRequest): Promise<GoalStructureSuggestion> {
    const title = input.title.trim().slice(0, MAX_TITLE);
    if (!title) {
      throw Object.assign(new Error('Goal title is required'), {
        statusCode: 400,
        code: 'INVALID_INPUT',
      });
    }

    const now = Date.now();
    const last = lastRequestAt.get(userId) ?? 0;
    if (now - last < RATE_LIMIT_MS) {
      throw Object.assign(new Error('Please wait a moment before requesting another suggestion'), {
        statusCode: 429,
        code: 'RATE_LIMITED',
      });
    }
    lastRequestAt.set(userId, now);

    if (!this.llm.structureGoal) {
      throw Object.assign(new Error('AI suggestions are unavailable right now. You can continue manually.'), {
        statusCode: 503,
        code: 'AI_UNAVAILABLE',
      });
    }

    const { aiContext } = await this.getAiContext(userId);
    const snapshot = await this.buildPlannerSnapshot(userId);
    const prompt = this.composePrompt({
      title,
      description: input.description?.slice(0, MAX_WHY),
      why: input.why?.slice(0, MAX_WHY),
      targetDate: input.targetDate ?? null,
      aiContext,
      snapshot,
    });

    let raw: unknown;
    try {
      raw = await Promise.race([
        this.llm.structureGoal(prompt),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(Object.assign(new Error('AI suggestions timed out. You can continue manually.'), {
              statusCode: 504,
              code: 'AI_TIMEOUT',
            }));
          }, AI_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      if (e.statusCode && e.code) throw err;
      throw Object.assign(
        new Error('AI suggestions are unavailable right now. You can continue manually.'),
        { statusCode: 503, code: 'AI_UNAVAILABLE' },
      );
    }

    const parsed = goalStructureSuggestionSchema.safeParse(raw);
    if (!parsed.success) {
      throw Object.assign(new Error('AI returned an invalid suggestion. You can continue manually.'), {
        statusCode: 502,
        code: 'AI_INVALID_RESPONSE',
      });
    }
    return parsed.data;
  }

  /**
   * Persist an edited suggestion as Goal + Processes + Projects (+ optional Tasks).
   * Generation never persists — only this path writes planner data.
   */
  async accept(
    userId: string,
    input: {
      title: string;
      why?: string;
      targetDate?: string | null;
      focusType?: 'FOCUS' | 'MAINTAIN' | 'EXPLORE';
      suggestion: GoalStructureSuggestion;
      selectedNextActionIndexes?: number[];
    },
  ) {
    const suggestion = goalStructureSuggestionSchema.parse(input.suggestion);
    const outcome =
      suggestion.outcome?.statement?.trim()
      || input.title.trim();
    const metricText = formatPrimaryMetric(suggestion);
    const milestoneIds = suggestion.milestones.map(() => randomUUID());
    const milestones = suggestion.milestones.map((m, index) => ({
      id: milestoneIds[index]!,
      title: m.title,
      status: (index === 0 ? 'current' : 'pending') as 'pending' | 'current' | 'done',
    }));
    const processIds = suggestion.processes.map(() => randomUUID());
    const processes = suggestion.processes.map((p, index) => ({
      id: processIds[index]!,
      name: p.name,
      measurementType: p.metricType,
      targetValue: p.targetValue,
      unit: p.unit,
      period: 'WEEK' as const,
      active: true,
    }));
    const processIdByName = new Map(processes.map((p) => [p.name.trim().toLowerCase(), p.id]));
    const systems = [
      ...processes.map((p) => ({
        id: randomUUID(),
        title: p.name,
        cadence: formatProcessCadence(p),
      })),
      ...(suggestion.timeProtectedMinutesPerWeek
        ? [{
            id: randomUUID(),
            title: 'Time protected',
            cadence: `${Math.round(suggestion.timeProtectedMinutesPerWeek / 60)}h / week`,
          }]
        : []),
    ];

    const goal = await this.planner.createGoal(userId, {
      title: outcome.slice(0, MAX_TITLE),
      outcome: outcome.slice(0, 10_000),
      why: (input.why ?? '').slice(0, 10_000),
      metric: metricText.slice(0, 10_000),
      targetDate: input.targetDate ?? null,
      focusType: input.focusType ?? 'FOCUS',
      milestones,
      systems,
      processes,
      currentMilestoneId: milestones[0]?.id ?? null,
    });

    const createdProjects = [];
    for (const project of suggestion.projects) {
      const defaultProcessId = project.suggestedDefaultProcessName
        ? processIdByName.get(project.suggestedDefaultProcessName.trim().toLowerCase()) ?? null
        : null;
      const created = await this.planner.createProject(userId, {
        title: project.title,
        description: project.purpose ?? '',
        goalId: goal.id,
        defaultGoalProcessId: defaultProcessId,
        active: true,
      });
      createdProjects.push(created);
    }

    const projectIdByTitle = new Map(
      createdProjects.map((p) => [p.title.trim().toLowerCase(), p.id]),
    );
    const selected = new Set(input.selectedNextActionIndexes ?? []);
    const createdTasks = [];
    for (let i = 0; i < suggestion.nextActions.length; i += 1) {
      if (!selected.has(i)) continue;
      const action = suggestion.nextActions[i]!;
      const projectId = action.projectTitle
        ? projectIdByTitle.get(action.projectTitle.trim().toLowerCase()) ?? null
        : null;
      const task = await this.planner.createTask(userId, {
        title: action.title,
        durationMinutes: action.estimatedMinutes ?? 30,
        projectId,
        goalId: goal.id,
        dueHorizon: 'WEEK',
      });
      createdTasks.push(task);
    }

    return {
      goal,
      projects: createdProjects,
      tasks: createdTasks,
    };
  }

  private composePrompt(opts: {
    title: string;
    description?: string;
    why?: string;
    targetDate: string | null;
    aiContext: string;
    snapshot: PlannerAiSnapshot;
  }): string {
    const plannerLines = [
      'ACTIVE GOALS',
      ...opts.snapshot.activeGoals.map((g) => `- ${g.title}${g.focusType ? ` — ${g.focusType}` : ''}`),
      '',
      'ACTIVE PROJECTS',
      ...opts.snapshot.activeProjects.map((p) => `- ${p.title}${p.goalTitle ? ` (Goal: ${p.goalTitle})` : ''}`),
      '',
      'CURRENT WEEKLY SYSTEMS',
      ...opts.snapshot.processes.map(
        (p) => `- ${p.name} — ${p.targetValue}${p.unit ? ` ${p.unit}` : ''} / ${p.period.toLowerCase()}`,
      ),
    ].join('\n');

    return [
      GOAL_STRUCTURE_JSON_PROMPT,
      '',
      'USER AI CONTEXT',
      opts.aiContext.trim() || '(none provided)',
      '',
      'CURRENT PLANNER CONTEXT',
      plannerLines || '(empty)',
      '',
      'NEW GOAL INPUT',
      `Title: ${opts.title}`,
      opts.why ? `Why: ${opts.why}` : '',
      opts.description ? `Description: ${opts.description}` : '',
      opts.targetDate ? `Target date: ${opts.targetDate}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}

function formatPrimaryMetric(suggestion: GoalStructureSuggestion): string {
  const metric = suggestion.metrics[0];
  if (!metric) return '';
  if (metric.needsUserDecision) {
    const alts = metric.possibleAlternatives?.length
      ? ` Possible metrics: ${metric.possibleAlternatives.join('; ')}.`
      : '';
    return `Metric needs clarification: ${metric.name}.${alts}`;
  }
  const current = metric.currentValue == null ? '—' : String(metric.currentValue);
  const target = metric.targetValue == null ? '—' : String(metric.targetValue);
  const unit = metric.unit ? ` ${metric.unit}` : '';
  return `${metric.name}\nCurrent: ${current}${unit}\nTarget: ${target}${unit}`.trim();
}

function formatProcessCadence(p: {
  measurementType: string;
  targetValue: number;
  unit?: string;
}): string {
  if (p.measurementType === 'DURATION') {
    const hours = p.targetValue >= 60 ? `${Math.round(p.targetValue / 60)}h` : `${p.targetValue}min`;
    return `${hours} / week`;
  }
  return `${p.targetValue}${p.unit ? ` ${p.unit}` : ''} / week`;
}

/** Test helper — clear rate limit map between tests. */
export function clearGoalStructureRateLimits(): void {
  lastRequestAt.clear();
}
