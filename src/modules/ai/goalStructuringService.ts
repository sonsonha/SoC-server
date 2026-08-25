import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import { goals, projects, tasks } from '../../infrastructure/db/schema/index.js';
import type { LlmProvider } from '../../infrastructure/providers/llm/types.js';
import { DeepSeekProviderError } from '../../infrastructure/providers/llm/deepseekLlmProvider.js';
import type { IdentityService } from '../identity/identityService.js';
import {
  parseGoalMilestones,
  parseGoalProcesses,
  reconcileMilestones,
  type PlannerV2Service,
} from '../../application/plannerV2Service.js';
import {
  GOAL_STRUCTURE_JSON_PROMPT,
  goalStructureSuggestionSchema,
  type GoalStructureSuggestion,
} from './goalStructureSchema.js';
import { INITIAL_OWNER_AI_CONTEXT_DEFAULT } from './ownerAiContextDefault.js';
import { timeProtectedMinutesToSystemCadence } from './timeProtectedAdapter.js';

const MAX_TITLE = 240;
const MAX_WHY = 4_000;
const MAX_AI_CONTEXT = 12_000;
const MAX_PROMPT_CHARS = 24_000;
const RATE_LIMIT_MS = 15_000;
/** Thinking + JSON for deepseek-v4-pro often needs >90s in production. */
const AI_TIMEOUT_MS = 150_000;

const lastRequestAt = new Map<string, number>();

export type PlannerAiSnapshot = {
  activeGoals: Array<{
    title: string;
    focusType: string | null;
    currentStage: string | null;
  }>;
  activeProjects: Array<{
    title: string;
    goalTitle: string | null;
    defaultProcessName: string | null;
  }>;
  processes: Array<{ name: string; targetValue: number; period: string; unit?: string }>;
};

export type GoalStructureRequest = {
  title: string;
  description?: string;
  why?: string;
  targetDate?: string | null;
};

