import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const skillLevels = pgTable('skill_levels', {
  id: text('id').primaryKey(),
  domain: text('domain').notNull(),
  level: integer('level').notNull().default(1), // 1–5
  notes: text('notes'),
  ...syncColumns,
});

/** Singleton personal status / chapter (id typically `profile-status`). */
export const profileStatus = pgTable('profile_status', {
  id: text('id').primaryKey(),
  chapter: text('chapter').notNull().default('WORKING'), // STUDENT | WORKING | APPLYING_ABROAD | OTHER
  summary: text('summary').notNull().default(''),
  usualLeaveHome: text('usual_leave_home'), // HH:mm
  preferredCountries: text('preferred_countries').notNull().default('[]'), // JSON string array
  ...syncColumns,
});
