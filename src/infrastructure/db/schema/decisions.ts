import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const decisions = pgTable('decisions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  context: text('context').notNull().default(''),
  status: text('status').notNull().default('OPEN'),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }),
  resolvedOptionId: text('resolved_option_id'),
  ...syncColumns,
});

export const decisionOptions = pgTable('decision_options', {
  id: text('id').primaryKey(),
  decisionId: text('decision_id').notNull(),
  label: text('label').notNull(),
  pros: text('pros').notNull().default(''),
  cons: text('cons').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  ...syncColumns,
});
