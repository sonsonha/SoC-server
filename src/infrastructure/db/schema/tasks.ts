import { bigint, boolean, integer, pgTable, real, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  projectId: text('project_id'),
  lifeArea: text('life_area').notNull().default('LEARNING'),
  priority: integer('priority').notNull().default(2),
  deadlineEpochMs: bigint('deadline_epoch_ms', { mode: 'number' }),
  estimatedMinutes: integer('estimated_minutes').notNull().default(30),
  actualMinutes: integer('actual_minutes'),
  energyRequirement: integer('energy_requirement').notNull().default(2),
  locationRequirements: text('location_requirements').notNull().default('[]'),
  dependencyIds: text('dependency_ids').notNull().default('[]'),
  preferredTime: text('preferred_time'),
  earliestStartEpochMs: bigint('earliest_start_epoch_ms', { mode: 'number' }),
  deadlineFlexible: boolean('deadline_flexible').notNull().default(true),
  interruptible: boolean('interruptible').notNull().default(true),
  deepWork: boolean('deep_work').notNull().default(false),
  nextAction: text('next_action'),
  rescheduleCount: integer('reschedule_count').notNull().default(0),
  status: text('status').notNull().default('TODO'),
  verificationLevel: text('verification_level').notNull().default('SELF'),
  isAnchorCandidate: boolean('is_anchor_candidate').notNull().default(false),
  estimateBiasFactor: real('estimate_bias_factor').notNull().default(1),
  ...syncColumns,
});
