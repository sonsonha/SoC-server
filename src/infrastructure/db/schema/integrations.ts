import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';

export const integrationTokens = pgTable(
  'integration_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    scopes: text('scopes'),
    googleAccountSub: text('google_account_sub'),
    googleAccountEmail: text('google_account_email'),
    writeCalendarId: text('write_calendar_id'),
    status: text('status').notNull().default('connected'),
    lastErrorCode: text('last_error_code'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('integration_tokens_user_provider_uidx').on(t.userId, t.provider),
    index('integration_tokens_user_id_idx').on(t.userId),
  ],
);

export const calendarCommitments = pgTable(
  'calendar_commitments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    externalCalendarEventId: text('external_calendar_event_id').notNull(),
    title: text('title').notNull(),
    startEpochMs: bigint('start_epoch_ms', { mode: 'number' }).notNull(),
    endEpochMs: bigint('end_epoch_ms', { mode: 'number' }).notNull(),
    location: text('location'),
    calendarId: text('calendar_id').notNull().default('primary'),
    revision: integer('revision').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('calendar_commitments_user_id_idx').on(t.userId),
    index('calendar_commitments_user_window_idx').on(t.userId, t.startEpochMs, t.endEpochMs),
  ],
);

export const calendarSyncState = pgTable(
  'calendar_sync_state',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'restrict' }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSyncToken: text('last_sync_token'),
    lastReplanAt: timestamp('last_replan_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    reconnectRequired: boolean('reconnect_required').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('calendar_sync_state_user_id_uidx').on(t.userId)],
);

/** One-time OAuth states binding Railway callback → Personal OS user (Vercel cookie absent). */
export const oauthConnectionStates = pgTable(
  'oauth_connection_states',
  {
    id: text('id').primaryKey(),
    stateHash: text('state_hash').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('oauth_connection_states_state_hash_uidx').on(t.stateHash),
    index('oauth_connection_states_user_id_idx').on(t.userId),
    index('oauth_connection_states_expires_at_idx').on(t.expiresAt),
  ],
);
