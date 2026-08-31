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
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'
import { isDevEmail } from '@/lib/dev'
import {
  CountryCode,
  Products,
  Transaction as PlaidTransaction,
  RemovedTransaction,
} from 'plaid'
import { getPlaidClient, isPlaidConfigured, isPlaidSandbox } from '@/lib/plaid/client'

// Plaid Sandbox dynamic-transactions test profile.
// `user_transactions_dynamic` is the only Sandbox username for which
// /sandbox/transactions/create reliably persists rows that surface
// in /transactions/sync. Pinned to ins_109508 (First Platypus Bank),
// the canonical Sandbox institution that supports the Transactions
// product. Used by connectSandboxItem() — see below.
const SANDBOX_DYNAMIC_INSTITUTION_ID = 'ins_109508'
const SANDBOX_DYNAMIC_USERNAME = 'user_transactions_dynamic'
const SANDBOX_DYNAMIC_PASSWORD = 'pass_good'

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
export async function createPlaidLinkToken(
  /** Absolute URL Plaid should redirect back to after an OAuth
   *  round trip (Cash App, Venmo, PayPal, and most bank OAuth
   *  flows). Must exactly match an entry in the Plaid dashboard's
   *  Allowed redirect URIs. Omit for non-OAuth institutions —
   *  Link will still work, they just can't OAuth. */
  redirectUri?: string,
): Promise<Result<{ ok: true; linkToken: string }>> {
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
      ...(redirectUri && { redirect_uri: redirectUri }),
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

    const persisted = await persistPlaidItem(gate, accessToken, itemId)
    if ('error' in persisted) return persisted

    revalidatePath('/settings')
    revalidatePath('/finance')
    revalidatePath('/web/finance')
    return {
      ok: true,
      message: `Connected ${persisted.accountCount} account${persisted.accountCount === 1 ? '' : 's'}.`,
    }
  } catch (err) {
    return { error: formatPlaidError('public token exchange', err) }
  }
}

