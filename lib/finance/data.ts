// ----------------------------------------------------------------
// Finance pillar — read-side helpers.
//
// Every UI aggregate (cash on hand, weekly in/out, per-account
// balances, movement ledger) reads through here so downstream
// screens don't reinvent the same query. Kept close to the DB
// shape — normalizer functions coerce the pg-node numeric ↔
// string quirk once, upstream code sees plain numbers.
// ----------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  FinanceAccount,
  FinanceAccountRow,
  FinanceCategory,
  FinanceCategoryRow,
  FinanceMovement,
  FinanceMovementDirection,
  FinanceMovementRow,
} from './types'

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/** Every active account for a restaurant, in tile-row order.
 *  Optional location scope lets a place-picker workspace see only
 *  its shop's accounts (Mercado's Register plus shop-wide POS,
 *  not Weslaco's Register). Shop-wide accounts (location_id null)
 *  are always included. */
export async function listAccounts(
  supabase: SupabaseClient,
  restaurantId: string,
  opts?: { locationId?: string | null; includeInactive?: boolean },
): Promise<FinanceAccount[]> {
  let q = supabase
    .from('finance_accounts')
    .select('*')
    .eq('restaurant_id', restaurantId)
  if (!opts?.includeInactive) q = q.eq('active', true)
  if (opts?.locationId) {
    // Include this location's account rows PLUS shop-wide rows.
    q = q.or(`location_id.is.null,location_id.eq.${opts.locationId}`)
  }
  q = q.order('sort_order', { ascending: true, nullsFirst: false })
       .order('created_at', { ascending: true })

  const { data } = await q
  return (data ?? []).map(rowToAccount)
}

export async function listCategories(
  supabase: SupabaseClient,
  restaurantId: string,
  opts?: { includeInactive?: boolean },
): Promise<FinanceCategory[]> {
  let q = supabase
    .from('finance_categories')
    .select('*')
    .eq('restaurant_id', restaurantId)
  if (!opts?.includeInactive) q = q.eq('active', true)
  q = q.order('sort_order', { ascending: true, nullsFirst: false })
       .order('name', { ascending: true })
  const { data } = await q
  return (data as FinanceCategoryRow[] | null) ?? []
}

/** Every movement in a time window, enriched with counterparty
 *  account + category context so the ledger row can render without
 *  another join. Ordered newest-first. */
export async function listMovements(
  supabase: SupabaseClient,
  restaurantId: string,
  opts: {
    from?: Date | string
    to?: Date | string
    limit?: number
    /** Filter to only movements that touch these account IDs
     *  (as source OR dest). Powers the per-account tile drill-in. */
    accountIds?: string[]
    /** Filter to only movements of these directions. */
    directions?: FinanceMovementDirection[]
  } = {},
): Promise<FinanceMovement[]> {
  let q = supabase
    .from('finance_movements')
    .select(`
      *,
      source:source_account_id ( id, name, kind, color ),
      dest:dest_account_id ( id, name, kind, color ),
      category:category_id ( id, name, kind, color )
    `)
    .eq('restaurant_id', restaurantId)
  if (opts.from) {
    const iso = typeof opts.from === 'string' ? opts.from : opts.from.toISOString()
    q = q.gte('occurred_at', iso)
  }
  if (opts.to) {
    const iso = typeof opts.to === 'string' ? opts.to : opts.to.toISOString()
    q = q.lte('occurred_at', iso)
  }
  if (opts.accountIds && opts.accountIds.length > 0) {
    const list = opts.accountIds.join(',')
    q = q.or(`source_account_id.in.(${list}),dest_account_id.in.(${list})`)
  }
  q = q.order('occurred_at', { ascending: false })
  if (opts.limit && opts.limit > 0) q = q.limit(opts.limit)
  const { data } = await q
  const enriched = (data ?? []).map(rowToMovement)
  if (opts.directions && opts.directions.length > 0) {
    const set = new Set(opts.directions)
    return enriched.filter(m => set.has(m.direction))
  }
  return enriched
}

/** Cash on hand = sum of every active account's balance. Simple
 *  aggregate, kept in one place so every surface reads the same
 *  number. */
export function cashOnHand(accounts: FinanceAccount[]): number {
  return accounts.reduce((s, a) => s + a.balance, 0)
}

/** Money that entered vs left the shop across a movement set.
 *  Income = +amount, Expense = -amount, Transfer = 0 (internal
 *  motion, not net flow). Used for the header's weekly delta. */
export function inOutTotals(movements: FinanceMovement[]): { in: number; out: number } {
  let inSum = 0
  let outSum = 0
  for (const m of movements) {
    if (m.direction === 'income') inSum += m.amount
    else if (m.direction === 'expense') outSum += m.amount
  }
  return { in: round2(inSum), out: round2(outSum) }
}

// ---------------------------------------------------------------- normalizers

function rowToAccount(raw: FinanceAccountRow): FinanceAccount {
  return { ...raw, balance: toNumber(raw.balance) }
}

interface EmbeddedRef {
  id: string | null
  name: string | null
  kind: string | null
  color: string | null
}

function rowToMovement(
  raw: FinanceMovementRow & {
    source: EmbeddedRef | EmbeddedRef[] | null
    dest: EmbeddedRef | EmbeddedRef[] | null
    category: EmbeddedRef | EmbeddedRef[] | null
  },
): FinanceMovement {
  // PostgREST returns embedded rows as either an object or a
  // one-element array depending on the FK cardinality — collapse
  // to a single object so downstream code doesn't care.
  const source = pickRef(raw.source)
  const dest = pickRef(raw.dest)
  const category = pickRef(raw.category)

  const direction: FinanceMovementDirection =
    raw.source_account_id && raw.dest_account_id ? 'transfer'
      : raw.dest_account_id ? 'income'
        : 'expense'

  return {
    ...raw,
    amount: toNumber(raw.amount),
    direction,
    source: source && source.id ? {
      id: source.id,
      name: source.name ?? '—',
      kind: (source.kind as FinanceMovement['source'] extends null ? never : NonNullable<FinanceMovement['source']>['kind']) ?? 'other',
      color: source.color,
    } : null,
    dest: dest && dest.id ? {
      id: dest.id,
      name: dest.name ?? '—',
      kind: (dest.kind as NonNullable<FinanceMovement['dest']>['kind']) ?? 'other',
      color: dest.color,
    } : null,
    category: category && category.id ? {
      id: category.id,
      name: category.name ?? '—',
      kind: (category.kind as NonNullable<FinanceMovement['category']>['kind']) ?? 'expense',
      color: category.color,
    } : null,
  }
}

function pickRef(ref: EmbeddedRef | EmbeddedRef[] | null): EmbeddedRef | null {
  if (!ref) return null
  return Array.isArray(ref) ? (ref[0] ?? null) : ref
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
