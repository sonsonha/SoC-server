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
import { resolveGoogleEventColorId, type PriorityLike } from '../infrastructure/providers/calendar/googleCalendarColors.js';
import {
  buildGoalProgress,
  type GoalMetricObservation,
  type GoalOutcomeStatus,
  type GoalProcess,
  type GoalReflection,
  type GoalReviewSnapshot,
} from './goalProgress.js';
import {
  appendCarryOverNote,
  buildCarryOverNote,
  deriveTaskProgressFromSessions,
  directTaskCompletePolicy,
  futureWeekOffsets,
  resolveRepeatWeekCount,
  shiftEpochByWeeks,
} from './sessionEvidence.js';

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

/** Stable hex used for UI + Google color approximation (matches web PRIORITY_LEVELS). */
export function priorityToHex(priority: PlannerPriorityInput): string {
  const normalized = priorityFromDb(priorityToDb(priority));
  if (normalized === 'P1') return '#dc2626';
  if (normalized === 'P3') return '#16a34a';
  if (normalized === 'P4') return '#64748b';
  return '#2563eb';
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
  repeatSeriesId?: string | null;
  carryOverFromTaskId?: string | null;
  carryOverNote?: string | null;
};

export type SeriesEditScope = 'THIS_INSTANCE' | 'THIS_AND_FUTURE';

type PatchTaskInput = Partial<CreateTaskInput> & {
  status?: PlannerTaskStatus;
  /** When set on a repeated Task, controls how structural edits propagate. */
  seriesScope?: SeriesEditScope;
};

type CreateTimeBlockInput = {
  taskId?: string | null;
  projectId?: string | null;
  title: string;
  startAt: string;
  endAt: string;
  color?: string;
  reminderMinutes?: number | null;
  notes?: string;
  status?: 'PLANNED' | 'DONE';
  repeatSeriesId?: string | null;
  /** When adding a Session to a repeated Task: propagate to future Task instances. */
  seriesScope?: SeriesEditScope;
};

type PatchTimeBlockInput = Partial<CreateTimeBlockInput> & {
  seriesScope?: SeriesEditScope;
};

export type ProjectType = 'STANDARD' | 'HABIT';

type CreateProjectInput = {
  title: string;
  goalId?: string | null;
  defaultGoalProcessId?: string | null;
  color?: string;
  lifeArea?: string;
  description?: string;
  active?: boolean;
  targetDate?: string | null;
  projectType?: ProjectType;
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
  /** Accepted for backward compatibility but never written for new Goals. */
  systems?: GoalSystem[];
  processes?: GoalProcess[];
  metricObservations?: GoalMetricObservation[];
  reflection?: GoalReflection | null;
  reviewSnapshot?: GoalReviewSnapshot | null;
};

type PatchGoalInput = Partial<CreateGoalInput>;

type RepeatRangeInput = {
  weeks?: number | null;
  until?: string | null;
};

function projectTypeFromDb(value: string | null | undefined): ProjectType {
  return value === 'HABIT' ? 'HABIT' : 'STANDARD';
}

