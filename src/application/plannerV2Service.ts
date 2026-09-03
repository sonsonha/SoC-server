import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import type { Db } from '../infrastructure/db/client.js';
import {
  calendarCommitments,
  goals,
  projects,
  tasks,
  timeBlocks,
} from '../infrastructure/db/schema/index.js';
import type { CalendarProvider } from '../infrastructure/providers/calendar/types.js';
import { isGoogleCalendarError } from '../infrastructure/providers/calendar/googleErrors.js';
import {
  buildGoalProgress,
  type GoalMetricObservation,
  type GoalOutcomeStatus,
  type GoalProcess,
  type GoalReflection,
  type GoalReviewSnapshot,
} from './goalProgress.js';

export type PlannerTaskStatus = 'INBOX' | 'SCHEDULED' | 'DONE';
export type PlannerPriority = 'P1' | 'P2' | 'P3' | 'P4';
export type PlannerPriorityInput =
  | PlannerPriority
  | 'HIGH'
  | 'NORMAL'
  | 'LOW'
  | 'DROP';

export function priorityToDb(priority: PlannerPriorityInput): number {
  if (priority === 'HIGH' || priority === 'P1') return 1;
  if (priority === 'LOW' || priority === 'P3') return 3;
  if (priority === 'DROP' || priority === 'P4') return 4;
  return 2;
}

export function priorityFromDb(priority: number): PlannerPriority {
  if (priority <= 1) return 'P1';
  if (priority === 3) return 'P3';
  if (priority >= 4) return 'P4';
  return 'P2';
}

export function dueHorizonFromDb(value: string | null): 'DAY' | 'WEEK' | 'MONTH' | null {
  if (value === 'DAY' || value === 'WEEK' || value === 'MONTH') return value;
  return null;
}

export type GoalMilestone = {
  id: string;
  title: string;
  status: 'pending' | 'current' | 'done';
};

export type GoalSystem = {
  id: string;
  title: string;
  targetType?: 'COUNT' | 'DURATION';
  targetValue?: number;
  unit?: string | null;
  period?: 'WEEK';
  durationWeeks?: number;
  startDate?: string | null;
  preferredDays?: number[] | null;
  preferredTime?: string | null;
  status?: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  /** Legacy display-only cadence retained for backward compatibility. */
  cadence?: string;
};

function parseJsonValue<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function normalizeMilestoneStatus(status: string | null | undefined): GoalMilestone['status'] {
  const value = (status ?? '').toLowerCase();
  if (value === 'done' || value === 'completed') return 'done';
  if (value === 'current' || value === 'active') return 'current';
  return 'pending';
}

export function reconcileMilestones(
  milestones: GoalMilestone[],
  currentMilestoneId?: string | null,
): GoalMilestone[] {
  const normalized = milestones.map((milestone) => ({
    ...milestone,
    status: normalizeMilestoneStatus(milestone.status),
  }));
  if (!currentMilestoneId) return normalized;
  return normalized.map((milestone) => ({
    ...milestone,
    status: milestone.id === currentMilestoneId
      ? 'current'
      : milestone.status === 'done'
        ? 'done'
        : 'pending',
  }));
}

export function parseGoalMilestones(
  raw: string | null | undefined,
  currentMilestoneId?: string | null,
): GoalMilestone[] {
  const parsed = parseJsonValue<GoalMilestone[] | null>(raw, []);
  const milestones = Array.isArray(parsed) ? parsed : [];
  return reconcileMilestones(milestones, currentMilestoneId);
}

export function parseGoalSystems(raw: string | null | undefined): GoalSystem[] {
  const parsed = parseJsonValue<GoalSystem[] | null>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is GoalSystem => Boolean(value && typeof value === 'object'))
    .map((value) => {
      const system = value as GoalSystem;
      return {
        ...system,
        id: typeof system.id === 'string' && system.id ? system.id : randomUUID(),
        title: typeof system.title === 'string' ? system.title : 'Untitled system',
        status: system.status === 'PAUSED' || system.status === 'COMPLETED' ? system.status : 'ACTIVE',
        period: 'WEEK' as const,
        preferredDays: Array.isArray(system.preferredDays) ? system.preferredDays : null,
      };
    });
}

