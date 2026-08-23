-- Batch B phase 1: add nullable user_id to planner root aggregates.
-- Backfill with: npm run planner:backfill-owner
-- Then apply 0018 to enforce NOT NULL.

ALTER TABLE goals ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS user_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'goals_user_id_users_id_fk'
  ) THEN
    ALTER TABLE goals
      ADD CONSTRAINT goals_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_user_id_users_id_fk'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_user_id_users_id_fk'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'time_blocks_user_id_users_id_fk'
  ) THEN
    ALTER TABLE time_blocks
      ADD CONSTRAINT time_blocks_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS goals_user_id_idx ON goals (user_id);
CREATE INDEX IF NOT EXISTS goals_user_id_status_idx ON goals (user_id, status);
CREATE INDEX IF NOT EXISTS projects_user_id_idx ON projects (user_id);
CREATE INDEX IF NOT EXISTS projects_user_id_goal_id_idx ON projects (user_id, goal_id);
CREATE INDEX IF NOT EXISTS tasks_user_id_idx ON tasks (user_id);
CREATE INDEX IF NOT EXISTS tasks_user_id_status_idx ON tasks (user_id, status);
CREATE INDEX IF NOT EXISTS tasks_user_id_project_id_idx ON tasks (user_id, project_id);
CREATE INDEX IF NOT EXISTS tasks_user_id_goal_id_idx ON tasks (user_id, goal_id);
CREATE INDEX IF NOT EXISTS time_blocks_user_id_idx ON time_blocks (user_id);
CREATE INDEX IF NOT EXISTS time_blocks_user_id_task_id_idx ON time_blocks (user_id, task_id);
CREATE INDEX IF NOT EXISTS time_blocks_user_id_start_idx ON time_blocks (user_id, start_epoch_ms);
