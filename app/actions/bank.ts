'use server'

// ----------------------------------------------------------------
// Bank sync — Plaid Sandbox phase (owner-only, server-only)
//
// Four actions cover the narrow V1 surface:
//
//   createPlaidLinkToken     → returns a link_token for <PlaidLink/>
//   exchangePlaidPublicToken → trades Link's public_token for an
//                              access_token, stores the Plaid Item
//                              secret + one connected_bank_accounts
//                              row per returned account
//   syncBankTransactions     → cursor-based /transactions/sync call
//                              that upserts bank_transactions and
//                              advances last_sync_cursor per account
//   disconnectBank           → marks every account under a Plaid
//                              Item inactive and deletes its secret
//
// Security posture:
//   • Every action calls requireRestaurantOwner(restaurantId).
//     Managers never reach the Plaid API surface.
//   • Access tokens live in `bank_provider_secrets`, a table whose
//     RLS is owner-only. The token never leaves the server.
//   • The client receives only the link_token (short-lived, Link-
//     only) and public result messages. Never an access_token.
//   • All writes happen through the existing anon-key supabase
//     client, which means RLS is still active as a second wall.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'
import {
  CountryCode,
  Products,
  Transaction as PlaidTransaction,
  RemovedTransaction,
} from 'plaid'
import { getPlaidClient, isPlaidConfigured } from '@/lib/plaid/client'

const PLAID_NOT_CONFIGURED = 'Plaid is not configured yet. Set PLAID_CLIENT_ID and PLAID_SECRET to enable bank sync.'

type Result<T = { ok: true; message: string }> = T | { error: string }

// ----------------------------------------------------------------
// Shared gate: resolve restaurant + owner-check in one place so
// each action stays a single line of permission setup.
// ----------------------------------------------------------------
async function gateOwner(): Promise<
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; restaurantId: string; userId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated.' }

  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role?.restaurant_id) return { ok: false, error: 'No restaurant found.' }

  try {
    await requireRestaurantOwner(role.restaurant_id)
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message }
    throw err
  }
  return { ok: true, supabase, restaurantId: role.restaurant_id, userId: user.id }
}

// ================================================================
// 1. createPlaidLinkToken
// ================================================================
export async function createPlaidLinkToken(): Promise<Result<{ ok: true; linkToken: string }>> {
  if (!isPlaidConfigured()) return { error: PLAID_NOT_CONFIGURED }
  const gate = await gateOwner()
  if (!gate.ok) return { error: gate.error }

  try {
    const plaid = getPlaidClient()
    const res = await plaid.linkTokenCreate({
      user: { client_user_id: gate.userId },
      client_name: 'Restaurant App',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    })
    return { ok: true, linkToken: res.data.link_token }
  } catch (err) {
    return { error: formatPlaidError('link token', err) }
  }
}

// ================================================================
// 2. exchangePlaidPublicToken
//
// Accepts a public_token from <PlaidLink/>, exchanges it with
// Plaid for an access_token + item_id, then persists:
//
//   bank_provider_secrets        — one row, holds the access_token
//   connected_bank_accounts      — one row per Plaid account
//                                  under that Item (upsert by
//                                  provider_account_id)
//
// Accounts are left with `last_sync_cursor = null` so the first
// call to syncBankTransactions() walks from the beginning.
// ================================================================
export async function exchangePlaidPublicToken(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  if (!isPlaidConfigured()) return { error: PLAID_NOT_CONFIGURED }
  const gate = await gateOwner()
  if (!gate.ok) return { error: gate.error }

  const publicToken = (formData.get('public_token') as string | null)?.trim()
  if (!publicToken) return { error: 'Missing public_token.' }

  try {
    const plaid = getPlaidClient()

    const exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken })
    const accessToken = exchange.data.access_token
    const itemId = exchange.data.item_id

    // Accounts + institution metadata for display. We call
    // accountsGet with the freshly minted access_token; this also
    // validates it before we persist.
    const accountsRes = await plaid.accountsGet({ access_token: accessToken })
    const accounts = accountsRes.data.accounts
    const institutionName = accountsRes.data.item.institution_id
      ? (await safeGetInstitutionName(accountsRes.data.item.institution_id)) ?? null
      : null

    // Persist the secret first. If the later account upsert fails,
    // a follow-up sync call can still recover the item using this row.
    const { error: secretError } = await gate.supabase
      .from('bank_provider_secrets')
      .upsert(
        {
          restaurant_id: gate.restaurantId,
          provider: 'plaid',
          provider_item_id: itemId,
          access_token: accessToken,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'restaurant_id,provider,provider_item_id' }
      )
    if (secretError) return { error: `Could not save bank credentials: ${secretError.message}` }

    // Upsert one row per Plaid account.
    const rows = accounts.map((a) => ({
      restaurant_id: gate.restaurantId,
      provider: 'plaid',
      provider_item_id: itemId,
      provider_account_id: a.account_id,
      account_name: a.name,
      account_mask: a.mask ?? null,
      account_type: a.type ?? null,
      account_subtype: a.subtype ?? null,
      institution_name: institutionName,
      currency: a.balances.iso_currency_code ?? 'USD',
      active: true,
    }))
    if (rows.length > 0) {
      const { error: accErr } = await gate.supabase
        .from('connected_bank_accounts')
        .upsert(rows, { onConflict: 'restaurant_id,provider,provider_account_id' })
      if (accErr) return { error: `Could not save accounts: ${accErr.message}` }
    }

    revalidatePath('/settings')
    revalidatePath('/finance')
    return { ok: true, message: `Connected ${rows.length} account${rows.length === 1 ? '' : 's'}.` }
  } catch (err) {
    return { error: formatPlaidError('public token exchange', err) }
  }
}

