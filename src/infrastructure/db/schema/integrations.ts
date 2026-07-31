import { bigint, pgTable, text, timestamp, integer, uniqueIndex } from 'drizzle-orm/pg-core';

export const integrationTokens = pgTable(
  'integration_tokens',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    scopes: text('scopes'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('integration_tokens_provider_uidx').on(t.provider)],
);

export const calendarCommitments = pgTable('calendar_commitments', {
  id: text('id').primaryKey(),
  externalCalendarEventId: text('external_calendar_event_id').notNull(),
  title: text('title').notNull(),
  startEpochMs: bigint('start_epoch_ms', { mode: 'number' }).notNull(),
  endEpochMs: bigint('end_epoch_ms', { mode: 'number' }).notNull(),
  location: text('location'),
  calendarId: text('calendar_id').notNull().default('primary'),
  revision: integer('revision').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const calendarSyncState = pgTable('calendar_sync_state', {
  id: text('id').primaryKey().default('default'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncToken: text('last_sync_token'),
  lastReplanAt: timestamp('last_replan_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
