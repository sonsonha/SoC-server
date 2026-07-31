import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const preparations = pgTable('preparations', {
  id: uuid('id').primaryKey(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  status: text('status').notNull().default('PENDING'),
  scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }).notNull(),
  timeBudgetMinutes: integer('time_budget_minutes').notNull(),
  goal: text('goal').notNull().default(''),
  practicePrompt: text('practice_prompt').notNull().default(''),
  doneCriteria: jsonb('done_criteria').notNull().$type<string[]>().default([]),
  selectedResourceId: uuid('selected_resource_id'),
  backupResourceIds: jsonb('backup_resource_ids').notNull().$type<string[]>().default([]),
  provenance: jsonb('provenance').$type<Record<string, unknown>>(),
  freshnessPolicy: text('freshness_policy').notNull().default('STATIC'),
  lastPreparedAt: timestamp('last_prepared_at', { withTimezone: true }),
  failureReason: text('failure_reason'),
  ...syncColumns,
});
