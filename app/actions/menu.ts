'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getAuthContext, formatError, logAudit } from '@/lib/auth'
import type { AvailabilityOverride } from '@/lib/menu/availability'
import { normalizeDisplayName, normalizeNameKey } from '@/lib/strings/names'

export async function createCategory(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Owner-only — the menu is structural restaurant config, not
  // operational data. A manager / staff editing the menu changes
  // pricing and what the POS can sell, which is an owner call.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can edit the menu.' }
  }

  const rawName = (formData.get('name') as string) ?? ''
  const displayName = normalizeDisplayName(rawName)
  const nameKey = normalizeNameKey(rawName)
  if (!displayName) return { error: 'Category name is required.' }

  // Duplicate guard — case-insensitive + whitespace-normalized,
  // restaurant-scoped. No `active` column on menu_categories, so we
  // compare against the full set.
  const { data: existingCats } = await ctx.supabase
    .from('menu_categories')
    .select('name')
    .eq('restaurant_id', ctx.restaurantId)
  const collision = (existingCats ?? []).find(
    (row) => normalizeNameKey((row.name as string) ?? '') === nameKey,
  )
  if (collision) {
    return {
      error: `A menu category named ${normalizeDisplayName((collision.name as string) ?? '')} already exists.`,
    }
  }

  const { error } = await ctx.supabase.from('menu_categories').insert({
    restaurant_id: ctx.restaurantId,
    name: displayName,
  })

  if (error) {
    console.error('Category creation failed:', error)
    return { error: formatError('category', error) }
  }

  revalidatePath('/menu')
  revalidatePath('/web/menu')
  redirect('/menu')
}

// Restaurant-scoped duplicate-name guard for menu items. Returns
// the colliding stored name (already normalized for display) when a
// match is found, or null when the name is clear to insert.
//
// We compare on the normalized key so casing/whitespace differences
// resolve to one fact. Active-only filter mirrors the inventory
// guard — soft-deleted/deactivated rows don't block a fresh name.
async function findMenuItemNameCollision(
  supabase: Awaited<ReturnType<typeof getAuthContext>>['context'] extends infer C
    ? C extends { supabase: infer S } ? S : never
    : never,
  restaurantId: string,
  nameKey: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('menu_items')
    .select('name')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
  const collision = (data ?? []).find(
    (row) => normalizeNameKey((row.name as string) ?? '') === nameKey,
  )
  if (!collision) return null
  return normalizeDisplayName((collision.name as string) ?? '')
}

// Creates an item directly inside a section (category_id required)
export async function createMenuItemInSection(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Owner-only — see createCategory above.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can edit the menu.' }
  }

  const rawName = (formData.get('name') as string) ?? ''
  const displayName = normalizeDisplayName(rawName)
  const nameKey = normalizeNameKey(rawName)
  const priceRaw = formData.get('price') as string
  const categoryId = formData.get('category_id') as string

  if (!displayName) return { error: 'Item name is required.' }
  if (!categoryId) return { error: 'Section is required.' }

  const price = parseFloat(priceRaw)
  if (isNaN(price) || price < 0) return { error: 'Please enter a valid price.' }

  const colliding = await findMenuItemNameCollision(ctx.supabase, ctx.restaurantId, nameKey)
  if (colliding) {
    return { error: `A menu item named ${colliding} already exists.` }
  }

  const { error } = await ctx.supabase.from('menu_items').insert({
    restaurant_id: ctx.restaurantId,
    category_id: categoryId,
    name: displayName,
    current_price: price,
    source: 'manual',
    external_id: null,
  })

  if (error) {
    console.error('Menu item creation failed:', error)
    return { error: formatError('menu item', error) }
  }

  revalidatePath('/menu')
  revalidatePath('/web/menu')
  return null // success — stay on the menu page
}

