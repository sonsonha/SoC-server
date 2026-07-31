import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const operatingPrinciples = pgTable('operating_principles', {
  id: text('id').primaryKey(),
  key: text('key').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  version: integer('version').notNull().default(1),
  ...syncColumns,
});
