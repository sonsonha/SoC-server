import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const resourceFeedback = pgTable('resource_feedback', {
  id: uuid('id').primaryKey(),
  preparationId: uuid('preparation_id').notNull(),
  resourceId: uuid('resource_id').notNull(),
  reason: text('reason').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
