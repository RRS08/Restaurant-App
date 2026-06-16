'use server'

import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId, formatError, logAudit } from '@/lib/auth'
import { normalizeDisplayName, normalizeNameKey } from '@/lib/strings/names'

export async function addRecipeComponent(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Owner-only — recipe quantities drive COGS and POS depletion. A
  // bad-actor manager could under-deduct to hide waste; structural
  // recipe edits belong with the owner.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can edit recipes.' }
  }

  const menuItemId = formData.get('menu_item_id') as string
  const inventoryItemId = formData.get('inventory_item_id') as string
  const quantityRaw = formData.get('quantity_required') as string

  if (!menuItemId || !inventoryItemId) return { error: 'Please select an inventory item.' }

  const quantity = parseFloat(quantityRaw)
  if (isNaN(quantity) || quantity <= 0) return { error: 'Quantity must be greater than 0.' }

  const { error } = await ctx.supabase.from('recipe_components').insert({
    restaurant_id: ctx.restaurantId,
    menu_item_id: menuItemId,
    inventory_item_id: inventoryItemId,
    quantity_required: quantity,
  })

  if (error) {
    if (error.code === '23505') return { error: 'This ingredient is already in the recipe.' }
    console.error('Recipe component creation failed:', error)
    return { error: formatError('add ingredient', error) }
  }

  await logAudit(ctx, null, 'add_recipe_component', 'recipe_components', menuItemId, {
    menu_item_id: menuItemId,
    inventory_item_id: inventoryItemId,
    quantity_required: quantity,
  })

  revalidatePath(`/menu/${menuItemId}/recipe`)
  revalidatePath('/menu')
  return null
}

// ----------------------------------------------------------------
// updateRecipeComponentQuantity — inline quantity edit per recipe
// row in the menu item drawer.
//
// Restaurant-scoped via the matching restaurant_id filter (RLS is
// also active). Only `quantity_required` is touched — the
// menu_item_id ↔ inventory_item_id link stays the same, so POS
// depletion and sellability projection continue to consume the
// same recipe shape, just with the new per-sale quantity.
//
// Caller passes menu_item_id so we can revalidate the right
// recipe-builder path; the canonical /menu path is always also
// revalidated so the card-level recipe count / status refreshes.
// ----------------------------------------------------------------
export async function updateRecipeComponentQuantity(
  prevState: { error: string } | null,
  formData: FormData,
): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Owner-only — see addRecipeComponent above.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can edit recipes.' }
  }

  const componentId = ((formData.get('component_id') as string | null) ?? '').trim()
  const menuItemId = ((formData.get('menu_item_id') as string | null) ?? '').trim()
  const quantityRaw = ((formData.get('quantity_required') as string | null) ?? '').trim()
  if (!componentId) return { error: 'No ingredient specified.' }

  const quantity = parseFloat(quantityRaw)
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { error: 'Quantity must be greater than 0.' }
  }

  const { error } = await ctx.supabase
    .from('recipe_components')
    .update({ quantity_required: quantity })
    .eq('id', componentId)
    .eq('restaurant_id', ctx.restaurantId)

  if (error) return { error: formatError('recipe quantity', error) }

  await logAudit(ctx, null, 'update_recipe_component_quantity', 'recipe_components', componentId, {
    menu_item_id: menuItemId || null,
    quantity_required: quantity,
  })

  if (menuItemId) revalidatePath(`/menu/${menuItemId}/recipe`)
  revalidatePath('/menu')
  revalidatePath('/pos')
  return null
}

export async function removeRecipeComponent(formData: FormData) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return

  // Owner-only — see addRecipeComponent above. Silent return on
  // failure matches this action's no-feedback shape.
  if (ctx.role !== 'owner') return

  const componentId = formData.get('component_id') as string
  const menuItemId = formData.get('menu_item_id') as string
  if (!componentId) return

  await ctx.supabase.from('recipe_components').delete().eq('id', componentId)
  await logAudit(ctx, null, 'remove_recipe_component', 'recipe_components', componentId, {
    menu_item_id: menuItemId || null,
  })
  revalidatePath(`/menu/${menuItemId}/recipe`)
  revalidatePath('/menu')
}

// Returns { item: { id, name, unitOfMeasure } } on success so the
// client can auto-select the ingredient for quantity entry.
// Prevents duplicates by checking for existing items with the same
// normalized name (trimmed, case-insensitive) in this restaurant.
export async function createInlineInventoryItem(
  prevState: { error: string; item?: undefined } | { item: { id: string; name: string; unitOfMeasure: string }; error?: undefined } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const { locationId, error: locError } = await resolveLocationId(ctx)
  if (locError) return { error: locError }

  // Location enforcement — resolveLocationId returns the manager's
  // own location when called without a form value, but if a caller
  // ever threads a `location_id` form field through here we'd want
  // the same gate that protects inventory_items elsewhere. Belt-and-
  // suspenders: a manager can only create against their location.
  if (ctx.role === 'manager' && ctx.locationId && locationId !== ctx.locationId) {
    return { error: 'You do not have access to this location.' }
  }

  // Normalize on the way in. Display name is what we save; the
  // lookup key powers the duplicate-resolves-to-reuse behavior so
  // "mushroom" types as a recipe ingredient correctly finds the
  // existing "Mushroom" row.
  const rawName = (formData.get('name') as string) ?? ''
  const displayName = normalizeDisplayName(rawName)
  const nameKey = normalizeNameKey(rawName)
  const unitOfMeasure = (formData.get('unit_of_measure') as string)?.trim() || 'units'
  const menuItemId = formData.get('menu_item_id') as string

  if (!displayName) return { error: 'Item name is required.' }

  // Existing-ingredient lookup. Fetch the candidate set (restaurant-
  // scoped + active) and filter in JS against the normalized key —
  // ilike alone catches casing but not collapsed-whitespace
  // differences ("nacho   cheese" vs "nacho cheese"). The recipe
  // builder intentionally REUSES on collision instead of erroring;
  // managers wiring up a recipe expect "type the ingredient, attach
  // it" to find the existing row.
  const { data: candidates } = await ctx.supabase
    .from('inventory_items')
    .select('id, name, unit_of_measure')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('active', true)
  const existing = (candidates ?? []).find(
    (row) => normalizeNameKey((row.name as string) ?? '') === nameKey,
  )

  if (existing) {
    revalidatePath('/menu')
    return {
      item: { id: existing.id, name: existing.name, unitOfMeasure: existing.unit_of_measure },
    }
  }

  // No duplicate — create new with the normalized display name.
  const { data: created, error } = await ctx.supabase
    .from('inventory_items')
    .insert({
      restaurant_id: ctx.restaurantId,
      location_id: locationId,
      name: displayName,
      unit_of_measure: unitOfMeasure,
      source: 'manual',
    })
    .select('id, name, unit_of_measure')
    .single()

  if (error || !created) {
    console.error('Inline inventory item creation failed:', error)
    return { error: formatError('create item', error) }
  }

  revalidatePath(`/menu/${menuItemId}/recipe`)
  revalidatePath('/menu')
  return {
    item: { id: created.id, name: created.name, unitOfMeasure: created.unit_of_measure },
  }
}
