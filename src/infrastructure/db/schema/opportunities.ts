import { bigint, boolean, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const opportunities = pgTable('opportunities', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  deadlineEpochMs: bigint('deadline_epoch_ms', { mode: 'number' }),
  lastTouchedEpochMs: bigint('last_touched_epoch_ms', { mode: 'number' }).notNull().default(0),
  active: boolean('active').notNull().default(true),
  ...syncColumns,
});

export const opportunityRequirements = pgTable('opportunity_requirements', {
  id: text('id').primaryKey(),
  opportunityId: text('opportunity_id').notNull(),
  label: text('label').notNull(),
  done: boolean('done').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  sourceUrl: text('source_url'),
  ...syncColumns,
});
