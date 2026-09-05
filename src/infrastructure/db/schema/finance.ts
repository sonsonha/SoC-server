import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { syncColumns } from './syncColumns.js';
import { users } from './identity.js';

/** One row per user — allocation percentages must sum to 100. */
export const financeAllocationSettings = pgTable(
  'finance_allocation_settings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    livingPct: integer('living_pct').notNull().default(55),
    safetyPct: integer('safety_pct').notNull().default(15),
    compoundPct: integer('compound_pct').notNull().default(20),
    opportunityPct: integer('opportunity_pct').notNull().default(10),
    currency: text('currency').notNull().default('VND'),
    ...syncColumns,
  },
  (t) => [
    uniqueIndex('finance_allocation_settings_user_id_uidx').on(t.userId),
  ],
);

export const financeIncomeSources = pgTable(
  'finance_income_sources',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...syncColumns,
  },
  (t) => [
    index('finance_income_sources_user_id_idx').on(t.userId),
  ],
);

export const financeIncomeEntries = pgTable(
  'finance_income_entries',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => financeIncomeSources.id, { onDelete: 'restrict' }),
    amountVnd: integer('amount_vnd').notNull(),
    currency: text('currency').notNull().default('VND'),
    /** Calendar date money was received (Asia/Ho_Chi_Minh day). */
    receivedAt: date('received_at').notNull(),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ...syncColumns,
  },
  (t) => [
    index('finance_income_entries_user_id_idx').on(t.userId),
    index('finance_income_entries_user_received_idx').on(t.userId, t.receivedAt),
    index('finance_income_entries_source_id_idx').on(t.sourceId),
  ],
);

/** Snapshot of bucket allocation at income record time (4 rows per income). */
export const financeIncomeAllocations = pgTable(
  'finance_income_allocations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    incomeEntryId: text('income_entry_id')
      .notNull()
      .references(() => financeIncomeEntries.id, { onDelete: 'cascade' }),
    /** LIVING | SAFETY | COMPOUND | OPPORTUNITY */
    bucket: text('bucket').notNull(),
    amountVnd: integer('amount_vnd').notNull(),
    pctApplied: integer('pct_applied').notNull(),
    ...syncColumns,
  },
  (t) => [
    index('finance_income_allocations_income_idx').on(t.incomeEntryId),
    index('finance_income_allocations_user_bucket_idx').on(t.userId, t.bucket),
    uniqueIndex('finance_income_allocations_income_bucket_uidx').on(t.incomeEntryId, t.bucket),
  ],
);

export const financeExpenseCategories = pgTable(
  'finance_expense_categories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** ESSENTIAL | FIXED | DISCRETIONARY | OTHER */
    kind: text('kind').notNull().default('OTHER'),
    /** Default funding bucket for expenses in this category. */
    defaultBucket: text('default_bucket').notNull().default('LIVING'),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    isSystem: boolean('is_system').notNull().default(false),
    ...syncColumns,
  },
  (t) => [
    index('finance_expense_categories_user_id_idx').on(t.userId),
  ],
);

export const financeExpenseEntries = pgTable(
  'finance_expense_entries',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => financeExpenseCategories.id, { onDelete: 'restrict' }),
    amountVnd: integer('amount_vnd').notNull(),
    currency: text('currency').notNull().default('VND'),
    fundingBucket: text('funding_bucket').notNull().default('LIVING'),
    spentAt: date('spent_at').notNull(),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ...syncColumns,
  },
  (t) => [
    index('finance_expense_entries_user_id_idx').on(t.userId),
    index('finance_expense_entries_user_spent_idx').on(t.userId, t.spentAt),
    index('finance_expense_entries_category_id_idx').on(t.categoryId),
  ],
);

export const financeDebts = pgTable(
  'finance_debts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    outstandingVnd: integer('outstanding_vnd').notNull().default(0),
    monthlyRequiredVnd: integer('monthly_required_vnd').notNull().default(0),
    active: boolean('active').notNull().default(true),
    ...syncColumns,
  },
  (t) => [
    index('finance_debts_user_id_idx').on(t.userId),
  ],
);

export const financeDebtPayments = pgTable(
  'finance_debt_payments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    debtId: text('debt_id')
      .notNull()
      .references(() => financeDebts.id, { onDelete: 'restrict' }),
    amountVnd: integer('amount_vnd').notNull(),
    currency: text('currency').notNull().default('VND'),
    paidAt: date('paid_at').notNull(),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ...syncColumns,
  },
  (t) => [
    index('finance_debt_payments_user_id_idx').on(t.userId),
    index('finance_debt_payments_user_paid_idx').on(t.userId, t.paidAt),
    index('finance_debt_payments_debt_id_idx').on(t.debtId),
  ],
);