// ----------------------------------------------------------------
// persistPlaidItem
//
// Shared write path for any flow that produces a fresh Plaid
// access_token + item_id (production Link exchange, dev-only
// sandbox connect, future flows). Calls /accounts/get to validate
// the token and pull display metadata, then upserts:
//   bank_provider_secrets   — owner-only, holds the access_token
//   connected_bank_accounts — one row per Plaid account
//
// Pure persistence — does not revalidate caches; callers do that
// so they can attach their own success message and redirects.
// ----------------------------------------------------------------
async function persistPlaidItem(
  gate: { supabase: Awaited<ReturnType<typeof createClient>>; restaurantId: string },
  accessToken: string,
  itemId: string
): Promise<{ ok: true; accountCount: number } | { error: string }> {
  const plaid = getPlaidClient()

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

  return { ok: true, accountCount: rows.length }
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

      console.log(`[plaid sync] item=${itemId} cursor=${cursor ? cursor.slice(0, 16) + '…' : 'null'}`)

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

      console.log(`[plaid sync] item=${itemId} delta: added=${added.length} modified=${modified.length} removed=${removed.length}`)

      // Upsert added + modified into bank_transactions. Track filter
      // drops so we can diagnose account_id mismatches.
      let droppedForUnknownAccount = 0
      const upserts = [...added, ...modified]
        .map((tx) => {
          const localAccountId = bucket.accountIdsByPlaid.get(tx.account_id)
          if (!localAccountId) {
            droppedForUnknownAccount++
            return null
          }
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

      if (droppedForUnknownAccount > 0) {
        console.warn(
          `[plaid sync] item=${itemId} dropped ${droppedForUnknownAccount} txn(s) — account_id mismatch.`,
          'Known local account ids for this item:',
          [...bucket.accountIdsByPlaid.keys()]
        )
      }
      console.log(`[plaid sync] item=${itemId} upserts=${upserts.length}`)

      if (upserts.length > 0) {
        const { error: upErr } = await gate.supabase
          .from('bank_transactions')
          .upsert(upserts, { onConflict: 'connected_bank_account_id,provider_transaction_id' })
        if (upErr) {
          console.error(`[plaid sync] item=${itemId} upsert failed:`, upErr.message)
          failedItems++
          errors.push(`item ${itemId}: ${upErr.message}`)
          continue
        }
        console.log(`[plaid sync] item=${itemId} upsert ok`)
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
  revalidatePath('/web/finance')
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
  revalidatePath('/web/finance')
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

// ================================================================
// 5. maybeAutoSyncBankTransactions
//
// Server-only helper called by the Finance page on load. Triggers
// a real sync only when at least one connected account hasn't been
// synced recently (or never has). Keeps the page snappy on repeat
// visits while still feeling "automatic" to the user.
//
// Returns whether a sync ran, so callers can decide whether to
// re-fetch dependent data.
// ================================================================

const AUTO_SYNC_STALENESS_MS = 5 * 60 * 1000  // 5 minutes

export async function maybeAutoSyncBankTransactions(): Promise<{
  synced: boolean
  message?: string
  error?: string
}> {
  if (!isPlaidConfigured()) return { synced: false }

  const gate = await gateOwner()
  if (!gate.ok) return { synced: false, error: gate.error }

  const { data: rows } = await gate.supabase
    .from('connected_bank_accounts')
    .select('last_synced_at')
    .eq('restaurant_id', gate.restaurantId)
    .eq('provider', 'plaid')
    .eq('active', true)

  if (!rows || rows.length === 0) return { synced: false }

  const now = Date.now()
  const stale = rows.some((r) => {
    if (!r.last_synced_at) return true
    return now - new Date(r.last_synced_at).getTime() > AUTO_SYNC_STALENESS_MS
  })
  if (!stale) return { synced: false }

  // Reuse the canonical sync path so the auto-trigger has identical
  // behavior to the manual button.
  const res = await syncBankTransactions(null, new FormData())
  if ('error' in res) return { synced: false, error: res.error }
  return { synced: true, message: res.message }
}

// ================================================================
// 6. connectSandboxItem (Sandbox-only, dev-only)
//
// Why this exists:
//   The interactive Plaid Link sandbox flow is non-deterministic
//   for `user_transactions_dynamic`. Even when the user types the
//   exact username + pass_good in Link, the resulting Item often
//   does NOT behave as a dynamic-transactions Item — calls to
//   /sandbox/transactions/create return 200 but Plaid silently
//   no-ops, leaving zero rows in /transactions/get. We confirmed
//   this with a live verdict-A diagnostic.
//
//   The reliable, documented way to create a Sandbox Item that
//   supports /sandbox/transactions/create is to skip Link entirely
//   and call /sandbox/public_token/create with
//   `options.override_username = 'user_transactions_dynamic'`. That
//   endpoint is what Plaid's own examples use for transaction tests.
//
// Behavior:
//   1. /sandbox/public_token/create  → public_token bound to a
//      First Platypus Bank Item with override_username =
//      user_transactions_dynamic, transactions product enabled.
//   2. /item/public_token/exchange   → access_token + item_id.
//   3. persistPlaidItem(...)         → same write path as the
//      production Link exchange (bank_provider_secrets +
//      connected_bank_accounts).
//
// Hidden in production:
//   The action returns an error if PLAID_ENV !== sandbox so it
//   can never run live. The UI already gates it behind isDev +
//   plaidSandbox, but the server-side check is defense in depth.
//
// Production parity:
//   This action does NOT replace the user-facing Connect bank
//   button (that still goes through Plaid Link). It's a separate,
//   sandbox-only affordance for testing.
// ================================================================
export async function connectSandboxItem(
  _prevState: Result | null,
  _formData: FormData
): Promise<Result> {
  if (!isPlaidConfigured()) return { error: PLAID_NOT_CONFIGURED }
  if (!isPlaidSandbox()) {
    return { error: 'Sandbox connect is only available when PLAID_ENV=sandbox.' }
  }
  const gate = await gateOwner()
  if (!gate.ok) return { error: gate.error }

  try {
    const plaid = getPlaidClient()

    const sandboxRes = await plaid.sandboxPublicTokenCreate({
      institution_id: SANDBOX_DYNAMIC_INSTITUTION_ID,
      initial_products: [Products.Transactions],
      options: {
        override_username: SANDBOX_DYNAMIC_USERNAME,
        override_password: SANDBOX_DYNAMIC_PASSWORD,
      },
    })
    const publicToken = sandboxRes.data.public_token

    const exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken })
    const accessToken = exchange.data.access_token
    const itemId = exchange.data.item_id

    const persisted = await persistPlaidItem(gate, accessToken, itemId)
    if ('error' in persisted) return persisted

    revalidatePath('/settings')
    revalidatePath('/finance')
    revalidatePath('/web/finance')
    return {
      ok: true,
      message:
        `Sandbox dynamic-transactions Item connected ` +
        `(${persisted.accountCount} account${persisted.accountCount === 1 ? '' : 's'}). ` +
        `Now click "Add sandbox rent expense" — it will hit this Item, which is guaranteed ` +
        `to support /sandbox/transactions/create.`,
    }
  } catch (err) {
    return { error: formatPlaidError('sandbox connect', err) }
  }
}

// ================================================================
// 7. createSandboxRentTransaction (Sandbox-only, dev-only)
//
// Calls Plaid's /sandbox/transactions/create endpoint to inject a
// fake rent expense into the connected sandbox account, then runs
// the regular sync so the new row flows into bank_transactions and
// Finance picks it up.
//
// Requirements:
//   • PLAID_ENV must be 'sandbox'
//   • The Plaid Item must have been created with the
//     `user_transactions_dynamic` username (otherwise Plaid rejects
//     the call with INVALID_ITEM)
//
// Owner-gated. Visible to dev users only via Finance UI.
// ================================================================
export async function createSandboxRentTransaction(
  _prevState: Result | null,
  formData: FormData
): Promise<Result> {
  if (!isPlaidConfigured()) return { error: 'Plaid is not configured.' }

  const gate = await gateOwner()
  if (!gate.ok) return { error: gate.error }

  const itemId = (formData.get('provider_item_id') as string | null)?.trim() ?? null

  // ----------------------------------------------------------------
  // DIAG: full inventory of what's in the DB before we choose an
  // Item. Lets us see at a glance whether there are stale or
  // orphan rows that could cause a create vs sync mismatch.
  // ----------------------------------------------------------------
  const { data: allSecrets } = await gate.supabase
    .from('bank_provider_secrets')
    .select('provider_item_id, updated_at')
    .eq('restaurant_id', gate.restaurantId)
    .eq('provider', 'plaid')
    .order('updated_at', { ascending: false })

  const { data: allAccounts } = await gate.supabase
    .from('connected_bank_accounts')
    .select('provider_item_id, provider_account_id, active, last_synced_at')
    .eq('restaurant_id', gate.restaurantId)
    .eq('provider', 'plaid')

  console.log('[sandbox rent] DIAG bank_provider_secrets rows:')
  for (const s of allSecrets ?? []) {
    console.log(`  item=${s.provider_item_id} updated_at=${s.updated_at}`)
  }
  console.log('[sandbox rent] DIAG connected_bank_accounts rows:')
  for (const a of allAccounts ?? []) {
    console.log(`  item=${a.provider_item_id} account=${a.provider_account_id} active=${a.active} last_synced=${a.last_synced_at ?? 'never'}`)
  }

  // Find the access_token. If the caller passed an item_id, target
  // that one; otherwise pick the most recently connected sandbox item.
  const secretsQuery = gate.supabase
    .from('bank_provider_secrets')
    .select('access_token, provider_item_id')
    .eq('restaurant_id', gate.restaurantId)
    .eq('provider', 'plaid')
    .order('updated_at', { ascending: false })
    .limit(1)

  const { data: secret } = itemId
    ? await secretsQuery.eq('provider_item_id', itemId).maybeSingle()
    : await secretsQuery.maybeSingle()

  if (!secret) return { error: 'No connected sandbox bank found.' }

  console.log(`[sandbox rent] CREATE-SIDE item_id (most-recent secret) = ${secret.provider_item_id}`)
  const activeItemIds = (allAccounts ?? []).filter((a) => a.active).map((a) => a.provider_item_id)
  const createItemIsActive = activeItemIds.includes(secret.provider_item_id)
  console.log(`[sandbox rent] SYNC-SIDE iterates active item_ids = [${activeItemIds.join(', ')}]`)
  console.log(`[sandbox rent] CREATE-SIDE item ∈ SYNC-SIDE list? ${createItemIsActive ? 'YES' : 'NO — sync will skip this item'}`)

  const amountRaw = (formData.get('amount') as string | null)?.trim()
  const amount = amountRaw ? parseFloat(amountRaw) : 1500
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'Amount must be greater than zero.' }
  }

  const today = new Date().toISOString().split('T')[0]
  const description = (formData.get('description') as string | null)?.trim() || 'RENT — Monthly'

  // Plaid SDK exposes /sandbox/transactions/create as
  // `sandboxTransactionsCreate`. The endpoint requires `date_posted`
  // and `description`; positive amount means an outflow (debit) on
  // the account, which is what we want for an expense.
  try {
    const plaid = getPlaidClient()

    // ------------------------------------------------------------
    // DIAG: ask Plaid directly what this access_token represents,
    // before we use it. Confirms (a) Plaid agrees on item_id,
    // (b) which products are enabled (transactions must be in
    // there), (c) what accounts Plaid sees vs what we stored.
    // ------------------------------------------------------------
    try {
      const itemRes = await plaid.itemGet({ access_token: secret.access_token })
      console.log(
        `[sandbox rent] /item/get plaid_item_id=${itemRes.data.item.item_id} products=${JSON.stringify(itemRes.data.item.products)} update_type=${itemRes.data.item.update_type ?? 'n/a'}`
      )
      if (itemRes.data.item.item_id !== secret.provider_item_id) {
        console.warn(
          `[sandbox rent] WARN our stored item_id (${secret.provider_item_id}) ≠ Plaid's item_id (${itemRes.data.item.item_id})`
        )
      }
      const accountsRes = await plaid.accountsGet({ access_token: secret.access_token })
      console.log(
        `[sandbox rent] /accounts/get returns ${accountsRes.data.accounts.length} account(s):`,
        accountsRes.data.accounts.map((a) => ({
          id: a.account_id, name: a.name, type: a.type, subtype: a.subtype,
        }))
      )
      // Cross-check Plaid's account_ids against our local rows.
      const localAccountIds = new Set(
        (allAccounts ?? [])
          .filter((a) => a.provider_item_id === secret.provider_item_id)
          .map((a) => a.provider_account_id)
      )
      const plaidAccountIds = accountsRes.data.accounts.map((a) => a.account_id)
      const missingFromLocal = plaidAccountIds.filter((id) => !localAccountIds.has(id))
      if (missingFromLocal.length > 0) {
        console.warn(
          `[sandbox rent] WARN Plaid account_ids missing from our DB:`, missingFromLocal,
          '— sync would drop transactions on these accounts via the bucket.accountIdsByPlaid filter.'
        )
      }
    } catch (verifyErr) {
      console.warn('[sandbox rent] /item/get or /accounts/get failed:', verifyErr)
      // Continue — diagnostics shouldn't block the sandbox create.
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandboxTxnCreate = (plaid as any).sandboxTransactionsCreate?.bind(plaid)
    if (typeof sandboxTxnCreate !== 'function') {
      return {
        error:
          'Plaid SDK on disk does not expose sandboxTransactionsCreate. ' +
          'Upgrade `plaid` to a recent version or call /sandbox/transactions/create directly.',
      }
    }

    console.log(
      `[sandbox rent] starting create: item=${secret.provider_item_id} amount=${amount} date=${today}`
    )
    const createRes = await sandboxTxnCreate({
      access_token: secret.access_token,
      transactions: [
        {
          amount,
          date_posted: today,
          date_transacted: today,
          description,
          iso_currency_code: 'USD',
        },
      ],
    })
    console.log(
      `[sandbox rent] plaid create ok: request_id=${createRes?.data?.request_id ?? '?'}`
    )
  } catch (err) {
    console.error('[sandbox rent] plaid create failed:', err)
    return { error: formatPlaidError('sandbox transaction create', err) }
  }

  // Plaid documents that /sandbox/transactions/create has a lag
  // before the new tx surfaces in /transactions/sync. Retry up to
  // 3 times with growing delays (~6s total worst case).
  const isEmpty = (msg: string) => /^Bank sync: 0 new, 0 updated, 0 removed/.test(msg)
  const delays = [0, 1000, 2000, 3000]

  let syncRes: Result | null = null
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      console.log(`[sandbox rent] sync attempt ${attempt + 1} after ${delays[attempt]}ms…`)
      await new Promise((r) => setTimeout(r, delays[attempt]))
    } else {
      console.log('[sandbox rent] sync attempt 1…')
    }
    const res = await syncBankTransactions(null, new FormData())
    if ('error' in res) {
      console.error(`[sandbox rent] sync attempt ${attempt + 1} failed:`, res.error)
      return { error: `Local sync failed: ${res.error}` }
    }
    console.log(`[sandbox rent] sync attempt ${attempt + 1} result:`, res.message)
    syncRes = res
    if (!isEmpty(res.message)) break
  }

  // ----------------------------------------------------------------
  // ALWAYS verify via /transactions/get, regardless of sync outcome.
  // Pulls a 2-day window so a midnight UTC boundary doesn't hide
  // today's tx. Surfaces the actual response body (transaction
  // list) in both the server log and the toast message — the
  // user explicitly asked for response contents, not status codes.
  // ----------------------------------------------------------------
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toISOString().split('T')[0]

  type VerifyTxn = { name: string; amount: number; date: string; account_id: string; transaction_id: string }
  let verifyTxns: VerifyTxn[] = []
  let verifyError: string | null = null
  try {
    const plaid = getPlaidClient()
    const verify = await plaid.transactionsGet({
      access_token: secret.access_token,
      start_date: yesterdayStr,
      end_date: today,
      options: { count: 100 },
    })
    verifyTxns = verify.data.transactions.map((t) => ({
      name: t.name ?? '(no name)',
      amount: t.amount,
      date: t.date,
      account_id: t.account_id,
      transaction_id: t.transaction_id,
    }))
    console.log(
      `[sandbox rent] /transactions/get window=${yesterdayStr}..${today} returned ${verifyTxns.length} txn(s):`
    )
    for (const t of verifyTxns) {
      console.log(`  • ${t.date} | ${t.amount.toFixed(2)} | ${t.name} | account=${t.account_id} | txn_id=${t.transaction_id}`)
    }
  } catch (err) {
    verifyError = formatPlaidError('verify', err)
    console.error('[sandbox rent] /transactions/get failed:', err)
  }

  revalidatePath('/finance')
  revalidatePath('/web/finance')
  revalidatePath('/settings')

  // Was the just-created rent actually persisted by Plaid?
  // Match by amount (Plaid sandbox preserves exact amount) and
  // description fragment (case-insensitive).
  const rentMatch = verifyTxns.find(
    (t) => Math.abs(t.amount - amount) < 0.01 &&
      t.name.toLowerCase().includes(description.toLowerCase().split(' ')[0])
  )
  const exactlyTodaysTxns = verifyTxns.filter((t) => t.date === today)

  // Build a multi-line summary the toast can render.
  const sample = verifyTxns.slice(0, 6).map(
    (t) => `  • ${t.date} | $${t.amount.toFixed(2)} | ${t.name}`
  ).join('\n')

  if (verifyError) {
    return {
      error:
        `Sandbox create returned 200, sync result: ${syncRes?.message ?? '(none)'}\n` +
        `But /transactions/get verification failed: ${verifyError}`,
    }
  }

  if (verifyTxns.length === 0) {
    // Definitive: Plaid has nothing for the last 2 days on this Item.
    // /sandbox/transactions/create returned 200 but didn't persist.
    // This Item is not a valid user_transactions_dynamic Item.
    return {
      error:
        `Plaid persisted ZERO transactions for ${yesterdayStr}..${today} on this Item.\n` +
        `\n` +
        `Conclusion: this Item is NOT a valid user_transactions_dynamic Item. ` +
        `/sandbox/transactions/create returned 200 but no row was actually stored.\n` +
        `\n` +
        `Fix: disconnect the bank in External money, reconnect via Plaid Link, ` +
        `and type EXACTLY "user_transactions_dynamic" as the username (password = pass_good).`,
    }
  }

  if (!rentMatch) {
    // Plaid has SOME transactions but not the rent we just created.
    // Item may be valid but Plaid is rejecting/ignoring our create.
    return {
      ok: true,
      message:
        `Sandbox create returned 200 and sync ran, but the $${amount.toFixed(2)} rent ` +
        `is NOT in /transactions/get for ${yesterdayStr}..${today}.\n` +
        `\n` +
        `Plaid returned ${verifyTxns.length} transaction(s) in that window:\n` +
        `${sample}${verifyTxns.length > 6 ? `\n  …(+${verifyTxns.length - 6} more)` : ''}\n` +
        `\n` +
        `Conclusion: this Item likely is NOT a user_transactions_dynamic Item — ` +
        `Plaid is returning the default sandbox transactions for it but silently ` +
        `dropping our /sandbox/transactions/create payload.`,
    }
  }

  // Rent IS in Plaid's response. Did sync surface it locally?
  const syncFoundIt = syncRes && !isEmpty(syncRes.message)
  return {
    ok: true,
    message:
      `Plaid PERSISTED the rent. Verified via /transactions/get:\n` +
      `  • ${rentMatch.date} | $${rentMatch.amount.toFixed(2)} | ${rentMatch.name}\n` +
      `\n` +
      `Sync result: ${syncRes?.message ?? '(no sync ran)'}\n` +
      (syncFoundIt
        ? `Local DB updated. The row should now appear in External money.`
        : `Sync cursor hasn't caught up yet. Refresh Finance — the next auto-sync ` +
          `(or page load) will pull it in. (${exactlyTodaysTxns.length} txn(s) dated ${today})`)
  }
}

