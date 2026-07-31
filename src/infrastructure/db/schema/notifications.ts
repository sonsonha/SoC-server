import { pgTable, text, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core';
import { deviceCredentials } from './deviceCredentials.js';

export const deviceFcmTokens = pgTable('device_fcm_tokens', {
  deviceId: uuid('device_id')
    .primaryKey()
    .references(() => deviceCredentials.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  platform: text('platform').notNull().default('android'),
  autonomy: text('autonomy').notNull().default('SUGGEST'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationLog = pgTable('notification_log', {
  id: text('id').primaryKey(),
  deviceId: uuid('device_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  deepLink: text('deep_link'),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
});

export const proactiveScanRuns = pgTable('proactive_scan_runs', {
  id: text('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  summary: jsonb('summary').$type<Record<string, unknown>>(),
});
