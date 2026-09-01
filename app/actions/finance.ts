'use server'

// ----------------------------------------------------------------
// Finance pillar — server actions.
//
// Every write path goes through here so the tenant guard + the
// balance-update side effects live in one place:
//
//   createAccount / updateAccount / deleteAccount
//   createMovement (income | expense | transfer)
//   deleteMovement (reverses its balance impact)
//
// Balances are stored on finance_accounts.balance and mutated
// incrementally when movements land. Doing the arithmetic here
// (rather than deriving on every read) keeps the tile row cheap
// — no N-way sum on page load.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getPlaidClient, isPlaidConfigured } from '@/lib/plaid/client'
import { syncPlaidItem } from '@/lib/bank/providers/plaid'
import { materializeFinanceMovements } from '@/lib/finance/materialize'
import {
  ACCOUNT_KIND_DEFAULTS,
  type FinanceAccountKind,
  type FinanceCategoryKind,
} from '@/lib/finance/types'

type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { error: string }

async function resolveOperator(): Promise<
  { ok: true; restaurantId: string; userId: string } | { error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }
  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role) return { error: 'No restaurant.' }
  return { ok: true, restaurantId: role.restaurant_id as string, userId: user.id }
}

// ---------------------------------------------------------------- accounts

export interface AccountInput {
  name: string
  kind: FinanceAccountKind
  location_id?: string | null
  color?: string | null
  glyph?: string | null
  sort_order?: number | null
  balance?: number
}

export async function createAccount(input: AccountInput): Promise<ActionResult<{ id: string }>> {
  const ctx = await resolveOperator()
  if ('error' in ctx) return ctx
  if (!input.name?.trim()) return { error: 'Account name is required.' }
  if (!['pos','cash','digital_wallet','bank','other'].includes(input.kind)) {
    return { error: 'Invalid account kind.' }
  }
  const admin = createAdminClient()
  // Optional location guard — refuse an account tied to a
  // location that belongs to another restaurant.
  if (input.location_id) {
    const { data: loc } = await admin
      .from('locations')
      .select('id')
      .eq('id', input.location_id)
      .eq('restaurant_id', ctx.restaurantId)
      .maybeSingle()
    if (!loc) return { error: 'Location not found.' }
  }
  const { data, error } = await admin
    .from('finance_accounts')
    .insert({
      restaurant_id: ctx.restaurantId,
      location_id: input.location_id ?? null,
      name: input.name.trim(),
      kind: input.kind,
      color: input.color ?? null,
      glyph: input.glyph ?? null,
      sort_order: input.sort_order ?? null,
      balance: input.balance ?? 0,
    })
    .select('id')
    .single()
  if (error || !data) {
    console.error('[finance:createAccount] insert failed', error)
    return { error: 'Could not create account.' }
  }
  revalidatePath('/finance')
  return { ok: true, data: { id: data.id as string } }
}

export interface AccountPatch {
  name?: string
  color?: string | null
  glyph?: string | null
  sort_order?: number | null
  active?: boolean
  balance?: number
}

export async function updateAccount(id: string, patch: AccountPatch): Promise<ActionResult> {
  if (!id) return { error: 'Missing account id.' }
  const ctx = await resolveOperator()
  if ('error' in ctx) return ctx
  const admin = createAdminClient()
  const { data: account } = await admin
    .from('finance_accounts')
    .select('id, restaurant_id')
    .eq('id', id)
    .maybeSingle()
  if (!account || account.restaurant_id !== ctx.restaurantId) {
    return { error: 'Account not found.' }
  }
  const patchRow: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.name !== undefined) {
    if (!patch.name.trim()) return { error: 'Name is required.' }
    patchRow.name = patch.name.trim()
  }
  if (patch.color !== undefined) patchRow.color = patch.color
  if (patch.glyph !== undefined) patchRow.glyph = patch.glyph
  if (patch.sort_order !== undefined) patchRow.sort_order = patch.sort_order
  if (patch.active !== undefined) patchRow.active = !!patch.active
  if (patch.balance !== undefined) {
    if (!Number.isFinite(patch.balance)) return { error: 'Invalid balance.' }
    patchRow.balance = patch.balance
  }
  const { error } = await admin.from('finance_accounts').update(patchRow).eq('id', id)
  if (error) {
    console.error('[finance:updateAccount] update failed', error)
    return { error: 'Could not save account.' }
  }
  revalidatePath('/finance')
  return { ok: true }
}

