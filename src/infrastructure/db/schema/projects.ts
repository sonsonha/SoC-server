import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  lifeArea: text('life_area').notNull(),
  description: text('description').notNull().default(''),
  active: boolean('active').notNull().default(true),
  ...syncColumns,
});
