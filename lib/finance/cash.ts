// ----------------------------------------------------------------
// Cash register sessions — denomination model + read helpers.
//
// A session is one open-to-close cycle at a location. Counting is
// done by denomination because that is how a drawer is actually
// counted (stack the twenties, stack the tens, …) and because a
// breakdown catches miscounts that a single total hides.
//
// Two reconciliation moments, deliberately separated:
//
//   AT CLOSE   → variance = counted − expected, where expected is
//                opening + cash sales − cash paid out + cash added.
//                A non-zero variance is a till error during the day.
//
//   AT NEXT OPEN → gap = this opening count − the previous closing
//                count. Cash legitimately leaves the drawer between
//                sessions (bank run, moved to a safe), so a
//                shortfall is not automatically a loss. The open
//                flow asks whether it was a deposit; a "yes" books
//                a Register → Bank transfer, a "no" records an
//                unexplained shortfall with a required note.
// ----------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'

/** US denominations, largest first — the order a drawer is counted
 *  in. `value` is in dollars so the sum lands directly in the
 *  numeric(10,2) columns without a cents round-trip. */
export const DENOMINATIONS = [
  { key: 'hundreds', label: '$100', value: 100 },
  { key: 'fifties',  label: '$50',  value: 50 },
  { key: 'twenties', label: '$20',  value: 20 },
  { key: 'tens',     label: '$10',  value: 10 },
  { key: 'fives',    label: '$5',   value: 5 },
  { key: 'ones',     label: '$1',   value: 1 },
  { key: 'quarters', label: '25¢',  value: 0.25 },
  { key: 'dimes',    label: '10¢',  value: 0.1 },
  { key: 'nickels',  label: '5¢',   value: 0.05 },
  { key: 'pennies',  label: '1¢',   value: 0.01 },
] as const

export type DenominationKey = typeof DENOMINATIONS[number]['key']
export type DenominationCounts = Partial<Record<DenominationKey, number>>

/** Sum a denomination count map into dollars. Rounds to cents at
 *  the end so accumulated float error on the coin rows (0.1 and
 *  0.05 are not exactly representable) cannot drift the total. */
export function sumDenominations(counts: DenominationCounts | null | undefined): number {
  if (!counts) return 0
  let total = 0
  for (const d of DENOMINATIONS) {
    const n = counts[d.key]
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
      total += n * d.value
    }
  }
  return Math.round(total * 100) / 100
}

/** Strip anything that is not a known denomination with a positive
 *  integer count. Called at the server boundary so a malformed
 *  client payload cannot smuggle junk into the jsonb column. */
export function normalizeDenominations(raw: unknown): DenominationCounts {
  const out: DenominationCounts = {}
  if (!raw || typeof raw !== 'object') return out
  const src = raw as Record<string, unknown>
  for (const d of DENOMINATIONS) {
    const v = src[d.key]
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
    if (Number.isFinite(n) && n > 0) out[d.key] = Math.floor(n)
  }
  return out
}

export type CashSessionStatus = 'open' | 'closed'
export type GapReason = 'deposit' | 'unexplained' | 'none'

export interface CashSession {
  id: string
  restaurant_id: string
  location_id: string
  opened_at: string
  opened_by: string | null
  opening_amount: number
  opening_denominations: DenominationCounts | null
  prior_close_amount: number | null
  opening_gap: number | null
  gap_reason: GapReason | null
  gap_deposit_amount: number | null
  gap_note: string | null
  closed_at: string | null
  closed_by: string | null
  closing_amount: number | null
  closing_denominations: DenominationCounts | null
  expected_amount: number | null
  variance: number | null
  variance_note: string | null
  status: CashSessionStatus
}

function toNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function rowToSession(raw: Record<string, unknown>): CashSession {
  return {
    ...(raw as unknown as CashSession),
    opening_amount: toNum(raw.opening_amount),
    prior_close_amount: raw.prior_close_amount == null ? null : toNum(raw.prior_close_amount),
    opening_gap: raw.opening_gap == null ? null : toNum(raw.opening_gap),
    gap_deposit_amount: raw.gap_deposit_amount == null ? null : toNum(raw.gap_deposit_amount),
    closing_amount: raw.closing_amount == null ? null : toNum(raw.closing_amount),
    expected_amount: raw.expected_amount == null ? null : toNum(raw.expected_amount),
    variance: raw.variance == null ? null : toNum(raw.variance),
  }
}

/** The currently-open session at a location, or null when the
 *  register is closed. The partial unique index on the table
 *  guarantees at most one. */
export async function getOpenCashSession(
  supabase: SupabaseClient,
  restaurantId: string,
  locationId: string,
): Promise<CashSession | null> {
  const { data } = await supabase
    .from('cash_sessions')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('location_id', locationId)
    .eq('status', 'open')
    .maybeSingle()
  return data ? rowToSession(data as Record<string, unknown>) : null
}

/** The most recently closed session at a location. Feeds the gap
 *  reconciliation on the next open — we compare the new count
 *  against whatever this one closed at. */
export async function getLastClosedCashSession(
  supabase: SupabaseClient,
  restaurantId: string,
  locationId: string,
): Promise<CashSession | null> {
  const { data } = await supabase
    .from('cash_sessions')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('location_id', locationId)
    .eq('status', 'closed')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ? rowToSession(data as Record<string, unknown>) : null
}

export interface ExpectedCashBreakdown {
  opening: number
  cashSales: number
  cashPaidOut: number
  cashAddedIn: number
  expected: number
}

/** What SHOULD be in the drawer right now, given an open session.
 *
 *  opening + cash sales − cash paid out + cash added in
 *
 *  Cash sales come from `orders` (payment_type='cash', scoped to
 *  this location, since the session opened). Paid-out and added-in
 *  come from `finance_movements` that touch the register account —
 *  which is exactly what the existing Add-expense flow writes when
 *  the operator picks Register as the source. No separate payout
 *  concept needed. */
export async function computeExpectedCash(
  supabase: SupabaseClient,
  args: {
    restaurantId: string
    locationId: string
    registerAccountId: string
    openedAt: string
    openingAmount: number
  },
): Promise<ExpectedCashBreakdown> {
  const [{ data: orders }, { data: movements }] = await Promise.all([
    supabase
      .from('orders')
      .select('total_amount, status, payment_type')
      .eq('restaurant_id', args.restaurantId)
      .eq('location_id', args.locationId)
      .eq('payment_type', 'cash')
      .gte('created_at', args.openedAt),
    supabase
      .from('finance_movements')
      .select('amount, source_account_id, dest_account_id')
      .eq('restaurant_id', args.restaurantId)
      .gte('occurred_at', args.openedAt)
      .or(`source_account_id.eq.${args.registerAccountId},dest_account_id.eq.${args.registerAccountId}`),
  ])

  let cashSales = 0
  for (const o of (orders ?? []) as Array<{ total_amount: unknown; status: string | null }>) {
    // Match the ledger convention used across Sales and Analytics:
    // a NULL status counts as completed, only 'voided' is excluded.
    if (o.status === 'voided') continue
    cashSales += toNum(o.total_amount)
  }

  let cashPaidOut = 0
  let cashAddedIn = 0
  for (const m of (movements ?? []) as Array<{
    amount: unknown
    source_account_id: string | null
    dest_account_id: string | null
  }>) {
    const amt = toNum(m.amount)
    if (m.source_account_id === args.registerAccountId) cashPaidOut += amt
    if (m.dest_account_id === args.registerAccountId) cashAddedIn += amt
  }

  const r2 = (n: number) => Math.round(n * 100) / 100
  return {
    opening: r2(args.openingAmount),
    cashSales: r2(cashSales),
    cashPaidOut: r2(cashPaidOut),
    cashAddedIn: r2(cashAddedIn),
    expected: r2(args.openingAmount + cashSales - cashPaidOut + cashAddedIn),
  }
}
