import { boolean, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const seasons = pgTable('seasons', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  narrative: text('narrative').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date'),
  priorityGoalIds: jsonb('priority_goal_ids').notNull().$type<string[]>(),
  active: boolean('active').notNull().default(true),
  ...syncColumns,
});