// ================================================================
// BANK REVIEW V1 — settlement actions
//
// Four review actions that mutate the bank_transactions.review_state
// column added in the Bank Review V1 migration. They are
// intentionally thin: RLS scopes every UPDATE to the calling
// restaurant, so the actions just need an authenticated user plus
// a txn_id. No owner gate — any member of the restaurant can review
// bank activity.
//
//   settleBankTransaction         marks a row settled with a kind
//                                 (revenue | inventory | labor |
//                                 operating)
//   ignoreBankTransaction         personal / owner transfer / not a
//                                 business event — excluded from
//                                 Finance totals
//   markBankTransactionNotAMatch  manager isn't sure yet; surface
//                                 it under "Review later" without
//                                 leaving it in the main queue
//   reopenBankTransaction         undo — flips any state back to
//                                 unreviewed
//
// Each action revalidates /finance so the card counts refresh
// without a hard reload. Bank Review V1 does NOT create expense
// rows on settle yet — it only tags the bank row. A future pass
// will optionally write/link to expenses for double-entry honesty.
// ================================================================
type SettlementKind = 'revenue' | 'inventory' | 'labor' | 'operating'
const SETTLEMENT_KINDS: SettlementKind[] = ['revenue', 'inventory', 'labor', 'operating']

async function authedSupabase() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, error: 'Not authenticated.' }
  return { ok: true as const, supabase, userId: user.id }
}

