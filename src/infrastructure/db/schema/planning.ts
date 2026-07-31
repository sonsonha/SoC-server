import { integer, jsonb, pgTable, real, text, timestamp } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const weeklyPlans = pgTable('weekly_plans', {
  id: text('id').primaryKey(),
  weekStart: text('week_start').notNull(),
  seasonId: text('season_id'),
  status: text('status').notNull().default('ACTIVE'),
  reviewState: text('review_state').notNull().default('UNREVIEWED'),
  capacityMinutes: integer('capacity_minutes').notNull().default(0),
  utilizedMinutes: integer('utilized_minutes').notNull().default(0),
  utilizationTarget: real('utilization_target').notNull().default(0.7),
  bufferMinutes: integer('buffer_minutes').notNull().default(180),
  summary: text('summary'),
  conflictNotes: text('conflict_notes'),
  calendarSyncStatus: text('calendar_sync_status').notNull().default('PENDING'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  supersededBy: text('superseded_by'),
  ...syncColumns,
});

export const weeklyOutcomes = pgTable('weekly_outcomes', {
  id: text('id').primaryKey(),
  weeklyPlanId: text('weekly_plan_id').notNull(),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  goalId: text('goal_id'),
  monthGoalId: text('month_goal_id'),
  quarterGoalId: text('quarter_goal_id'),
  yearGoalId: text('year_goal_id'),
  status: text('status').notNull().default('ACTIVE'),
  successCriteria: text('success_criteria').notNull().default(''),
  ...syncColumns,
});

export const planningPreferences = pgTable('planning_preferences', {
  id: text('id').primaryKey().default('default'),
  timezone: text('timezone').notNull().default('Asia/Ho_Chi_Minh'),
  sundayPrepLocalTime: text('sunday_prep_local_time').notNull().default('18:00'),
  eveningPrepLocalTime: text('evening_prep_local_time').notNull().default('21:00'),
  morningRefreshOffsetMinutes: integer('morning_refresh_offset_minutes').notNull().default(45),
  wakeLocalTime: text('wake_local_time').notNull().default('07:00'),
  capacityUtilization: real('capacity_utilization').notNull().default(0.7),
  autonomy: text('autonomy').notNull().default('COS_CALENDAR_WRITE'),
  workStartLocal: text('work_start_local').notNull().default('09:00'),
  workEndLocal: text('work_end_local').notNull().default('18:00'),
  sleepTargetHours: real('sleep_target_hours').notNull().default(7.5),
  maxReschedulesBeforeDecision: integer('max_reschedules_before_decision').notNull().default(3),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const planningRuns = pgTable('planning_runs', {
  id: text('id').primaryKey(),
  runType: text('run_type').notNull(),
  targetPeriod: text('target_period').notNull(),
  trigger: text('trigger').notNull().default('SCHEDULE'),
  status: text('status').notNull().default('RUNNING'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  inputRevision: integer('input_revision'),
  outputPlanId: text('output_plan_id'),
  outputRevision: integer('output_revision'),
  error: text('error'),
  retryCount: integer('retry_count').notNull().default(0),
  idempotencyKey: text('idempotency_key').notNull(),
  details: jsonb('details').notNull().$type<Record<string, unknown>>().default({}),
});

export const durableJobs = pgTable('durable_jobs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
  status: text('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const planRevisions = pgTable('plan_revisions', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  revision: integer('revision').notNull(),
  trigger: text('trigger'),
  summary: text('summary'),
  diff: jsonb('diff').notNull().$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
