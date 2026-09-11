ALTER TABLE finance_debts
  ADD COLUMN IF NOT EXISTS borrowed_at date;
--> statement-breakpoint
ALTER TABLE finance_debts
  ADD COLUMN IF NOT EXISTS last_paid_at date;