export async function settleBankTransaction(
  prevState: Result | null,
  formData: FormData,
): Promise<Result> {
  const txnId = (formData.get('txn_id') as string | null)?.trim()
  const kindRaw = (formData.get('kind') as string | null)?.trim()
  if (!txnId) return { error: 'Missing transaction id.' }
  if (!kindRaw || !SETTLEMENT_KINDS.includes(kindRaw as SettlementKind)) {
    return { error: 'Invalid settlement kind.' }
  }
  const kind = kindRaw as SettlementKind

  const gate = await authedSupabase()
  if (!gate.ok) return { error: gate.error }

  const { error } = await gate.supabase
    .from('bank_transactions')
    .update({
      review_state: 'settled',
      settled_kind: kind,
      settled_at: new Date().toISOString(),
    })
    .eq('id', txnId)

  if (error) return { error: error.message }

  revalidatePath('/finance')
  revalidatePath('/web/finance')
  return { ok: true, message: `Settled as ${kind}.` }
}

export async function ignoreBankTransaction(
  prevState: Result | null,
  formData: FormData,
): Promise<Result> {
  const txnId = (formData.get('txn_id') as string | null)?.trim()
  if (!txnId) return { error: 'Missing transaction id.' }

  const gate = await authedSupabase()
  if (!gate.ok) return { error: gate.error }

  const { error } = await gate.supabase
    .from('bank_transactions')
    .update({
      review_state: 'ignored',
      settled_kind: null,
      settled_expense_id: null,
      settled_at: new Date().toISOString(),
    })
    .eq('id', txnId)

  if (error) return { error: error.message }

  revalidatePath('/finance')
  revalidatePath('/web/finance')
  return { ok: true, message: 'Ignored.' }
}

