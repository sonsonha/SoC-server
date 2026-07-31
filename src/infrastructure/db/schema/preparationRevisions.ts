import { integer, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

export const preparationRevisions = pgTable('preparation_revisions', {
  id: uuid('id').primaryKey(),
  preparationId: uuid('preparation_id').notNull(),
  revision: integer('revision').notNull(),
  snapshot: jsonb('snapshot').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
