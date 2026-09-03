import { boolean, index, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';
import { users } from './identity.js';

export const projects = pgTable(
  'projects',
  {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  goalId: text('goal_id'),
  defaultGoalProcessId: text('default_goal_process_id'),
  color: text('color').notNull().default('#705CF6'),
  lifeArea: text('life_area').notNull(),
  description: text('description').notNull().default(''),
  targetDate: text('target_date'),
  /** STANDARD = finite work; HABIT = repeated/ongoing behavior (same Project model). */
  projectType: text('project_type').notNull().default('STANDARD'),
  active: boolean('active').notNull().default(true),
  ...syncColumns,
  },
  (t) => [
    index('projects_user_id_idx').on(t.userId),
    index('projects_user_id_goal_id_idx').on(t.userId, t.goalId),
    index('projects_user_id_project_type_idx').on(t.userId, t.projectType),
  ],
);