export async function markBankTransactionNotAMatch(
  prevState: Result | null,
  formData: FormData,
): Promise<Result> {
  const txnId = (formData.get('txn_id') as string | null)?.trim()
  if (!txnId) return { error: 'Missing transaction id.' }

  const gate = await authedSupabase()
  if (!gate.ok) return { error: gate.error }

  const { error } = await gate.supabase
    .from('bank_transactions')
    .update({
      review_state: 'not_a_match',
      settled_kind: null,
      settled_expense_id: null,
      settled_at: new Date().toISOString(),
    })
    .eq('id', txnId)

  if (error) return { error: error.message }

  revalidatePath('/finance')
  revalidatePath('/web/finance')
  return { ok: true, message: 'Marked for later review.' }
}

export async function reopenBankTransaction(
  prevState: Result | null,
  formData: FormData,
): Promise<Result> {
  const txnId = (formData.get('txn_id') as string | null)?.trim()
  if (!txnId) return { error: 'Missing transaction id.' }

  const gate = await authedSupabase()
  if (!gate.ok) return { error: gate.error }

  const { error } = await gate.supabase
    .from('bank_transactions')
    .update({
      review_state: 'unreviewed',
      settled_kind: null,
      settled_expense_id: null,
      settled_at: null,
    })
    .eq('id', txnId)

  if (error) return { error: error.message }

  revalidatePath('/finance')
  revalidatePath('/web/finance')
  return { ok: true, message: 'Reopened.' }
}

// ================================================================
// Group-level settlement actions
//
// Bank Review now groups unreviewed activity into vendor/category
// buckets (Costco, HEB, Rent & utilities, Bank fees, etc.) so the
// manager confirms or changes one pattern at a time instead of
// every transaction. Each group action accepts a `txn_ids` field
// — a comma-separated list of bank_transactions.id values — and
// applies the same review_state update to every row in that list.
//
// RLS scopes the UPDATE to the calling restaurant automatically;
// the only client-trusted input is the id set, which RLS rejects
// for any id outside the restaurant. The shape (review_state +
// settled_kind + settled_at) mirrors the single-row actions above
// exactly, so settling a group is just a batched form of settling
// each underlying row.
// ================================================================

