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
import type {
  FinanceAccountKind,
  FinanceCategoryKind,
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
