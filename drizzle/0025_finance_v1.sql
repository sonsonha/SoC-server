-- Personal Finance V1 ledger (integer VND, soft-delete via deleted_at)

CREATE TABLE IF NOT EXISTS finance_allocation_settings (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  living_pct integer NOT NULL DEFAULT 55,
  safety_pct integer NOT NULL DEFAULT 15,
  compound_pct integer NOT NULL DEFAULT 20,
  opportunity_pct integer NOT NULL DEFAULT 10,
  currency text NOT NULL DEFAULT 'VND',
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS finance_allocation_settings_user_id_uidx
  ON finance_allocation_settings(user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS finance_income_sources (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_income_sources_user_id_idx
  ON finance_income_sources(user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS finance_income_entries (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_id text NOT NULL REFERENCES finance_income_sources(id) ON DELETE RESTRICT,
  amount_vnd integer NOT NULL,
  currency text NOT NULL DEFAULT 'VND',
  received_at date NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_income_entries_user_id_idx
  ON finance_income_entries(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_income_entries_user_received_idx
  ON finance_income_entries(user_id, received_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_income_entries_source_id_idx
  ON finance_income_entries(source_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS finance_income_allocations (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  income_entry_id text NOT NULL REFERENCES finance_income_entries(id) ON DELETE CASCADE,
  bucket text NOT NULL,
  amount_vnd integer NOT NULL,
  pct_applied integer NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_income_allocations_income_idx
  ON finance_income_allocations(income_entry_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_income_allocations_user_bucket_idx
  ON finance_income_allocations(user_id, bucket);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS finance_income_allocations_income_bucket_uidx
  ON finance_income_allocations(income_entry_id, bucket);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS finance_expense_categories (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'OTHER',
  default_bucket text NOT NULL DEFAULT 'LIVING',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  is_system boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_expense_categories_user_id_idx
  ON finance_expense_categories(user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS finance_expense_entries (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category_id text NOT NULL REFERENCES finance_expense_categories(id) ON DELETE RESTRICT,
  amount_vnd integer NOT NULL,
  currency text NOT NULL DEFAULT 'VND',
  funding_bucket text NOT NULL DEFAULT 'LIVING',
  spent_at date NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_expense_entries_user_id_idx
  ON finance_expense_entries(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_expense_entries_user_spent_idx
  ON finance_expense_entries(user_id, spent_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_expense_entries_category_id_idx
  ON finance_expense_entries(category_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS finance_debts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  outstanding_vnd integer NOT NULL DEFAULT 0,
  monthly_required_vnd integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_debts_user_id_idx
  ON finance_debts(user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS finance_debt_payments (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  debt_id text NOT NULL REFERENCES finance_debts(id) ON DELETE RESTRICT,
  amount_vnd integer NOT NULL,
  currency text NOT NULL DEFAULT 'VND',
  paid_at date NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_debt_payments_user_id_idx
  ON finance_debt_payments(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_debt_payments_user_paid_idx
  ON finance_debt_payments(user_id, paid_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finance_debt_payments_debt_id_idx
  ON finance_debt_payments(debt_id);
