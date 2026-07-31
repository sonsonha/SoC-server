import type { JobQueue } from './jobQueue.js';
import type { PreparationService } from '../../application/preparationService.js';

export function registerPreparationReplaceJob(
  jobQueue: JobQueue,
  preparationService: PreparationService,
): void {
  jobQueue.register('preparation.replace', async (payload) => {
    await preparationService.replace(payload.preparationId, payload.excludeResourceIds);
  });
}
