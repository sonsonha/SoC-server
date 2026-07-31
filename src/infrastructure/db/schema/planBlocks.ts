import { bigint, boolean, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const planBlocks = pgTable('plan_blocks', {
  id: text('id').primaryKey(),
  dailyPlanId: text('daily_plan_id').notNull(),
  date: text('date').notNull(),
  startEpochMs: bigint('start_epoch_ms', { mode: 'number' }).notNull(),
  endEpochMs: bigint('end_epoch_ms', { mode: 'number' }).notNull(),
  type: text('type').notNull(),
  ownership: text('ownership').notNull().default('COS'),
  title: text('title').notNull(),
  taskId: text('task_id'),
  habitId: text('habit_id'),
  commitmentId: text('commitment_id'),
  locationId: text('location_id'),
  locked: boolean('locked').notNull().default(false),
  preparationId: uuid('preparation_id'),
  /** Google COS calendar event id — never set for EXTERNAL ownership. */
  externalCalendarEventId: text('external_calendar_event_id'),
  goalId: text('goal_id'),
  weeklyOutcomeId: text('weekly_outcome_id'),
  ...syncColumns,
});
