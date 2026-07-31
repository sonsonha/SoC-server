import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const completions = pgTable('completions', {
  id: uuid('id').primaryKey(),
  preparationId: uuid('preparation_id'),
  taskId: text('task_id'),
  grade: text('grade').notNull().default('FULL'),
  minutes: integer('minutes').notNull(),
  note: text('note'),
  ...syncColumns,
});