function parseTxnIds(formData: FormData): string[] {
  const raw = (formData.get('txn_ids') as string | null)?.trim() ?? ''
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export async function settleBankTransactionGroup(
  prevState: Result | null,
  formData: FormData,
): Promise<Result> {
  const txnIds = parseTxnIds(formData)
  const kindRaw = (formData.get('kind') as string | null)?.trim()
  if (txnIds.length === 0) return { error: 'No transactions to settle.' }
  if (!kindRaw || !SETTLEMENT_KINDS.includes(kindRaw as SettlementKind)) {
    return { error: 'Invalid settlement kind.' }
  }
  const kind = kindRaw as SettlementKind

  const gate = await authedSupabase()
  if (!gate.ok) return { error: gate.error }

  const { error } = await gate.supabase
    .from('bank_transactions')
    .update({
      review_state: 'settled',
      settled_kind: kind,
      settled_at: new Date().toISOString(),
    })
    .in('id', txnIds)

  if (error) return { error: error.message }

  revalidatePath('/finance')
  revalidatePath('/web/finance')
  return {
    ok: true,
    message: `Settled ${txnIds.length} transaction${txnIds.length === 1 ? '' : 's'} as ${kind}.`,
  }
}

export async function ignoreBankTransactionGroup(
  prevState: Result | null,
  formData: FormData,
): Promise<Result> {
  const txnIds = parseTxnIds(formData)
  if (txnIds.length === 0) return { error: 'No transactions to ignore.' }

  const gate = await authedSupabase()
  if (!gate.ok) return { error: gate.error }

  const { error } = await gate.supabase
    .from('bank_transactions')
    .update({
      review_state: 'ignored',
      settled_kind: null,
      settled_expense_id: null,
      settled_at: new Date().toISOString(),
    })
    .in('id', txnIds)

  if (error) return { error: error.message }

  revalidatePath('/finance')
  revalidatePath('/web/finance')
  return {
    ok: true,
    message: `Ignored ${txnIds.length} transaction${txnIds.length === 1 ? '' : 's'}.`,
  }
}

export async function markBankTransactionGroupNotAMatch(
  prevState: Result | null,
  formData: FormData,
): Promise<Result> {
  const txnIds = parseTxnIds(formData)
  if (txnIds.length === 0) return { error: 'No transactions to defer.' }

  const gate = await authedSupabase()
  if (!gate.ok) return { error: gate.error }

  const { error } = await gate.supabase
    .from('bank_transactions')
    .update({
      review_state: 'not_a_match',
      settled_kind: null,
      settled_expense_id: null,
      settled_at: new Date().toISOString(),
    })
    .in('id', txnIds)

  if (error) return { error: error.message }

  revalidatePath('/finance')
  revalidatePath('/web/finance')
  return {
    ok: true,
    message: `Marked ${txnIds.length} transaction${txnIds.length === 1 ? '' : 's'} for later review.`,
  }
}

// ================================================================
// FINANCE SETTLEMENT SANDBOX — dev-only seeding
//
// Inserts deterministic test bank_transactions rows so the Bank
// Review workflow can be exercised against scenarios that real
// Plaid sandbox data doesn't reliably produce. Every seeded row is
// tagged in two redundant ways for safe cleanup:
//
//   1. provider_transaction_id begins with 'sandbox_'
//   2. provider_metadata.sandbox is true
//
// `clearSandboxBankTransactions` filters on the prefix AND the
// calling restaurant scope so a runaway query cannot delete real
// Plaid-imported rows. Every action is gated by isDevEmail; in
// production an unauthorized user receives the same generic error
// the auth gate would return.
//
// Scenarios are tuned to the matching engine in lib/finance/
// matching.ts so the "Suggested matches" section actually fires:
//   - revenue   → Stripe Payout (REVENUE_KEYWORDS + INCOME PFC)
//   - inventory → Sysco Foods   (INVENTORY_KEYWORDS + FOOD_AND_DRINK)
//   - payroll   → ADP Payroll   (LABOR_KEYWORDS)
//   - operating → Rent payment  (OPERATING_KEYWORDS + RENT_AND_UTILITIES)
//   - personal  → CVS Pharmacy  (PERSONAL_KEYWORDS, MEDICAL PFC)
//   - cash      → Cash Deposit  (no PFC; classifier returns unclear)
//   - unmatched → ambiguous in + out (no signals — manager triage)
// ================================================================

const SANDBOX_PFX = 'sandbox_'

interface SandboxSeedSpec {
  scenario: string
  direction: 'inflow' | 'outflow'
  amount: number
  rawCategory: string | null
  merchantName: string
  description: string
  daysAgo: number
}

const SANDBOX_SCENARIOS: Record<string, SandboxSeedSpec[]> = {
  revenue: [
    { scenario: 'revenue', direction: 'inflow', amount: 487.32, rawCategory: 'INCOME',
      merchantName: 'Stripe Payout', description: 'STRIPE PAYOUT 487.32', daysAgo: 1 },
  ],
  inventory: [
    { scenario: 'inventory', direction: 'outflow', amount: 312.50, rawCategory: 'FOOD_AND_DRINK',
      merchantName: 'Sysco Foods', description: 'SYSCO ACH DEBIT', daysAgo: 2 },
  ],
  payroll: [
    { scenario: 'payroll', direction: 'outflow', amount: 1842.50, rawCategory: 'GENERAL_SERVICES',
      merchantName: 'ADP Payroll', description: 'ADP PAYROLL BIWEEKLY', daysAgo: 3 },
  ],
  operating: [
    { scenario: 'operating', direction: 'outflow', amount: 1500.00, rawCategory: 'RENT_AND_UTILITIES',
      merchantName: 'Property Mgmt LLC', description: 'RENT PAYMENT MAY', daysAgo: 0 },
  ],
  personal: [
    { scenario: 'personal', direction: 'outflow', amount: 87.23, rawCategory: 'MEDICAL',
      merchantName: 'CVS Pharmacy', description: 'CVS PHARMACY 87.23', daysAgo: 4 },
  ],
  cash: [
    { scenario: 'cash', direction: 'inflow', amount: 425.00, rawCategory: null,
      merchantName: 'Cash Deposit', description: 'CASH DEPOSIT BRANCH', daysAgo: 1 },
  ],
  unmatched: [
    { scenario: 'unmatched_in', direction: 'inflow', amount: 200.00, rawCategory: null,
      merchantName: 'Unknown Deposit', description: 'INCOMING WIRE', daysAgo: 5 },
    { scenario: 'unmatched_out', direction: 'outflow', amount: 142.99, rawCategory: null,
      merchantName: 'WTHDRWL', description: 'WTHDRWL ATM 142.99', daysAgo: 3 },
  ],
}

async function gateDev(): Promise<
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; restaurantId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated.' }
  if (!isDevEmail(user.email)) return { ok: false, error: 'Dev access only.' }
  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role?.restaurant_id) return { ok: false, error: 'No restaurant found.' }
  return { ok: true, supabase, restaurantId: role.restaurant_id }
}