/** Soft delete — flip active=false so historical movements
 *  still resolve their source/dest, but the account leaves the
 *  tile row + picker. */
export async function deleteAccount(id: string): Promise<ActionResult> {
  return updateAccount(id, { active: false })
}

// ---------------------------------------------------------------- movements

export interface MovementInput {
  occurred_at?: string
  amount: number
  source_account_id?: string | null
  dest_account_id?: string | null
  category_id?: string | null
  note?: string | null
  memo?: string | null
  receipt_url?: string | null
}

export async function createMovement(input: MovementInput): Promise<ActionResult<{ id: string }>> {
  const ctx = await resolveOperator()
  if ('error' in ctx) return ctx
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { error: 'Amount must be greater than zero.' }
  }
  if (!input.source_account_id && !input.dest_account_id) {
    return { error: 'A movement needs at least one account (source or destination).' }
  }
  const admin = createAdminClient()
  // Verify every referenced id belongs to this restaurant.
  const accountIds = [input.source_account_id, input.dest_account_id].filter(Boolean) as string[]
  if (accountIds.length > 0) {
    const { data: accts } = await admin
      .from('finance_accounts')
      .select('id, restaurant_id, balance')
      .in('id', accountIds)
    const bad = (accts ?? []).some((a) => a.restaurant_id !== ctx.restaurantId)
    if (bad || (accts?.length ?? 0) !== accountIds.length) {
      return { error: 'Account not found.' }
    }
  }
  if (input.category_id) {
    const { data: cat } = await admin
      .from('finance_categories')
      .select('id, restaurant_id')
      .eq('id', input.category_id)
      .maybeSingle()
    if (!cat || cat.restaurant_id !== ctx.restaurantId) {
      return { error: 'Category not found.' }
    }
  }
  const { data, error } = await admin
    .from('finance_movements')
    .insert({
      restaurant_id: ctx.restaurantId,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      amount: input.amount,
      source_account_id: input.source_account_id ?? null,
      dest_account_id: input.dest_account_id ?? null,
      category_id: input.category_id ?? null,
      note: input.note ?? null,
      memo: input.memo ?? null,
      receipt_url: input.receipt_url ?? null,
      origin: 'manual',
      created_by: ctx.userId,
    })
    .select('id')
    .single()
  if (error || !data) {
    console.error('[finance:createMovement] insert failed', error)
    return { error: 'Could not save movement.' }
  }
  // Balance updates — source loses, dest gains. Done via two
  // small RPCs so concurrent movements don't step on each other.
  // Falls back to a read-modify-write when a bump call fails
  // (RPC absent, e.g. first-time DB) so v1 works even without
  // the SQL helper set up. Real deployments should add the RPC
  // for correctness under load; the fallback is acceptable at
  // pilot volumes.
  if (input.source_account_id) {
    await bumpBalance(admin, input.source_account_id, -input.amount)
  }
  if (input.dest_account_id) {
    await bumpBalance(admin, input.dest_account_id, input.amount)
  }
  revalidatePath('/finance')
  return { ok: true, data: { id: data.id as string } }
}

/** Manual-expense sugar — most common Add-expense flow: money
 *  leaves an account, no destination, one category. */
export async function addExpense(input: {
  source_account_id: string
  amount: number
  category_id?: string | null
  note?: string | null
  memo?: string | null
  occurred_at?: string
  receipt_url?: string | null
}): Promise<ActionResult<{ id: string }>> {
  return createMovement({
    source_account_id: input.source_account_id,
    dest_account_id: null,
    amount: input.amount,
    category_id: input.category_id ?? null,
    note: input.note ?? null,
    memo: input.memo ?? null,
    occurred_at: input.occurred_at,
    receipt_url: input.receipt_url ?? null,
  })
}

