import { jsonb, pgTable, uuid } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export type PreferenceWeights = {
  formatWeights?: Record<string, number>;
  maxDurationMinutes?: number | null;
  avoidProviders?: string[];
  penalizeLongForm?: boolean;
  penalizeVideo?: boolean;
};

export const GLOBAL_PREFERENCE_ID = '00000000-0000-4000-8000-000000000001';

export const resourcePreferences = pgTable('resource_preferences', {
  id: uuid('id').primaryKey(),
  weights: jsonb('weights').notNull().$type<PreferenceWeights>().default({}),
  ...syncColumns,
});