function aiError(
  message: string,
  statusCode: number,
  code: string,
): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), { statusCode, code });
}

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
      throw aiError('User not found', 404, 'NOT_FOUND');
    }
    const stored = await this.identity.getAiContext(userId);
    if (stored != null && stored.trim()) {
      return { aiContext: stored.slice(0, MAX_AI_CONTEXT), isDefaultSeed: false };
    }
    // Owner seed only — never inherit for other users.
    if (this.identity.isLegacyCalendarOwner(user.email)) {
      return { aiContext: INITIAL_OWNER_AI_CONTEXT_DEFAULT, isDefaultSeed: true };
    }
    return { aiContext: '', isDefaultSeed: false };
  }

  async setAiContext(userId: string, aiContext: string): Promise<{ aiContext: string }> {
    const trimmed = aiContext.slice(0, MAX_AI_CONTEXT);
    await this.identity.setAiContext(userId, trimmed);
    return { aiContext: trimmed };
  }

  async resetAiContext(userId: string): Promise<{ aiContext: string }> {
    const user = await this.identity.getUserById(userId);
    if (!user) {
      throw aiError('User not found', 404, 'NOT_FOUND');
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
    const activeGoalRows = goalRows.filter((g) => g.status === 'ACTIVE').slice(0, 12);

    const processNameById = new Map<string, string>();
    for (const g of activeGoalRows) {
      for (const proc of parseGoalProcesses(g.processesJson)) {
        if (proc.active) processNameById.set(proc.id, proc.name);
      }
    }

    const activeGoals = activeGoalRows.map((g) => {
      const milestones = parseGoalMilestones(g.milestonesJson, g.currentMilestoneId);
      const current = milestones.find((m) => m.status === 'current') ?? null;
      return {
        title: g.title,
        focusType: g.focusType,
        currentStage: current?.title ?? null,
      };
    });

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
        defaultProcessName: p.defaultGoalProcessId
          ? (processNameById.get(p.defaultGoalProcessId) ?? null)
          : null,
      }));

    const processMap = new Map<string, PlannerAiSnapshot['processes'][number]>();
    for (const g of activeGoalRows) {
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
      throw aiError('Goal title is required', 400, 'INVALID_INPUT');
    }

    const now = Date.now();
    const last = lastRequestAt.get(userId) ?? 0;
    if (now - last < RATE_LIMIT_MS) {
      throw aiError(
        'Please wait a moment before requesting another suggestion',
        429,
        'RATE_LIMITED',
      );
    }
    lastRequestAt.set(userId, now);

    if (!this.llm.structureGoal) {
      throw aiError(
        'AI suggestions are unavailable right now. You can continue manually.',
        503,
        'AI_UNAVAILABLE',
      );
    }

    const { aiContext } = await this.getAiContext(userId);
    const snapshot = await this.buildPlannerSnapshot(userId);
    const prompt = this.composePrompt({
      title,
      description: input.description?.slice(0, MAX_WHY),
      why: input.why?.slice(0, MAX_WHY),
      targetDate: input.targetDate ?? null,
      aiContext: aiContext.slice(0, MAX_AI_CONTEXT),
      snapshot,
    }).slice(0, MAX_PROMPT_CHARS);

    let raw: unknown;
    try {
      raw = await Promise.race([
        this.llm.structureGoal(prompt),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(aiError(
              'AI suggestions timed out. You can continue manually.',
              504,
              'AI_TIMEOUT',
            ));
          }, AI_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      if (err instanceof DeepSeekProviderError) {
        throw aiError(err.message, err.statusCode, err.code);
      }
      const e = err as { statusCode?: number; code?: string; message?: string };
      if (e.statusCode && e.code) throw err;
      throw aiError(
        'AI suggestions are unavailable right now. You can continue manually.',
        503,
        'AI_UNAVAILABLE',
      );
    }

    const parsed = goalStructureSuggestionSchema.safeParse(raw);
    if (!parsed.success) {
      throw aiError(
        'AI returned an invalid suggestion. You can continue manually.',
        502,
        'AI_STRUCTURE_INVALID',
      );
    }
    return parsed.data;
  }

  /**
   * Persist an edited suggestion atomically.
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
    if (suggestion.projects.length === 0) {
      throw aiError('At least one Project is required', 400, 'INVALID_INPUT');
    }

    const outcome =
      suggestion.outcome?.statement?.trim()
      || input.title.trim();
    const metricText = formatPrimaryMetric(suggestion);
    const milestoneIds = suggestion.milestones.map(() => randomUUID());
    const milestones = reconcileMilestones(
      suggestion.milestones.map((m, index) => ({
        id: milestoneIds[index]!,
        title: m.title,
        status: (index === 0 ? 'current' : 'pending') as 'pending' | 'current' | 'done',
      })),
      milestoneIds[0] ?? null,
    );
    const processIds = suggestion.processes.map(() => randomUUID());
    const processes = suggestion.processes.map((p, index) => ({
      id: processIds[index]!,
      name: p.name,
      measurementType: p.metricType,
      targetValue: p.targetValue,
      unit: p.unit ?? undefined,
      period: 'WEEK' as const,
      active: true,
    }));
    /** Resolve suggested process names within THIS draft only — never fuzzy-match existing goals. */
    const processIdByName = new Map(
      processes.map((p) => [p.name.trim().toLowerCase(), p.id] as const),
    );
    const timeProtected = timeProtectedMinutesToSystemCadence(
      suggestion.timeProtectedMinutesPerWeek,
    );
    const systems = [
      ...processes.map((p) => ({
        id: randomUUID(),
        title: p.name,
        cadence: formatProcessCadence(p),
      })),
      ...(timeProtected
        ? [{ id: randomUUID(), title: timeProtected.title, cadence: timeProtected.cadence }]
        : []),
    ];

    const goalId = randomUUID();
    const now = new Date();
    const selected = new Set(input.selectedNextActionIndexes ?? []);

    const result = await this.db.transaction(async (tx) => {
      await tx.insert(goals).values({
        id: goalId,
        userId,
        title: outcome.slice(0, MAX_TITLE),
        lifeArea: 'LIFE',
        description: '',
        horizon: 'SHORT',
        status: 'ACTIVE',
        targetDate: input.targetDate ?? null,
        parentId: null,
        successCriteria: '',
        outcome: outcome.slice(0, 10_000),
        why: (input.why ?? '').slice(0, 10_000),
        metric: metricText.slice(0, 10_000),
        focusType: input.focusType ?? 'FOCUS',
        outcomeStatus: 'ACTIVE',
        achievedAt: null,
        closedAt: null,
        currentMilestoneId: milestones[0]?.id ?? null,
        milestonesJson: JSON.stringify(milestones),
        systemsJson: JSON.stringify(systems),
        processesJson: JSON.stringify(processes),
        metricObservationsJson: JSON.stringify([]),
        reflectionJson: JSON.stringify({}),
        reviewSnapshotJson: JSON.stringify({}),
        revision: 1,
        updatedAt: now,
        deletedAt: null,
      });

      const createdProjects: Array<{
        id: string;
        title: string;
        goalId: string;
        defaultGoalProcessId: string | null;
      }> = [];

      for (const project of suggestion.projects) {
        const defaultProcessId = project.suggestedDefaultProcessName?.trim()
          ? processIdByName.get(project.suggestedDefaultProcessName.trim().toLowerCase()) ?? null
          : null;
        const projectId = randomUUID();
        await tx.insert(projects).values({
          id: projectId,
          userId,
          title: project.title.slice(0, MAX_TITLE),
          goalId,
          defaultGoalProcessId: defaultProcessId,
          color: '#705CF6',
          lifeArea: 'LIFE',
          description: (project.purpose ?? '').slice(0, 10_000),
          targetDate: null,
          active: true,
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        });
        createdProjects.push({
          id: projectId,
          title: project.title,
          goalId,
          defaultGoalProcessId: defaultProcessId,
        });
      }

      const projectIdByTitle = new Map(
        createdProjects.map((p) => [p.title.trim().toLowerCase(), p.id] as const),
      );
      const createdTasks: Array<{ id: string; title: string }> = [];

      for (let i = 0; i < suggestion.nextActions.length; i += 1) {
        if (!selected.has(i)) continue;
        const action = suggestion.nextActions[i]!;
        const projectId = action.projectTitle?.trim()
          ? projectIdByTitle.get(action.projectTitle.trim().toLowerCase()) ?? null
          : null;
        const linkedProcessId = projectId
          ? (createdProjects.find((p) => p.id === projectId)?.defaultGoalProcessId ?? null)
          : null;
        const taskId = randomUUID();
        await tx.insert(tasks).values({
          id: taskId,
          userId,
          title: action.title.slice(0, MAX_TITLE),
          description: '',
          projectId,
          goalId,
          goalProcessId: linkedProcessId,
          lifeArea: 'LIFE',
          priority: 2,
          preferredTime: 'WEEK',
          estimatedMinutes: action.estimatedMinutes ?? 30,
          status: 'TODO',
          revision: 1,
          updatedAt: now,
          deletedAt: null,
        });
        createdTasks.push({ id: taskId, title: action.title });
      }

      return { createdProjects, createdTasks };
    });

    // Serialize via planner ownership path (same user) for API response shape.
    const goal = await this.planner.getGoalProgress(userId, goalId).then((r) => r.goal);
    return {
      goal,
      projects: result.createdProjects,
      tasks: result.createdTasks,
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
      ...(opts.snapshot.activeGoals.length
        ? opts.snapshot.activeGoals.map((g) => {
            const stage = g.currentStage ? `; stage: ${g.currentStage}` : '';
            return `- ${g.title}${g.focusType ? ` — ${g.focusType}` : ''}${stage}`;
          })
        : ['(none)']),
      '',
      'ACTIVE PROJECTS',
      ...(opts.snapshot.activeProjects.length
        ? opts.snapshot.activeProjects.map((p) => {
            const goal = p.goalTitle ? ` (Goal: ${p.goalTitle})` : '';
            const proc = p.defaultProcessName ? `; process: ${p.defaultProcessName}` : '';
            return `- ${p.title}${goal}${proc}`;
          })
        : ['(none)']),
      '',
      'CURRENT WEEKLY SYSTEMS',
      ...(opts.snapshot.processes.length
        ? opts.snapshot.processes.map(
            (p) =>
              `- ${p.name} — ${p.targetValue}${p.unit ? ` ${p.unit}` : ''} / ${p.period.toLowerCase()}`,
          )
        : ['(none)']),
    ].join('\n');

    return [
      GOAL_STRUCTURE_JSON_PROMPT,
      '',
      'USER AI CONTEXT',
      opts.aiContext.trim() || '(none provided)',
      '',
      'CURRENT PLANNER CONTEXT',
      plannerLines,
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
