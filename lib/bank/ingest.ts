// ----------------------------------------------------------------
// Bank Intake Helper
//
// Thin server-side utility that takes normalized transactions from a
// BankProvider and upserts them into `bank_transactions`. Future sync
// workers (cron / webhook / manual refresh) all call into this so the
// ingest rules live in exactly one place.
//
// Rules:
//   • Every row is restaurant-scoped.
//   • Idempotent via `(connected_bank_account_id, provider_transaction_id)`
//     unique constraint — re-syncing the same window is safe.
//   • No UI side-effects here. Rendering decisions live in the
//     Finance page loader / client.
// ----------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedBankTransaction } from './provider'

export interface IngestArgs {
  supabase: SupabaseClient
  restaurantId: string
  connectedBankAccountId: string
  transactions: NormalizedBankTransaction[]
  /** Cursor returned by the provider, persisted for the next sync. */
  nextCursor?: string | null
}

export interface IngestResult {
  inserted: number
  error: string | null
}

export async function ingestBankTransactions({
  supabase,
  restaurantId,
  connectedBankAccountId,
  transactions,
  nextCursor,
}: IngestArgs): Promise<IngestResult> {
  if (transactions.length === 0) {
    // Still update sync state so the next call picks up where we left off.
    const { error: cursorError } = await supabase
      .from('connected_bank_accounts')
      .update({
        last_synced_at: new Date().toISOString(),
        ...(nextCursor !== undefined ? { last_sync_cursor: nextCursor } : {}),
      })
      .eq('id', connectedBankAccountId)
      .eq('restaurant_id', restaurantId)

    return { inserted: 0, error: cursorError?.message ?? null }
  }

  const rows = transactions.map((tx) => ({
    restaurant_id: restaurantId,
    connected_bank_account_id: connectedBankAccountId,
    provider_transaction_id: tx.providerTransactionId,
    amount: tx.amount,
    direction: tx.direction,
    currency: tx.currency,
    description: tx.description,
    merchant_name: tx.merchantName,
    raw_category: tx.rawCategory,
    posted_at: tx.postedAt,
    pending: tx.pending,
    provider_metadata: tx.providerMetadata,
  }))

  // Idempotent upsert on the (account, provider_transaction_id) unique key.
  const { error: upsertError, count } = await supabase
    .from('bank_transactions')
    .upsert(rows, { onConflict: 'connected_bank_account_id,provider_transaction_id', count: 'exact' })

  if (upsertError) return { inserted: 0, error: upsertError.message }

  // Advance sync state on the connected account
  const { error: cursorError } = await supabase
    .from('connected_bank_accounts')
    .update({
      last_synced_at: new Date().toISOString(),
      ...(nextCursor !== undefined ? { last_sync_cursor: nextCursor } : {}),
    })
    .eq('id', connectedBankAccountId)
    .eq('restaurant_id', restaurantId)

  if (cursorError) return { inserted: count ?? rows.length, error: cursorError.message }

  return { inserted: count ?? rows.length, error: null }
}
