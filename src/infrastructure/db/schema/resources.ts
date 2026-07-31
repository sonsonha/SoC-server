import { integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export type ResourceMetadata = {
  placeId?: string;
  address?: string;
  hours?: string;
  mapsUrl?: string;
  cuisine?: string[];
  vibe?: string[];
  rating?: number;
  isBackup?: boolean;
};

export const resources = pgTable('resources', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  url: text('url'),
  format: text('format').notNull().default('ARTICLE'),
  provider: text('provider').notNull().default('unknown'),
  durationMinutes: integer('duration_minutes'),
  notes: text('notes'),
  learningItemId: text('learning_item_id'),
  metadata: jsonb('metadata').$type<ResourceMetadata | null>(),
  ...syncColumns,
});

export const resourceCandidates = pgTable('resource_candidates', {
  id: uuid('id').primaryKey(),
  preparationId: uuid('preparation_id').notNull(),
  title: text('title').notNull(),
  url: text('url'),
  snippet: text('snippet'),
  score: integer('score'),
  provider: text('provider').notNull().default('search'),
  searchQuery: text('search_query'),
  createdAt: text('created_at').notNull(),
});
