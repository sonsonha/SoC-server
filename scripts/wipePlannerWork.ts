import { sql } from 'drizzle-orm';
import type { createDb } from '../src/infrastructure/db/client.js';

/** Planner / demo work. Credentials and profile settings are not in this list. */
export const PLANNER_WORK_TABLES = [
  'time_blocks',
  'plan_blocks',
  'daily_plans',
  'weekly_plans',
  'weekly_outcomes',
  'planning_runs',
  'plan_revisions',
  'durable_jobs',
  'completions',
  'preparation_revisions',
  'resource_feedback',
  'resource_candidates',
  'resources',
  'resource_preferences',
  'preparations',
  'inbox_items',
  'waiting_items',
  'decision_options',
  'decisions',
  'person_notes',
  'people',
  'opportunity_requirements',
  'opportunities',
  'calendar_commitments',
  'notification_log',
  'client_mutations',
  'sync_cursors',
  'tasks',
  'projects',
  'goals',
] as const;

export const PRESERVED_TABLES = [
  'device_credentials',
  'integration_tokens',
  'calendar_sync_state',
  'device_fcm_tokens',
  'missions',
  'operating_principles',
  'seasons',
  'locations',
  'travel_edges',
  'skill_levels',
  'profile_status',
  'learning_items',
  'learning_tracks',
  'planning_preferences',
  'drizzle.__drizzle_migrations',
] as const;

export async function countTable(db: ReturnType<typeof createDb>, table: string): Promise<number> {
  const rows = await db.execute(sql.raw(`SELECT COUNT(*)::int AS count FROM ${table}`));
  const first = rows[0] as { count?: number } | undefined;
  return Number(first?.count ?? 0);
}

export async function previewPlannerWork(db: ReturnType<typeof createDb>) {
  const counts: Record<string, number> = {};
  for (const table of PLANNER_WORK_TABLES) {
    try {
      counts[table] = await countTable(db, table);
    } catch {
      counts[table] = -1;
    }
  }
  return counts;
}

export async function wipePlannerWork(db: ReturnType<typeof createDb>) {
  const present: string[] = [];
  for (const table of PLANNER_WORK_TABLES) {
    try {
      await countTable(db, table);
      present.push(table);
    } catch {
      // Table not migrated yet.
    }
  }
  if (present.length === 0) return;
  await db.execute(sql.raw(`TRUNCATE TABLE ${present.join(', ')} CASCADE`));
}
