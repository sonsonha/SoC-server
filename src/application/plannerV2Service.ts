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

export type PlannerTaskStatus = 'INBOX' | 'SCHEDULED' | 'DONE';
export type PlannerPriority = 'LOW' | 'NORMAL' | 'HIGH';

export function priorityToDb(priority: PlannerPriority): number {
  if (priority === 'HIGH') return 1;
  if (priority === 'LOW') return 3;
  return 2;
}

export function priorityFromDb(priority: number): PlannerPriority {
  if (priority <= 1) return 'HIGH';
  if (priority >= 3) return 'LOW';
  return 'NORMAL';
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
  dueAt?: string | null;
  durationMinutes?: number;
  priority?: PlannerPriority;
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
  color?: string;
  lifeArea?: string;
  description?: string;
  active?: boolean;
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
};

type PatchGoalInput = Partial<CreateGoalInput>;

export class PlannerV2Service {
  constructor(
    private readonly db: Db,
    private readonly calendar: CalendarProvider,
  ) {}

  async getPlanner(fromIso: string, toIso: string) {
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    const [taskRows, projectRows, goalRows, blockRows, externalRows] = await Promise.all([
      this.db.select().from(tasks).where(isNull(tasks.deletedAt)),
      this.db.select().from(projects).where(isNull(projects.deletedAt)),
      this.db.select().from(goals).where(isNull(goals.deletedAt)),
      this.db
        .select()
        .from(timeBlocks)
        .where(
          and(
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

  async createTask(input: CreateTaskInput) {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(tasks).values({
      id,
      title: input.title,
      description: input.notes ?? '',
      projectId: input.projectId ?? null,
      lifeArea: 'LIFE',
      priority: priorityToDb(input.priority ?? 'NORMAL'),
      deadlineEpochMs: input.dueAt ? new Date(input.dueAt).getTime() : null,
      estimatedMinutes: input.durationMinutes ?? 30,
      status: 'TODO',
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    const created = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return this.serializeTask(created[0]!);
  }

  async patchTask(id: string, input: PatchTaskInput) {
    const current = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!current[0] || current[0].deletedAt) this.notFound('Task');
    const row = current[0]!;
    const status = input.status === undefined
      ? row.status
      : input.status === 'DONE'
        ? 'DONE'
        : input.status === 'SCHEDULED'
          ? 'SCHEDULED'
          : 'TODO';
    await this.db
      .update(tasks)
      .set({
        title: input.title ?? row.title,
        description: input.notes ?? row.description,
        projectId: input.projectId === undefined ? row.projectId : input.projectId,
        deadlineEpochMs: input.dueAt === undefined
          ? row.deadlineEpochMs
          : input.dueAt
            ? new Date(input.dueAt).getTime()
            : null,
        estimatedMinutes: input.durationMinutes ?? row.estimatedMinutes,
        priority: input.priority ? priorityToDb(input.priority) : row.priority,
        status,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id));
    const updated = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return this.serializeTask(updated[0]!);
  }

  async getTaskTimeBlocks(taskId: string) {
    const task = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task[0] || task[0].deletedAt) this.notFound('Task');
    const rows = await this.db
      .select()
      .from(timeBlocks)
      .where(and(eq(timeBlocks.taskId, taskId), isNull(timeBlocks.deletedAt)))
      .orderBy(asc(timeBlocks.startEpochMs));
    return rows.map((row) => this.serializeBlock(row));
  }

  async deleteTask(id: string) {
    const current = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!current[0] || current[0].deletedAt) this.notFound('Task');
    const row = current[0]!;
    const linkedBlocks = await this.db
      .select({ id: timeBlocks.id })
      .from(timeBlocks)
      .where(and(eq(timeBlocks.taskId, id), isNull(timeBlocks.deletedAt)));

    for (const block of linkedBlocks) {
      await this.deleteTimeBlock(block.id);
    }

    await this.db
      .update(tasks)
      .set({
        status: 'CANCELLED',
        deletedAt: new Date(),
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id));
    return { id, deleted: true as const, removedTimeBlocks: linkedBlocks.length };
  }

  async createTimeBlock(input: CreateTimeBlockInput) {
    const start = new Date(input.startAt).getTime();
    const end = new Date(input.endAt).getTime();
    this.validateWindow(start, end);
    const id = randomUUID();
    await this.db.insert(timeBlocks).values({
      id,
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
        .where(eq(tasks.id, input.taskId));
    }
    return this.syncBlock(id);
  }

  async patchTimeBlock(id: string, input: Partial<CreateTimeBlockInput>) {
    const rows = await this.db.select().from(timeBlocks).where(eq(timeBlocks.id, id)).limit(1);
    if (!rows[0] || rows[0].deletedAt) this.notFound('Time block');
    const row = rows[0]!;
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
      .where(eq(timeBlocks.id, id));
    return this.syncBlock(id);
  }

  async deleteTimeBlock(id: string) {
    const rows = await this.db.select().from(timeBlocks).where(eq(timeBlocks.id, id)).limit(1);
    if (!rows[0] || rows[0].deletedAt) this.notFound('Time block');
    const row = rows[0]!;
    if (row.googleEventId && this.calendar.deleteCosEvent) {
      await this.calendar.deleteCosEvent(row.googleEventId);
    }
    await this.db
      .update(timeBlocks)
      .set({
        deletedAt: new Date(),
        syncStatus: 'SYNCED',
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(timeBlocks.id, id));
    return { id, deleted: true as const };
  }

  async createProject(input: CreateProjectInput) {
    if (input.goalId) await this.requireGoal(input.goalId);
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(projects).values({
      id,
      title: input.title,
      goalId: input.goalId ?? null,
      color: input.color ?? '#705CF6',
      lifeArea: input.lifeArea ?? 'LIFE',
      description: input.description ?? '',
      active: input.active ?? true,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    const created = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return this.serializeProject(created[0]!);
  }

  async patchProject(id: string, input: PatchProjectInput) {
    const current = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!current[0] || current[0].deletedAt) this.notFound('Project');
    const row = current[0]!;
    if (input.goalId) await this.requireGoal(input.goalId);
    await this.db
      .update(projects)
      .set({
        title: input.title ?? row.title,
        goalId: input.goalId === undefined ? row.goalId : input.goalId,
        color: input.color ?? row.color,
        lifeArea: input.lifeArea ?? row.lifeArea,
        description: input.description ?? row.description,
        active: input.active ?? row.active,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id));
    const updated = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return this.serializeProject(updated[0]!);
  }

  async deleteProject(id: string) {
    const current = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!current[0] || current[0].deletedAt) this.notFound('Project');
    const row = current[0]!;
    await this.db
      .update(tasks)
      .set({ projectId: null, updatedAt: new Date() })
      .where(and(eq(tasks.projectId, id), isNull(tasks.deletedAt)));
    await this.db
      .update(projects)
      .set({
        deletedAt: new Date(),
        active: false,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id));
    return { id, deleted: true as const };
  }

  async createGoal(input: CreateGoalInput) {
    if (input.parentId) await this.requireGoal(input.parentId);
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(goals).values({
      id,
      title: input.title,
      lifeArea: input.lifeArea ?? 'LIFE',
      description: input.description ?? '',
      horizon: input.horizon ?? 'SHORT',
      status: input.status ?? 'ACTIVE',
      targetDate: input.targetDate ?? null,
      parentId: input.parentId ?? null,
      successCriteria: input.successCriteria ?? '',
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    const created = await this.db.select().from(goals).where(eq(goals.id, id)).limit(1);
    return this.serializeGoal(created[0]!);
  }

  async patchGoal(id: string, input: PatchGoalInput) {
    const current = await this.db.select().from(goals).where(eq(goals.id, id)).limit(1);
    if (!current[0] || current[0].deletedAt) this.notFound('Goal');
    const row = current[0]!;
    if (input.parentId) await this.requireGoal(input.parentId);
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
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(goals.id, id));
    const updated = await this.db.select().from(goals).where(eq(goals.id, id)).limit(1);
    return this.serializeGoal(updated[0]!);
  }

  async deleteGoal(id: string) {
    const current = await this.db.select().from(goals).where(eq(goals.id, id)).limit(1);
    if (!current[0] || current[0].deletedAt) this.notFound('Goal');
    const row = current[0]!;
    await this.db
      .update(projects)
      .set({ goalId: null, updatedAt: new Date() })
      .where(and(eq(projects.goalId, id), isNull(projects.deletedAt)));
    await this.db
      .update(goals)
      .set({
        deletedAt: new Date(),
        status: 'ARCHIVED',
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(goals.id, id));
    return { id, deleted: true as const };
  }

  async retryCalendarSync(): Promise<{ attempted: number; synced: number; failed: number }> {
    const rows = await this.db
      .select({ id: timeBlocks.id })
      .from(timeBlocks)
      .where(
        and(
          isNull(timeBlocks.deletedAt),
          inArray(timeBlocks.syncStatus, ['PENDING', 'FAILED']),
        ),
      );
    let synced = 0;
    let failed = 0;
    for (const row of rows) {
      const result = await this.syncBlock(row.id);
      if (result.syncStatus === 'SYNCED') synced += 1;
      else failed += 1;
    }
    return { attempted: rows.length, synced, failed };
  }

  private async syncBlock(id: string) {
    const rows = await this.db.select().from(timeBlocks).where(eq(timeBlocks.id, id)).limit(1);
    const row = rows[0]!;
    if (!this.calendar.upsertCosEvent) return this.serializeBlock(row);
    try {
      const googleEventId = await this.calendar.upsertCosEvent({
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
        .where(eq(timeBlocks.id, id));
      return this.serializeBlock({ ...row, googleEventId, syncStatus: 'SYNCED' });
    } catch {
      await this.db
        .update(timeBlocks)
        .set({ syncStatus: 'FAILED', updatedAt: new Date() })
        .where(eq(timeBlocks.id, id));
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
      dueAt: row.deadlineEpochMs ? new Date(row.deadlineEpochMs).toISOString() : null,
      durationMinutes: row.estimatedMinutes,
      priority: priorityFromDb(row.priority),
      status: taskStatusFromDb(row.status),
      revision: row.revision,
    };
  }

  private serializeProject(row: typeof projects.$inferSelect) {
    return {
      id: row.id,
      title: row.title,
      goalId: row.goalId,
      color: row.color,
      lifeArea: row.lifeArea,
      description: row.description,
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
      revision: row.revision,
    };
  }

  private async requireGoal(id: string) {
    const rows = await this.db.select().from(goals).where(eq(goals.id, id)).limit(1);
    if (!rows[0] || rows[0].deletedAt) this.notFound('Goal');
  }

  private validateWindow(start: number, end: number) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw Object.assign(new Error('endAt must be after startAt'), {
        statusCode: 400,
        code: 'INVALID_TIME_BLOCK',
      });
    }
  }

  private notFound(name: string): never {
    throw Object.assign(new Error(`${name} not found`), { statusCode: 404, code: 'NOT_FOUND' });
  }
}
