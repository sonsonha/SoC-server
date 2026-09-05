-- Finance: 4-bucket → 6-bucket allocation model
-- LIVING 40 / SAFETY 5 / INVESTING 30 / OPPORTUNITY 10 / LEARNING 10 / FUN 5

ALTER TABLE finance_allocation_settings
  ADD COLUMN IF NOT EXISTS investing_pct integer NOT NULL DEFAULT 30;
--> statement-breakpoint
ALTER TABLE finance_allocation_settings
  ADD COLUMN IF NOT EXISTS learning_pct integer NOT NULL DEFAULT 10;
--> statement-breakpoint
ALTER TABLE finance_allocation_settings
  ADD COLUMN IF NOT EXISTS fun_pct integer NOT NULL DEFAULT 5;
--> statement-breakpoint

-- Map legacy compound_pct → investing_pct when column still exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'finance_allocation_settings' AND column_name = 'compound_pct'
  ) THEN
    UPDATE finance_allocation_settings
    SET investing_pct = compound_pct
    WHERE investing_pct = 30 AND compound_pct IS DISTINCT FROM 30;
  END IF;
END $$;
--> statement-breakpoint

-- Reset all users to the new policy defaults (early V1)
UPDATE finance_allocation_settings SET
  living_pct = 40,
  safety_pct = 5,
  investing_pct = 30,
  opportunity_pct = 10,
  learning_pct = 10,
  fun_pct = 5,
  updated_at = now();
--> statement-breakpoint

ALTER TABLE finance_allocation_settings DROP COLUMN IF EXISTS compound_pct;
--> statement-breakpoint

-- Rename COMPOUND allocation rows → INVESTING
UPDATE finance_income_allocations
SET bucket = 'INVESTING', updated_at = now()
WHERE bucket = 'COMPOUND';
--> statement-breakpoint

-- Refresh seeded category defaults where still system rows
UPDATE finance_expense_categories
SET default_bucket = 'FUN', updated_at = now()
WHERE is_system = true AND name IN ('Shopping', 'Entertainment');
--> statement-breakpoint
UPDATE finance_expense_categories
SET default_bucket = 'LEARNING', updated_at = now()
WHERE is_system = true AND name IN ('Education');