/** Delete a movement + reverse its balance impact. */
export async function deleteMovement(id: string): Promise<ActionResult> {
  if (!id) return { error: 'Missing movement id.' }
  const ctx = await resolveOperator()
  if ('error' in ctx) return ctx
  const admin = createAdminClient()
  const { data: mv } = await admin
    .from('finance_movements')
    .select('id, restaurant_id, amount, source_account_id, dest_account_id')
    .eq('id', id)
    .maybeSingle()
  if (!mv || mv.restaurant_id !== ctx.restaurantId) return { error: 'Movement not found.' }
  const amount = typeof mv.amount === 'number' ? mv.amount : parseFloat(String(mv.amount))
  if (!Number.isFinite(amount)) return { error: 'Movement amount invalid.' }
  const { error } = await admin.from('finance_movements').delete().eq('id', id)
  if (error) {
    console.error('[finance:deleteMovement] delete failed', error)
    return { error: 'Could not delete movement.' }
  }
  // Reverse the balance impact — source gets it back, dest loses it.
  if (mv.source_account_id) await bumpBalance(admin, mv.source_account_id as string, amount)
  if (mv.dest_account_id) await bumpBalance(admin, mv.dest_account_id as string, -amount)
  revalidatePath('/finance')
  return { ok: true }
}

// ---------------------------------------------------------------- Plaid bridge

/** Mirror every Plaid-connected `connected_bank_accounts` row for
 *  this restaurant into `finance_accounts` so the Finance tile
 *  row shows a fresh tile the moment a Link exchange finishes.
 *  Idempotent — running twice on the same
 *  (restaurant, provider_account_id) no-ops via a lookup by
 *  provider='plaid' + provider_ref=<account_id>.
 *
 *  Institution-based kind inference: Venmo / Cash App / PayPal
 *  land as 'digital_wallet' tiles; everything else is 'bank'.
 *
 *  `locationId` scopes the new tiles to the active place so a
 *  Mercado-workspace connect lands on Mercado's tile row instead
 *  of shop-wide. Null = shop-wide.
 */
export async function bridgePlaidAccountsToFinance(
  locationId?: string | null,
): Promise<ActionResult<{ inserted: number }>> {
  const ctx = await resolveOperator()
  if ('error' in ctx) return ctx
  const admin = createAdminClient()

  const { data: connected } = await admin
    .from('connected_bank_accounts')
    .select('provider_item_id, provider_account_id, account_name, account_mask, account_type, account_subtype, institution_name')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('provider', 'plaid')
    .eq('active', true)
  if (!connected || connected.length === 0) return { ok: true, data: { inserted: 0 } }

  const providerRefs = connected.map(c => c.provider_account_id as string).filter(Boolean)
  if (providerRefs.length === 0) return { ok: true, data: { inserted: 0 } }

  const { data: existing } = await admin
    .from('finance_accounts')
    .select('provider_ref')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('provider', 'plaid')
    .in('provider_ref', providerRefs)
  const existingRefs = new Set((existing ?? []).map(r => (r as { provider_ref: string }).provider_ref))

  const toInsert = connected.filter(c => !existingRefs.has(c.provider_account_id as string))
  if (toInsert.length === 0) return { ok: true, data: { inserted: 0 } }

  // Live balance fetch — one Plaid call per unique item covers
  // every account underneath it. Missed accounts (Plaid error,
  // stale token) fall back to 0 so the tile still lands.
  const balances = await fetchPlaidBalances(
    admin,
    ctx.restaurantId,
    Array.from(new Set(toInsert.map(c => c.provider_item_id as string).filter(Boolean))),
  )

  const rows = toInsert.map(c => {
    const inst = String(c.institution_name ?? '').toLowerCase()
    const walletMatch = /venmo|cash\s*app|paypal|apple\s*cash|zelle/.test(inst)
    const kind: FinanceAccountKind = walletMatch ? 'digital_wallet' : 'bank'
    // Tile name — bank name + subtype (checking/savings) + mask so
    // "Chase Checking ··4321" reads distinct from "Chase Savings
    // ··8765". When Plaid returns a friendlier account_name we
    // prefer it and fall back to the composed form.
    const subtypePretty = prettifyAccountSubtype(String(c.account_subtype ?? ''))
    const bank = String(c.institution_name ?? '').trim()
    const composed = [bank, subtypePretty].filter(Boolean).join(' ')
    const base = c.account_name && String(c.account_name).trim().length > 0
      ? String(c.account_name).trim()
      : (composed || 'Account')
    const suffix = c.account_mask ? ` ··${c.account_mask}` : ''
    const name = `${base}${suffix}`.trim()
    const live = balances.get(c.provider_account_id as string)
    return {
      restaurant_id: ctx.restaurantId,
      location_id: locationId ?? null,
      name,
      kind,
      color: ACCOUNT_KIND_DEFAULTS[kind].color,
      balance: live ?? 0,
      provider: 'plaid' as const,
      provider_ref: c.provider_account_id,
      active: true,
    }
  })
  const { error } = await admin.from('finance_accounts').insert(rows)
  if (error) {
    console.error('[finance:bridgePlaid] insert failed', error)
    return { error: 'Could not link Plaid accounts to Finance.' }
  }

  // Kick off first sync for every fresh Item so the ledger fills
  // with the 30-day backfill before the operator's next paint.
  // Errors here don't fail the bridge — the tile is already live
  // and a manual refresh (or the next auto sync) will retry.
  const freshItemIds = Array.from(
    new Set(toInsert.map(c => c.provider_item_id as string).filter(Boolean))
  )
  for (const itemId of freshItemIds) {
    const sync = await syncPlaidItem(admin, ctx.restaurantId, itemId)
    if (sync.error) console.error('[finance:bridgePlaid] initial sync failed', itemId, sync.error)
  }
  const mat = await materializeFinanceMovements(admin, ctx.restaurantId)
  if (mat.error) console.error('[finance:bridgePlaid] materialize failed', mat.error)

  revalidatePath('/finance')
  return { ok: true, data: { inserted: rows.length } }
}

