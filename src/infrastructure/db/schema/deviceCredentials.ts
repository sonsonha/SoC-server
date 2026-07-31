import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
} from 'drizzle-orm/pg-core';

export const deviceCredentials = pgTable('device_credentials', {
  id: uuid('id').primaryKey(),
  secretHash: text('secret_hash').notNull(),
  label: text('label'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
});

export const syncCursors = pgTable('sync_cursors', {
  deviceId: uuid('device_id')
    .primaryKey()
    .references(() => deviceCredentials.id, { onDelete: 'cascade' }),
  cursor: text('cursor').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clientMutations = pgTable('client_mutations', {
  mutationId: uuid('mutation_id').primaryKey(),
  deviceId: uuid('device_id')
    .notNull()
    .references(() => deviceCredentials.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  operation: text('operation').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
});