/** Approximate Monday 00:00 UTC+7 for WEEK dueAt anchors (matches product week). */
function startOfUtcWeekApprox(epochMs: number) {
  const offset = 7 * 60 * 60 * 1000;
  const shifted = new Date(epochMs + offset);
  const day = shifted.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + diff,
  ) - offset;
}

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

    if (input.status === 'DONE') {
      const sessions = await this.listActiveSessionsForTask(userId, id);
      const policy = directTaskCompletePolicy(sessions);
      if (!policy.allow) {
        if (policy.reason === 'ZERO_SESSIONS') {
          this.badRequest('Schedule at least one session to track completion.');
        }
        this.badRequest('Complete sessions on the Calendar — multi-session Tasks cannot be marked done directly.');
      }
      const only = sessions[0]!;
      await this.setSessionCompletion(userId, only.id, true);
      return this.serializeTask((await this.requireOwnedTask(userId, id)));
    }

    const status = input.status === undefined
      ? row.status
      : input.status === 'SCHEDULED'
        ? 'SCHEDULED'
        : 'TODO';
    const completedAtEpochMs = input.status === undefined
      ? row.completedAtEpochMs
      : null;

    const nextNotes = input.notes === undefined ? row.description : input.notes;
    const nextTitle = input.title ?? row.title;
    const nextDueAt = input.dueAt === undefined
      ? row.deadlineEpochMs
      : input.dueAt
        ? new Date(input.dueAt).getTime()
        : null;
    const nextHorizon = input.dueHorizon === undefined ? row.preferredTime : input.dueHorizon;
    const nextDuration = input.durationMinutes ?? row.estimatedMinutes;
    const nextPriority = input.priority ? priorityToDb(input.priority) : row.priority;
    const nextProjectId = input.projectId === undefined ? row.projectId : input.projectId;

    const applyToFuture = input.seriesScope === 'THIS_AND_FUTURE' && Boolean(row.repeatSeriesId);
    const targets = applyToFuture
      ? await this.listSeriesTasksFrom(userId, row.repeatSeriesId!, row.deadlineEpochMs ?? 0, id)
      : [row];

    for (const target of targets) {
      const isSource = target.id === id;
      await this.db
        .update(tasks)
        .set({
          title: nextTitle,
          description: isSource ? nextNotes : target.description,
          projectId: nextProjectId,
          goalId: isSource ? nextGoalId : target.goalId,
          goalProcessId: isSource ? nextProcessId : target.goalProcessId,
          deadlineEpochMs: isSource
            ? nextDueAt
            : target.deadlineEpochMs,
          preferredTime: nextHorizon,
          estimatedMinutes: nextDuration,
          priority: nextPriority,
          status: isSource ? status : target.status,
          completedAtEpochMs: isSource ? completedAtEpochMs : target.completedAtEpochMs,
          repeatSeriesId: input.repeatSeriesId === undefined
            ? target.repeatSeriesId
            : input.repeatSeriesId,
          carryOverFromTaskId: input.carryOverFromTaskId === undefined
            ? target.carryOverFromTaskId
            : input.carryOverFromTaskId,
          carryOverNote: input.carryOverNote === undefined
            ? target.carryOverNote
            : input.carryOverNote,
          revision: target.revision + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, target.id), eq(tasks.userId, userId)));
    }

    // Keep linked Sessions' Google colors in sync when priority changes.
    if (input.priority && nextPriority !== row.priority) {
      const color = priorityToHex(input.priority);
      for (const target of targets) {
        const linked = await this.db
          .select({ id: timeBlocks.id })
          .from(timeBlocks)
          .where(
            and(
              eq(timeBlocks.userId, userId),
              eq(timeBlocks.taskId, target.id),
              isNull(timeBlocks.deletedAt),
            ),
          );
        for (const block of linked) {
          await this.db
            .update(timeBlocks)
            .set({
              color,
              syncStatus: 'PENDING',
              updatedAt: new Date(),
            })
            .where(and(eq(timeBlocks.id, block.id), eq(timeBlocks.userId, userId)));
          await this.syncBlock(userId, block.id);
        }
      }
    }

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

  async deleteTask(
    userId: string,
    id: string,
    opts?: { seriesScope?: SeriesEditScope },
  ) {
    const row = await this.requireOwnedTask(userId, id);
    const targets = opts?.seriesScope === 'THIS_AND_FUTURE' && row.repeatSeriesId
      ? await this.listSeriesTasksFrom(
        userId,
        row.repeatSeriesId,
        row.deadlineEpochMs ?? 0,
        id,
      )
      : [row];

    let removedTimeBlocks = 0;
    for (const target of targets) {
      const linkedBlocks = await this.db
        .select({ id: timeBlocks.id })
        .from(timeBlocks)
        .where(
          and(
            eq(timeBlocks.userId, userId),
            eq(timeBlocks.taskId, target.id),
            isNull(timeBlocks.deletedAt),
          ),
        );

      for (const block of linkedBlocks) {
        // Instance-only session soft-delete (do not cascade session series here).
        await this.deleteTimeBlock(userId, block.id);
        removedTimeBlocks += 1;
      }

      await this.db
        .update(tasks)
        .set({
          status: 'CANCELLED',
          deletedAt: new Date(),
          revision: target.revision + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, target.id), eq(tasks.userId, userId)));
    }
    return {
      id,
      deleted: true as const,
      removedTimeBlocks,
      removedTaskCount: targets.length,
    };
  }

  async createTimeBlock(userId: string, input: CreateTimeBlockInput) {
    const start = new Date(input.startAt).getTime();
    const end = new Date(input.endAt).getTime();
    this.validateWindow(start, end);
    const task = input.taskId ? await this.requireOwnedTask(userId, input.taskId) : null;
    if (input.projectId) await this.requireOwnedProject(userId, input.projectId);
    const id = randomUUID();
    const status = input.status === 'DONE' ? 'DONE' : 'PLANNED';
    const propagateFuture = input.seriesScope === 'THIS_AND_FUTURE' && Boolean(task?.repeatSeriesId);
    const sessionSeriesId = propagateFuture
      ? (input.repeatSeriesId ?? randomUUID())
      : (input.repeatSeriesId ?? null);
    await this.db.insert(timeBlocks).values({
      id,
      userId,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      title: input.title,
      startEpochMs: start,
      endEpochMs: end,
      color: input.color ?? '#705CF6',
      status,
      notes: input.notes ?? '',
      completedAtEpochMs: status === 'DONE' ? Date.now() : null,
      reminderMinutes: input.reminderMinutes ?? null,
      repeatSeriesId: sessionSeriesId,
      syncStatus: 'PENDING',
      revision: 1,
      updatedAt: new Date(),
      deletedAt: null,
    });
    if (input.taskId) {
      await this.syncTaskStatusFromSessions(userId, input.taskId);
    }
    const created = await this.syncBlock(userId, id);

    if (propagateFuture && task?.repeatSeriesId && sessionSeriesId) {
      const futureTasks = await this.listSeriesTasksFrom(
        userId,
        task.repeatSeriesId,
        task.deadlineEpochMs ?? start,
        task.id,
      );
      const duration = end - start;
      for (const future of futureTasks) {
        if (future.id === task.id) continue;
        const weekDelta = task.deadlineEpochMs != null && future.deadlineEpochMs != null
          ? Math.round((future.deadlineEpochMs - task.deadlineEpochMs) / (7 * 86_400_000))
          : 0;
        if (weekDelta <= 0) continue;
        const futureStart = shiftEpochByWeeks(start, weekDelta);
        const futureEnd = futureStart + duration;
        const blockId = randomUUID();
        await this.db.insert(timeBlocks).values({
          id: blockId,
          userId,
          taskId: future.id,
          projectId: input.projectId ?? future.projectId,
          title: input.title,
          startEpochMs: futureStart,
          endEpochMs: futureEnd,
          color: input.color ?? '#705CF6',
          status: 'PLANNED',
          notes: input.notes ?? '',
          completedAtEpochMs: null,
          reminderMinutes: input.reminderMinutes ?? null,
          repeatSeriesId: sessionSeriesId,
          syncStatus: 'PENDING',
          revision: 1,
          updatedAt: new Date(),
          deletedAt: null,
        });
        await this.syncBlock(userId, blockId);
        await this.syncTaskStatusFromSessions(userId, future.id);
      }
    }

    return created;
  }

  async patchTimeBlock(userId: string, id: string, input: PatchTimeBlockInput) {
    const row = await this.requireOwnedTimeBlock(userId, id);
    if (input.taskId) await this.requireOwnedTask(userId, input.taskId);
    if (input.projectId) await this.requireOwnedProject(userId, input.projectId);
    const start = input.startAt ? new Date(input.startAt).getTime() : row.startEpochMs;
    const end = input.endAt ? new Date(input.endAt).getTime() : row.endEpochMs;
    this.validateWindow(start, end);

    if (input.status !== undefined) {
      await this.setSessionCompletion(userId, id, input.status === 'DONE');
      // Re-read after completion toggle; continue with other field patches if any.
      const afterStatus = await this.requireOwnedTimeBlock(userId, id);
      const hasStructural =
        input.startAt !== undefined
        || input.endAt !== undefined
        || input.title !== undefined
        || input.notes !== undefined
        || input.color !== undefined
        || input.reminderMinutes !== undefined
        || input.taskId !== undefined
        || input.projectId !== undefined;
      if (!hasStructural) {
        return this.serializeBlock(afterStatus);
      }
    }

    const nextTitle = input.title ?? row.title;
    const nextNotes = input.notes === undefined ? row.notes : input.notes;
    const nextColor = input.color ?? row.color;
    const nextReminder = input.reminderMinutes === undefined
      ? row.reminderMinutes
      : input.reminderMinutes;
    const nextTaskId = input.taskId === undefined ? row.taskId : input.taskId;
    const nextProjectId = input.projectId === undefined ? row.projectId : input.projectId;
    const deltaStart = start - row.startEpochMs;
    const deltaEnd = end - row.endEpochMs;

    const applyToFuture = input.seriesScope === 'THIS_AND_FUTURE' && Boolean(row.repeatSeriesId);
    const targets = applyToFuture
      ? await this.listSeriesBlocksFrom(userId, row.repeatSeriesId!, row.startEpochMs, id)
      : [row];

    for (const target of targets) {
      const isSource = target.id === id;
      await this.db
        .update(timeBlocks)
        .set({
          taskId: isSource ? nextTaskId : target.taskId,
          projectId: isSource ? nextProjectId : target.projectId,
          title: nextTitle,
          notes: nextNotes,
          startEpochMs: isSource ? start : target.startEpochMs + deltaStart,
          endEpochMs: isSource ? end : target.endEpochMs + deltaEnd,
          color: nextColor,
          reminderMinutes: nextReminder,
          syncStatus: 'PENDING',
          revision: target.revision + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(timeBlocks.id, target.id), eq(timeBlocks.userId, userId)));
      await this.syncBlock(userId, target.id);
    }

    const affectedTaskIds = new Set<string>();
    for (const target of targets) {
      const taskId = target.id === id ? nextTaskId : target.taskId;
      if (taskId) affectedTaskIds.add(taskId);
      if (row.taskId) affectedTaskIds.add(row.taskId);
    }
    for (const taskId of affectedTaskIds) {
      await this.syncTaskStatusFromSessions(userId, taskId);
    }

    return this.syncBlock(userId, id);
  }

  async deleteTimeBlock(
    userId: string,
    id: string,
    opts?: { seriesScope?: SeriesEditScope },
  ) {
    const row = await this.requireOwnedTimeBlock(userId, id);
    const targets = opts?.seriesScope === 'THIS_AND_FUTURE' && row.repeatSeriesId
      ? await this.listSeriesBlocksFrom(userId, row.repeatSeriesId, row.startEpochMs, id)
      : [row];

    for (const target of targets) {
      // Soft-delete locally first — never block unschedule on Google failures.
      await this.db
        .update(timeBlocks)
        .set({
          deletedAt: new Date(),
          syncStatus: 'SYNCED',
          revision: target.revision + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(timeBlocks.id, target.id), eq(timeBlocks.userId, userId)));
      if (target.taskId) {
        await this.syncTaskStatusFromSessions(userId, target.taskId);
      }

      if (target.googleEventId) {
        try {
          const calendar = await this.calendarFor(userId);
          await calendar.deleteCosEvent?.(target.googleEventId);
        } catch (err) {
          const safe = isGoogleCalendarError(err)
            ? err.toLogFields()
            : { message: err instanceof Error ? err.message : 'unknown' };
          console.warn('planner.deleteTimeBlock google cleanup failed', {
            timeBlockId: target.id,
            googleEventId: target.googleEventId,
            ...safe,
          });
        }
      }
    }
    return { id, deleted: true as const, removedCount: targets.length };
  }

  /** Mark a Calendar Session done/incomplete. Never completes other series instances. */
  async setSessionCompletion(userId: string, id: string, done: boolean) {
    const row = await this.requireOwnedTimeBlock(userId, id);
    await this.db
      .update(timeBlocks)
      .set({
        status: done ? 'DONE' : 'PLANNED',
        completedAtEpochMs: done ? (row.completedAtEpochMs ?? Date.now()) : null,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(timeBlocks.id, id), eq(timeBlocks.userId, userId)));
    if (row.taskId) {
      await this.syncTaskStatusFromSessions(userId, row.taskId);
    }
    return this.serializeBlock(await this.requireOwnedTimeBlock(userId, id));
  }

  /**
   * Repeat Task: materialize future Task instances + ALL current Sessions.
   * Source Task joins (or keeps) a shared repeatSeriesId.
   */
  async repeatTask(userId: string, taskId: string, range: RepeatRangeInput) {
    const source = await this.requireOwnedTask(userId, taskId);
    const sessions = await this.listActiveSessionsForTask(userId, taskId);
    const fromEpoch = source.deadlineEpochMs
      ?? sessions[0]?.startEpochMs
      ?? Date.now();
    const weekCount = resolveRepeatWeekCount({
      weeks: range.weeks,
      untilEpochMs: range.until ? new Date(range.until).getTime() : null,
      fromEpochMs: fromEpoch,
    });
    const seriesId = source.repeatSeriesId ?? randomUUID();
    if (!source.repeatSeriesId) {
      await this.db
        .update(tasks)
        .set({ repeatSeriesId: seriesId, revision: source.revision + 1, updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
    }

    // Ensure each source session has a stable series id for correspondence.
    const sessionSeriesById = new Map<string, string>();
    for (const session of sessions) {
      const sid = session.repeatSeriesId ?? randomUUID();
      sessionSeriesById.set(session.id, sid);
      if (!session.repeatSeriesId) {
        await this.db
          .update(timeBlocks)
          .set({ repeatSeriesId: sid, revision: session.revision + 1, updatedAt: new Date() })
          .where(and(eq(timeBlocks.id, session.id), eq(timeBlocks.userId, userId)));
      }
    }

    const createdTaskIds: string[] = [];
    for (const weekOffset of futureWeekOffsets(weekCount)) {
      const newTaskId = randomUUID();
      const dueAt = source.deadlineEpochMs != null
        ? shiftEpochByWeeks(source.deadlineEpochMs, weekOffset)
        : null;
      await this.db.insert(tasks).values({
        id: newTaskId,
        userId,
        title: source.title,
        description: '',
        projectId: source.projectId,
        goalId: source.goalId,
        goalProcessId: source.goalProcessId,
        lifeArea: source.lifeArea,
        priority: source.priority,
        deadlineEpochMs: dueAt,
        preferredTime: source.preferredTime,
        estimatedMinutes: source.estimatedMinutes,
        status: 'TODO',
        completedAtEpochMs: null,
        repeatSeriesId: seriesId,
        revision: 1,
        updatedAt: new Date(),
        deletedAt: null,
      });
      createdTaskIds.push(newTaskId);

      for (const session of sessions) {
        const blockId = randomUUID();
        const start = shiftEpochByWeeks(session.startEpochMs, weekOffset);
        const end = shiftEpochByWeeks(session.endEpochMs, weekOffset);
        await this.db.insert(timeBlocks).values({
          id: blockId,
          userId,
          taskId: newTaskId,
          projectId: session.projectId ?? source.projectId,
          title: session.title,
          startEpochMs: start,
          endEpochMs: end,
          color: session.color,
          status: 'PLANNED',
          notes: session.notes ?? '',
          completedAtEpochMs: null,
          reminderMinutes: session.reminderMinutes,
          repeatSeriesId: sessionSeriesById.get(session.id) ?? null,
          syncStatus: 'PENDING',
          revision: 1,
          updatedAt: new Date(),
          deletedAt: null,
        });
        await this.syncBlock(userId, blockId);
      }
      if (sessions.length > 0) {
        await this.syncTaskStatusFromSessions(userId, newTaskId);
      }
    }

    return {
      seriesId,
      sourceTaskId: taskId,
      createdTaskIds,
      weeks: weekCount,
    };
  }

  /** Summarize a Task's repeat series for Edit Repeat UI. */
  async getTaskRepeatSummary(userId: string, taskId: string) {
    const task = await this.requireOwnedTask(userId, taskId);
    if (!task.repeatSeriesId) return null;
    const siblings = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.repeatSeriesId, task.repeatSeriesId),
          isNull(tasks.deletedAt),
        ),
      );
    const dues = siblings
      .map((row) => row.deadlineEpochMs)
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b);
    const starts = dues.length ? dues[0]! : task.deadlineEpochMs;
    const ends = dues.length ? dues[dues.length - 1]! : task.deadlineEpochMs;
    const weekSpan = starts != null && ends != null
      ? Math.max(1, Math.round((ends - starts) / (7 * 86_400_000)) + 1)
      : siblings.length;
    return {
      seriesId: task.repeatSeriesId,
      cadence: 'WEEKLY' as const,
      instanceCount: siblings.length,
      weekCount: weekSpan,
      startsAt: starts != null ? new Date(starts).toISOString() : null,
      endsAt: ends != null ? new Date(ends).toISOString() : null,
    };
  }

  /**
   * Edit Repeat: extend (materialize more weeks), shorten/stop (remove or detach future).
   * Never deletes past instances or completed historical sessions.
   */
  async updateTaskRepeat(
    userId: string,
    taskId: string,
    input: RepeatRangeInput & { stopAfterThis?: boolean },
  ) {
    const source = await this.requireOwnedTask(userId, taskId);
    if (!source.repeatSeriesId) this.badRequest('Task is not part of a repeat series.');
    const seriesId = source.repeatSeriesId;
    const siblings = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.repeatSeriesId, seriesId),
          isNull(tasks.deletedAt),
        ),
      );
    const sourceDue = source.deadlineEpochMs ?? 0;
    const pastAndCurrent = siblings.filter((row) => (row.deadlineEpochMs ?? 0) <= sourceDue);
    const future = siblings
      .filter((row) => (row.deadlineEpochMs ?? 0) > sourceDue)
      .sort((a, b) => (a.deadlineEpochMs ?? 0) - (b.deadlineEpochMs ?? 0));

    if (input.stopAfterThis) {
      const { removed, detached } = await this.retireFutureSeriesTasks(userId, future);
      return {
        seriesId,
        action: 'STOP_AFTER_THIS' as const,
        keptInstanceCount: pastAndCurrent.length,
        removed,
        detached,
      };
    }

    const fromEpoch = source.deadlineEpochMs
      ?? (await this.listActiveSessionsForTask(userId, taskId))[0]?.startEpochMs
      ?? Date.now();
    const desiredWeeks = resolveRepeatWeekCount({
      weeks: input.weeks,
      untilEpochMs: input.until ? new Date(input.until).getTime() : null,
      fromEpochMs: fromEpoch,
    });
    // desiredWeeks = number of FUTURE weeks from source (same as repeatTask).
    // Total span from series start = index of source among sorted + desiredWeeks.
    const sorted = [...siblings].sort((a, b) => (a.deadlineEpochMs ?? 0) - (b.deadlineEpochMs ?? 0));
    const sourceIndex = sorted.findIndex((row) => row.id === source.id);
    const keepFutureCount = desiredWeeks;
    const keepFuture = future.slice(0, keepFutureCount);
    const dropFuture = future.slice(keepFutureCount);

    const { removed, detached } = await this.retireFutureSeriesTasks(userId, dropFuture);

    // Extend: materialize missing future weeks beyond keepFuture.
    const existingFutureOffsets = new Set(
      keepFuture.map((row) => {
        if (source.deadlineEpochMs == null || row.deadlineEpochMs == null) return -1;
        return Math.round((row.deadlineEpochMs - source.deadlineEpochMs) / (7 * 86_400_000));
      }).filter((n) => n > 0),
    );
    const sessions = await this.listActiveSessionsForTask(userId, taskId);
    const sessionSeriesById = new Map<string, string>();
    for (const session of sessions) {
      const sid = session.repeatSeriesId ?? randomUUID();
      sessionSeriesById.set(session.id, sid);
      if (!session.repeatSeriesId) {
        await this.db
          .update(timeBlocks)
          .set({ repeatSeriesId: sid, revision: session.revision + 1, updatedAt: new Date() })
          .where(and(eq(timeBlocks.id, session.id), eq(timeBlocks.userId, userId)));
      }
    }

    const createdTaskIds: string[] = [];
    for (const weekOffset of futureWeekOffsets(desiredWeeks)) {
      if (existingFutureOffsets.has(weekOffset)) continue;
      const newTaskId = randomUUID();
      const dueAt = source.deadlineEpochMs != null
        ? shiftEpochByWeeks(source.deadlineEpochMs, weekOffset)
        : null;
      await this.db.insert(tasks).values({
        id: newTaskId,
        userId,
        title: source.title,
        description: '',
        projectId: source.projectId,
        goalId: source.goalId,
        goalProcessId: source.goalProcessId,
        lifeArea: source.lifeArea,
        priority: source.priority,
        deadlineEpochMs: dueAt,
        preferredTime: source.preferredTime,
        estimatedMinutes: source.estimatedMinutes,
        status: 'TODO',
        completedAtEpochMs: null,
        repeatSeriesId: seriesId,
        revision: 1,
        updatedAt: new Date(),
        deletedAt: null,
      });
      createdTaskIds.push(newTaskId);
      for (const session of sessions) {
        const blockId = randomUUID();
        await this.db.insert(timeBlocks).values({
          id: blockId,
          userId,
          taskId: newTaskId,
          projectId: session.projectId ?? source.projectId,
          title: session.title,
          startEpochMs: shiftEpochByWeeks(session.startEpochMs, weekOffset),
          endEpochMs: shiftEpochByWeeks(session.endEpochMs, weekOffset),
          color: session.color,
          status: 'PLANNED',
          notes: session.notes ?? '',
          completedAtEpochMs: null,
          reminderMinutes: session.reminderMinutes,
          repeatSeriesId: sessionSeriesById.get(session.id) ?? null,
          syncStatus: 'PENDING',
          revision: 1,
          updatedAt: new Date(),
          deletedAt: null,
        });
        await this.syncBlock(userId, blockId);
      }
      if (sessions.length > 0) {
        await this.syncTaskStatusFromSessions(userId, newTaskId);
      }
    }

    return {
      seriesId,
      action: 'UPDATE' as const,
      weekCount: desiredWeeks,
      createdTaskIds,
      removed,
      detached,
      sourceIndex,
    };
  }

  private async retireFutureSeriesTasks(
    userId: string,
    future: Array<typeof tasks.$inferSelect>,
  ) {
    let removed = 0;
    let detached = 0;
    for (const task of future) {
      const sessions = await this.listActiveSessionsForTask(userId, task.id);
      const hasEvidence = sessions.some((session) =>
        session.status === 'DONE' || Boolean(session.completedAtEpochMs),
      );
      const hasCarryNote = Boolean(task.carryOverNote?.trim());
      if (hasEvidence || hasCarryNote) {
        await this.db
          .update(tasks)
          .set({
            repeatSeriesId: null,
            revision: task.revision + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
        for (const session of sessions) {
          if (session.repeatSeriesId) {
            await this.db
              .update(timeBlocks)
              .set({
                repeatSeriesId: null,
                revision: session.revision + 1,
                updatedAt: new Date(),
              })
              .where(and(eq(timeBlocks.id, session.id), eq(timeBlocks.userId, userId)));
          }
        }
        detached += 1;
        continue;
      }
      await this.deleteTask(userId, task.id);
      removed += 1;
    }
    return { removed, detached };
  }

  /**
   * Repeat Session: only the selected Session into future weeks.
   * Creates Task instances when the week has no corresponding Task in the series.
   */
  async repeatSession(userId: string, blockId: string, range: RepeatRangeInput) {
    const session = await this.requireOwnedTimeBlock(userId, blockId);
    if (!session.taskId) this.badRequest('Session must belong to a Task to repeat.');
    const sourceTask = await this.requireOwnedTask(userId, session.taskId);
    const fromEpoch = session.startEpochMs;
    const weekCount = resolveRepeatWeekCount({
      weeks: range.weeks,
      untilEpochMs: range.until ? new Date(range.until).getTime() : null,
      fromEpochMs: fromEpoch,
    });

    const taskSeriesId = sourceTask.repeatSeriesId ?? randomUUID();
    if (!sourceTask.repeatSeriesId) {
      await this.db
        .update(tasks)
        .set({ repeatSeriesId: taskSeriesId, revision: sourceTask.revision + 1, updatedAt: new Date() })
        .where(and(eq(tasks.id, sourceTask.id), eq(tasks.userId, userId)));
    }

    const sessionSeriesId = session.repeatSeriesId ?? randomUUID();
    if (!session.repeatSeriesId) {
      await this.db
        .update(timeBlocks)
        .set({ repeatSeriesId: sessionSeriesId, revision: session.revision + 1, updatedAt: new Date() })
        .where(and(eq(timeBlocks.id, blockId), eq(timeBlocks.userId, userId)));
    }

    const createdTaskIds: string[] = [];
    const createdBlockIds: string[] = [];

    for (const weekOffset of futureWeekOffsets(weekCount)) {
      const targetStart = shiftEpochByWeeks(session.startEpochMs, weekOffset);
      // Conflict: corresponding session already exists in series for this week.
      const existingBlocks = await this.db
        .select()
        .from(timeBlocks)
        .where(
          and(
            eq(timeBlocks.userId, userId),
            eq(timeBlocks.repeatSeriesId, sessionSeriesId),
            isNull(timeBlocks.deletedAt),
          ),
        );
      const conflict = existingBlocks.find((b) => {
        const delta = Math.abs(b.startEpochMs - targetStart);
        return delta < 60_000;
      });
      if (conflict) {
        this.badRequest('A corresponding repeated Session already exists in that week.');
      }

      let targetTaskId = await this.findSeriesTaskForWeek(
        userId,
        taskSeriesId,
        sourceTask.deadlineEpochMs != null
          ? shiftEpochByWeeks(sourceTask.deadlineEpochMs, weekOffset)
          : targetStart,
      );

      if (!targetTaskId) {
        targetTaskId = randomUUID();
        const dueAt = sourceTask.deadlineEpochMs != null
          ? shiftEpochByWeeks(sourceTask.deadlineEpochMs, weekOffset)
          : null;
        await this.db.insert(tasks).values({
          id: targetTaskId,
          userId,
          title: sourceTask.title,
          description: '',
          projectId: sourceTask.projectId,
          goalId: sourceTask.goalId,
          goalProcessId: sourceTask.goalProcessId,
          lifeArea: sourceTask.lifeArea,
          priority: sourceTask.priority,
          deadlineEpochMs: dueAt,
          preferredTime: sourceTask.preferredTime,
          estimatedMinutes: sourceTask.estimatedMinutes,
          status: 'TODO',
          completedAtEpochMs: null,
          repeatSeriesId: taskSeriesId,
          revision: 1,
          updatedAt: new Date(),
          deletedAt: null,
        });
        createdTaskIds.push(targetTaskId);
      }

      const newBlockId = randomUUID();
      await this.db.insert(timeBlocks).values({
        id: newBlockId,
        userId,
        taskId: targetTaskId,
        projectId: session.projectId ?? sourceTask.projectId,
        title: session.title,
        startEpochMs: targetStart,
        endEpochMs: shiftEpochByWeeks(session.endEpochMs, weekOffset),
        color: session.color,
        status: 'PLANNED',
        notes: session.notes ?? '',
        completedAtEpochMs: null,
        reminderMinutes: session.reminderMinutes,
        repeatSeriesId: sessionSeriesId,
        syncStatus: 'PENDING',
        revision: 1,
        updatedAt: new Date(),
        deletedAt: null,
      });
      createdBlockIds.push(newBlockId);
      await this.syncBlock(userId, newBlockId);
      await this.syncTaskStatusFromSessions(userId, targetTaskId);
    }

    return {
      taskSeriesId,
      sessionSeriesId,
      sourceBlockId: blockId,
      createdTaskIds,
      createdBlockIds,
      weeks: weekCount,
    };
  }

  /**
   * Cross-week carry-over for a non-repeated incomplete Session:
   * keep source Task historical; create a new Task in the target week and move the Session.
   */
  async carryOverSession(userId: string, blockId: string, targetStartAt: string) {
    const session = await this.requireOwnedTimeBlock(userId, blockId);
    if (!session.taskId) this.badRequest('Session must belong to a Task.');
    if (session.repeatSeriesId) {
      this.badRequest('Use series edit scope for repeated Sessions instead of carry-over.');
    }
    const sourceTask = await this.requireOwnedTask(userId, session.taskId);
    const sessions = await this.listActiveSessionsForTask(userId, sourceTask.id);
    const progress = deriveTaskProgressFromSessions(sessions);
    const targetStart = new Date(targetStartAt).getTime();
    const duration = session.endEpochMs - session.startEpochMs;
    const targetEnd = targetStart + duration;

    const carryNote = buildCarryOverNote(progress);
    const newTaskId = randomUUID();
    const horizon = dueHorizonFromDb(sourceTask.preferredTime) ?? 'WEEK';
    // Align new Task dueAt to Monday of target week when WEEK horizon.
    const dueAt = horizon === 'WEEK'
      ? startOfUtcWeekApprox(targetStart)
      : targetStart;

    await this.db.insert(tasks).values({
      id: newTaskId,
      userId,
      title: sourceTask.title,
      description: appendCarryOverNote('', carryNote),
      projectId: sourceTask.projectId,
      goalId: sourceTask.goalId,
      goalProcessId: sourceTask.goalProcessId,
      lifeArea: sourceTask.lifeArea,
      priority: sourceTask.priority,
      deadlineEpochMs: dueAt,
      preferredTime: sourceTask.preferredTime ?? 'WEEK',
      estimatedMinutes: sourceTask.estimatedMinutes,
      status: 'TODO',
      completedAtEpochMs: null,
      carryOverFromTaskId: sourceTask.id,
      carryOverNote: carryNote,
      revision: 1,
      updatedAt: new Date(),
      deletedAt: null,
    });

    await this.db
      .update(timeBlocks)
      .set({
        taskId: newTaskId,
        startEpochMs: targetStart,
        endEpochMs: targetEnd,
        status: 'PLANNED',
        completedAtEpochMs: null,
        syncStatus: 'PENDING',
        revision: session.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(timeBlocks.id, blockId), eq(timeBlocks.userId, userId)));

    await this.syncTaskStatusFromSessions(userId, sourceTask.id);
    await this.syncTaskStatusFromSessions(userId, newTaskId);
    await this.syncBlock(userId, blockId);

    return {
      sourceTaskId: sourceTask.id,
      newTaskId,
      timeBlockId: blockId,
      carryOverNote: carryNote,
    };
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
      projectType: input.projectType === 'HABIT' ? 'HABIT' : 'STANDARD',
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
        projectType: input.projectType === undefined
          ? row.projectType
          : input.projectType === 'HABIT' ? 'HABIT' : 'STANDARD',
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
      // Systems retired from active product writes — keep column empty for new Goals.
      systemsJson: '[]',
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
        // Do not write systems — leave historical systems_json untouched.
        systemsJson: row.systemsJson,
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
    const now = Date.now();
    const fromEpochMs = now - 86_400_000;
    const toEpochMs = now + 14 * 86_400_000;
    // Include already-SYNCED blocks in the active window so Sync now can refresh
    // Google event colors (priority palette) and not only PENDING/FAILED retries.
    const rows = await this.db
      .select({ id: timeBlocks.id, syncStatus: timeBlocks.syncStatus })
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, userId),
          isNull(timeBlocks.deletedAt),
          lt(timeBlocks.startEpochMs, toEpochMs),
          gt(timeBlocks.endEpochMs, fromEpochMs),
          inArray(timeBlocks.syncStatus, ['PENDING', 'FAILED', 'SYNCED']),
        ),
      );
    let synced = 0;
    let failed = 0;
    for (const row of rows) {
      const result = await this.syncBlock(userId, row.id);
      if (result.syncStatus === 'SYNCED') synced += 1;
      else failed += 1;
    }

    // Drop leftover Personal OS Google events (e.g. old purple copies) that no
    // longer match a live time block's googleEventId after recreate.
    await this.purgeOrphanCosEvents(userId, fromEpochMs, toEpochMs);

    return { attempted: rows.length, synced, failed };
  }

  private async purgeOrphanCosEvents(
    userId: string,
    fromEpochMs: number,
    toEpochMs: number,
  ): Promise<void> {
    const calendar = await this.calendarFor(userId);
    if (!calendar.listCosEvents || !calendar.deleteCosEvent) return;

    const owned = await this.db
      .select({ googleEventId: timeBlocks.googleEventId })
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, userId),
          isNull(timeBlocks.deletedAt),
        ),
      );
    const keep = new Set(
      owned.map((row) => row.googleEventId).filter((id): id is string => Boolean(id)),
    );

    let events: Awaited<ReturnType<NonNullable<typeof calendar.listCosEvents>>>;
    try {
      events = await calendar.listCosEvents(fromEpochMs, toEpochMs);
    } catch (err) {
      console.warn('planner.purgeOrphanCosEvents list failed', {
        message: err instanceof Error ? err.message : 'unknown',
      });
      return;
    }

    let removed = 0;
    for (const event of events) {
      const origin = event.appMetadata?.plannerOrigin;
      if (origin !== 'personal-os' && origin !== 'cos') continue;
      if (!event.eventId || keep.has(event.eventId)) continue;
      try {
        await calendar.deleteCosEvent(event.eventId);
        removed += 1;
      } catch (err) {
        console.warn('planner.purgeOrphanCosEvents delete failed', {
          eventId: event.eventId,
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    if (removed > 0) {
      console.info('planner.purgeOrphanCosEvents', { userId, removed });
    }
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
      let priority: PriorityLike | null = null;
      if (row.taskId) {
        const taskRows = await this.db
          .select({ priority: tasks.priority })
          .from(tasks)
          .where(and(eq(tasks.id, row.taskId), eq(tasks.userId, userId)))
          .limit(1);
        const raw = taskRows[0]?.priority;
        priority = raw === 1 || raw === 2 || raw === 3 || raw === 4 ? raw : null;
      }
      const colorId = resolveGoogleEventColorId({
        priority,
        color: row.color,
      });
      console.info('planner.syncBlock color', {
        timeBlockId: id,
        taskId: row.taskId ?? null,
        priority,
        blockColor: row.color,
        colorId,
        googleEventId: row.googleEventId ?? null,
      });
      const googleEventId = await calendar.upsertCosEvent({
        eventId: row.googleEventId ?? undefined,
        title: row.title,
        startEpochMs: row.startEpochMs,
        endEpochMs: row.endEpochMs,
        calendarId: row.calendarId ?? undefined,
        colorId,
        appMetadata: {
          plannerOrigin: 'personal-os',
          timeBlockId: row.id,
          ...(row.taskId ? { taskId: row.taskId } : {}),
          revision: String(row.revision),
          colorId,
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
      notes: row.notes ?? '',
      completedAt: row.completedAtEpochMs
        ? new Date(row.completedAtEpochMs).toISOString()
        : null,
      repeatSeriesId: row.repeatSeriesId,
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
      repeatSeriesId: row.repeatSeriesId,
      carryOverFromTaskId: row.carryOverFromTaskId,
      carryOverNote: row.carryOverNote,
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
      projectType: projectTypeFromDb(row.projectType),
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

  private async listActiveSessionsForTask(userId: string, taskId: string) {
    return this.db
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
  }

  private async syncTaskStatusFromSessions(userId: string, taskId: string) {
    const row = await this.requireOwnedTask(userId, taskId);
    const sessions = await this.listActiveSessionsForTask(userId, taskId);
    const derived = deriveTaskProgressFromSessions(sessions);
    const nextStatus =
      derived.derivedTaskStatus === 'DONE'
        ? 'DONE'
        : derived.derivedTaskStatus === 'SCHEDULED'
          ? 'SCHEDULED'
          : 'TODO';
    const completedAtEpochMs = nextStatus === 'DONE'
      ? (row.completedAtEpochMs ?? Date.now())
      : null;
    if (row.status === nextStatus && row.completedAtEpochMs === completedAtEpochMs) {
      return;
    }
    await this.db
      .update(tasks)
      .set({
        status: nextStatus,
        completedAtEpochMs,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  }

  /** Tasks in series at or after the edited instance (by dueAt / id). Never past. */
  private async listSeriesTasksFrom(
    userId: string,
    seriesId: string,
    fromDueEpochMs: number,
    includeId: string,
  ) {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.repeatSeriesId, seriesId),
          isNull(tasks.deletedAt),
        ),
      );
    return rows.filter((row) => {
      if (row.id === includeId) return true;
      const due = row.deadlineEpochMs ?? 0;
      return due >= fromDueEpochMs;
    });
  }

  private async listSeriesBlocksFrom(
    userId: string,
    seriesId: string,
    fromStartEpochMs: number,
    includeId: string,
  ) {
    const rows = await this.db
      .select()
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, userId),
          eq(timeBlocks.repeatSeriesId, seriesId),
          isNull(timeBlocks.deletedAt),
        ),
      );
    return rows.filter((row) => {
      if (row.id === includeId) return true;
      return row.startEpochMs >= fromStartEpochMs;
    });
  }

  private async findSeriesTaskForWeek(
    userId: string,
    seriesId: string,
    weekAnchorEpochMs: number,
  ) {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.repeatSeriesId, seriesId),
          isNull(tasks.deletedAt),
        ),
      );
    const match = rows.find((row) => {
      if (row.deadlineEpochMs == null) return false;
      return Math.abs(row.deadlineEpochMs - weekAnchorEpochMs) < 12 * 60 * 60 * 1000;
    });
    return match?.id ?? null;
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
