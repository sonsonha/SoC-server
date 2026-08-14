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
      projects: projectRows.map((row) => ({
        id: row.id,
        title: row.title,
        goalId: row.goalId,
        color: row.color,
        active: row.active,
      })),
      goals: goalRows.map((row) => ({
        id: row.id,
        title: row.title,
        horizon: row.horizon,
        status: row.status,
        targetDate: row.targetDate,
        parentId: row.parentId,
      })),
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
    return { id, status: taskStatusFromDb(status), revision: row.revision + 1 };
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
    return { id, deleted: true };
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
