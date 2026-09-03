import { bigint, boolean, index, integer, pgTable, real, text } from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';
import { users } from './identity.js';

export const tasks = pgTable(
  'tasks',
  {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  projectId: text('project_id'),
  goalId: text('goal_id'),
  goalProcessId: text('goal_process_id'),
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
  completedAtEpochMs: bigint('completed_at_epoch_ms', { mode: 'number' }),
  /** Links materialized Task instances from Repeat Task / Repeat Session. */
  repeatSeriesId: text('repeat_series_id'),
  /** Source Task when a Session was carried into a new horizon. */
  carryOverFromTaskId: text('carry_over_from_task_id'),
  /** Human-readable provenance for cross-week carry-over. */
  carryOverNote: text('carry_over_note'),
  verificationLevel: text('verification_level').notNull().default('SELF'),
  isAnchorCandidate: boolean('is_anchor_candidate').notNull().default(false),
  estimateBiasFactor: real('estimate_bias_factor').notNull().default(1),
  ...syncColumns,
  },
  (t) => [
    index('tasks_user_id_idx').on(t.userId),
    index('tasks_user_id_status_idx').on(t.userId, t.status),
    index('tasks_user_id_project_id_idx').on(t.userId, t.projectId),
    index('tasks_user_id_goal_id_idx').on(t.userId, t.goalId),
    index('tasks_user_id_repeat_series_id_idx').on(t.userId, t.repeatSeriesId),
  ],
);
