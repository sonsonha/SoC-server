import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../infrastructure/db/client.js';
import { completions, tasks } from '../infrastructure/db/schema/index.js';
import type { LearningCurriculumService } from '../modules/learning/curriculumService.js';

export type CompletionInput = {
  preparationId?: string;
  taskId?: string;
  grade: 'FULL' | 'PARTIAL' | 'FLOOR';
  minutes: number;
  note?: string;
};

export class CompletionService {
  private learning: LearningCurriculumService | null = null;

  constructor(private readonly db: Db) {}

  setLearningService(service: LearningCurriculumService): void {
    this.learning = service;
  }

  async record(input: CompletionInput) {
    const id = randomUUID();
    const now = new Date();

    const existing = input.preparationId
      ? await this.db
          .select()
          .from(completions)
          .where(eq(completions.preparationId, input.preparationId))
          .limit(1)
      : [];

    if (existing.length > 0) {
      return { completionId: existing[0].id, idempotent: true as const, skillSuggestion: null };
    }

    await this.db.insert(completions).values({
      id,
      preparationId: input.preparationId ?? null,
      taskId: input.taskId ?? null,
      grade: input.grade,
      minutes: input.minutes,
      note: input.note ?? null,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });

    if (input.taskId) {
      const taskRows = await this.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1);
      const task = taskRows[0];
      if (task) {
        const newActual = (task.actualMinutes ?? 0) + input.minutes;
        const status = input.grade === 'FULL' ? 'DONE' : 'IN_PROGRESS';
        await this.db
          .update(tasks)
          .set({
            actualMinutes: newActual,
            status,
            revision: task.revision + 1,
            updatedAt: now,
          })
          .where(eq(tasks.id, input.taskId));
      }
    }

    const skillSuggestion =
      input.grade === 'FULL' && input.taskId && this.learning
        ? await this.learning.skillSuggestionForTask(input.taskId)
        : null;

    return { completionId: id, idempotent: false as const, skillSuggestion };
  }
}