export async function createMenuItem(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Owner-only — see createCategory above.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can edit the menu.' }
  }

  const rawName = (formData.get('name') as string) ?? ''
  const displayName = normalizeDisplayName(rawName)
  const nameKey = normalizeNameKey(rawName)
  const priceRaw = formData.get('price') as string
  const categoryId = (formData.get('category_id') as string) || null

  if (!displayName) return { error: 'Item name is required.' }

  const price = parseFloat(priceRaw)
  if (isNaN(price) || price < 0) return { error: 'Please enter a valid price.' }

  const colliding = await findMenuItemNameCollision(ctx.supabase, ctx.restaurantId, nameKey)
  if (colliding) {
    return { error: `A menu item named ${colliding} already exists.` }
  }

  const { error } = await ctx.supabase.from('menu_items').insert({
    restaurant_id: ctx.restaurantId,
    category_id: categoryId,
    name: displayName,
    current_price: price,
    source: 'manual',
    external_id: null,
  })

  if (error) {
    console.error('Menu item creation failed:', error)
    return { error: formatError('menu item', error) }
  }

  revalidatePath('/menu')
  revalidatePath('/web/menu')
  redirect('/menu')
}

export async function deleteCategory(formData: FormData) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return

  // Owner-only — see createCategory above. Silent return on
  // failure matches this action's existing no-feedback shape.
  if (ctx.role !== 'owner') return

  const categoryId = formData.get('category_id') as string
  if (!categoryId) return

  // Items in this category get category_id set to null (on delete set null in schema)
  await ctx.supabase.from('menu_categories').delete().eq('id', categoryId)
  await logAudit(ctx, null, 'delete_menu_category', 'menu_categories', categoryId)
  revalidatePath('/menu')
  revalidatePath('/web/menu')
}

// Deletes a menu item. Recipe components are removed automatically
// (on delete cascade). If the item has order history (order_items
// references it with on delete restrict), the delete is blocked by
// PostgreSQL and we deactivate instead.
// Inventory items are NEVER affected — only the menu item and its
// recipe links are removed.
export async function deleteMenuItem(
  prevState: { error: string } | null,
  formData: FormData
): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Owner-only — deleting items rewires recipe components and may
  // hard-fail against order history (we deactivate instead). Either
  // outcome is structural enough to require owner sign-off.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can delete menu items.' }
  }

  const itemId = formData.get('item_id') as string
  if (!itemId) return { error: 'No item specified.' }

  // Try delete — will fail if order_items references this item (restrict)
  const { error } = await ctx.supabase.from('menu_items').delete().eq('id', itemId)

  if (error) {
    // FK violation from order_items — deactivate instead
    if (error.code === '23503') {
      await ctx.supabase.from('menu_items').update({ active: false }).eq('id', itemId)
      await logAudit(ctx, null, 'deactivate_menu_item', 'menu_items', itemId, { reason: 'order_history' })
      revalidatePath('/menu')
      revalidatePath('/web/menu')
      return { error: 'Item has order history and cannot be fully deleted. It has been deactivated instead.' }
    }
    return { error: error.message }
  }

  await logAudit(ctx, null, 'delete_menu_item', 'menu_items', itemId)
  revalidatePath('/menu')
  revalidatePath('/web/menu')
  return null
}

// ----------------------------------------------------------------
// setMenuItemAvailabilityOverride
//
// Owner/manager toggle for the manual override stored on menu_items.
// Three valid values:
//
//   'none'           — system rules apply normally (auto-disable on
//                      stock-out, otherwise sellable).
//   'force_disabled' — item never appears as sellable in POS, even
//                      when projection says healthy.
//   'force_enabled'  — item stays sellable in POS even when
//                      projection says out. System truth is preserved
//                      on the menu drawer so the manager can see why
//                      the override matters.
//
// Audit: every change is written to `audit_logs` with the before/after
// override values. That log is the long-term home for the future
// intelligence layer's stockout / re-enable timeline view.
// ----------------------------------------------------------------
const VALID_AVAILABILITY_OVERRIDES: AvailabilityOverride[] = [
  'none',
  'force_enabled',
  'force_disabled',
]