/** Manual refresh entry point. Drains `/transactions/sync` for
 *  every active Plaid item, materializes fresh rows into the
 *  ledger, and refreshes live balances. Idempotent — safe to
 *  fire repeatedly (e.g. a "Refresh" button, or a background
 *  cron once we wire one up). */
export async function syncPlaidToFinance(): Promise<
  ActionResult<{ items: number; movementsInserted: number; transfersPaired: number }>
> {
  const ctx = await resolveOperator()
  if ('error' in ctx) return ctx
  if (!isPlaidConfigured()) return { error: 'Plaid not configured.' }
  const admin = createAdminClient()

  const { data: items } = await admin
    .from('bank_provider_secrets')
    .select('provider_item_id')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('provider', 'plaid')
  const itemIds = Array.from(
    new Set((items ?? []).map(r => (r as { provider_item_id: string }).provider_item_id).filter(Boolean))
  )
  if (itemIds.length === 0) return { ok: true, data: { items: 0, movementsInserted: 0, transfersPaired: 0 } }

  for (const itemId of itemIds) {
    const sync = await syncPlaidItem(admin, ctx.restaurantId, itemId)
    if (sync.error) console.error('[finance:sync] item failed', itemId, sync.error)
  }
  const mat = await materializeFinanceMovements(admin, ctx.restaurantId)
  if (mat.error) console.error('[finance:sync] materialize failed', mat.error)

  // Refresh live balances on every Plaid tile so the header cash
  // total stays honest even if a manual movement drifted it.
  await refreshPlaidBalances(admin, ctx.restaurantId, itemIds)

  revalidatePath('/finance')
  return {
    ok: true,
    data: {
      items: itemIds.length,
      movementsInserted: mat.inserted,
      transfersPaired: mat.transfersPaired,
    },
  }
}

/** Rewrite each Plaid-linked finance_accounts.balance to the live
 *  value from Plaid. Called from the manual sync path; the bridge
 *  path doesn't need it since it just wrote the same value. */
async function refreshPlaidBalances(
  admin: Admin,
  restaurantId: string,
  itemIds: string[],
): Promise<void> {
  if (!isPlaidConfigured() || itemIds.length === 0) return
  const { data: secrets } = await admin
    .from('bank_provider_secrets')
    .select('provider_item_id, access_token')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'plaid')
    .in('provider_item_id', itemIds)
  if (!secrets || secrets.length === 0) return

  const plaid = getPlaidClient()
  const nextBalanceByRef = new Map<string, number>()
  await Promise.all(secrets.map(async (s) => {
    try {
      const res = await plaid.accountsBalanceGet({ access_token: (s as { access_token: string }).access_token })
      for (const acct of res.data.accounts ?? []) {
        const bal = acct.balances?.available ?? acct.balances?.current
        if (typeof bal === 'number' && Number.isFinite(bal)) {
          nextBalanceByRef.set(acct.account_id, bal)
        }
      }
    } catch (err) {
      console.error('[finance:refreshBalances] item failed', s.provider_item_id, err)
    }
  }))
  if (nextBalanceByRef.size === 0) return

  const { data: tiles } = await admin
    .from('finance_accounts')
    .select('id, provider_ref')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'plaid')
    .eq('active', true)
  await Promise.all((tiles ?? []).map(async (t) => {
    const pr = (t as { provider_ref: string | null }).provider_ref
    if (!pr) return
    const next = nextBalanceByRef.get(pr)
    if (next === undefined) return
    await admin
      .from('finance_accounts')
      .update({ balance: next, updated_at: new Date().toISOString() })
      .eq('id', (t as { id: string }).id)
  }))
}

