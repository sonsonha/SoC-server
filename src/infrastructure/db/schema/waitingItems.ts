import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const waitingItems = pgTable('waiting_items', {
  id: text('id').primaryKey(),
  taskId: text('task_id'),
  title: text('title').notNull(),
  waitingOnPersonId: text('waiting_on_person_id'),
  waitingOnLabel: text('waiting_on_label'),
  followUpAt: timestamp('follow_up_at', { withTimezone: true }),
  status: text('status').notNull().default('ACTIVE'),
  ...syncColumns,
});
