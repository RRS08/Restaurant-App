'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId, logAudit, formatError } from '@/lib/auth'
import { requireLocationAccess, AuthzError } from '@/lib/authz'

// Graceful wrapper so existing { error: string } action returns stay
// intact. Each operational write that targets a specific location
// calls this right after resolving the location_id.
async function requireLocResult(restaurantId: string, locationId: string): Promise<string | null> {
  try {
    await requireLocationAccess(restaurantId, locationId)
    return null
  } catch (err) {
    if (err instanceof AuthzError) return err.message
    throw err
  }
}

export async function createInventoryItem(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const { locationId, error: locError } = await resolveLocationId(ctx)
  if (locError) return { error: locError }
  const locAuthErr = await requireLocResult(ctx.restaurantId, locationId)
  if (locAuthErr) return { error: locAuthErr }

  const name = (formData.get('name') as string)?.trim()
  const unitOfMeasure = (formData.get('unit_of_measure') as string)?.trim() || 'units'
  const thresholdRaw = formData.get('low_stock_threshold') as string
  const threshold = thresholdRaw ? parseFloat(thresholdRaw) : 5

  if (!name) return { error: 'Item name is required.' }
  if (isNaN(threshold) || threshold < 0) return { error: 'Threshold must be 0 or more.' }

  const { error } = await ctx.supabase.from('inventory_items').insert({
    restaurant_id: ctx.restaurantId,
    location_id: locationId,
    name,
    unit_of_measure: unitOfMeasure,
    low_stock_threshold: threshold,
    source: 'manual',
  })

  if (error) {
    console.error('Inventory item creation failed:', error)
    return { error: formatError('inventory item', error) }
  }

  await logAudit(ctx, locationId, 'create_inventory_item', 'inventory_items')
  revalidatePath('/inventory')
  redirect('/inventory')
}

export async function updateThreshold(formData: FormData) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return

  const itemId = formData.get('item_id') as string
  const thresholdRaw = formData.get('low_stock_threshold') as string
  if (!itemId) return

  const threshold = parseFloat(thresholdRaw)
  if (isNaN(threshold) || threshold < 0) return

  // Fetch the item's location so we can enforce location-scoped
  // access via the central guard (owner-or-matching-manager).
  const { data: item } = await ctx.supabase
    .from('inventory_items')
    .select('location_id')
    .eq('id', itemId)
    .single()
  if (!item) return
  const locAuthErr = await requireLocResult(ctx.restaurantId, item.location_id)
  if (locAuthErr) return

  await ctx.supabase
    .from('inventory_items')
    .update({ low_stock_threshold: threshold })
    .eq('id', itemId)

  revalidatePath('/inventory')
}

export async function createInventoryCount(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const { locationId, error: locError } = await resolveLocationId(ctx)
  if (locError) return { error: locError }
  const locAuthErr = await requireLocResult(ctx.restaurantId, locationId)
  if (locAuthErr) return { error: locAuthErr }

  const inventoryItemId = formData.get('inventory_item_id') as string
  const quantityRaw = formData.get('quantity_on_hand') as string

  if (!inventoryItemId) return { error: 'Please select an inventory item.' }

  const quantity = parseFloat(quantityRaw)
  if (isNaN(quantity) || quantity < 0) return { error: 'Quantity must be 0 or more.' }

  const { error } = await ctx.supabase.from('inventory_counts').insert({
    restaurant_id: ctx.restaurantId,
    location_id: locationId,
    inventory_item_id: inventoryItemId,
    quantity_on_hand: quantity,
    entered_by_user_id: ctx.userId,
  })

  if (error) {
    console.error('Inventory count failed:', error)
    return { error: formatError('inventory count', error) }
  }

  await logAudit(ctx, locationId, 'create_inventory_count', 'inventory_counts')
  revalidatePath('/inventory')
  redirect('/inventory')
}