export async function seedSandboxBankTransactions(
  prevState: Result | null,
  formData: FormData,
): Promise<Result> {
  const gate = await gateDev()
  if (!gate.ok) return { error: gate.error }

  const scenarioKey = (formData.get('scenario') as string | null)?.trim()
  if (!scenarioKey) return { error: 'Missing scenario.' }

  // 'demo' = run every named scenario; otherwise the single one.
  let specs: SandboxSeedSpec[] = []
  if (scenarioKey === 'demo') {
    specs = Object.values(SANDBOX_SCENARIOS).flat()
  } else if (scenarioKey in SANDBOX_SCENARIOS) {
    specs = SANDBOX_SCENARIOS[scenarioKey]
  } else {
    return { error: `Unknown scenario: ${scenarioKey}` }
  }

  // Need an active connected_bank_account to anchor the FK. The
  // Plaid sandbox connect lives at the top of /dev-tools — the
  // manager has to run that once before this section can do work.
  const { data: accts } = await gate.supabase
    .from('connected_bank_accounts')
    .select('id')
    .eq('restaurant_id', gate.restaurantId)
    .eq('active', true)
    .limit(1)
  const accountId = accts?.[0]?.id
  if (!accountId) {
    return { error: 'Connect a sandbox bank first (top of /dev-tools).' }
  }

  const nowMs = Date.now()
  const nowIso = new Date().toISOString()
  const rows = specs.map((spec, i) => {
    const postedAt = new Date()
    postedAt.setDate(postedAt.getDate() - spec.daysAgo)
    return {
      restaurant_id: gate.restaurantId,
      connected_bank_account_id: accountId,
      provider_transaction_id: `${SANDBOX_PFX}${spec.scenario}_${nowMs}_${i}`,
      amount: spec.amount,
      direction: spec.direction,
      currency: 'USD',
      description: spec.description,
      merchant_name: spec.merchantName,
      raw_category: spec.rawCategory,
      posted_at: postedAt.toISOString(),
      pending: false,
      provider_metadata: { sandbox: true, scenario: spec.scenario, seeded_at: nowIso },
      review_state: 'unreviewed',
    }
  })

  const { error } = await gate.supabase.from('bank_transactions').insert(rows)
  if (error) return { error: error.message }

  revalidatePath('/finance')
  revalidatePath('/web/finance')
  revalidatePath('/dev-tools')
  return {
    ok: true,
    message: `Seeded ${rows.length} sandbox row${rows.length === 1 ? '' : 's'} (${scenarioKey}).`,
  }
}

export async function clearSandboxBankTransactions(
  prevState: Result | null,
  formData: FormData,
): Promise<Result> {
  const gate = await gateDev()
  if (!gate.ok) return { error: gate.error }

  // Two-fold safety: explicit restaurant scope + prefix match.
  // RLS already constrains writes to this restaurant; the prefix
  // guarantees only sandbox-seeded rows are touched even if a
  // future RLS change widens scope.
  const { data, error } = await gate.supabase
    .from('bank_transactions')
    .delete()
    .eq('restaurant_id', gate.restaurantId)
    .like('provider_transaction_id', `${SANDBOX_PFX}%`)
    .select('id')

  if (error) return { error: error.message }

  revalidatePath('/finance')
  revalidatePath('/web/finance')
  revalidatePath('/dev-tools')
  return {
    ok: true,
    message: `Cleared ${data?.length ?? 0} sandbox row${(data?.length ?? 0) === 1 ? '' : 's'}.`,
  }
}

