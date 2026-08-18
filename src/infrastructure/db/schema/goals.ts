import { integer, pgTable, real, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

/**
 * Hierarchical goals.
 * horizon: MISSION | YEAR | QUARTER | MONTH | WEEK | SHORT | LONG
 * parentId links Month→Quarter→Year (etc). SHORT/LONG kept for legacy sync.
 */
export const goals = pgTable('goals', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  lifeArea: text('life_area').notNull(),
  seasonId: text('season_id'),
  description: text('description').notNull().default(''),
  horizon: text('horizon').notNull().default('SHORT'),
  status: text('status').notNull().default('ACTIVE'),
  targetDate: text('target_date'),
  parentId: text('parent_id'),
  successCriteria: text('success_criteria').notNull().default(''),
  capacityShare: real('capacity_share'),
  outcome: text('outcome').notNull().default(''),
  why: text('why').notNull().default(''),
  metric: text('metric').notNull().default(''),
  focusType: text('focus_type').notNull().default('FOCUS'),
  currentMilestoneId: text('current_milestone_id'),
  milestonesJson: text('milestones_json').notNull().default('[]'),
  systemsJson: text('systems_json').notNull().default('[]'),
  ...syncColumns,
});
