'use server'

import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId, formatError } from '@/lib/auth'

export async function addRecipeComponent(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

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

  revalidatePath(`/menu/${menuItemId}/recipe`)
  revalidatePath('/menu')
  return null
}

export async function removeRecipeComponent(formData: FormData) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return

  const componentId = formData.get('component_id') as string
  const menuItemId = formData.get('menu_item_id') as string
  if (!componentId) return

  await ctx.supabase.from('recipe_components').delete().eq('id', componentId)
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

  const name = (formData.get('name') as string)?.trim()
  const unitOfMeasure = (formData.get('unit_of_measure') as string)?.trim() || 'units'
  const menuItemId = formData.get('menu_item_id') as string

  if (!name) return { error: 'Item name is required.' }

  // Check for existing ingredient with the same name (case-insensitive)
  const { data: existing } = await ctx.supabase
    .from('inventory_items')
    .select('id, name, unit_of_measure')
    .ilike('name', name)
    .limit(1)
    .single()

  if (existing) {
    // Duplicate found — reuse it instead of creating
    revalidatePath('/menu')
    return {
      item: { id: existing.id, name: existing.name, unitOfMeasure: existing.unit_of_measure },
    }
  }

  // No duplicate — create new
  const { data: created, error } = await ctx.supabase
    .from('inventory_items')
    .insert({
      restaurant_id: ctx.restaurantId,
      location_id: locationId,
      name,
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
