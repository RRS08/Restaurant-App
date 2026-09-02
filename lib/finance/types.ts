// ----------------------------------------------------------------
// Finance pillar — shared types.
//
// Every screen (Finance dashboard, Add expense drawer, future
// exports) reads through these shapes so the DB → UI path never
// drifts. Kept minimal: the DB shapes are the source of truth,
// the enriched shapes fold in a few derived fields the UI cares
// about (the counterparty account, the category label + kind,
// a direction flag).
// ----------------------------------------------------------------

export type FinanceAccountKind = 'pos' | 'cash' | 'digital_wallet' | 'bank' | 'other'
export type FinanceCategoryKind = 'income' | 'expense' | 'transfer'
export type FinanceMovementOrigin = 'auto' | 'manual'
/** Derived from source/dest_account_id presence:
 *   income   = dest set, source null
 *   expense  = source set, dest null
 *   transfer = both set
 */
export type FinanceMovementDirection = 'income' | 'expense' | 'transfer'

// ---------------------------------------------------------------- DB shapes
// (mirror finance_accounts / finance_categories / finance_movements)

export interface FinanceAccountRow {
  id: string
  restaurant_id: string
  location_id: string | null
  name: string
  kind: FinanceAccountKind
  color: string | null
  glyph: string | null
  sort_order: number | null
  active: boolean
  balance: number | string
  provider: string | null
  provider_ref: string | null
  created_at: string
  updated_at: string
}

export interface FinanceCategoryRow {
  id: string
  restaurant_id: string
  name: string
  kind: FinanceCategoryKind
  color: string | null
  sort_order: number | null
  active: boolean
  tax_category: string | null
  created_at: string
}

