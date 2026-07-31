import { bigint, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const inboxItems = pgTable('inbox_items', {
  id: uuid('id').primaryKey(),
  rawText: text('raw_text').notNull(),
  createdAtEpochMs: bigint('created_at_epoch_ms', { mode: 'number' }).notNull(),
  parseStatus: text('parse_status').notNull().default('PARSED'),
  linkedEntityIds: jsonb('linked_entity_ids').notNull().$type<string[]>().default([]),
  parseJson: jsonb('parse_json').$type<Record<string, unknown>>(),
  ...syncColumns,
});
