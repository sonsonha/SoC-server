-- Batch B phase 2: require ownership after backfill.
-- Fails if any NULL user_id remains — run planner:backfill-owner first.

DO $$
DECLARE
  null_goals INTEGER;
  null_projects INTEGER;
  null_tasks INTEGER;
  null_blocks INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_goals FROM goals WHERE user_id IS NULL;
  SELECT COUNT(*) INTO null_projects FROM projects WHERE user_id IS NULL;
  SELECT COUNT(*) INTO null_tasks FROM tasks WHERE user_id IS NULL;
  SELECT COUNT(*) INTO null_blocks FROM time_blocks WHERE user_id IS NULL;

  IF null_goals > 0 OR null_projects > 0 OR null_tasks > 0 OR null_blocks > 0 THEN
    RAISE EXCEPTION
      'planner ownership backfill incomplete: goals=% projects=% tasks=% time_blocks=% NULL user_id rows remain. Run: npm run planner:backfill-owner',
      null_goals, null_projects, null_tasks, null_blocks;
  END IF;
END $$;

ALTER TABLE goals ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE projects ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE time_blocks ALTER COLUMN user_id SET NOT NULL;
