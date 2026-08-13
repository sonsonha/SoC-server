import { bigint, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

/**
 * A user-owned allocation of time. Tasks remain the source of truth for work;
 * time blocks are the bridge between the planner and Google Calendar.
 */
export const timeBlocks = pgTable('time_blocks', {
  id: text('id').primaryKey(),
  taskId: text('task_id'),
  projectId: text('project_id'),
  title: text('title').notNull(),
  startEpochMs: bigint('start_epoch_ms', { mode: 'number' }).notNull(),
  endEpochMs: bigint('end_epoch_ms', { mode: 'number' }).notNull(),
  color: text('color').notNull().default('#705CF6'),
  status: text('status').notNull().default('PLANNED'),
  origin: text('origin').notNull().default('PLANNER'),
  calendarId: text('calendar_id'),
  googleEventId: text('google_event_id'),
  googleEtag: text('google_etag'),
  syncStatus: text('sync_status').notNull().default('PENDING'),
  reminderMinutes: integer('reminder_minutes'),
  recurrenceRule: text('recurrence_rule'),
  ...syncColumns,
});
