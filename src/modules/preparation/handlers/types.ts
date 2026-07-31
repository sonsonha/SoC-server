import type { preparations } from '../../../infrastructure/db/schema/preparations.js';

export type PrepRow = typeof preparations.$inferSelect;

export type PreparationRunContext = {
  prep: PrepRow;
  preparationId: string;
  excludeResourceIds: string[];
  excludeUrls: Set<string>;
  fail: (reason: string) => Promise<void>;
  setNeedsInput: (reason: string) => Promise<void>;
  insertResource: (input: {
    title: string;
    url: string;
    format: string;
    provider: string;
    snippet: string;
    learningItemId: string | null;
    metadata?: import('../../../infrastructure/db/schema/resources.js').ResourceMetadata | null;
  }) => Promise<string>;
  finishReady: (input: {
    goal: string;
    practicePrompt: string;
    doneCriteria: string[];
    selectedResourceId: string;
    backupResourceIds: string[];
    provenance: Record<string, unknown>;
    freshnessPolicy: 'STATIC' | 'DAILY' | 'EVENT_BOUND';
  }) => Promise<void>;
};
