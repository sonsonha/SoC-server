-- Batch D: persist first-use onboarding completion (nullable).
-- Completed when user connects Calendar OR chooses "Not now".
-- Existing owner should be backfilled via: npm run onboarding:backfill-owner

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