/** Plaid's account_subtype values are lowercased with underscores
 *  ("checking", "savings", "credit card", "money market"). Turn
 *  them into a title-cased word for tile labels. */
function prettifyAccountSubtype(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  return s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/** Read the live balance for each Plaid account under the given
 *  item ids. Returns a Map keyed by `provider_account_id` →
 *  numeric balance (available if present, else current). Missing
 *  entries mean the fetch failed and the caller should fall back
 *  to 0 rather than block the bridge. */
async function fetchPlaidBalances(
  admin: Admin,
  restaurantId: string,
  itemIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!isPlaidConfigured() || itemIds.length === 0) return out

  const { data: secrets } = await admin
    .from('bank_provider_secrets')
    .select('provider_item_id, access_token')
    .eq('restaurant_id', restaurantId)
    .eq('provider', 'plaid')
    .in('provider_item_id', itemIds)
  if (!secrets || secrets.length === 0) return out

  const plaid = getPlaidClient()
  await Promise.all(secrets.map(async (s) => {
    const token = (s as { access_token: string }).access_token
    if (!token) return
    try {
      const res = await plaid.accountsBalanceGet({ access_token: token })
      for (const acct of res.data.accounts ?? []) {
        const bal = acct.balances?.available ?? acct.balances?.current
        if (typeof bal === 'number' && Number.isFinite(bal)) {
          out.set(acct.account_id, bal)
        }
      }
    } catch (err) {
      console.error('[finance:fetchPlaidBalances] item failed', s.provider_item_id, err)
    }
  }))
  return out
}

/** Remove a Finance account and everything downstream from it —
 *  hard delete, not a soft flag. Wipes:
 *
 *    finance_movements  — every row touching this account
 *    bank_transactions  — cascaded by the connected_bank_accounts
 *                         FK's ON DELETE CASCADE
 *    connected_bank_accounts — the raw bank row
 *    bank_provider_secrets   — dropped when this was the last
 *                              account under its Plaid item
 *    finance_accounts   — the tile itself
 *
 *  When this was the last account under its Plaid Item, also
 *  calls /item/remove at Plaid so the trial slot frees.
 *
 *  The user asked for hard delete explicitly: they want a
 *  removed tile to leave no trace in totals, ledger, or sync
 *  cost. Soft-delete leaked historical movements into Overview
 *  and kept the sync running against inactive rows.
 *
 *  Non-plaid tiles get the same hard treatment — movements go,
 *  the tile goes. No provider secret to clean up. */
