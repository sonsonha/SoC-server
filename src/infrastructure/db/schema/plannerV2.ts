import { bigint, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';
import { users } from './identity.js';

/**
 * A user-owned allocation of time. Tasks remain the source of truth for work;
 * time blocks are the bridge between the planner and Google Calendar.
 */
export const timeBlocks = pgTable(
  'time_blocks',
  {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
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
  },
  (t) => [
    index('time_blocks_user_id_idx').on(t.userId),
    index('time_blocks_user_id_task_id_idx').on(t.userId, t.taskId),
    index('time_blocks_user_id_start_idx').on(t.userId, t.startEpochMs),
  ],
);
