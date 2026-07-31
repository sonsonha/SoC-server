import { and, eq, isNull, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import { waitingItems, tasks } from '../../infrastructure/db/schema/index.js';

export class WaitingService {
  constructor(private readonly db: Db) {}

  async listActive() {
    return this.db
      .select()
      .from(waitingItems)
      .where(and(eq(waitingItems.status, 'ACTIVE'), isNull(waitingItems.deletedAt)))
      .orderBy(desc(waitingItems.updatedAt));
  }

  async create(input: {
    title: string;
    taskId?: string;
    waitingOnPersonId?: string;
    waitingOnLabel?: string;
    followUpAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(waitingItems).values({
      id,
      taskId: input.taskId ?? null,
      title: input.title,
      waitingOnPersonId: input.waitingOnPersonId ?? null,
      waitingOnLabel: input.waitingOnLabel ?? null,
      followUpAt: input.followUpAt ?? null,
      status: 'ACTIVE',
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    return id;
  }

  async resolve(id: string): Promise<void> {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(waitingItems)
      .where(and(eq(waitingItems.id, id), isNull(waitingItems.deletedAt)))
      .limit(1);
    const item = rows[0];
    if (!item) {
      throw Object.assign(new Error('Waiting item not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }

    await this.db
      .update(waitingItems)
      .set({ status: 'RESOLVED', revision: item.revision + 1, updatedAt: now })
      .where(eq(waitingItems.id, id));

    if (item.taskId) {
      const taskRows = await this.db.select().from(tasks).where(eq(tasks.id, item.taskId)).limit(1);
      const task = taskRows[0];
      if (task && task.status === 'WAITING') {
        await this.db
          .update(tasks)
          .set({ status: 'TODO', revision: task.revision + 1, updatedAt: now })
          .where(eq(tasks.id, item.taskId));
      }
    }
  }
}