// ================================================================
// 3. syncBankTransactions
//
// Uses Plaid's /transactions/sync (the modern incremental endpoint)
// per Plaid Item. Each Item has its own cursor, stored on every
// `connected_bank_accounts` row under that item — we read the most
// recent one as the starting cursor and write the fresh cursor back
// to every account under the item after the sync completes.
//
// Behavior:
//   • `added` and `modified` are upserted into bank_transactions by
//     (connected_bank_account_id, provider_transaction_id).
//   • `removed` rows are deleted (Plaid only emits this for true
//     reversals — it's rare but honoring it keeps the raw table
//     truthful).
//   • We loop while `has_more` is true so one call drains the
//     available delta for each item.
// ================================================================
export async function syncBankTransactions(
  _prevState: Result | null,
  _formData: FormData
): Promise<Result> {
  if (!isPlaidConfigured()) return { error: PLAID_NOT_CONFIGURED }
  const gate = await gateOwner()
  if (!gate.ok) return { error: gate.error }

  // Load every Plaid-linked account under this restaurant, grouped
  // by provider_item_id. Items are the sync unit — accounts share
  // a cursor because Plaid maintains one per Item.
  const { data: accountRows, error: accLoadErr } = await gate.supabase
    .from('connected_bank_accounts')
    .select('id, provider_item_id, provider_account_id, last_sync_cursor')
    .eq('restaurant_id', gate.restaurantId)
    .eq('provider', 'plaid')
    .eq('active', true)
  if (accLoadErr) return { error: accLoadErr.message }
  if (!accountRows || accountRows.length === 0) {
    return { error: 'No connected bank accounts to sync.' }
  }

  const itemsMap = new Map<string, { ids: string[]; accountIdsByPlaid: Map<string, string>; cursor: string | null }>()
  for (const r of accountRows) {
    if (!r.provider_item_id) continue
    const existing = itemsMap.get(r.provider_item_id) ?? {
      ids: [],
      accountIdsByPlaid: new Map<string, string>(),
      cursor: null as string | null,
    }
    existing.ids.push(r.id)
    existing.accountIdsByPlaid.set(r.provider_account_id, r.id)
    if (r.last_sync_cursor) existing.cursor = r.last_sync_cursor
    itemsMap.set(r.provider_item_id, existing)
  }

  const plaid = getPlaidClient()

  let totalAdded = 0
  let totalModified = 0
  let totalRemoved = 0
  let failedItems = 0
  const errors: string[] = []

  for (const [itemId, bucket] of itemsMap.entries()) {
    // Look up the access_token for this item (owner-only table).
    const { data: secret, error: secretErr } = await gate.supabase
      .from('bank_provider_secrets')
      .select('access_token')
      .eq('restaurant_id', gate.restaurantId)
      .eq('provider', 'plaid')
      .eq('provider_item_id', itemId)
      .maybeSingle()
    if (secretErr || !secret) {
      failedItems++
      errors.push(`item ${itemId}: missing credentials`)
      continue
    }

    try {
      let cursor: string | undefined = bucket.cursor ?? undefined
      let added: PlaidTransaction[] = []
      let modified: PlaidTransaction[] = []
      let removed: RemovedTransaction[] = []
      let hasMore = true

      // Drain all pages of the delta in one call.
      while (hasMore) {
        const res = await plaid.transactionsSync({
          access_token: secret.access_token,
          cursor,
        })
        added = added.concat(res.data.added)
        modified = modified.concat(res.data.modified)
        removed = removed.concat(res.data.removed)
        hasMore = res.data.has_more
        cursor = res.data.next_cursor
      }

      // Upsert added + modified into bank_transactions.
      const upserts = [...added, ...modified]
        .map((tx) => {
          const localAccountId = bucket.accountIdsByPlaid.get(tx.account_id)
          if (!localAccountId) return null
          const amt = Number(tx.amount)
          // Plaid convention: positive amount = outflow (debit),
          // negative = inflow (credit). We normalize to positive
          // `amount` + a `direction` tag so the raw row is honest.
          const direction: 'inflow' | 'outflow' = amt >= 0 ? 'outflow' : 'inflow'
          return {
            restaurant_id: gate.restaurantId,
            connected_bank_account_id: localAccountId,
            provider_transaction_id: tx.transaction_id,
            amount: Math.abs(amt),
            direction,
            currency: tx.iso_currency_code ?? 'USD',
            description: tx.name ?? null,
            merchant_name: tx.merchant_name ?? null,
            raw_category: (tx.personal_finance_category?.primary ?? tx.category?.[0]) ?? null,
            posted_at: (tx.datetime ?? tx.authorized_datetime ?? tx.date) as string,
            pending: !!tx.pending,
            provider_metadata: tx as unknown as Record<string, unknown>,
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)

      if (upserts.length > 0) {
        const { error: upErr } = await gate.supabase
          .from('bank_transactions')
          .upsert(upserts, { onConflict: 'connected_bank_account_id,provider_transaction_id' })
        if (upErr) {
          failedItems++
          errors.push(`item ${itemId}: ${upErr.message}`)
          continue
        }
      }

      // Delete removed rows.
      if (removed.length > 0) {
        const removedIds = removed.map((r) => r.transaction_id)
        await gate.supabase
          .from('bank_transactions')
          .delete()
          .in('provider_transaction_id', removedIds)
          .in('connected_bank_account_id', bucket.ids)
      }

      // Advance cursor + last_synced_at on every account under this item.
      await gate.supabase
        .from('connected_bank_accounts')
        .update({
          last_sync_cursor: cursor ?? null,
          last_synced_at: new Date().toISOString(),
        })
        .in('id', bucket.ids)

      totalAdded += added.length
      totalModified += modified.length
      totalRemoved += removed.length
    } catch (err) {
      failedItems++
      errors.push(`item ${itemId}: ${formatPlaidError('sync', err)}`)
    }
  }

  revalidatePath('/finance')
  revalidatePath('/settings')

  if (failedItems > 0 && failedItems === itemsMap.size) {
    return { error: `All ${failedItems} item syncs failed. ${errors[0] ?? ''}` }
  }
  const failHint = failedItems > 0 ? ` (${failedItems} item${failedItems === 1 ? '' : 's'} failed)` : ''
  return {
    ok: true,
    message: `Bank sync: ${totalAdded} new, ${totalModified} updated, ${totalRemoved} removed${failHint}.`,
  }
}

// ================================================================
// 4. disconnectBank
//
// Marks every account under a Plaid Item inactive and deletes the
// item's secret row. Keeps historical bank_transactions so Finance
// doesn't lose context. Accepts `provider_item_id` so the caller
// can target a specific connection (future-proof for multi-item).
// ================================================================
export async function disconnectBank(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  if (!isPlaidConfigured()) return { error: PLAID_NOT_CONFIGURED }
  const gate = await gateOwner()
  if (!gate.ok) return { error: gate.error }

  const itemId = (formData.get('provider_item_id') as string | null)?.trim()
  if (!itemId) return { error: 'Missing provider_item_id.' }

  // Best-effort remote revoke — if Plaid rejects it, we still
  // proceed with the local deactivate so the UI doesn't get stuck.
  try {
    const { data: secret } = await gate.supabase
      .from('bank_provider_secrets')
      .select('access_token')
      .eq('restaurant_id', gate.restaurantId)
      .eq('provider', 'plaid')
      .eq('provider_item_id', itemId)
      .maybeSingle()
    if (secret) {
      const plaid = getPlaidClient()
      await plaid.itemRemove({ access_token: secret.access_token }).catch(() => null)
    }
  } catch {
    // swallow — local cleanup below is the source of truth
  }

  const { error: accErr } = await gate.supabase
    .from('connected_bank_accounts')
    .update({ active: false })
    .eq('restaurant_id', gate.restaurantId)
    .eq('provider', 'plaid')
    .eq('provider_item_id', itemId)
  if (accErr) return { error: accErr.message }

  const { error: secErr } = await gate.supabase
    .from('bank_provider_secrets')
    .delete()
    .eq('restaurant_id', gate.restaurantId)
    .eq('provider', 'plaid')
    .eq('provider_item_id', itemId)
  if (secErr) return { error: secErr.message }

  revalidatePath('/settings')
  revalidatePath('/finance')
  return { ok: true, message: 'Disconnected bank.' }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

async function safeGetInstitutionName(institutionId: string): Promise<string | null> {
  try {
    const plaid = getPlaidClient()
    const res = await plaid.institutionsGetById({
      institution_id: institutionId,
      country_codes: [CountryCode.Us],
    })
    return res.data.institution.name ?? null
  } catch {
    return null
  }
}

function formatPlaidError(step: string, err: unknown): string {
  // Plaid SDK throws Axios-shaped errors with response.data.
  const anyErr = err as {
    response?: { data?: { error_code?: string; error_message?: string } }
    message?: string
  }
  const code = anyErr?.response?.data?.error_code
  const msg = anyErr?.response?.data?.error_message ?? anyErr?.message ?? 'Unknown error'
  if (process.env.NODE_ENV === 'development') {
    return `[DEV] ${step} failed — ${msg}${code ? ` (${code})` : ''}`
  }
  return `Could not complete ${step}. Please try again.`
}
