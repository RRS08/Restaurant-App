// ----------------------------------------------------------------
// Materialize raw bank_transactions → finance_movements.
//
// Runs after Plaid sync. Reads every unmaterialized
// bank_transactions row (idempotent via origin_ref =
// provider_transaction_id) inside the 30-day backfill window and:
//
//   1. Resolves the finance_account tile that mirrors each
//      bank account (by provider_ref = provider_account_id).
//   2. Maps Plaid's personal_finance_category → SEED_CATEGORIES
//      via lib/finance/plaid-category-map.ts.
//   3. Auto-pairs transfer legs across two of the user's own
//      linked accounts (same day, same amount, opposite direction,
//      transfer hint on at least one side).
//   4. Inserts finance_movements with origin='auto',
//      origin_ref=provider_transaction_id.
//
// Balance is NOT bumped from here — Plaid's live balance is the
// source of truth and is re-fetched separately on every sync so
// the tile never drifts from the bank.
//
// Backfill window: 30 days. bank_transactions keeps every row
// Plaid returns (raw truth); the operator-facing ledger only
// shows recent history so an empty Finance doesn't get buried
// under old noise. "Pull more history" is a future affordance.
// ----------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import { mapPlaidCategory } from './plaid-category-map'

const BACKFILL_DAYS = 30
const TRANSFER_MATCH_WINDOW_DAYS = 2

export interface MaterializeResult {
  inserted: number
  transfersPaired: number
  error: string | null
}

interface BankTxRow {
  id: string
  connected_bank_account_id: string
  provider_transaction_id: string
  amount: number | string
  direction: 'inflow' | 'outflow'
  description: string | null
  merchant_name: string | null
  raw_category: string | null
  posted_at: string
  pending: boolean
  provider_metadata: {
    personal_finance_category?: { primary?: string | null; detailed?: string | null } | null
  } | null
}

interface CategoryRow {
  id: string
  name: string
  kind: 'income' | 'expense' | 'transfer'
}

interface AccountMapEntry {
  financeAccountId: string
  connectedBankAccountId: string
}

