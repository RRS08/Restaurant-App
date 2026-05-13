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
//
// Refuses to archive when recipe_components still reference the item.
// Background: a previous gap let users archive items that menus
// still depended on. POS depletion would then write to the archived
// id, the Inventory page would filter that row out of the table,
// and stock movement would silently disappear. The integrity check
// reactivates anything stuck in this state; this guard prevents new
// instances. The action is now useActionState-shaped so the inline
// archive button can surface the error.
export async function archiveInventoryItem(
  _prevState: { error: string } | null,
  formData: FormData
): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const itemId = formData.get('item_id') as string
  if (!itemId) return { error: 'No item specified.' }

  const { data: item } = await ctx.supabase
    .from('inventory_items')
    .select('location_id, name')
    .eq('id', itemId)
    .single()
  if (!item) return { error: 'Item not found.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, item.location_id)
  if (locAuthErr) return { error: locAuthErr }

  // Guard: refuse archive when recipes still depend on this item.
  // Inline lookup is cheap (head:true count) and prevents the silent
  // "depletion writes to invisible row" state we just had to repair.
  const { count: recipeCount } = await ctx.supabase
    .from('recipe_components')
    .select('id', { count: 'exact', head: true })
    .eq('inventory_item_id', itemId)

  if ((recipeCount ?? 0) > 0) {
    return {
      error: `Cannot archive — "${item.name}" is used in ${recipeCount} active recipe${recipeCount === 1 ? '' : 's'}. Remove the recipe links first.`,
    }
  }

  const { error: updateError } = await ctx.supabase
    .from('inventory_items')
    .update({ active: false })
    .eq('id', itemId)

  if (updateError) {
    return { error: formatError('archive item', updateError) }
  }

  revalidatePath('/inventory')
  revalidatePath('/menu')
  revalidatePath('/pos')
  return null
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

// ================================================================
// RESTOCK ORDERS — first replenishment workflow.
//
// Lifecycle: draft → ordered → received (stock auto-updates).
// Cancel exits to a terminal 'canceled' status from draft or ordered.
//
// Locked rule: stock changes ONLY on receipt. Creating an order
// does not touch inventory. Receipt inserts an inventory_transactions
// row (purchase, +qty) which the existing estimated-stock logic
// folds in automatically. When expected_cost was set, receipt also
// inserts an expenses row (source='inventory_purchase') so the
// buy lands in Finance's Spend total without the manager double-
// logging it. Both side-effect IDs are stored back on the order
// (received_transaction_id, received_expense_id) so a future
// "undo receipt" can find and reverse them.
// ================================================================

export async function createRestockOrder(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const inventoryItemId = (formData.get('inventory_item_id') as string)?.trim()
  if (!inventoryItemId) return { error: 'Please select an inventory item.' }

  const quantityRaw = formData.get('quantity') as string
  const quantity = parseFloat(quantityRaw)
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { error: 'Quantity must be greater than zero.' }
  }

  const vendor = ((formData.get('vendor') as string)?.trim()) || null
  const notes = ((formData.get('notes') as string)?.trim()) || null
  const costRaw = (formData.get('expected_cost') as string)?.trim()
  const expectedCost = costRaw ? parseFloat(costRaw) : null
  if (expectedCost !== null && (!Number.isFinite(expectedCost) || expectedCost < 0)) {
    return { error: 'Expected cost must be 0 or more.' }
  }

  // Resolve location from the item itself, then enforce that the
  // current user can write to it. Owners pass through; managers must
  // match the item's location.
  const { data: item } = await ctx.supabase
    .from('inventory_items')
    .select('location_id')
    .eq('id', inventoryItemId)
    .single()
  if (!item) return { error: 'Inventory item not found.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, item.location_id)
  if (locAuthErr) return { error: locAuthErr }

  const { error } = await ctx.supabase.from('restock_orders').insert({
    restaurant_id: ctx.restaurantId,
    location_id: item.location_id,
    inventory_item_id: inventoryItemId,
    quantity,
    vendor,
    expected_cost: expectedCost,
    notes,
    status: 'draft',
  })
  if (error) return { error: formatError('restock order', error) }

  await logAudit(ctx, item.location_id, 'create_restock_order', 'restock_orders')
  revalidatePath('/inventory')
  return null
}

export async function markRestockOrdered(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const orderId = (formData.get('order_id') as string)?.trim()
  if (!orderId) return { error: 'Missing order id.' }

  // Defense-in-depth: verify the order is currently 'draft' before
  // moving it forward, so a stale/duplicate click can't skip a step.
  const { data: order } = await ctx.supabase
    .from('restock_orders')
    .select('id, status, location_id')
    .eq('id', orderId)
    .single()
  if (!order) return { error: 'Order not found.' }
  if (order.status !== 'draft') {
    return { error: `Only draft orders can be marked ordered (current status: ${order.status}).` }
  }
  const locAuthErr = await requireLocResult(ctx.restaurantId, order.location_id)
  if (locAuthErr) return { error: locAuthErr }

  const { error } = await ctx.supabase
    .from('restock_orders')
    .update({ status: 'ordered', ordered_at: new Date().toISOString() })
    .eq('id', orderId)
  if (error) return { error: formatError('restock order', error) }

  await logAudit(ctx, order.location_id, 'mark_restock_ordered', 'restock_orders', orderId)
  revalidatePath('/inventory')
  return null
}

export async function markRestockReceived(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const orderId = (formData.get('order_id') as string)?.trim()
  if (!orderId) return { error: 'Missing order id.' }

  // Pull the full order — we need item, qty, location, and any
  // expected cost to drive the side effects.
  const { data: order } = await ctx.supabase
    .from('restock_orders')
    .select('id, status, location_id, inventory_item_id, quantity, vendor, expected_cost')
    .eq('id', orderId)
    .single()
  if (!order) return { error: 'Order not found.' }
  if (order.status === 'received') return { error: 'Order is already received.' }
  if (order.status === 'canceled') return { error: 'Canceled orders cannot be received.' }
  // Allow receiving from either 'draft' or 'ordered' — sometimes
  // managers receive a small delivery before formally marking it
  // ordered. Skipping the ordered step is operationally fine.
  const locAuthErr = await requireLocResult(ctx.restaurantId, order.location_id)
  if (locAuthErr) return { error: locAuthErr }

  // ----- Side effect 1: inventory transaction (the stock bump) -----
  // unit_cost is recorded only when expected_cost was provided, so
  // future cost-tracking has data without forcing manager input.
  const unitCost = order.expected_cost && order.quantity > 0
    ? Number(order.expected_cost) / Number(order.quantity)
    : null

  const { data: tx, error: txErr } = await ctx.supabase
    .from('inventory_transactions')
    .insert({
      restaurant_id: ctx.restaurantId,
      location_id: order.location_id,
      inventory_item_id: order.inventory_item_id,
      transaction_type: 'purchase',
      quantity_change: order.quantity,
      unit_cost: unitCost,
      reference_note: `Restock received${order.vendor ? ` · ${order.vendor}` : ''}`,
    })
    .select('id')
    .single()
  if (txErr || !tx) return { error: formatError('inventory transaction', txErr) }

  // ----- Side effect 2 (optional): expenses bridge to Finance -----
  // Only fires when the order had an expected cost > 0. Tagged
  // source='inventory_purchase' so Finance's Spend model recognizes
  // it as inventory and the de-dup logic against bank-confirmed
  // food/drink outflows works naturally.
  let expenseId: string | null = null
  if (order.expected_cost !== null && Number(order.expected_cost) > 0) {
    const { data: exp, error: expErr } = await ctx.supabase
      .from('expenses')
      .insert({
        restaurant_id: ctx.restaurantId,
        location_id: order.location_id,
        category: 'Inventory Purchase',
        amount: order.expected_cost,
        vendor_name: order.vendor,
        expense_date: new Date().toISOString().split('T')[0],
        is_inventory_related: true,
        source: 'inventory_purchase',
        notes: `Restock #${orderId.slice(0, 8)} received`,
      })
      .select('id')
      .single()
    // Don't roll back the receipt if the expense write fails — the
    // stock update is the locked guarantee. Expense bridge is
    // best-effort; the manager can re-log manually if needed.
    if (!expErr && exp) expenseId = exp.id
  }

  // ----- Update the order itself -----
  const { error: updErr } = await ctx.supabase
    .from('restock_orders')
    .update({
      status: 'received',
      received_at: new Date().toISOString(),
      received_transaction_id: tx.id,
      received_expense_id: expenseId,
    })
    .eq('id', orderId)
  if (updErr) return { error: formatError('restock order', updErr) }

  await logAudit(ctx, order.location_id, 'receive_restock_order', 'restock_orders', orderId, {
    quantity: Number(order.quantity),
    expected_cost: order.expected_cost ? Number(order.expected_cost) : null,
    expense_created: expenseId !== null,
  })
  revalidatePath('/inventory')
  revalidatePath('/finance')
  return null
}

export async function cancelRestockOrder(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const orderId = (formData.get('order_id') as string)?.trim()
  if (!orderId) return { error: 'Missing order id.' }

  const { data: order } = await ctx.supabase
    .from('restock_orders')
    .select('id, status, location_id')
    .eq('id', orderId)
    .single()
  if (!order) return { error: 'Order not found.' }
  if (order.status === 'received') return { error: 'Received orders cannot be canceled.' }
  if (order.status === 'canceled') return { error: 'Order is already canceled.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, order.location_id)
  if (locAuthErr) return { error: locAuthErr }

  const { error } = await ctx.supabase
    .from('restock_orders')
    .update({ status: 'canceled', canceled_at: new Date().toISOString() })
    .eq('id', orderId)
  if (error) return { error: formatError('restock order', error) }

  await logAudit(ctx, order.location_id, 'cancel_restock_order', 'restock_orders', orderId)
  revalidatePath('/inventory')
  return null
}

// ----------------------------------------------------------------
// quickAddToOrder — thin wrapper around createRestockOrder for the
// inventory row's "+ Add" button. React's plain `<form action>`
// expects `(formData) => void | Promise<void>`, but the canonical
// createRestockOrder is a useActionState-style action with the
// `(prevState, formData)` signature. This wrapper bridges the gap
// without forcing the row into useActionState (which would mean
// one hook per row in the hot list).
// ----------------------------------------------------------------
export async function quickAddToOrder(formData: FormData) {
  await createRestockOrder(null, formData)
}

// ----------------------------------------------------------------
// updateRestockQuantity — edit the quantity on a draft order.
// Only allowed while the order is still 'draft'; once placed, the
// quantity is locked because the manager has already committed it
// to the vendor. The Order Builder rail uses this for inline qty
// edits on cart line items.
// ----------------------------------------------------------------
export async function updateRestockQuantity(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const orderId = (formData.get('order_id') as string)?.trim()
  if (!orderId) return { error: 'Missing order id.' }

  const qtyRaw = formData.get('quantity') as string
  const quantity = parseFloat(qtyRaw)
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { error: 'Quantity must be greater than zero.' }
  }

  const { data: order } = await ctx.supabase
    .from('restock_orders')
    .select('id, status, location_id')
    .eq('id', orderId)
    .single()
  if (!order) return { error: 'Order not found.' }
  if (order.status !== 'draft') {
    return { error: 'Quantity can only be edited while the order is a draft.' }
  }
  const locAuthErr = await requireLocResult(ctx.restaurantId, order.location_id)
  if (locAuthErr) return { error: locAuthErr }

  const { error } = await ctx.supabase
    .from('restock_orders')
    .update({ quantity })
    .eq('id', orderId)
  if (error) return { error: formatError('restock order', error) }

  revalidatePath('/inventory')
  return null
}

// ----------------------------------------------------------------
// placeAllDrafts — flip every draft restock order in the manager's
// restaurant to 'ordered' in one shot. This is the cart's "Place
// order" action; per-line-item receipt then happens independently
// as goods arrive (markRestockReceived already handles that).
//
// We deliberately don't bundle drafts into a parent purchase-order
// row in this pass — line-item lifecycle is the right granularity
// for partial deliveries and multi-vendor splits.
// ----------------------------------------------------------------
export async function placeAllDrafts(
  prevState: { error: string } | null,
  _formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Confirm there's something to place. Empty cart = no-op.
  const { count } = await ctx.supabase
    .from('restock_orders')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', ctx.restaurantId)
    .eq('status', 'draft')
  if (!count || count === 0) {
    return { error: 'No draft items to place.' }
  }

  const { error } = await ctx.supabase
    .from('restock_orders')
    .update({ status: 'ordered', ordered_at: new Date().toISOString() })
    .eq('restaurant_id', ctx.restaurantId)
    .eq('status', 'draft')
  if (error) return { error: formatError('restock orders', error) }

  await logAudit(ctx, null, 'place_restock_drafts', 'restock_orders', undefined, { count })
  revalidatePath('/inventory')
  return null
}