// ----------------------------------------------------------------
// setMenuItemActive — flip a menu item's `active` flag.
//
// Sits alongside `setMenuItemAvailabilityOverride` (which manages the
// per-shift "out of stock / force on" runtime override) and the
// recipe-builder actions. This action manages the more permanent
// "is this item part of the menu at all?" flag:
//
//   • For Native POS users, `active` directly gates POS strip
//     visibility — inactive items don't appear at the till.
//   • For External POS users, `active` is records-local (depletion
//     and sales ingestion don't gate on it; the external POS owns
//     the actual "sellable now" decision in their own dashboard).
//
// Imported items land with `active = false` so the manager has an
// explicit "promote" step after building the recipe. That promotion
// flows through here.
//
// Any restaurant member can flip this — same access scope as the
// recipe builder and the rest of menu CRUD. Restaurant-scoped via
// explicit restaurant_id filter (RLS would block cross-tenant
// writes too, but the filter is defense in depth).
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// updateMenuItemPrice — inline price editor in the item drawer.
//
// Restaurant-scoped via the matching restaurant_id filter (RLS
// blocks cross-tenant writes too, but the explicit filter is
// defense in depth). The action only touches `current_price` —
// recipe links, active flag, override, and source are untouched,
// so POS depletion + Sales bridge keep working exactly as before.
// Revalidates /menu and /pos so the drawer + the POS strip both
// pick up the new price on the next render.
// ----------------------------------------------------------------
export async function updateMenuItemPrice(
  prevState: { error: string } | null,
  formData: FormData,
): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const itemId = ((formData.get('item_id') as string | null) ?? '').trim()
  if (!itemId) return { error: 'No item specified.' }

  const priceRaw = ((formData.get('price') as string | null) ?? '').trim()
  const price = parseFloat(priceRaw)
  if (!Number.isFinite(price) || price <= 0) {
    return { error: 'Price must be greater than 0.' }
  }

  const { error } = await ctx.supabase
    .from('menu_items')
    .update({ current_price: price })
    .eq('id', itemId)
    .eq('restaurant_id', ctx.restaurantId)

  if (error) return { error: formatError('menu item', error) }

  await logAudit(ctx, null, 'update_menu_item_price', 'menu_items', itemId, { price })

  revalidatePath('/menu')
  revalidatePath('/web/menu')
  revalidatePath('/pos')
  return null
}

// ----------------------------------------------------------------
// assignMenuItemCategory — move a menu item into a category (or
// clear its assignment). Powers both the click-to-assign popover on
// the "Awaiting a section" band and the drag-and-drop reorganize
// pattern on section cards. Owner-only, same as every other
// menu-editing action.
//
// Args intentionally take the raw ids (not a FormData) so the client
// can call it optimistically from a startTransition without building
// a form-shaped payload for a one-field mutation.
//   - categoryId: string  → assign to that section
//   - categoryId: null    → clear (send item back to Awaiting)
//
// The target category is verified to belong to the caller's
// restaurant before we write. RLS also gates this; the explicit
// check is defense-in-depth + a friendlier error than a silent
// no-op update.
// ----------------------------------------------------------------
export async function assignMenuItemCategory(
  menuItemId: string,
  categoryId: string | null,
): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can reorganize the menu.' }
  }

  if (!menuItemId) return { error: 'No item specified.' }

  // Confirm the target category belongs to the caller's restaurant.
  // Skip when clearing (categoryId === null) — that's always safe.
  if (categoryId) {
    const { data: cat } = await ctx.supabase
      .from('menu_categories')
      .select('id')
      .eq('id', categoryId)
      .eq('restaurant_id', ctx.restaurantId)
      .maybeSingle()
    if (!cat) return { error: 'That section does not exist.' }
  }

  const { error } = await ctx.supabase
    .from('menu_items')
    .update({ category_id: categoryId })
    .eq('id', menuItemId)
    .eq('restaurant_id', ctx.restaurantId)

  if (error) return { error: formatError('menu item', error) }

  await logAudit(
    ctx,
    null,
    'assign_menu_item_category',
    'menu_items',
    menuItemId,
    { categoryId },
  )

  revalidatePath('/menu')
  revalidatePath('/web/menu')
  revalidatePath('/pos')
  return null
}