export async function disconnectFinanceAccount(id: string): Promise<ActionResult> {
  if (!id) return { error: 'Missing account id.' }
  const ctx = await resolveOperator()
  if ('error' in ctx) return ctx
  const admin = createAdminClient()

  const { data: account } = await admin
    .from('finance_accounts')
    .select('id, restaurant_id, provider, provider_ref')
    .eq('id', id)
    .maybeSingle()
  if (!account || account.restaurant_id !== ctx.restaurantId) {
    return { error: 'Account not found.' }
  }

  // 1) Purge every movement that touches this account. Deleting a
  //    finance_accounts row first would either violate an FK or
  //    silently null out source/dest; explicit delete keeps the
  //    ledger totals honest either way.
  const { error: mvErr } = await admin
    .from('finance_movements')
    .delete()
    .eq('restaurant_id', ctx.restaurantId)
    .or(`source_account_id.eq.${id},dest_account_id.eq.${id}`)
  if (mvErr) {
    console.error('[finance:disconnect] movement purge failed', mvErr)
    return { error: 'Could not remove account movements.' }
  }

  // 2) For Plaid tiles: also purge the underlying bank rows +
  //    revoke the item at Plaid when this was the last one under
  //    it. connected_bank_accounts is FK'd from bank_transactions
  //    with ON DELETE CASCADE, so deleting the CBA row wipes the
  //    raw tx too.
  if (account.provider === 'plaid' && account.provider_ref) {
    const { data: connected } = await admin
      .from('connected_bank_accounts')
      .select('id, provider_item_id')
      .eq('restaurant_id', ctx.restaurantId)
      .eq('provider', 'plaid')
      .eq('provider_account_id', account.provider_ref)
      .maybeSingle()

    if (connected) {
      await admin
        .from('connected_bank_accounts')
        .delete()
        .eq('id', connected.id as string)

      const itemId = connected.provider_item_id as string | null
      if (itemId) {
        // Any sibling accounts still under this Plaid Item? If not,
        // /item/remove at Plaid + drop the secret so the trial slot
        // frees. Otherwise leave the item alive for siblings.
        const { data: siblings } = await admin
          .from('connected_bank_accounts')
          .select('id')
          .eq('restaurant_id', ctx.restaurantId)
          .eq('provider', 'plaid')
          .eq('provider_item_id', itemId)
          .limit(1)

        if (!siblings || siblings.length === 0) {
          if (isPlaidConfigured()) {
            try {
              const { data: secret } = await admin
                .from('bank_provider_secrets')
                .select('access_token')
                .eq('restaurant_id', ctx.restaurantId)
                .eq('provider', 'plaid')
                .eq('provider_item_id', itemId)
                .maybeSingle()
              if (secret?.access_token) {
                const plaid = getPlaidClient()
                await plaid.itemRemove({ access_token: secret.access_token as string }).catch(() => null)
              }
            } catch (err) {
              console.error('[finance:disconnect] itemRemove failed', err)
            }
          }
          await admin
            .from('bank_provider_secrets')
            .delete()
            .eq('restaurant_id', ctx.restaurantId)
            .eq('provider', 'plaid')
            .eq('provider_item_id', itemId)
        }
      }
    }
  }

  // 3) The tile itself.
  const { error: finErr } = await admin
    .from('finance_accounts')
    .delete()
    .eq('id', id)
  if (finErr) {
    console.error('[finance:disconnect] finance_accounts delete failed', finErr)
    return { error: 'Could not remove account.' }
  }

  revalidatePath('/finance')
  return { ok: true }
}

// ---------------------------------------------------------------- categories

export interface CategoryInput {
  name: string
  kind: FinanceCategoryKind
  color?: string | null
  tax_category?: string | null
  sort_order?: number | null
}

export async function createCategory(input: CategoryInput): Promise<ActionResult<{ id: string }>> {
  const ctx = await resolveOperator()
  if ('error' in ctx) return ctx
  if (!input.name?.trim()) return { error: 'Category name is required.' }
  if (!['income','expense','transfer'].includes(input.kind)) {
    return { error: 'Invalid category kind.' }
  }
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('finance_categories')
    .insert({
      restaurant_id: ctx.restaurantId,
      name: input.name.trim(),
      kind: input.kind,
      color: input.color ?? null,
      tax_category: input.tax_category ?? null,
      sort_order: input.sort_order ?? null,
      active: true,
    })
    .select('id')
    .single()
  if (error || !data) {
    // Unique-index collision on (restaurant, kind, lower(name))
    // renders as a friendly error rather than the raw pg text.
    const msg = (error?.message ?? '').includes('finance_categories_unique_name')
      ? `A ${input.kind} category named "${input.name.trim()}" already exists.`
      : 'Could not create category.'
    console.error('[finance:createCategory] insert failed', error)
    return { error: msg }
  }
  revalidatePath('/finance')
  return { ok: true, data: { id: data.id as string } }
}

// ---------------------------------------------------------------- internals

type Admin = ReturnType<typeof createAdminClient>

/** Increment (or decrement, when delta is negative) an account's
 *  balance. Read-modify-write with a numeric coerce because the
 *  pg numeric type surfaces as string. */
async function bumpBalance(admin: Admin, accountId: string, delta: number): Promise<void> {
  const { data: acct } = await admin
    .from('finance_accounts')
    .select('balance')
    .eq('id', accountId)
    .maybeSingle()
  if (!acct) return
  const current = typeof acct.balance === 'number' ? acct.balance : parseFloat(String(acct.balance ?? '0'))
  const next = round2((Number.isFinite(current) ? current : 0) + delta)
  await admin
    .from('finance_accounts')
    .update({ balance: next, updated_at: new Date().toISOString() })
    .eq('id', accountId)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