export async function createInventoryTransaction(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const { locationId, error: locError } = await resolveLocationId(ctx)
  if (locError) return { error: locError }
  const locAuthErr = await requireLocResult(ctx.restaurantId, locationId)
  if (locAuthErr) return { error: locAuthErr }

  const inventoryItemId = formData.get('inventory_item_id') as string
  const transactionType = formData.get('transaction_type') as string
  const quantityRaw = formData.get('quantity_change') as string
  const unitCostRaw = formData.get('unit_cost') as string
  const referenceNote = (formData.get('reference_note') as string)?.trim() || null

  if (!inventoryItemId) return { error: 'Please select an inventory item.' }

  const validTypes = ['purchase', 'waste', 'adjustment']
  if (!validTypes.includes(transactionType)) return { error: 'Invalid transaction type.' }

  const quantity = parseFloat(quantityRaw)
  if (isNaN(quantity) || quantity === 0) return { error: 'Quantity must be a non-zero number.' }

  let signedQuantity = quantity
  if (transactionType === 'waste' && signedQuantity > 0) signedQuantity = -signedQuantity
  if (transactionType === 'purchase' && signedQuantity < 0) signedQuantity = -signedQuantity

  const unitCost = unitCostRaw ? parseFloat(unitCostRaw) : null
  if (unitCost !== null && (isNaN(unitCost) || unitCost < 0)) {
    return { error: 'Unit cost must be 0 or more.' }
  }

  const { error } = await ctx.supabase.from('inventory_transactions').insert({
    restaurant_id: ctx.restaurantId,
    location_id: locationId,
    inventory_item_id: inventoryItemId,
    transaction_type: transactionType,
    quantity_change: signedQuantity,
    unit_cost: unitCost,
    reference_note: referenceNote,
  })

  if (error) {
    console.error('Inventory transaction failed:', error)
    return { error: formatError('transaction', error) }
  }

  await logAudit(ctx, locationId, 'create_inventory_transaction', 'inventory_transactions')
  revalidatePath('/inventory')
  redirect('/inventory')
}

// Archive an inventory item (set active = false).
// Preserves all history — the item just stops appearing in active lists.
export async function archiveInventoryItem(formData: FormData) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return

  const itemId = formData.get('item_id') as string
  if (!itemId) return

  const { data: item } = await ctx.supabase
    .from('inventory_items')
    .select('location_id')
    .eq('id', itemId)
    .single()
  if (!item) return
  const locAuthErr = await requireLocResult(ctx.restaurantId, item.location_id)
  if (locAuthErr) return

  await ctx.supabase
    .from('inventory_items')
    .update({ active: false })
    .eq('id', itemId)

  revalidatePath('/inventory')
}

// Delete an inventory item — only allowed when it has NO dependent records.
// Returns an error message if dependencies exist so the UI can show it.
export async function deleteInventoryItem(formData: FormData): Promise<{ error: string } | undefined> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  const itemId = formData.get('item_id') as string
  if (!itemId) return { error: 'No item specified.' }

  const { data: item } = await ctx.supabase
    .from('inventory_items')
    .select('location_id')
    .eq('id', itemId)
    .single()
  if (!item) return { error: 'Item not found.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, item.location_id)
  if (locAuthErr) return { error: locAuthErr }

  // Check for dependencies
  const [{ count: rc }, { count: ic }, { count: it }] = await Promise.all([
    ctx.supabase.from('recipe_components').select('id', { count: 'exact', head: true }).eq('inventory_item_id', itemId),
    ctx.supabase.from('inventory_counts').select('id', { count: 'exact', head: true }).eq('inventory_item_id', itemId),
    ctx.supabase.from('inventory_transactions').select('id', { count: 'exact', head: true }).eq('inventory_item_id', itemId),
  ])

  const deps = (rc ?? 0) + (ic ?? 0) + (it ?? 0)

  if (deps > 0) {
    const parts: string[] = []
    if ((rc ?? 0) > 0) parts.push(`${rc} recipe${(rc ?? 0) > 1 ? 's' : ''}`)
    if ((ic ?? 0) > 0) parts.push(`${ic} count${(ic ?? 0) > 1 ? 's' : ''}`)
    if ((it ?? 0) > 0) parts.push(`${it} transaction${(it ?? 0) > 1 ? 's' : ''}`)
    return { error: `Cannot delete — linked to ${parts.join(', ')}. Archive instead.` }
  }

  await ctx.supabase.from('inventory_items').delete().eq('id', itemId)
  revalidatePath('/inventory')
  return undefined
}