// ----------------------------------------------------------------
// bulkAssignMenuItemCategory — move many menu items into a category
// (or clear their assignments) in one round-trip. Powers the
// tap-to-select bulk workflow on the "Awaiting a section" band,
// where a manager fresh off a CSV import needs to sort dozens of
// items into their real sections quickly.
//
// Same trust model as the single-item variant: owner-only, target
// category is verified restaurant-scoped, RLS also gates the write.
// Empty input is a no-op (returns null) rather than an error — the
// UI can call it defensively without checking selection size.
// ----------------------------------------------------------------
export async function bulkAssignMenuItemCategory(
  menuItemIds: string[],
  categoryId: string | null,
): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can reorganize the menu.' }
  }

  if (menuItemIds.length === 0) return null

  if (categoryId) {
    const { data: cat } = await ctx.supabase
      .from('menu_categories')
      .select('id')
      .eq('id', categoryId)
      .eq('restaurant_id', ctx.restaurantId)
      .maybeSingle()
    if (!cat) return { error: 'That section does not exist.' }
  }

  const { error } = await ctx.supabase
    .from('menu_items')
    .update({ category_id: categoryId })
    .in('id', menuItemIds)
    .eq('restaurant_id', ctx.restaurantId)

  if (error) return { error: formatError('menu item', error) }

  await logAudit(
    ctx,
    null,
    'bulk_assign_menu_item_category',
    'menu_items',
    undefined,
    { menuItemIds, categoryId, count: menuItemIds.length },
  )

  revalidatePath('/menu')
  revalidatePath('/web/menu')
  revalidatePath('/pos')
  return null
}

export async function setMenuItemActive(
  prevState: { error: string } | null,
  formData: FormData,
): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const itemId = (formData.get('item_id') as string | null)?.trim() ?? ''
  const activeRaw = (formData.get('active') as string | null)?.trim() ?? ''
  if (!itemId) return { error: 'No item specified.' }
  if (activeRaw !== 'true' && activeRaw !== 'false') {
    return { error: 'Invalid active value.' }
  }
  const active = activeRaw === 'true'

  const { error } = await ctx.supabase
    .from('menu_items')
    .update({ active })
    .eq('id', itemId)
    .eq('restaurant_id', ctx.restaurantId)

  if (error) return { error: formatError('menu item', error) }

  await logAudit(ctx, null, 'set_menu_item_active', 'menu_items', itemId, { active })

  // POS strip + Menu page both read from menu_items; both need to
  // reflect the flag change immediately.
  revalidatePath('/menu')
  revalidatePath('/web/menu')
  revalidatePath('/pos')
  return null
}

export async function setMenuItemAvailabilityOverride(
  prevState: { error: string } | null,
  formData: FormData
): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const itemId = (formData.get('item_id') as string | null)?.trim() ?? ''
  const overrideRaw = (formData.get('override') as string | null)?.trim() ?? ''
  if (!itemId) return { error: 'No item specified.' }
  if (!(VALID_AVAILABILITY_OVERRIDES as string[]).includes(overrideRaw)) {
    return { error: 'Invalid override value.' }
  }
  const override = overrideRaw as AvailabilityOverride

  // Read the current value first so the audit row carries the
  // before/after pair — useful for the future re-enable / stockout
  // timeline view without joining through audit-log diffs.
  const { data: existing } = await ctx.supabase
    .from('menu_items')
    .select('id, availability_override')
    .eq('id', itemId)
    .maybeSingle()
  if (!existing) return { error: 'Item not found.' }

  const previous = (existing.availability_override as AvailabilityOverride | null) ?? 'none'
  if (previous === override) {
    // No-op — don't touch timestamps or write an audit row for a
    // click that didn't change anything.
    return null
  }

  // When clearing the override, also clear the audit columns so the
  // drawer doesn't keep showing a stale "set by X on Y" line.
  const patch: Record<string, unknown> = { availability_override: override }
  if (override === 'none') {
    patch.availability_override_set_at = null
    patch.availability_override_set_by = null
  } else {
    patch.availability_override_set_at = new Date().toISOString()
    patch.availability_override_set_by = ctx.userId
  }

  const { error } = await ctx.supabase.from('menu_items').update(patch).eq('id', itemId)
  if (error) return { error: formatError('availability override', error) }

  await logAudit(ctx, null, 'set_menu_availability_override', 'menu_items', itemId, {
    previous,
    next: override,
  })

  revalidatePath('/menu')
  revalidatePath('/web/menu')
  revalidatePath('/pos')
  return null
}