export async function materializeFinanceMovements(
  admin: SupabaseClient,
  restaurantId: string,
): Promise<MaterializeResult> {
  const cutoff = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // 1. Load raw tx within window.
  const { data: rawTx } = await admin
    .from('bank_transactions')
    .select('id, connected_bank_account_id, provider_transaction_id, amount, direction, description, merchant_name, raw_category, posted_at, pending, provider_metadata')
    .eq('restaurant_id', restaurantId)
    .gte('posted_at', cutoff)
    .order('posted_at', { ascending: true })
  if (!rawTx || rawTx.length === 0) return { inserted: 0, transfersPaired: 0, error: null }

  // 2. Load already-materialized origin refs so we skip them.
  const providerRefs = (rawTx as BankTxRow[]).map(t => t.provider_transaction_id)
  const { data: existing } = await admin
    .from('finance_movements')
    .select('origin_ref')
    .eq('restaurant_id', restaurantId)
    .eq('origin', 'auto')
    .in('origin_ref', providerRefs)
  const materialized = new Set(
    (existing ?? []).map(r => (r as { origin_ref: string | null }).origin_ref).filter((x): x is string => !!x)
  )
  const fresh = (rawTx as BankTxRow[]).filter(t => !materialized.has(t.provider_transaction_id))
  if (fresh.length === 0) return { inserted: 0, transfersPaired: 0, error: null }

  // 3. Build connected_bank_account → finance_account map.
  const { data: connectedRows } = await admin
    .from('connected_bank_accounts')
    .select('id, provider_account_id')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'plaid')
  const cbaById = new Map<string, string>() // cba.id → provider_account_id
  for (const c of connectedRows ?? []) {
    cbaById.set((c as { id: string }).id, (c as { provider_account_id: string }).provider_account_id)
  }

  const { data: financeAccounts } = await admin
    .from('finance_accounts')
    .select('id, provider_ref')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'plaid')
    .eq('active', true)
  const financeByProviderRef = new Map<string, string>()
  for (const f of financeAccounts ?? []) {
    const pr = (f as { provider_ref: string | null }).provider_ref
    if (pr) financeByProviderRef.set(pr, (f as { id: string }).id)
  }

  const accountMap = new Map<string, AccountMapEntry>() // cba.id → { financeAccountId, connectedBankAccountId }
  for (const [cbaId, providerAccountId] of cbaById.entries()) {
    const financeAccountId = financeByProviderRef.get(providerAccountId)
    if (financeAccountId) {
      accountMap.set(cbaId, { financeAccountId, connectedBankAccountId: cbaId })
    }
  }

  // 4. Load current categories so we can resolve seed names → ids.
  const { data: categories } = await admin
    .from('finance_categories')
    .select('id, name, kind')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
  const categoryByName = new Map<string, CategoryRow>()
  for (const c of (categories ?? []) as CategoryRow[]) {
    categoryByName.set(c.name.toLowerCase(), c)
  }

  // 5. Transfer pairing pass — group by day + amount, look for
  //    opposite-direction hits across two accounts.
  const transferHints: Set<string> = new Set() // provider_transaction_id
  interface PrepRow {
    raw: BankTxRow
    financeAccountId: string | null
    seedName: string | null
    isTransferHint: boolean
    dayKey: string
    amountNum: number
  }
  const prepped: PrepRow[] = fresh.map(t => {
    const acct = accountMap.get(t.connected_bank_account_id)
    const pfc = t.provider_metadata?.personal_finance_category ?? null
    const cat = mapPlaidCategory(pfc?.primary ?? null, pfc?.detailed ?? null)
    const amt = typeof t.amount === 'number' ? t.amount : parseFloat(String(t.amount))
    return {
      raw: t,
      financeAccountId: acct?.financeAccountId ?? null,
      seedName: cat.seedName,
      isTransferHint: cat.isTransferHint,
      dayKey: t.posted_at.slice(0, 10),
      amountNum: Number.isFinite(amt) ? amt : 0,
    }
  })

  // Pair candidates: same amount, opposite direction, within a small
  // date window, both mapped to a finance account, at least one hinted.
  const pairs = new Map<string, string>() // provider_transaction_id (outflow) → provider_transaction_id (inflow)
  const usedInPair = new Set<string>()
  for (const outflow of prepped) {
    if (outflow.raw.direction !== 'outflow') continue
    if (usedInPair.has(outflow.raw.provider_transaction_id)) continue
    if (!outflow.financeAccountId) continue
    const outDay = new Date(outflow.raw.posted_at).getTime()
    for (const inflow of prepped) {
      if (inflow.raw.direction !== 'inflow') continue
      if (usedInPair.has(inflow.raw.provider_transaction_id)) continue
      if (!inflow.financeAccountId) continue
      if (inflow.financeAccountId === outflow.financeAccountId) continue
      if (Math.abs(inflow.amountNum - outflow.amountNum) > 0.01) continue
      const inDay = new Date(inflow.raw.posted_at).getTime()
      const daysApart = Math.abs(inDay - outDay) / (24 * 60 * 60 * 1000)
      if (daysApart > TRANSFER_MATCH_WINDOW_DAYS) continue
      if (!outflow.isTransferHint && !inflow.isTransferHint) continue
      pairs.set(outflow.raw.provider_transaction_id, inflow.raw.provider_transaction_id)
      usedInPair.add(outflow.raw.provider_transaction_id)
      usedInPair.add(inflow.raw.provider_transaction_id)
      transferHints.add(outflow.raw.provider_transaction_id)
      transferHints.add(inflow.raw.provider_transaction_id)
      break
    }
  }

  // 6. Build insert rows.
  //    - Paired transfers: emit ONE row (source=outflow account,
  //      dest=inflow account), suppress the inflow half.
  //    - Unpaired: emit an income (inflow) or expense (outflow) row.
  const emittedInflowsCoveredByPair = new Set<string>()
  for (const inflowId of pairs.values()) emittedInflowsCoveredByPair.add(inflowId)

  const insertRows: Array<Record<string, unknown>> = []

  for (const p of prepped) {
    if (emittedInflowsCoveredByPair.has(p.raw.provider_transaction_id)) continue
    if (!p.financeAccountId) continue // no matching Finance tile — skip

    const paired = pairs.get(p.raw.provider_transaction_id)

    if (paired) {
      // Transfer row: source = this (outflow), dest = the paired inflow's account
      const inflowPrep = prepped.find(x => x.raw.provider_transaction_id === paired)
      if (!inflowPrep?.financeAccountId) continue
      const cat = categoryByName.get('between accounts') ?? null
      insertRows.push({
        restaurant_id: restaurantId,
        occurred_at: p.raw.posted_at,
        amount: p.amountNum,
        source_account_id: p.financeAccountId,
        dest_account_id: inflowPrep.financeAccountId,
        category_id: cat?.id ?? null,
        note: p.raw.merchant_name || p.raw.description || 'Transfer',
        memo: null,
        origin: 'auto',
        origin_ref: p.raw.provider_transaction_id,
      })
      continue
    }

    // Standalone income (inflow) or expense (outflow)
    const isInflow = p.raw.direction === 'inflow'
    const seed = p.seedName ? categoryByName.get(p.seedName.toLowerCase()) : null
    // Guard: an inflow tx shouldn't attach to an expense-kind category, etc.
    const kindOk =
      !seed ||
      (isInflow && seed.kind === 'income') ||
      (!isInflow && seed.kind === 'expense') ||
      seed.kind === 'transfer'
    insertRows.push({
      restaurant_id: restaurantId,
      occurred_at: p.raw.posted_at,
      amount: p.amountNum,
      source_account_id: isInflow ? null : p.financeAccountId,
      dest_account_id: isInflow ? p.financeAccountId : null,
      category_id: kindOk ? (seed?.id ?? null) : null,
      note: p.raw.merchant_name || p.raw.description || (isInflow ? 'Deposit' : 'Charge'),
      memo: null,
      origin: 'auto',
      origin_ref: p.raw.provider_transaction_id,
    })
  }

  if (insertRows.length === 0) return { inserted: 0, transfersPaired: pairs.size, error: null }

  const { error } = await admin.from('finance_movements').insert(insertRows)
  if (error) {
    console.error('[finance:materialize] insert failed', error)
    return { inserted: 0, transfersPaired: pairs.size, error: error.message }
  }
  return { inserted: insertRows.length, transfersPaired: pairs.size, error: null }
}
