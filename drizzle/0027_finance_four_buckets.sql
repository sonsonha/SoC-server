-- Finance: 6-bucket → 4-bucket (LIVING / SAFETY / GROWTH / FUN)
-- Defaults: 50 / 15 / 30 / 5
-- INVESTING + OPPORTUNITY + LEARNING (+ legacy COMPOUND) → GROWTH

ALTER TABLE finance_allocation_settings
  ADD COLUMN IF NOT EXISTS growth_pct integer NOT NULL DEFAULT 30;
--> statement-breakpoint

-- Merge pct columns into growth_pct (before drop)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'finance_allocation_settings' AND column_name = 'investing_pct'
  ) THEN
    UPDATE finance_allocation_settings SET
      growth_pct = COALESCE(investing_pct, 0)
        + COALESCE(opportunity_pct, 0)
        + COALESCE(learning_pct, 0),
      updated_at = now();
  END IF;
END $$;
--> statement-breakpoint

-- Early V1: reset all users to the new 4-bucket policy defaults
UPDATE finance_allocation_settings SET
  living_pct = 50,
  safety_pct = 15,
  growth_pct = 30,
  fun_pct = 5,
  updated_at = now();
--> statement-breakpoint

ALTER TABLE finance_allocation_settings DROP COLUMN IF EXISTS investing_pct;
--> statement-breakpoint
ALTER TABLE finance_allocation_settings DROP COLUMN IF EXISTS opportunity_pct;
--> statement-breakpoint
ALTER TABLE finance_allocation_settings DROP COLUMN IF EXISTS learning_pct;
--> statement-breakpoint

-- Merge historical income allocation rows into GROWTH (preserve VND totals)
CREATE TEMP TABLE finance_growth_merge AS
SELECT
  income_entry_id,
  user_id,
  SUM(amount_vnd)::integer AS amount_vnd,
  LEAST(100, SUM(pct_applied))::integer AS pct_applied
FROM finance_income_allocations
WHERE bucket IN ('INVESTING', 'OPPORTUNITY', 'LEARNING', 'COMPOUND')
GROUP BY income_entry_id, user_id;
--> statement-breakpoint

-- Remove legacy bucket rows (including soft-deleted) so unique (income, bucket) is free
DELETE FROM finance_income_allocations
WHERE bucket IN ('INVESTING', 'OPPORTUNITY', 'LEARNING', 'COMPOUND');
--> statement-breakpoint

-- Fold into existing GROWTH row when present
UPDATE finance_income_allocations a
SET
  amount_vnd = a.amount_vnd + g.amount_vnd,
  pct_applied = LEAST(100, a.pct_applied + g.pct_applied),
  deleted_at = NULL,
  updated_at = now()
FROM finance_growth_merge g
WHERE a.income_entry_id = g.income_entry_id
  AND a.bucket = 'GROWTH';
--> statement-breakpoint

INSERT INTO finance_income_allocations (
  id, user_id, income_entry_id, bucket, amount_vnd, pct_applied,
  revision, updated_at, deleted_at
)
SELECT
  gen_random_uuid()::text,
  g.user_id,
  g.income_entry_id,
  'GROWTH',
  g.amount_vnd,
  g.pct_applied,
  1,
  now(),
  NULL
FROM finance_growth_merge g
WHERE NOT EXISTS (
  SELECT 1
  FROM finance_income_allocations a
  WHERE a.income_entry_id = g.income_entry_id
    AND a.bucket = 'GROWTH'
);
--> statement-breakpoint

DROP TABLE IF EXISTS finance_growth_merge;
--> statement-breakpoint

UPDATE finance_expense_entries
SET funding_bucket = 'GROWTH', updated_at = now()
WHERE funding_bucket IN ('INVESTING', 'OPPORTUNITY', 'LEARNING', 'COMPOUND');
--> statement-breakpoint

UPDATE finance_expense_categories
SET default_bucket = 'GROWTH', updated_at = now()
WHERE default_bucket IN ('INVESTING', 'OPPORTUNITY', 'LEARNING', 'COMPOUND');
--> statement-breakpoint

UPDATE finance_expense_categories
SET default_bucket = 'FUN', updated_at = now()
WHERE is_system = true AND name IN ('Shopping', 'Entertainment');
--> statement-breakpoint

UPDATE finance_expense_categories
SET default_bucket = 'GROWTH', updated_at = now()
WHERE is_system = true AND name IN ('Education', 'Books', 'Courses', 'Investing');