export function parseGoalProcesses(raw: string | null | undefined): GoalProcess[] {
  const parsed = parseJsonValue<GoalProcess[] | null>(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function parseGoalMetricObservations(raw: string | null | undefined): GoalMetricObservation[] {
  const parsed = parseJsonValue<GoalMetricObservation[] | null>(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function parseGoalReflection(raw: string | null | undefined): GoalReflection | null {
  const parsed = parseJsonValue<GoalReflection | null>(raw, null);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

export function parseGoalReviewSnapshot(raw: string | null | undefined): GoalReviewSnapshot | null {
  const parsed = parseJsonValue<GoalReviewSnapshot | null>(raw, null);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

export function taskStatusFromDb(status: string): PlannerTaskStatus {
  if (status === 'DONE' || status === 'CANCELLED') return 'DONE';
  if (status === 'SCHEDULED' || status === 'PLANNED' || status === 'RESCHEDULED') {
    return 'SCHEDULED';
  }
  return 'INBOX';
}

type CreateTaskInput = {
  title: string;
  notes?: string;
  projectId?: string | null;
  goalId?: string | null;
  goalProcessId?: string | null;
  dueAt?: string | null;
  dueHorizon?: 'DAY' | 'WEEK' | 'MONTH' | null;
  durationMinutes?: number;
  priority?: PlannerPriorityInput;
};

type PatchTaskInput = Partial<CreateTaskInput> & { status?: PlannerTaskStatus };

type CreateTimeBlockInput = {
  taskId?: string | null;
  projectId?: string | null;
  title: string;
  startAt: string;
  endAt: string;
  color?: string;
  reminderMinutes?: number | null;
};

type CreateProjectInput = {
  title: string;
  goalId?: string | null;
  defaultGoalProcessId?: string | null;
  color?: string;
  lifeArea?: string;
  description?: string;
  active?: boolean;
  targetDate?: string | null;
};

type PatchProjectInput = Partial<CreateProjectInput>;

type CreateGoalInput = {
  title: string;
  horizon?: string;
  lifeArea?: string;
  parentId?: string | null;
  targetDate?: string | null;
  description?: string;
  successCriteria?: string;
  status?: string;
  outcome?: string;
  why?: string;
  metric?: string;
  focusType?: 'FOCUS' | 'MAINTAIN' | 'EXPLORE';
  outcomeStatus?: GoalOutcomeStatus;
  achievedAt?: string | null;
  closedAt?: string | null;
  currentMilestoneId?: string | null;
  milestones?: GoalMilestone[];
  systems?: GoalSystem[];
  processes?: GoalProcess[];
  metricObservations?: GoalMetricObservation[];
  reflection?: GoalReflection | null;
  reviewSnapshot?: GoalReviewSnapshot | null;
};

type PatchGoalInput = Partial<CreateGoalInput>;

export class PlannerV2Service {
  constructor(
    private readonly db: Db,
    private readonly resolveCalendar: (userId: string) => Promise<CalendarProvider> | CalendarProvider,
  ) {}

  private async calendarFor(userId: string): Promise<CalendarProvider> {
    return await this.resolveCalendar(userId);
  }

  async getPlanner(
    userId: string,
    fromIso: string,
    toIso: string,
    _opts?: { includeExternalEvents?: boolean },
  ) {
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    const [taskRows, projectRows, goalRows, blockRows, externalRows] = await Promise.all([
      this.db.select().from(tasks).where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt))),
      this.db
        .select()
        .from(projects)
        .where(and(eq(projects.userId, userId), isNull(projects.deletedAt))),
      this.db.select().from(goals).where(and(eq(goals.userId, userId), isNull(goals.deletedAt))),
      this.db
        .select()
        .from(timeBlocks)
        .where(
          and(
            eq(timeBlocks.userId, userId),
            isNull(timeBlocks.deletedAt),
            lt(timeBlocks.startEpochMs, to),
            gt(timeBlocks.endEpochMs, from),
          ),
        )
        .orderBy(asc(timeBlocks.startEpochMs)),
      this.db
        .select()
        .from(calendarCommitments)
        .where(
          and(
            eq(calendarCommitments.userId, userId),
            isNull(calendarCommitments.deletedAt),
            lt(calendarCommitments.startEpochMs, to),
            gt(calendarCommitments.endEpochMs, from),
          ),
        )
        .orderBy(asc(calendarCommitments.startEpochMs)),
    ]);

    return {
      tasks: taskRows.map((row) => this.serializeTask(row)),
      projects: projectRows.map((row) => this.serializeProject(row)),
      goals: goalRows.map((row) => this.serializeGoal(row)),
      timeBlocks: blockRows.map((row) => this.serializeBlock(row)),
      externalEvents: externalRows.map((row) => ({
        id: row.id,
        googleEventId: row.externalCalendarEventId,
        calendarId: row.calendarId,
        title: row.title,
        startAt: new Date(row.startEpochMs).toISOString(),
        endAt: new Date(row.endEpochMs).toISOString(),
        location: row.location,
        ownership: 'EXTERNAL' as const,
      })),
    };
  }

  async createTask(userId: string, input: CreateTaskInput) {
    if (input.goalId) await this.requireOwnedGoal(userId, input.goalId);
    if (input.projectId) await this.requireOwnedProject(userId, input.projectId);
    let goalId = input.goalId ?? null;
    let goalProcessId = input.goalProcessId ?? null;
    if (input.projectId) {
      const project = await this.requireOwnedProject(userId, input.projectId);
      if (!goalId) goalId = project.goalId;
      if (!goalProcessId) goalProcessId = project.defaultGoalProcessId;
    }
    if (goalId) {
      const goal = await this.requireOwnedGoal(userId, goalId);
      if (goalProcessId) this.requireProcessOnGoal(goal, goalProcessId);
    } else if (goalProcessId) {
      this.badRequest('goalProcessId requires a goalId owned by the current user');
    }
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(tasks).values({
      id,
      userId,
      title: input.title,
      description: input.notes ?? '',
      projectId: input.projectId ?? null,
      goalId,
      goalProcessId,
      lifeArea: 'LIFE',
      priority: priorityToDb(input.priority ?? 'NORMAL'),
      deadlineEpochMs: input.dueAt ? new Date(input.dueAt).getTime() : null,
      preferredTime: input.dueHorizon ?? null,
      estimatedMinutes: input.durationMinutes ?? 30,
      status: 'TODO',
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    const created = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return this.serializeTask(created[0]!);
  }

  async patchTask(userId: string, id: string, input: PatchTaskInput) {
    const row = await this.requireOwnedTask(userId, id);
    if (input.goalId) await this.requireOwnedGoal(userId, input.goalId);
    if (input.projectId) await this.requireOwnedProject(userId, input.projectId);
    const nextGoalId = input.goalId === undefined ? row.goalId : input.goalId;
    const nextProcessId = input.goalProcessId === undefined ? row.goalProcessId : input.goalProcessId;
    if (nextGoalId && nextProcessId) {
      const goal = await this.requireOwnedGoal(userId, nextGoalId);
      this.requireProcessOnGoal(goal, nextProcessId);
    } else if (nextProcessId && !nextGoalId) {
      this.badRequest('goalProcessId requires a goalId owned by the current user');
    }
    const status = input.status === undefined
      ? row.status
      : input.status === 'DONE'
        ? 'DONE'
        : input.status === 'SCHEDULED'
          ? 'SCHEDULED'
          : 'TODO';
    const completedAtEpochMs = input.status === undefined
      ? row.completedAtEpochMs
      : input.status === 'DONE'
        ? row.completedAtEpochMs ?? Date.now()
        : null;
    await this.db
      .update(tasks)
      .set({
        title: input.title ?? row.title,
        description: input.notes ?? row.description,
        projectId: input.projectId === undefined ? row.projectId : input.projectId,
        goalId: nextGoalId,
        goalProcessId: nextProcessId,
        deadlineEpochMs: input.dueAt === undefined
          ? row.deadlineEpochMs
          : input.dueAt
            ? new Date(input.dueAt).getTime()
            : null,
        preferredTime: input.dueHorizon === undefined ? row.preferredTime : input.dueHorizon,
        estimatedMinutes: input.durationMinutes ?? row.estimatedMinutes,
        priority: input.priority ? priorityToDb(input.priority) : row.priority,
        status,
        completedAtEpochMs,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)));
    const updated = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return this.serializeTask(updated[0]!);
  }

  async getTaskTimeBlocks(userId: string, taskId: string) {
    await this.requireOwnedTask(userId, taskId);
    const rows = await this.db
      .select()
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, userId),
          eq(timeBlocks.taskId, taskId),
          isNull(timeBlocks.deletedAt),
        ),
      )
      .orderBy(asc(timeBlocks.startEpochMs));
    return rows.map((row) => this.serializeBlock(row));
  }

  async deleteTask(userId: string, id: string) {
    const row = await this.requireOwnedTask(userId, id);
    const linkedBlocks = await this.db
      .select({ id: timeBlocks.id })
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, userId),
          eq(timeBlocks.taskId, id),
          isNull(timeBlocks.deletedAt),
        ),
      );

    for (const block of linkedBlocks) {
      await this.deleteTimeBlock(userId, block.id);
    }

    await this.db
      .update(tasks)
      .set({
        status: 'CANCELLED',
        deletedAt: new Date(),
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)));
    return { id, deleted: true as const, removedTimeBlocks: linkedBlocks.length };
  }

  async createTimeBlock(userId: string, input: CreateTimeBlockInput) {
    const start = new Date(input.startAt).getTime();
    const end = new Date(input.endAt).getTime();
    this.validateWindow(start, end);
    if (input.taskId) await this.requireOwnedTask(userId, input.taskId);
    if (input.projectId) await this.requireOwnedProject(userId, input.projectId);
    const id = randomUUID();
    await this.db.insert(timeBlocks).values({
      id,
      userId,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      title: input.title,
      startEpochMs: start,
      endEpochMs: end,
      color: input.color ?? '#705CF6',
      reminderMinutes: input.reminderMinutes ?? null,
      syncStatus: 'PENDING',
      revision: 1,
      updatedAt: new Date(),
      deletedAt: null,
    });
    if (input.taskId) {
      await this.db
        .update(tasks)
        .set({ status: 'SCHEDULED', updatedAt: new Date() })
        .where(and(eq(tasks.id, input.taskId), eq(tasks.userId, userId)));
    }
    return this.syncBlock(userId, id);
  }

  async patchTimeBlock(userId: string, id: string, input: Partial<CreateTimeBlockInput>) {
    const row = await this.requireOwnedTimeBlock(userId, id);
    if (input.taskId) await this.requireOwnedTask(userId, input.taskId);
    if (input.projectId) await this.requireOwnedProject(userId, input.projectId);
    const start = input.startAt ? new Date(input.startAt).getTime() : row.startEpochMs;
    const end = input.endAt ? new Date(input.endAt).getTime() : row.endEpochMs;
    this.validateWindow(start, end);
    await this.db
      .update(timeBlocks)
      .set({
        taskId: input.taskId === undefined ? row.taskId : input.taskId,
        projectId: input.projectId === undefined ? row.projectId : input.projectId,
        title: input.title ?? row.title,
        startEpochMs: start,
        endEpochMs: end,
        color: input.color ?? row.color,
        reminderMinutes: input.reminderMinutes === undefined
          ? row.reminderMinutes
          : input.reminderMinutes,
        syncStatus: 'PENDING',
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(timeBlocks.id, id), eq(timeBlocks.userId, userId)));
    return this.syncBlock(userId, id);
  }

  async deleteTimeBlock(userId: string, id: string) {
    const row = await this.requireOwnedTimeBlock(userId, id);
    const calendar = await this.calendarFor(userId);
    if (row.googleEventId && calendar.deleteCosEvent) {
      await calendar.deleteCosEvent(row.googleEventId);
    }
    await this.db
      .update(timeBlocks)
      .set({
        deletedAt: new Date(),
        syncStatus: 'SYNCED',
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(timeBlocks.id, id), eq(timeBlocks.userId, userId)));
    return { id, deleted: true as const };
  }

  async createProject(userId: string, input: CreateProjectInput) {
    if (input.goalId) {
      const goal = await this.requireOwnedGoal(userId, input.goalId);
      if (input.defaultGoalProcessId) {
        this.requireProcessOnGoal(goal, input.defaultGoalProcessId);
      }
    } else if (input.defaultGoalProcessId) {
      this.badRequest('defaultGoalProcessId requires a goalId owned by the current user');
    }
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(projects).values({
      id,
      userId,
      title: input.title,
      goalId: input.goalId ?? null,
      defaultGoalProcessId: input.defaultGoalProcessId ?? null,
      color: input.color ?? '#705CF6',
      lifeArea: input.lifeArea ?? 'LIFE',
      description: input.description ?? '',
      targetDate: input.targetDate ?? null,
      active: input.active ?? true,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    const created = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return this.serializeProject(created[0]!);
  }

  async patchProject(userId: string, id: string, input: PatchProjectInput) {
    const row = await this.requireOwnedProject(userId, id);
    const nextGoalId = input.goalId === undefined ? row.goalId : input.goalId;
    const nextProcessId = input.defaultGoalProcessId === undefined
      ? row.defaultGoalProcessId
      : input.defaultGoalProcessId;
    if (nextGoalId) {
      const goal = await this.requireOwnedGoal(userId, nextGoalId);
      if (nextProcessId) this.requireProcessOnGoal(goal, nextProcessId);
    } else if (nextProcessId) {
      this.badRequest('defaultGoalProcessId requires a goalId owned by the current user');
    }
    await this.db
      .update(projects)
      .set({
        title: input.title ?? row.title,
        goalId: nextGoalId,
        defaultGoalProcessId: nextProcessId,
        color: input.color ?? row.color,
        lifeArea: input.lifeArea ?? row.lifeArea,
        description: input.description ?? row.description,
        targetDate: input.targetDate === undefined ? row.targetDate : input.targetDate,
        active: input.active ?? row.active,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, id), eq(projects.userId, userId)));
    const updated = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return this.serializeProject(updated[0]!);
  }

  async deleteProject(userId: string, id: string) {
    const row = await this.requireOwnedProject(userId, id);
    await this.db
      .update(tasks)
      .set({ projectId: null, updatedAt: new Date() })
      .where(and(eq(tasks.projectId, id), eq(tasks.userId, userId), isNull(tasks.deletedAt)));
    await this.db
      .update(projects)
      .set({
        deletedAt: new Date(),
        active: false,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, id), eq(projects.userId, userId)));
    return { id, deleted: true as const };
  }

  async createGoal(userId: string, input: CreateGoalInput) {
    if (input.parentId) await this.requireOwnedGoal(userId, input.parentId);
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(goals).values({
      id,
      userId,
      title: input.title,
      lifeArea: input.lifeArea ?? 'LIFE',
      description: input.description ?? '',
      horizon: input.horizon ?? 'SHORT',
      status: input.status ?? 'ACTIVE',
      targetDate: input.targetDate ?? null,
      parentId: input.parentId ?? null,
      successCriteria: input.successCriteria ?? '',
      outcome: input.outcome ?? input.title,
      why: input.why ?? '',
      metric: input.metric ?? input.successCriteria ?? '',
      focusType: input.focusType ?? 'FOCUS',
      outcomeStatus: input.outcomeStatus ?? 'ACTIVE',
      achievedAt: input.achievedAt ?? null,
      closedAt: input.closedAt ?? null,
      currentMilestoneId: input.currentMilestoneId ?? null,
      milestonesJson: JSON.stringify(reconcileMilestones(input.milestones ?? [], input.currentMilestoneId)),
      systemsJson: JSON.stringify(input.systems ?? []),
      processesJson: JSON.stringify(input.processes ?? []),
      metricObservationsJson: JSON.stringify(input.metricObservations ?? []),
      reflectionJson: JSON.stringify(input.reflection ?? {}),
      reviewSnapshotJson: JSON.stringify(input.reviewSnapshot ?? {}),
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    const created = await this.db.select().from(goals).where(eq(goals.id, id)).limit(1);
    return this.serializeGoal(created[0]!);
  }

  async patchGoal(userId: string, id: string, input: PatchGoalInput) {
    const row = await this.requireOwnedGoal(userId, id);
    if (input.parentId) await this.requireOwnedGoal(userId, input.parentId);
    await this.db
      .update(goals)
      .set({
        title: input.title ?? row.title,
        lifeArea: input.lifeArea ?? row.lifeArea,
        description: input.description ?? row.description,
        horizon: input.horizon ?? row.horizon,
        status: input.status ?? row.status,
        targetDate: input.targetDate === undefined ? row.targetDate : input.targetDate,
        parentId: input.parentId === undefined ? row.parentId : input.parentId,
        successCriteria: input.successCriteria ?? row.successCriteria,
        outcome: input.outcome ?? row.outcome,
        why: input.why ?? row.why,
        metric: input.metric ?? row.metric,
        focusType: input.focusType ?? row.focusType,
        outcomeStatus: input.outcomeStatus ?? row.outcomeStatus,
        achievedAt: input.achievedAt === undefined ? row.achievedAt : input.achievedAt,
        closedAt: input.closedAt === undefined ? row.closedAt : input.closedAt,
        currentMilestoneId: input.currentMilestoneId === undefined
          ? row.currentMilestoneId
          : input.currentMilestoneId,
        milestonesJson: input.milestones === undefined
          ? row.milestonesJson
          : JSON.stringify(reconcileMilestones(
            input.milestones,
            input.currentMilestoneId === undefined ? row.currentMilestoneId : input.currentMilestoneId,
          )),
        systemsJson: input.systems === undefined
          ? row.systemsJson
          : JSON.stringify(input.systems),
        processesJson: input.processes === undefined
          ? row.processesJson
          : JSON.stringify(input.processes),
        metricObservationsJson: input.metricObservations === undefined
          ? row.metricObservationsJson
          : JSON.stringify(input.metricObservations),
        reflectionJson: input.reflection === undefined
          ? row.reflectionJson
          : JSON.stringify(input.reflection ?? {}),
        reviewSnapshotJson: input.reviewSnapshot === undefined
          ? row.reviewSnapshotJson
          : JSON.stringify(input.reviewSnapshot ?? {}),
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(goals.id, id), eq(goals.userId, userId)));
    const updated = await this.db.select().from(goals).where(eq(goals.id, id)).limit(1);
    return this.serializeGoal(updated[0]!);
  }

  async deleteGoal(userId: string, id: string) {
    const row = await this.requireOwnedGoal(userId, id);
    await this.db
      .update(projects)
      .set({ goalId: null, updatedAt: new Date() })
      .where(and(eq(projects.goalId, id), eq(projects.userId, userId), isNull(projects.deletedAt)));
    await this.db
      .update(goals)
      .set({
        deletedAt: new Date(),
        status: 'ARCHIVED',
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(goals.id, id), eq(goals.userId, userId)));
    return { id, deleted: true as const };
  }

  async getGoalProgress(userId: string, id: string, nowIso?: string) {
    const goal = await this.requireOwnedGoal(userId, id);

    const linkedProjects = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), eq(projects.goalId, id), isNull(projects.deletedAt)));
    const linkedProjectIds = new Set(linkedProjects.map((project) => project.id));
    const taskRows = (
      await this.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)))
    ).filter((task) => task.goalId === id || (task.projectId ? linkedProjectIds.has(task.projectId) : false));
    const taskIds = taskRows.map((task) => task.id);
    const blockRows = taskIds.length === 0
      ? []
      : await this.db
        .select()
        .from(timeBlocks)
        .where(
          and(
            eq(timeBlocks.userId, userId),
            inArray(timeBlocks.taskId, taskIds),
            isNull(timeBlocks.deletedAt),
          ),
        )
        .orderBy(asc(timeBlocks.startEpochMs));

    const progress = buildGoalProgress(
      parseGoalProcesses(goal.processesJson),
      parseGoalMetricObservations(goal.metricObservationsJson),
      taskRows.map((task) => ({
        id: task.id,
        title: task.title,
        goalId: task.goalId,
        goalProcessId: task.goalProcessId,
        projectId: task.projectId,
        status: taskStatusFromDb(task.status),
        dueAt: task.deadlineEpochMs ? new Date(task.deadlineEpochMs).toISOString() : null,
        completedAt: task.completedAtEpochMs ? new Date(task.completedAtEpochMs).toISOString() : null,
      })),
      blockRows.map((block) => ({
        id: block.id,
        taskId: block.taskId,
        startAt: new Date(block.startEpochMs).toISOString(),
        endAt: new Date(block.endEpochMs).toISOString(),
        durationMinutes: Math.round((block.endEpochMs - block.startEpochMs) / 60_000),
      })),
      nowIso ? new Date(nowIso) : new Date(),
      new Map(linkedProjects.map((project) => [project.id, project.defaultGoalProcessId])),
    );

    return {
      goal: this.serializeGoal(goal),
      progress,
    };
  }

  async retryCalendarSync(userId: string): Promise<{ attempted: number; synced: number; failed: number }> {
    const rows = await this.db
      .select({ id: timeBlocks.id })
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, userId),
          isNull(timeBlocks.deletedAt),
          inArray(timeBlocks.syncStatus, ['PENDING', 'FAILED']),
        ),
      );
    let synced = 0;
    let failed = 0;
    for (const row of rows) {
      const result = await this.syncBlock(userId, row.id);
      if (result.syncStatus === 'SYNCED') synced += 1;
      else failed += 1;
    }
    return { attempted: rows.length, synced, failed };
  }

  private async syncBlock(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(timeBlocks)
      .where(and(eq(timeBlocks.id, id), eq(timeBlocks.userId, userId)))
      .limit(1);
    const row = rows[0];
    if (!row || row.deletedAt) this.notFound('Time block');
    const calendar = await this.calendarFor(userId);
    if (!calendar.upsertCosEvent) return this.serializeBlock(row);
    try {
      const googleEventId = await calendar.upsertCosEvent({
        eventId: row.googleEventId ?? undefined,
        title: row.title,
        startEpochMs: row.startEpochMs,
        endEpochMs: row.endEpochMs,
        calendarId: row.calendarId ?? undefined,
        appMetadata: {
          plannerOrigin: 'personal-os',
          timeBlockId: row.id,
          ...(row.taskId ? { taskId: row.taskId } : {}),
          revision: String(row.revision),
        },
      });
      await this.db
        .update(timeBlocks)
        .set({ googleEventId, syncStatus: 'SYNCED', updatedAt: new Date() })
        .where(and(eq(timeBlocks.id, id), eq(timeBlocks.userId, userId)));
      return this.serializeBlock({ ...row, googleEventId, syncStatus: 'SYNCED' });
    } catch (err) {
      const safe = isGoogleCalendarError(err)
        ? err.toLogFields()
        : { message: err instanceof Error ? err.message : 'unknown' };
      console.error('planner.syncBlock failed', {
        timeBlockId: id,
        hasGoogleEventId: Boolean(row.googleEventId),
        ...safe,
      });
      await this.db
        .update(timeBlocks)
        .set({ syncStatus: 'FAILED', updatedAt: new Date() })
        .where(and(eq(timeBlocks.id, id), eq(timeBlocks.userId, userId)));
      return this.serializeBlock({ ...row, syncStatus: 'FAILED' });
    }
  }

  private serializeBlock(row: typeof timeBlocks.$inferSelect) {
    return {
      id: row.id,
      taskId: row.taskId,
      projectId: row.projectId,
      title: row.title,
      startAt: new Date(row.startEpochMs).toISOString(),
      endAt: new Date(row.endEpochMs).toISOString(),
      color: row.color,
      status: row.status,
      ownership: 'PLANNER' as const,
      googleEventId: row.googleEventId,
      syncStatus: row.syncStatus,
      reminderMinutes: row.reminderMinutes,
      revision: row.revision,
    };
  }

  private serializeTask(row: typeof tasks.$inferSelect) {
    return {
      id: row.id,
      title: row.title,
      notes: row.description,
      projectId: row.projectId,
      goalId: row.goalId,
      goalProcessId: row.goalProcessId,
      dueAt: row.deadlineEpochMs ? new Date(row.deadlineEpochMs).toISOString() : null,
      dueHorizon: dueHorizonFromDb(row.preferredTime),
      durationMinutes: row.estimatedMinutes,
      priority: priorityFromDb(row.priority),
      status: taskStatusFromDb(row.status),
      completedAt: row.completedAtEpochMs ? new Date(row.completedAtEpochMs).toISOString() : null,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private serializeProject(row: typeof projects.$inferSelect) {
    return {
      id: row.id,
      title: row.title,
      goalId: row.goalId,
      defaultGoalProcessId: row.defaultGoalProcessId,
      color: row.color,
      lifeArea: row.lifeArea,
      description: row.description,
      targetDate: row.targetDate,
      active: row.active,
      revision: row.revision,
    };
  }

  private serializeGoal(row: typeof goals.$inferSelect) {
    return {
      id: row.id,
      title: row.title,
      horizon: row.horizon,
      lifeArea: row.lifeArea,
      status: row.status,
      targetDate: row.targetDate,
      parentId: row.parentId,
      description: row.description,
      successCriteria: row.successCriteria,
      outcome: row.outcome || row.title,
      why: row.why,
      metric: row.metric || row.successCriteria,
      focusType: row.focusType,
      outcomeStatus: row.outcomeStatus,
      achievedAt: row.achievedAt,
      closedAt: row.closedAt,
      currentMilestoneId: row.currentMilestoneId,
      milestones: parseGoalMilestones(row.milestonesJson, row.currentMilestoneId),
      systems: parseGoalSystems(row.systemsJson),
      processes: parseGoalProcesses(row.processesJson),
      metricObservations: parseGoalMetricObservations(row.metricObservationsJson),
      reflection: parseGoalReflection(row.reflectionJson),
      reviewSnapshot: parseGoalReviewSnapshot(row.reviewSnapshotJson),
      revision: row.revision,
    };
  }

  private async requireOwnedGoal(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(goals)
      .where(and(eq(goals.id, id), eq(goals.userId, userId)))
      .limit(1);
    if (!rows[0] || rows[0].deletedAt) this.notFound('Goal');
    return rows[0];
  }

  private async requireOwnedProject(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .limit(1);
    if (!rows[0] || rows[0].deletedAt) this.notFound('Project');
    return rows[0];
  }

  private async requireOwnedTask(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
      .limit(1);
    if (!rows[0] || rows[0].deletedAt) this.notFound('Task');
    return rows[0];
  }

  private async requireOwnedTimeBlock(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(timeBlocks)
      .where(and(eq(timeBlocks.id, id), eq(timeBlocks.userId, userId)))
      .limit(1);
    if (!rows[0] || rows[0].deletedAt) this.notFound('Time block');
    return rows[0];
  }

  private requireProcessOnGoal(goal: typeof goals.$inferSelect, processId: string) {
    const processes = parseGoalProcesses(goal.processesJson);
    if (!processes.some((process) => process.id === processId)) {
      this.notFound('Goal process');
    }
  }

  private validateWindow(start: number, end: number) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw Object.assign(new Error('endAt must be after startAt'), {
        statusCode: 400,
        code: 'INVALID_TIME_BLOCK',
      });
    }
  }

  private badRequest(message: string): never {
    throw Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_RELATION' });
  }

  private notFound(name: string): never {
    throw Object.assign(new Error(`${name} not found`), { statusCode: 404, code: 'NOT_FOUND' });
  }
}
