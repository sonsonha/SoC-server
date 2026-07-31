import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

/** User-confirmed learning curriculum track (Phase 11). */
export const learningTracks = pgTable('learning_tracks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  lifeArea: text('life_area').notNull().default('INTELLECTUAL'),
  topic: text('topic').notNull(),
  priority: integer('priority').notNull().default(3),
  targetPerWeek: integer('target_per_week').notNull().default(2),
  horizon: text('horizon').notNull().default('WEEK'), // WEEK | MONTH
  status: text('status').notNull().default('ACTIVE'), // ACTIVE | PAUSED | DONE
  goalId: text('goal_id'),
  skillId: text('skill_id'),
  definitionOfProgress: text('definition_of_progress').notNull().default(''),
  recommendationId: text('recommendation_id'),
  ...syncColumns,
});