// ================================================================
// resetFinanceBankSandbox — dev-only full reset for Finance testing
//
// Wipes ALL local bank rows for this restaurant so the verification
// engine can be exercised from a clean slate:
//
//   bank_transactions          — every row deleted (covers raw
//                                Plaid-imported rows, sandbox seeds,
//                                and all of their review_state /
//                                settled_kind / settled_expense_id /
//                                settled_at columns)
//
// CRITICAL — last_sync_cursor is intentionally PRESERVED.
//
//   Plaid's /transactions/sync is incremental: the cursor is its
//   bookmark of what it has already handed us. If we null the
//   cursor here, the next sync (which Finance auto-triggers on
//   page load via maybeAutoSyncBankTransactions) will replay every
//   historical Plaid transaction — undoing this reset within
//   seconds. Keeping the cursor in place means "Plaid: don't
//   redeliver what you've already shown us." Only genuinely new
//   transactions will flow in after this reset.
//
//   If the manager wants Plaid to also re-deliver historical
//   transactions, the path is to disconnect the bank in Settings
//   and reconnect via Plaid Link — a new Item carries a fresh
//   access_token + a null cursor by design.
//
// last_synced_at is also preserved — it's just a display field
// ("Synced X minutes ago"); nulling it would force the staleness
// detector to fire a sync immediately, fighting against the
// cursor-preservation behavior above.
//
// Intentionally preserved (everything operational, plus the
// connection itself):
//
//   bank_provider_secrets      — Plaid access tokens stay in place
//   connected_bank_accounts    — rows + cursors + last_synced_at
//   orders / expenses / inventory_movements / shifts / employees /
//   menu_items / locations / restaurants / user_roles — never read
//   or touched here.
//
// Restaurant-scoped via explicit .eq('restaurant_id', ...) on the
// DELETE, on top of RLS. Dev gate enforces internal-only access.
// ================================================================
export async function resetFinanceBankSandbox(
  prevState: Result | null,
  _formData: FormData,
): Promise<Result> {
  // Auth layer 1: must be authenticated + on the dev allowlist.
  // gateDev is the security boundary here; the actual DELETE uses
  // the service-role admin client to bypass RLS — see below.
  const gate = await gateDev()
  if (!gate.ok) return { error: gate.error }

  // Anchor restaurant_id by reading a visible bank row through the
  // RLS-scoped client. That tells us exactly which restaurant
  // Finance is reading (Finance uses the same anon-key path). If
  // there is no visible row, we have nothing to delete and short-
  // circuit.
  const { data: visibleRow, error: selErr } = await gate.supabase
    .from('bank_transactions')
    .select('restaurant_id')
    .limit(1)
    .maybeSingle()
  if (selErr) return { error: `Could not inspect bank transactions: ${selErr.message}` }

  if (!visibleRow) {
    revalidatePath('/finance')
    revalidatePath('/web/finance')
    revalidatePath('/dev-tools')
    revalidatePath('/settings')
    return {
      ok: true,
      message: 'No bank transactions visible for this account — nothing to delete.',
    }
  }

  const targetRestaurantId = (visibleRow as { restaurant_id: string }).restaurant_id

  // Cross-check: targetRestaurantId MUST match the restaurant_id
  // that gateDev resolved for this user via user_roles. If they
  // disagree, we refuse to delete — that's the "wrong restaurant"
  // scenario and we don't want to wipe someone else's data even
  // though the service-role client could.
  if (targetRestaurantId !== gate.restaurantId) {
    return {
      error:
        `Refusing to delete — Finance is showing bank rows from restaurant ` +
        `${targetRestaurantId.slice(0, 8)}… but your account is authorized for ` +
        `${gate.restaurantId.slice(0, 8)}…. Investigate the user_roles drift ` +
        `before re-running.`,
    }
  }

  // Auth layer 2 (data): service-role DELETE.
  //
  // Why service role here:
  //   The anon-key DELETE through gate.supabase returns 0 affected
  //   rows in this environment even though the matching SELECT
  //   succeeds. The RLS DELETE policy on bank_transactions is
  //   identical in shape to the SELECT policy (both check
  //   `restaurant_id = my_restaurant_id()`), so the silent block
  //   is a Supabase-side state issue, not a logic issue.
  //
  //   This is a dev-only, isDevEmail-gated destructive action.
  //   The authorization decision has already been made above
  //   (gateDev + restaurant_id cross-check). Bypassing RLS for
  //   the data write is appropriate.
  //
  // Safety:
  //   • Explicit .eq('restaurant_id', targetRestaurantId) — never
  //     wipe more than this one restaurant's rows.
  //   • targetRestaurantId was read via the RLS-scoped client, so
  //     it's a restaurant the calling user can already see into.
  //   • No table other than bank_transactions is touched.
  const admin = createAdminClient()
  const { data: deleted, error: delErr } = await admin
    .from('bank_transactions')
    .delete()
    .eq('restaurant_id', targetRestaurantId)
    .select('id')
  if (delErr) return { error: `Bank transactions wipe failed: ${delErr.message}` }

  revalidatePath('/finance')
  revalidatePath('/web/finance')
  revalidatePath('/dev-tools')
  revalidatePath('/settings')
  const n = deleted?.length ?? 0
  return {
    ok: true,
    message:
      `Reset complete. Deleted ${n} bank transaction${n === 1 ? '' : 's'} for restaurant ` +
      `${targetRestaurantId.slice(0, 8)}…. Sync cursors preserved so Plaid will not ` +
      `redeliver history — only genuinely new activity will sync. Sales, inventory, ` +
      `staffing, menu, and business setup were not touched.`,
  }
}

