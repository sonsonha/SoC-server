import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  goalId: text('goal_id'),
  defaultGoalProcessId: text('default_goal_process_id'),
  color: text('color').notNull().default('#705CF6'),
  lifeArea: text('life_area').notNull(),
  description: text('description').notNull().default(''),
  targetDate: text('target_date'),
  active: boolean('active').notNull().default(true),
  ...syncColumns,
});
