import { doublePrecision, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const locations = pgTable('locations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  openingHours: text('opening_hours'),
  notes: text('notes'),
  ...syncColumns,
});

export const travelEdges = pgTable('travel_edges', {
  id: text('id').primaryKey(),
  fromLocationId: text('from_location_id').notNull(),
  toLocationId: text('to_location_id').notNull(),
  typicalMinutes: integer('typical_minutes').notNull(),
  ...syncColumns,
});
