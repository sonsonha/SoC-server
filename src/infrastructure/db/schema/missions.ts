import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const missions = pgTable('missions', {
  id: text('id').primaryKey(),
  northStar: text('north_star').notNull(),
  freedoms: jsonb('freedoms').notNull().$type<string[]>(),
  careerHypotheses: jsonb('career_hypotheses').notNull().$type<string[]>(),
  ...syncColumns,
});
