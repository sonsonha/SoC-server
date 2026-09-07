import { bigint, boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';
import { users } from './identity.js';

type SessionOutcomeItemRow = { id: string; text: string; done: boolean };

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
  /** Optional intention/result for one execution session (separate from Task notes). */
  notes: text('notes').notNull().default(''),
  completedAtEpochMs: bigint('completed_at_epoch_ms', { mode: 'number' }),
  /**
   * Daily Focus belongs to this Session instance (not the parent Task).
   * Local focus date = Asia/Ho_Chi_Minh day of startEpochMs.
   * Completing the Session must NOT clear this flag (historical adherence).
   */
  isDailyFocus: boolean('is_daily_focus').notNull().default(false),
  /**
   * Optional Session Outcome (NONE | CHECKLIST | QUANTITY).
   * Independent from status/DONE and from Task definition_of_done.
   */
  sessionOutcomeType: text('session_outcome_type').notNull().default('NONE'),
  sessionOutcomeItems: jsonb('session_outcome_items').$type<SessionOutcomeItemRow[] | null>(),
  sessionOutcomeTarget: integer('session_outcome_target'),
  sessionOutcomeActual: integer('session_outcome_actual'),
  sessionOutcomeUnit: text('session_outcome_unit'),
  /** Links corresponding Sessions across materialized weeks (Repeat Session / Repeat Task). */
  repeatSeriesId: text('repeat_series_id'),
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
    index('time_blocks_user_id_repeat_series_id_idx').on(t.userId, t.repeatSeriesId),
    index('time_blocks_user_id_is_daily_focus_idx').on(t.userId, t.isDailyFocus),
  ],
);
