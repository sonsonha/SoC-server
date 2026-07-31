import { integer, timestamp } from 'drizzle-orm/pg-core';

/** Shared sync metadata columns for cloud-canonical entities. */
export const syncColumns = {
  revision: integer('revision').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};
