import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const people = pgTable('people', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  relationship: text('relationship'),
  contextTags: jsonb('context_tags').notNull().$type<string[]>().default([]),
  ...syncColumns,
});

export const personNotes = pgTable('person_notes', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  ...syncColumns,
});
