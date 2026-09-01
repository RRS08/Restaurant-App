// ----------------------------------------------------------------
// Plaid transaction sync (per-item).
//
// Plaid's `/transactions/sync` is item-scoped, not account-scoped —
// one cursor per Item covers every account underneath it. The
// generic BankProvider interface in `lib/bank/provider.ts` was
// shaped around a per-account contract; rather than force-fit that
// (redundant cursors, N calls where 1 would do), Plaid sync lives
// here and is called directly by the Finance action layer.
//
// Responsibilities:
//   • Load access_token for a given item from bank_provider_secrets.
//   • Drain `/transactions/sync` (added + modified + removed) until
//     has_more is false.
//   • Upsert each added/modified row into `bank_transactions` via
//     the shared `ingestBankTransactions` helper, per account.
//   • Advance `last_sync_cursor` on every connected_bank_accounts
//     row under the item (cursor is item-scoped but stored on
//     each account row for schema simplicity).
//
// This is capture-only. Turning bank_transactions into
// finance_movements happens in `lib/finance/materialize.ts` — the
// two layers stay decoupled so a category re-mapping doesn't
// require re-fetching from Plaid.
// ----------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import { getPlaidClient, isPlaidConfigured } from '@/lib/plaid/client'
import { ingestBankTransactions } from '../ingest'
import type { NormalizedBankTransaction } from '../provider'

export interface PlaidSyncItemResult {
  itemId: string
  perAccount: Array<{ connectedBankAccountId: string; inserted: number }>
  removedProviderIds: string[]
  error: string | null
}

/** Drain Plaid `/transactions/sync` for one Item and persist to
 *  bank_transactions. Idempotent — safe to run on every visit. */
export async function syncPlaidItem(
  admin: SupabaseClient,
  restaurantId: string,
  providerItemId: string,
): Promise<PlaidSyncItemResult> {
  const result: PlaidSyncItemResult = {
    itemId: providerItemId,
    perAccount: [],
    removedProviderIds: [],
    error: null,
  }

  if (!isPlaidConfigured()) {
    result.error = 'Plaid not configured.'
    return result
  }

  const { data: secret } = await admin
    .from('bank_provider_secrets')
    .select('access_token')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'plaid')
    .eq('provider_item_id', providerItemId)
    .maybeSingle()
  if (!secret?.access_token) {
    result.error = 'No access token for this Plaid item.'
    return result
  }

  const { data: accounts } = await admin
    .from('connected_bank_accounts')
    .select('id, provider_account_id, last_sync_cursor')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'plaid')
    .eq('provider_item_id', providerItemId)
    .eq('active', true)
  if (!accounts || accounts.length === 0) {
    result.error = 'No connected accounts for this Plaid item.'
    return result
  }

  // Cursor is item-scoped in Plaid; we stored it redundantly on
  // each account row. Pick the first non-null one; empty ⇒ initial
  // sync (Plaid returns everything it has cached, ~90d).
  const startingCursor =
    accounts.map(a => (a as { last_sync_cursor: string | null }).last_sync_cursor).find(Boolean) ??
    null

  const plaid = getPlaidClient()
  const added: unknown[] = []
  const modified: unknown[] = []
  const removed: Array<{ transaction_id?: string }> = []
  let cursor: string | null | undefined = startingCursor
  let hasMore = true

  try {
    while (hasMore) {
      const res = await plaid.transactionsSync({
        access_token: secret.access_token as string,
        cursor: cursor ?? undefined,
      })
      added.push(...(res.data.added ?? []))
      modified.push(...(res.data.modified ?? []))
      removed.push(...(res.data.removed ?? []))
      cursor = res.data.next_cursor
      hasMore = res.data.has_more
    }
  } catch (err) {
    console.error('[plaid:sync] transactionsSync failed', providerItemId, err)
    result.error = 'Plaid sync failed.'
    return result
  }

  // Group tx by account_id so we can call ingest once per account.
  const byAccount = new Map<string, NormalizedBankTransaction[]>()
  const allTx = [...added, ...modified] as PlaidTx[]
  for (const tx of allTx) {
    const accId = tx.account_id
    if (!accId) continue
    const norm = normalizePlaidTx(tx)
    if (!norm) continue
    const bucket = byAccount.get(accId) ?? []
    bucket.push(norm)
    byAccount.set(accId, bucket)
  }

  // Ingest per account.
  for (const acct of accounts) {
    const providerAccountId = (acct as { provider_account_id: string }).provider_account_id
    const txs = byAccount.get(providerAccountId) ?? []
    const ingest = await ingestBankTransactions({
      supabase: admin,
      restaurantId,
      connectedBankAccountId: (acct as { id: string }).id,
      transactions: txs,
      nextCursor: cursor,
    })
    if (ingest.error) {
      console.error('[plaid:sync] ingest failed', providerAccountId, ingest.error)
    }
    result.perAccount.push({
      connectedBankAccountId: (acct as { id: string }).id,
      inserted: ingest.inserted,
    })
  }

  // Delete removed transactions from raw store — Plaid may reverse
  // a tx that never posted. Downstream materialize step also purges
  // matching finance_movements.
  const removedIds = removed.map(r => r.transaction_id).filter((x): x is string => !!x)
  if (removedIds.length > 0) {
    await admin
      .from('bank_transactions')
      .delete()
      .eq('restaurant_id', restaurantId)
      .in('provider_transaction_id', removedIds)
    result.removedProviderIds = removedIds
  }

  return result
}

// ---------------------------------------------------------------- helpers

interface PlaidTx {
  transaction_id: string
  account_id: string
  amount: number
  iso_currency_code?: string | null
  unofficial_currency_code?: string | null
  name?: string | null
  merchant_name?: string | null
  category?: string[] | null
  personal_finance_category?: { primary?: string | null; detailed?: string | null } | null
  date?: string | null
  datetime?: string | null
  authorized_datetime?: string | null
  pending?: boolean
  /** When a pending tx posts, Plaid sends a new tx with this
   *  field pointing back at the original pending row's id. We
   *  persist it so the materialize pass can dedupe the pair
   *  and suppress the ghost. */
  pending_transaction_id?: string | null
}

/** Turn a Plaid tx into the shape `ingestBankTransactions`
 *  expects. Plaid convention: positive amount = money out
 *  (outflow), negative = money in (inflow). We store amount as
 *  absolute value and carry the sign in `direction`. */
function normalizePlaidTx(tx: PlaidTx): NormalizedBankTransaction | null {
  if (!tx?.transaction_id) return null
  if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount)) return null
  const direction: 'inflow' | 'outflow' = tx.amount > 0 ? 'outflow' : 'inflow'
  const amount = Math.abs(tx.amount)
  const currency = tx.iso_currency_code ?? tx.unofficial_currency_code ?? 'USD'
  const postedAt =
    tx.datetime ??
    tx.authorized_datetime ??
    (tx.date ? `${tx.date}T12:00:00Z` : new Date().toISOString())
  const rawCategory =
    tx.personal_finance_category?.detailed ??
    tx.personal_finance_category?.primary ??
    (Array.isArray(tx.category) ? tx.category.join(' / ') : null)
  return {
    providerTransactionId: tx.transaction_id,
    amount,
    direction,
    currency,
    description: tx.name ?? null,
    merchantName: tx.merchant_name ?? null,
    rawCategory,
    postedAt,
    pending: !!tx.pending,
    providerMetadata: {
      personal_finance_category: tx.personal_finance_category ?? null,
      category: tx.category ?? null,
      pending_transaction_id: tx.pending_transaction_id ?? null,
    },
  }
}
