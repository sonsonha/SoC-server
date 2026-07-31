import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const learningItems = pgTable('learning_items', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  why: text('why').notNull().default(''),
  source: text('source').notNull().default(''),
  tier: text('tier').notNull().default('NEXT'),
  estimatedMinutes: integer('estimated_minutes').notNull().default(45),
  definitionOfDone: text('definition_of_done').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  ...syncColumns,
});
