-- Finance analytics: policy pcts on income, safety target months, category recurrence

ALTER TABLE finance_allocation_settings
  ADD COLUMN IF NOT EXISTS safety_target_months integer NOT NULL DEFAULT 6;
--> statement-breakpoint

ALTER TABLE finance_income_entries
  ADD COLUMN IF NOT EXISTS policy_living_pct integer NOT NULL DEFAULT 50;
--> statement-breakpoint
ALTER TABLE finance_income_entries
  ADD COLUMN IF NOT EXISTS policy_safety_pct integer NOT NULL DEFAULT 15;
--> statement-breakpoint
ALTER TABLE finance_income_entries
  ADD COLUMN IF NOT EXISTS policy_growth_pct integer NOT NULL DEFAULT 30;
--> statement-breakpoint
ALTER TABLE finance_income_entries
  ADD COLUMN IF NOT EXISTS policy_fun_pct integer NOT NULL DEFAULT 5;
--> statement-breakpoint

-- Backfill policy pcts from existing allocation snapshot pcts (best effort)
UPDATE finance_income_entries e
SET
  policy_living_pct = COALESCE((
    SELECT a.pct_applied FROM finance_income_allocations a
    WHERE a.income_entry_id = e.id AND a.bucket = 'LIVING' AND a.deleted_at IS NULL
    LIMIT 1
  ), 50),
  policy_safety_pct = COALESCE((
    SELECT a.pct_applied FROM finance_income_allocations a
    WHERE a.income_entry_id = e.id AND a.bucket = 'SAFETY' AND a.deleted_at IS NULL
    LIMIT 1
  ), 15),
  policy_growth_pct = COALESCE((
    SELECT a.pct_applied FROM finance_income_allocations a
    WHERE a.income_entry_id = e.id AND a.bucket = 'GROWTH' AND a.deleted_at IS NULL
    LIMIT 1
  ), 30),
  policy_fun_pct = COALESCE((
    SELECT a.pct_applied FROM finance_income_allocations a
    WHERE a.income_entry_id = e.id AND a.bucket = 'FUN' AND a.deleted_at IS NULL
    LIMIT 1
  ), 5),
  updated_at = now();
--> statement-breakpoint

-- Recurrence dimension (FIXED | VARIABLE); necessity remains in kind (approx)
ALTER TABLE finance_expense_categories
  ADD COLUMN IF NOT EXISTS recurrence text NOT NULL DEFAULT 'VARIABLE';
--> statement-breakpoint

UPDATE finance_expense_categories
SET recurrence = 'FIXED', updated_at = now()
WHERE kind = 'FIXED';
--> statement-breakpoint

UPDATE finance_expense_categories
SET recurrence = 'VARIABLE', updated_at = now()
WHERE kind IN ('ESSENTIAL', 'DISCRETIONARY', 'OTHER')
  AND recurrence IS DISTINCT FROM 'FIXED';
