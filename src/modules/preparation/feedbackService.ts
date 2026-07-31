import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../../infrastructure/db/client.js';
import { preparations, resourceFeedback } from '../../infrastructure/db/schema/index.js';
import type { FeedbackReason } from '../../domain/feedback.js';
import type { JobQueue } from '../../infrastructure/jobs/jobQueue.js';
import { PreferenceService } from '../resources/preferenceService.js';

const MAX_REPLACES_PER_DAY = 5;

export class FeedbackService {
  private readonly preferences: PreferenceService;

  constructor(
    private readonly db: Db,
    private readonly jobs: JobQueue,
  ) {
    this.preferences = new PreferenceService(db);
  }

  async submitFeedback(
    preparationId: string,
    reason: FeedbackReason,
    note?: string,
  ): Promise<{ preparationId: string; status: string }> {
    const prepRows = await this.db
      .select()
      .from(preparations)
      .where(eq(preparations.id, preparationId))
      .limit(1);
    const prep = prepRows[0];
    if (!prep || prep.deletedAt) {
      throw Object.assign(new Error('Preparation not found'), { statusCode: 404 });
    }
    if (!prep.selectedResourceId) {
      throw Object.assign(new Error('No resource to replace'), { statusCode: 400 });
    }

    const feedbackToday = await this.db.select().from(resourceFeedback);
    const todayCount = feedbackToday.filter(
      (f) =>
        f.preparationId === preparationId &&
        f.createdAt >= new Date(new Date().setHours(0, 0, 0, 0)),
    ).length;
    if (todayCount >= MAX_REPLACES_PER_DAY) {
      throw Object.assign(new Error('Max replacements per day reached'), { statusCode: 429 });
    }

    const now = new Date();
    await this.db.insert(resourceFeedback).values({
      id: randomUUID(),
      preparationId,
      resourceId: prep.selectedResourceId,
      reason,
      note: note ?? null,
      createdAt: now,
    });

    await this.preferences.applyFeedback(reason, note);

    const allFeedback = await this.db
      .select()
      .from(resourceFeedback)
      .where(eq(resourceFeedback.preparationId, preparationId));
    const excludeResourceIds = [...new Set(allFeedback.map((f) => f.resourceId))];

    await this.db
      .update(preparations)
      .set({
        status: 'PREPARING',
        updatedAt: now,
        revision: prep.revision + 1,
      })
      .where(eq(preparations.id, preparationId));

    this.jobs.enqueue('preparation.replace', {
      preparationId,
      excludeResourceIds,
    });

    return { preparationId, status: 'PREPARING' };
  }
}