export interface FinanceMovementRow {
  id: string
  restaurant_id: string
  occurred_at: string
  amount: number | string
  source_account_id: string | null
  dest_account_id: string | null
  category_id: string | null
  note: string | null
  memo: string | null
  origin: FinanceMovementOrigin
  origin_ref: string | null
  reconciled_at: string | null
  reconciled_source: string | null
  receipt_url: string | null
  vendor_id: string | null
  customer_id: string | null
  recurring_schedule_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------- UI shapes
// (enriched with the bits the drawer + ledger row need without a
// second round trip)

/** Account tile / picker shape — same as the row, but with the
 *  balance coerced to number so downstream math never worries
 *  about the numeric ↔ string quirk of pg-node. `mask` is joined
 *  in for Plaid tiles from connected_bank_accounts so the tile
 *  can render "··4321" in the subtitle without keeping a mask
 *  column of its own. */
export interface FinanceAccount extends Omit<FinanceAccountRow, 'balance'> {
  balance: number
  mask: string | null
  // ---- Live POS batch overlay (kind === 'pos' only) ----
  //
  // When a tenant has a payment processor connected, the POS
  // tile's balance is not the stored finance_accounts.balance —
  // it's the processor's current un-deposited total, read live.
  // These fields are all null for tenants without a POS provider,
  // which is what keeps the tile's existing copy and behavior
  // exactly as it was for them.
  /** Which processor supplied the live balance, if any. */
  livePendingSource?: 'poynt' | null
  /** When that live figure was read (ISO). */
  livePendingFetchedAt?: string | null
  /** createdAt of the oldest transaction still in the open batch
   *  (ISO) — lets the tile say how long the batch has been open. */
  livePendingOpenedAt?: string | null
  /** Set when the processor read failed and `balance` therefore
   *  fell back to the stored value. */
  livePendingError?: 'sync_failed' | null
}

export interface FinanceCategory extends FinanceCategoryRow {}

/** Movement enriched with the counterparty account name/color and
 *  the category name/kind + a derived direction — enough for the
 *  ledger row and the drawer to render without further lookups. */
export interface FinanceMovement extends Omit<FinanceMovementRow, 'amount'> {
  amount: number
  direction: FinanceMovementDirection
  source: {
    id: string
    name: string
    kind: FinanceAccountKind
    color: string | null
    glyph: string | null
  } | null
  dest: {
    id: string
    name: string
    kind: FinanceAccountKind
    color: string | null
    glyph: string | null
  } | null
  category: {
    id: string
    name: string
    kind: FinanceCategoryKind
    color: string | null
  } | null
}

// ---------------------------------------------------------------- Constants

/** Default glyph + color per account kind, used when the operator
 *  doesn't override at add time. The card tint on the tile row
 *  mirrors these so a POS tile reads different from a Bank tile at
 *  a glance. */
export const ACCOUNT_KIND_DEFAULTS: Record<
  FinanceAccountKind,
  { label: string; color: string; glyph: string }
> = {
  pos:            { label: 'POS',            color: '#EEF2FF', glyph: 'credit-card' },
  cash:           { label: 'Cash',           color: '#ECFDF5', glyph: 'register' },
  digital_wallet: { label: 'Digital wallet', color: '#EFF6FF', glyph: 'wallet' },
  bank:           { label: 'Bank',           color: '#F5F3FF', glyph: 'bank' },
  other:          { label: 'Other',          color: '#F4F4F5', glyph: 'dot' },
}

/** Seed category starter set — inserted on first Finance visit
 *  for a restaurant. Owner adds more as they need them.
 *  tax_category strings map loosely to IRS Schedule C lines
 *  so a future export can generate a Schedule C draft with no
 *  additional user tagging. */
export const SEED_CATEGORIES: Array<{
  name: string
  kind: FinanceCategoryKind
  color: string
  tax_category: string | null
  sort_order: number
}> = [
  // Income
  { name: 'Sales',    kind: 'income',   color: '#059669', tax_category: 'Gross receipts',        sort_order: 10 },
  { name: 'Tips',     kind: 'income',   color: '#10B981', tax_category: 'Gross receipts',        sort_order: 20 },
  { name: 'Rental',   kind: 'income',   color: '#84CC16', tax_category: 'Other income',          sort_order: 30 },
  { name: 'Refund in', kind: 'income',  color: '#A3E635', tax_category: 'Other income',          sort_order: 40 },
  // Expense
  { name: 'Rent',       kind: 'expense', color: '#F97316', tax_category: 'Rent or lease',        sort_order: 50 },
  { name: 'Payroll',    kind: 'expense', color: '#EF4444', tax_category: 'Wages',                sort_order: 60 },
  { name: 'Utilities',  kind: 'expense', color: '#8B5CF6', tax_category: 'Utilities',            sort_order: 70 },
  { name: 'Supplies',   kind: 'expense', color: '#EC4899', tax_category: 'Supplies',             sort_order: 80 },
  { name: 'Inventory',  kind: 'expense', color: '#6366F1', tax_category: 'Cost of goods sold',   sort_order: 90 },
  { name: 'Fees',       kind: 'expense', color: '#F59E0B', tax_category: 'Commissions and fees', sort_order: 100 },
  { name: 'Marketing',  kind: 'expense', color: '#0EA5E9', tax_category: 'Advertising',          sort_order: 110 },
  { name: 'Other',      kind: 'expense', color: '#6B7280', tax_category: 'Other expenses',       sort_order: 120 },
  // Transfer — includes owner-side movement AND our Personal
  // bucket. Anything with kind='transfer' is excluded from the
  // P&L totals (cash-basis P&L excludes non-operational cash).
  { name: 'Cash deposit',     kind: 'transfer', color: '#059669', tax_category: null, sort_order: 130 },
  { name: 'Card settlement',  kind: 'transfer', color: '#6366F1', tax_category: null, sort_order: 140 },
  { name: 'Owner draw',       kind: 'transfer', color: '#DC2626', tax_category: null, sort_order: 150 },
  { name: 'Owner contribution', kind: 'transfer', color: '#16A34A', tax_category: null, sort_order: 160 },
  { name: 'Personal',         kind: 'transfer', color: '#A855F7', tax_category: null, sort_order: 165 },
  { name: 'Between accounts', kind: 'transfer', color: '#6B7280', tax_category: null, sort_order: 170 },
]
