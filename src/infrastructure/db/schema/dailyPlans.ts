import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const dailyPlans = pgTable('daily_plans', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  mainOutcome: text('main_outcome'),
  anchorTaskIds: jsonb('anchor_task_ids').notNull().$type<string[]>().default([]),
  briefing: text('briefing'),
  bufferMinutes: integer('buffer_minutes').notNull().default(30),
  hardStopNotes: text('hard_stop_notes'),
  /** PROPOSED | ACCEPTED — calendar activation */
  status: text('status').notNull().default('PROPOSED'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  weeklyPlanId: text('weekly_plan_id'),
  /** UNREVIEWED | REVIEWED | MANUALLY_ADJUSTED — review is optional */
  reviewState: text('review_state').notNull().default('UNREVIEWED'),
  /** GENERATED | ACTIVE | SUPERSEDED | DRAFT */
  planState: text('plan_state').notNull().default('GENERATED'),
  goalIds: jsonb('goal_ids').notNull().$type<string[]>().default([]),
  firstActionTitle: text('first_action_title'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  ...syncColumns,
});
