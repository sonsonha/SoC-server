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
import {
  MAX_AI_CONTEXT_CHARS,
  resolveUserAiContext,
} from './userAiContext.js';
import { normalizeGoalStructureSuggestion } from './normalizeGoalStructureSuggestion.js';
import { formatZodIssuesSafe, safeTopLevelKeys } from './goalStructureValidation.js';
import { durationProcessToHours } from '../../application/durationProcessUnits.js';

const MAX_TITLE = 240;
const MAX_WHY = 4_000;
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
    projectType: 'STANDARD' | 'HABIT';
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
    return resolveUserAiContext({
      userEmail: user.email,
      savedContext: stored,
      initialOwnerEmail: this.identity.getInitialOwnerEmail?.(),
    });
  }

  async setAiContext(userId: string, aiContext: string): Promise<{ aiContext: string }> {
    const trimmed = aiContext.slice(0, MAX_AI_CONTEXT_CHARS);
    await this.identity.setAiContext(userId, trimmed);
    return { aiContext: trimmed };
  }

  async resetAiContext(userId: string): Promise<{ aiContext: string }> {
    const user = await this.identity.getUserById(userId);
    if (!user) {
      throw aiError('User not found', 404, 'NOT_FOUND');
    }
    const reset = resolveUserAiContext({
      userEmail: user.email,
      savedContext: null,
      initialOwnerEmail: this.identity.getInitialOwnerEmail?.(),
    });
    await this.identity.setAiContext(userId, reset.aiContext);
    return { aiContext: reset.aiContext };
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
        projectType: p.projectType === 'HABIT' ? ('HABIT' as const) : ('STANDARD' as const),
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
      aiContext: aiContext.slice(0, MAX_AI_CONTEXT_CHARS),
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

    const requestId = randomUUID();
    const normalized = normalizeGoalStructureSuggestion(raw);
    const parsed = goalStructureSuggestionSchema.safeParse(normalized);
    if (!parsed.success) {
      console.error('AI_SCHEMA_INVALID', {
        requestId,
        provider: 'deepseek',
        topLevelKeys: safeTopLevelKeys(raw),
        issues: formatZodIssuesSafe(parsed.error),
      });
      throw aiError(
        'AI returned an invalid suggestion. You can continue manually.',
        502,
        'AI_SCHEMA_INVALID',
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
    const processes = suggestion.processes.map((p, index) => {
      const measurementType = p.metricType;
      const converted = measurementType === 'DURATION'
        ? durationProcessToHours(p.targetValue, p.unit)
        : { targetValue: p.targetValue, unit: p.unit ?? undefined };
      return {
        id: processIds[index]!,
        name: p.name,
        measurementType,
        targetValue: converted.targetValue,
        unit: measurementType === 'DURATION' ? 'h' : (converted.unit as string | undefined),
        period: 'WEEK' as const,
        active: true,
      };
    });
    const processIdByName = new Map(
      processes.map((p) => [p.name.trim().toLowerCase(), p.id] as const),
    );

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
        systemsJson: '[]',
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
        projectType: 'STANDARD' | 'HABIT';
      }> = [];

      for (const project of suggestion.projects) {
        const defaultProcessId = project.suggestedDefaultProcessName?.trim()
          ? processIdByName.get(project.suggestedDefaultProcessName.trim().toLowerCase()) ?? null
          : null;
        const projectType = project.projectType === 'HABIT' ? 'HABIT' : 'STANDARD';
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
          projectType,
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
          projectType,
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
            const type = p.projectType === 'HABIT' ? 'Habit' : 'Project';
            const goal = p.goalTitle ? ` (Goal: ${p.goalTitle})` : '';
            const proc = p.defaultProcessName ? `; process: ${p.defaultProcessName}` : '';
            return `- [${type}] ${p.title}${goal}${proc}`;
          })
        : ['(none)']),
      '',
      'CURRENT WEEKLY PROCESSES',
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
      'USER CONTEXT RELEVANCE RULE',
      'Treat User AI Context as background, not as a requirement that every Goal reference every area.',
      'Use only the parts relevant to this Goal. Do not force unrelated education, career, project,',
      'technology, or personal-interest details into the proposed structure.',
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

/** Test helper — clear rate limit map between tests. */
export function clearGoalStructureRateLimits(): void {
  lastRequestAt.clear();
}
