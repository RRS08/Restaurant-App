'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId, logAudit, formatError } from '@/lib/auth'
import { requireLocationAccess, AuthzError } from '@/lib/authz'
import { normalizeDisplayName, normalizeNameKey } from '@/lib/strings/names'

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

  // Normalize on the way in. Display name = title-cased, trimmed,
  // single-spaced. Key = lowercase version used to compare against
  // existing rows so casing/whitespace differences collide cleanly.
  const rawName = (formData.get('name') as string) ?? ''
  const displayName = normalizeDisplayName(rawName)
  const nameKey = normalizeNameKey(rawName)
  const unitOfMeasure = (formData.get('unit_of_measure') as string)?.trim() || 'units'
  const thresholdRaw = formData.get('low_stock_threshold') as string
  const threshold = thresholdRaw ? parseFloat(thresholdRaw) : 5

  if (!displayName) return { error: 'Item name is required.' }
  if (isNaN(threshold) || threshold < 0) return { error: 'Threshold must be 0 or more.' }

  // Duplicate guard — case-insensitive + whitespace-normalized. Scoped
  // to active inventory items in this restaurant (RLS gates the row
  // set; we additionally filter `active=true` so an archived prior
  // row doesn't block a new create). Collision compares the normalized
  // key, so "mushroom", "MUSHROOM", and "  Mushroom  " all collide
  // with a stored "Mushroom".
  const { data: existingItems } = await ctx.supabase
    .from('inventory_items')
    .select('id, name')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('active', true)
  const collision = (existingItems ?? []).find(
    (row) => normalizeNameKey((row.name as string) ?? '') === nameKey,
  )
  if (collision) {
    return {
      error: `An inventory item named ${normalizeDisplayName((collision.name as string) ?? '')} already exists.`,
    }
  }

  const { error } = await ctx.supabase.from('inventory_items').insert({
    restaurant_id: ctx.restaurantId,
    location_id: locationId,
    name: displayName,
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
  revalidatePath('/web/inventory')
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
  revalidatePath('/web/inventory')
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
  revalidatePath('/web/inventory')
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
  revalidatePath('/web/inventory')
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
  revalidatePath('/web/inventory')
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
  revalidatePath('/web/inventory')
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

  // Vendor is a short user-created business name → normalize display
  // form (title-case, collapsed whitespace). No vendor entity table
  // exists, so we don't dedupe — managers may type "Sysco Foods"
  // repeatedly; normalizing the display form is enough to keep the
  // restock list clean.
  const vendorRaw = ((formData.get('vendor') as string) ?? '').trim()
  const vendor = vendorRaw ? normalizeDisplayName(vendorRaw) : null
  const notes = ((formData.get('notes') as string)?.trim()) || null
  const costRaw = (formData.get('expected_cost') as string)?.trim()
  const expectedCost = costRaw ? parseFloat(costRaw) : null
  if (expectedCost !== null && (!Number.isFinite(expectedCost) || expectedCost < 0)) {
    return { error: 'Expected cost must be 0 or more.' }
  }

  // Optional expected delivery date. Stored as a yyyy-mm-dd string —
  // never gates the stock movement, purely annotation for the
  // Awaiting receipt view. Reject malformed input so we don't
  // silently coerce to a bad date downstream.
  const expectedDateRaw = (formData.get('expected_date') as string)?.trim() || ''
  let expectedDate: string | null = null
  if (expectedDateRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDateRaw)) {
      return { error: 'Expected date must be a valid yyyy-mm-dd date.' }
    }
    expectedDate = expectedDateRaw
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
    expected_date: expectedDate,
    notes,
    status: 'draft',
  })
  if (error) return { error: formatError('restock order', error) }

  await logAudit(ctx, item.location_id, 'create_restock_order', 'restock_orders')
  revalidatePath('/inventory')
  revalidatePath('/web/inventory')
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
  revalidatePath('/web/inventory')
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

  // Pull the full order — we need item, qty, location, expected
  // cost, AND the batch identity (ordered_at) so the Finance bridge
  // can roll multi-line tickets into a single expense row.
  const { data: order } = await ctx.supabase
    .from('restock_orders')
    .select('id, status, location_id, inventory_item_id, quantity, vendor, expected_cost, ordered_at')
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

  // Optional received_quantity from the form supports partial
  // receipts: the manager edits the input on the receive panel
  // before confirming. When omitted, default to the ordered amount
  // so a single-click receive on the row still works as before.
  // The stock bump uses the RECEIVED amount, not the ordered amount,
  // so a 20-oz order that arrived as 18 oz lands +18 oz in inventory.
  const receivedRaw = (formData.get('received_quantity') as string | null)?.trim() ?? ''
  let receivedQuantity = Number(order.quantity)
  if (receivedRaw !== '') {
    const parsed = parseFloat(receivedRaw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { error: 'Received quantity must be greater than zero.' }
    }
    receivedQuantity = parsed
  }

  // Optional `confirmed_total` from the form — the manager-confirmed
  // ticket-level total. When present, this is what Finance records
  // for the batch (not the per-line cost sum). The action also
  // re-distributes the new total across siblings so per-line
  // expected_cost reflects the latest confirmation for analytics.
  // When omitted, the Finance bridge falls back to the existing
  // sibling-sum behavior. Edits during a partial receive update the
  // already-booked Finance row in place.
  const confirmedRaw = (formData.get('confirmed_total') as string | null)?.trim() ?? ''
  let confirmedTotal: number | null = null
  if (confirmedRaw !== '') {
    const parsed = parseFloat(confirmedRaw)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: 'Confirmed total must be 0 or more.' }
    }
    confirmedTotal = parsed
  }

  // ----- Overdrawn deficit recovery -----
  //
  // Product rule: when stock is overdrawn (estimated < 0 — sales
  // depletion exceeded the last counted amount), receiving treats
  // the current state as 0 before adding the received quantity. So
  // receiving 20 oz on -4 oz stock lands the manager at 20 oz, NOT
  // 16 oz. The reasoning: the negative number means either the
  // count was wrong OR the depletion records were noisy; either
  // way, the physical truth of "we just received X" should anchor
  // the new state, not "X minus accumulated tracking error."
  //
  // We preserve the negative number in the transaction history
  // rather than pretending it never happened — that gives future
  // tracking-accuracy intelligence the signal it needs to estimate
  // how often the depletion model diverges from physical truth.
  // Implementation: if estimated < 0, insert a separate `adjustment`
  // transaction with quantity_change = abs(estimated) and a note
  // explaining the recovery. The subsequent `purchase` insert is
  // unchanged and carries the actual received amount.
  //
  // Mirrors the page-level estimated-stock calculation:
  //   latest count.quantity_on_hand + sum(transactions where
  //   transaction_datetime >= count.count_date)
  let deficitToClear = 0
  const { data: latestCount } = await ctx.supabase
    .from('inventory_counts')
    .select('quantity_on_hand, count_date')
    .eq('inventory_item_id', order.inventory_item_id)
    .order('count_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestCount) {
    const { data: postCountTxs } = await ctx.supabase
      .from('inventory_transactions')
      .select('quantity_change')
      .eq('inventory_item_id', order.inventory_item_id)
      .gte('transaction_datetime', latestCount.count_date)
    const postCountSum = (postCountTxs ?? []).reduce(
      (s, t) => s + Number(t.quantity_change),
      0,
    )
    const estimated = Number(latestCount.quantity_on_hand) + postCountSum
    if (estimated < 0) deficitToClear = Math.abs(estimated)
  }

  if (deficitToClear > 0) {
    const { error: adjErr } = await ctx.supabase
      .from('inventory_transactions')
      .insert({
        restaurant_id: ctx.restaurantId,
        location_id: order.location_id,
        inventory_item_id: order.inventory_item_id,
        transaction_type: 'adjustment',
        quantity_change: deficitToClear,
        unit_cost: null,
        reference_note: `Overdrawn deficit cleared at receipt (was ${(-deficitToClear).toFixed(2)})`,
      })
    if (adjErr) return { error: formatError('deficit adjustment', adjErr) }
  }

  // ----- Side effect 1: inventory transaction (the stock bump) -----
  // unit_cost is recorded only when expected_cost was provided, so
  // future cost-tracking has data without forcing manager input.
  // We use the ORDERED quantity as the divisor so unit_cost reflects
  // the per-unit price the manager agreed to, not the per-unit price
  // diluted by a short delivery.
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
      quantity_change: receivedQuantity,
      unit_cost: unitCost,
      reference_note: `Restock received${order.vendor ? ` · ${order.vendor}` : ''}`,
    })
    .select('id')
    .single()
  if (txErr || !tx) return { error: formatError('inventory transaction', txErr) }

  // ----- Side effect 2 (optional): expenses bridge to Finance -----
  //
  // RULE: one vendor ticket = one Finance expense row. Inventory is
  // line-level (stock moves per receive), Finance is ticket-level
  // (one Spend entry per supplier order, regardless of how many
  // items rolled up to it).
  //
  // History: placeRestockTicket splits the ticket total equally
  // across selected drafts and stamps `expected_cost` per line. A
  // previous version of this action inserted ONE expense row per
  // line at receipt time, which created N duplicated Finance rows
  // for an N-line ticket (e.g. a 3-line $350.01 Walmart ticket
  // displayed as 3 × $116.67). The fix below collapses to a single
  // Finance row using the FULL TICKET TOTAL.
  //
  // Strategy (minimal, schema-free): first receive in a batch wins.
  //   1. Find siblings sharing this line's `ordered_at` (the batch
  //      identity placeRestockTicket / placeAllDrafts stamp).
  //   2. If any sibling already has `received_expense_id` set, some
  //      earlier receive already wrote the Finance row — skip.
  //   3. Otherwise, this is the first receive in the batch. Sum
  //      `expected_cost` across all siblings to recover the original
  //      ticket total, and insert ONE expense row with that amount.
  //   4. Store the new expense_id on the current line's
  //      `received_expense_id` so future sibling checks see it and
  //      skip.
  //
  // Solo lines (no ordered_at — fast-receive path on a draft that
  // was never formally placed) preserve the per-line behavior since
  // there's no batch to roll up.
  //
  // Close-short interaction: closeRestockBatch flips remaining lines
  // to `canceled` but never touches Finance. So a batch where the
  // manager received 2 of 3 lines and short-closed the 3rd still
  // records the FULL ticket total (the first-receive winner already
  // wrote it). This matches the spec: "If the order is closed short:
  // Finance should record one ticket-level spend entry · use the
  // current ticket total."
  //
  // Race note: two simultaneous receives in different tabs could
  // both pass the sibling check before either commits. Realistically
  // unreachable from the in-app UI (the receive loop is awaited
  // sequentially); a future hardening could add a unique constraint
  // on (restaurant_id, ordered_at) for inventory_purchase rows.
  let expenseId: string | null = null

  if (order.ordered_at) {
    // Real batch — sibling-aware Finance insertion + confirmed-
    // total honoring.
    const { data: siblings } = await ctx.supabase
      .from('restock_orders')
      .select('id, expected_cost, received_expense_id')
      .eq('restaurant_id', ctx.restaurantId)
      .eq('ordered_at', order.ordered_at)

    const siblingsList = siblings ?? []

    // ---- Step A: re-distribute confirmed total if it differs from
    // current per-line sum. Persists the manager's confirmed total
    // as the source of truth for the batch's expected_cost shares.
    const currentCents = siblingsList.reduce(
      (c, s) => c + (s.expected_cost === null ? 0 : Math.round(Number(s.expected_cost) * 100)),
      0,
    )
    const confirmedCents = confirmedTotal !== null ? Math.round(confirmedTotal * 100) : null

    if (confirmedCents !== null && confirmedCents !== currentCents && siblingsList.length > 0) {
      const baseCents = Math.floor(confirmedCents / siblingsList.length)
      const remainder = confirmedCents - baseCents * siblingsList.length
      const sortedIds = siblingsList.map((s) => s.id).sort()
      const bumpedIds = sortedIds.slice(0, remainder)
      const baseDollars = baseCents / 100
      const bumpedDollars = (baseCents + 1) / 100

      const { error: distErr } = await ctx.supabase
        .from('restock_orders')
        .update({ expected_cost: baseDollars })
        .in('id', sortedIds)
      if (distErr) {
        console.error('restock receive: confirmed-total redistribution failed', distErr)
      }
      if (bumpedIds.length > 0) {
        const { error: bumpErr } = await ctx.supabase
          .from('restock_orders')
          .update({ expected_cost: bumpedDollars })
          .in('id', bumpedIds)
        if (bumpErr) {
          console.error('restock receive: confirmed-total bump failed', bumpErr)
        }
      }
    }

    // ---- Step B: determine the Finance amount.
    //   • confirmedTotal provided → use it
    //   • else → use the sibling sum (legacy fallback)
    const financeAmount = confirmedCents !== null
      ? confirmedCents / 100
      : currentCents / 100

    // ---- Step C: insert or update the single Finance row for this
    // batch. Sibling-tracked: the first receive's line carries the
    // expense_id; later receives update that same row.
    const expensedSibling = siblingsList.find(
      (s) => s.id !== orderId && s.received_expense_id !== null,
    )

    if (expensedSibling?.received_expense_id) {
      // Existing Finance row — bump its amount if the confirmed
      // total drifted. Idempotent when amounts already match.
      if (financeAmount > 0) {
        const { data: exp } = await ctx.supabase
          .from('expenses')
          .select('amount')
          .eq('id', expensedSibling.received_expense_id)
          .single()
        if (exp && Math.round(Number(exp.amount) * 100) !== Math.round(financeAmount * 100)) {
          const { error: updErr } = await ctx.supabase
            .from('expenses')
            .update({ amount: financeAmount })
            .eq('id', expensedSibling.received_expense_id)
          if (updErr) {
            console.error('restock receive: Finance row update failed', updErr)
          }
        }
      }
      // expenseId stays null — the back-ref already lives on the
      // earlier sibling. Don't double-stamp.
    } else if (financeAmount > 0) {
      // First receive in the batch — insert the single Finance row.
      const { data: exp, error: expErr } = await ctx.supabase
        .from('expenses')
        .insert({
          restaurant_id: ctx.restaurantId,
          location_id: order.location_id,
          category: 'Inventory Purchase',
          amount: financeAmount,
          vendor_name: order.vendor,
          expense_date: new Date().toISOString().split('T')[0],
          is_inventory_related: true,
          source: 'inventory_purchase',
          notes: `Restock ticket ${orderId.slice(0, 8)} received`,
        })
        .select('id')
        .single()
      if (!expErr && exp) expenseId = exp.id
    }
  } else {
    // Solo line (no ordered_at — fast-receive on a draft). No batch
    // to sum; confirmedTotal (if any) overrides; otherwise fall back
    // to the per-line cost.
    const amount = confirmedTotal !== null
      ? confirmedTotal
      : (order.expected_cost !== null ? Number(order.expected_cost) : 0)
    if (amount > 0) {
      const { data: exp, error: expErr } = await ctx.supabase
        .from('expenses')
        .insert({
          restaurant_id: ctx.restaurantId,
          location_id: order.location_id,
          category: 'Inventory Purchase',
          amount,
          vendor_name: order.vendor,
          expense_date: new Date().toISOString().split('T')[0],
          is_inventory_related: true,
          source: 'inventory_purchase',
          notes: `Restock ${orderId.slice(0, 8)} received`,
        })
        .select('id')
        .single()
      if (!expErr && exp) expenseId = exp.id
    }
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
    ordered_quantity: Number(order.quantity),
    received_quantity: receivedQuantity,
    expected_cost: order.expected_cost ? Number(order.expected_cost) : null,
    expense_created: expenseId !== null,
    deficit_cleared: deficitToClear > 0 ? deficitToClear : null,
  })
  revalidatePath('/inventory')
  revalidatePath('/web/inventory')
  revalidatePath('/finance')
  return null
}

// ----------------------------------------------------------------
// closeRestockBatch — short-close N still-`ordered` lines in one
// shot. Used by the Restock Orders drawer's "Receive and close
// order" path: any lines the manager DIDN'T receive get canceled in
// a single round-trip so the batch can move to Closed Orders.
//
// Semantics:
//   - Each line in `order_ids` that's currently `ordered` is set to
//     `canceled` with `canceled_at = now()`.
//   - Lines that are already `received` / `canceled` / `draft` are
//     silently skipped — close-short is a no-op on terminal states
//     and we don't want a half-failed batch to surface as an error.
//   - Stock is NOT touched. The lock holds: stock only moves on
//     receipt. Closing short = "this part of the order isn't coming
//     — don't add the missing amount."
//   - Cost is NOT touched. Per-line expected_cost stays on the row
//     for analytics; canceled lines don't fire the Finance bridge,
//     so the Finance Spend total reflects only what was received.
//
// Lines that were never ordered (`draft`) should be canceled
// through `cancelRestockOrder`, which is the staging-area path.
// This action is the line-level companion to a multi-line receipt
// where the manager wants to wrap up the batch in one click.
// ----------------------------------------------------------------
export async function closeRestockBatch(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const idsRaw = ((formData.get('order_ids') as string) ?? '').trim()
  if (!idsRaw) return null
  const orderIds = idsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  if (orderIds.length === 0) return null

  // Verify ownership + collect the actually-closable subset. Foreign
  // ids and terminal-state ids are filtered out — we want this call
  // to succeed idempotently even if the client's view of "still
  // pending" is one revalidation stale.
  const { data: orders } = await ctx.supabase
    .from('restock_orders')
    .select('id, status, location_id')
    .in('id', orderIds)
    .eq('restaurant_id', ctx.restaurantId)
  if (!orders || orders.length === 0) return null

  // Location authz across the batch. Owner passes through; managers
  // must match every involved location (multi-location batches are
  // already prevented at ticket-creation time, but enforce here too).
  for (const o of orders) {
    const locErr = await requireLocResult(ctx.restaurantId, o.location_id)
    if (locErr) return { error: locErr }
  }

  const closableIds = orders.filter((o) => o.status === 'ordered').map((o) => o.id)
  if (closableIds.length === 0) return null

  const { error } = await ctx.supabase
    .from('restock_orders')
    .update({ status: 'canceled', canceled_at: new Date().toISOString() })
    .in('id', closableIds)
    .eq('status', 'ordered')
  if (error) return { error: formatError('close restock batch', error) }

  await logAudit(
    ctx,
    orders[0].location_id,
    'close_restock_batch',
    'restock_orders',
    undefined,
    { count: closableIds.length, short_close: true },
  )
  revalidatePath('/inventory')
  revalidatePath('/web/inventory')
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
  revalidatePath('/web/inventory')
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
  revalidatePath('/web/inventory')
  return null
}

// ----------------------------------------------------------------
// updateRestockOrderDetails — edit the optional vendor / expected
// cost / expected date / notes on a draft order. The item drawer's
// Restock card no longer collects these — they live in the Restock
// Cart drawer, where the manager finalizes the order before
// committing.
//
// Each field is updated only when its form key is PRESENT (even if
// empty). That lets the cart's inline editor clear a field by
// passing an empty string without forcing it to send every field
// in every save. Fields not in the FormData are left untouched.
//
// Cost still lands in Finance at RECEIPT time via the existing
// expenses bridge in markRestockReceived — there is no Finance
// side effect here; this is the intent surface, not the realized
// surface. See the comment block on markRestockReceived for the
// timing rationale.
// ----------------------------------------------------------------
export async function updateRestockOrderDetails(
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
  if (order.status !== 'draft') {
    return { error: 'Details can only be edited while the order is a draft.' }
  }
  const locAuthErr = await requireLocResult(ctx.restaurantId, order.location_id)
  if (locAuthErr) return { error: locAuthErr }

  // Build the partial update from whichever fields the form sent.
  const update: Record<string, string | number | null> = {}

  if (formData.has('vendor')) {
    const vendorRaw = ((formData.get('vendor') as string) ?? '').trim()
    update.vendor = vendorRaw.length > 0 ? normalizeDisplayName(vendorRaw) : null
  }

  if (formData.has('expected_cost')) {
    const raw = ((formData.get('expected_cost') as string) ?? '').trim()
    if (raw === '') {
      update.expected_cost = null
    } else {
      const parsed = parseFloat(raw)
      if (!Number.isFinite(parsed) || parsed < 0) {
        return { error: 'Expected cost must be 0 or more.' }
      }
      update.expected_cost = parsed
    }
  }

  if (formData.has('expected_date')) {
    const raw = ((formData.get('expected_date') as string) ?? '').trim()
    if (raw === '') {
      update.expected_date = null
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return { error: 'Expected date must be a valid yyyy-mm-dd date.' }
      }
      update.expected_date = raw
    }
  }

  if (formData.has('notes')) {
    const notes = ((formData.get('notes') as string) ?? '').trim()
    update.notes = notes.length > 0 ? notes : null
  }

  if (Object.keys(update).length === 0) {
    // Nothing sent — treat as a no-op rather than an error so the
    // calling form can submit without triggering false-positive
    // failures during snapshot/diff flows.
    return null
  }

  const { error } = await ctx.supabase
    .from('restock_orders')
    .update(update)
    .eq('id', orderId)
  if (error) return { error: formatError('restock order', error) }

  revalidatePath('/inventory')
  revalidatePath('/web/inventory')
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
  revalidatePath('/web/inventory')
  return null
}

// ----------------------------------------------------------------
// placeRestockTicket — vendor-ticket commit. Takes a SELECTED set of
// draft restock_orders ids plus ticket-level vendor / expected total
// / expected date / notes, and flips those rows to 'ordered' in one
// atomic UPDATE.
//
// Compared to placeAllDrafts:
//   • Acts on a manager-chosen subset (the items dragged into the
//     active vendor ticket), not the whole cart. Drafts NOT in the
//     ticket stay as drafts and can be assembled into a separate
//     vendor ticket later.
//   • Stamps the same vendor / expected_date / notes on every row
//     so the entire ticket reads as one supplier order downstream.
//   • Distributes the ticket's expected total equally across the
//     selected rows so per-line `expected_cost` aggregates back to
//     the entered total — preserves the existing Finance bridge
//     architecture (each line's receipt inserts one expense row
//     for its share, totals reconcile to the entered ticket total
//     on full receipt). The split is an implementation detail; the
//     UI never shows per-line cost to the manager.
//   • Sets ordered_at to the same instant for every line in the
//     ticket so the OrdersDrawer groups them as one awaiting-receipt
//     batch (same key as placeAllDrafts).
//
// Vendor is required — without it the ticket can't represent a real
// supplier order. Everything else is optional.
// ----------------------------------------------------------------
export async function placeRestockTicket(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Parse the selected draft ids — comma-separated string from the
  // client's Set<string> serialization.
  const orderIdsRaw = ((formData.get('order_ids') as string) ?? '').trim()
  if (!orderIdsRaw) return { error: 'Add at least one item to the ticket.' }
  const orderIds = orderIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  if (orderIds.length === 0) return { error: 'Add at least one item to the ticket.' }

  // Ticket-level fields. Vendor is required; the rest are optional.
  const vendorRaw = ((formData.get('vendor') as string) ?? '').trim()
  if (!vendorRaw) return { error: 'Vendor is required to create the order ticket.' }
  const vendor = normalizeDisplayName(vendorRaw)

  const totalRaw = ((formData.get('expected_total') as string) ?? '').trim()
  let totalCost: number | null = null
  if (totalRaw !== '') {
    const parsed = parseFloat(totalRaw)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: 'Expected total must be 0 or more.' }
    }
    totalCost = parsed
  }

  const expectedDateRaw = ((formData.get('expected_date') as string) ?? '').trim()
  let expectedDate: string | null = null
  if (expectedDateRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDateRaw)) {
      return { error: 'Expected date must be a valid yyyy-mm-dd date.' }
    }
    expectedDate = expectedDateRaw
  }

  const notes = ((formData.get('notes') as string) ?? '').trim() || null

  // Verify every selected id is a real draft for this restaurant.
  // Catches stale ticket state where a draft was canceled between
  // the manager dragging it into the ticket and clicking Create.
  const { data: drafts } = await ctx.supabase
    .from('restock_orders')
    .select('id, location_id')
    .in('id', orderIds)
    .eq('restaurant_id', ctx.restaurantId)
    .eq('status', 'draft')
  if (!drafts || drafts.length !== orderIds.length) {
    return { error: 'Some items are no longer staged. Refresh the cart and try again.' }
  }
  // Location authz, same pattern as createRestockOrder. Owners
  // pass through; managers can only commit tickets containing
  // items at their assigned location.
  for (const d of drafts) {
    const locErr = await requireLocResult(ctx.restaurantId, d.location_id)
    if (locErr) return { error: locErr }
  }

  // ----- Cent-precision equal split -----
  //
  // Bug history: a naive float split (`totalCost / drafts.length`)
  // truncated at the 2-decimal numeric(10,2) column. Entering
  // $1000.00 across 3 lines stored 333.33 × 3, then siblings sum
  // back to $999.99 in the Finance bridge and the closed-order
  // display. A cent went missing every cycle.
  //
  // Fix: convert the ticket total to integer cents, divide by line
  // count, distribute the remainder cents one-per-line to the first
  // `remainder` rows. The per-line dollar amounts now sum back to
  // the entered total EXACTLY. Examples:
  //   $1000 / 3   → 333.34, 333.33, 333.33  (sum 1000.00 ✓)
  //   $350.01 / 3 → 116.67, 116.67, 116.67  (sum 350.01 ✓)
  //   $82.43 / 2  → 41.22,  41.21           (sum 82.43  ✓)
  //   $0.99 / 2   → 0.50,   0.49            (sum 0.99   ✓)
  //
  // When the split is uneven we do TWO updates: one bulk pass with
  // the base cost on every line, then a second pass on the first
  // `remainder` ids bumping their cost by one cent. The id list is
  // sorted so distribution is deterministic (same input → same
  // per-line costs across reruns). For pilot scale (a few lines per
  // ticket) two queries is acceptable; large-scale we could collapse
  // via an RPC.
  const orderedAt = new Date().toISOString()

  if (totalCost === null) {
    // No total → no cost on any line. Single bulk update.
    const { error } = await ctx.supabase
      .from('restock_orders')
      .update({
        vendor,
        expected_cost: null,
        expected_date: expectedDate,
        notes,
        status: 'ordered',
        ordered_at: orderedAt,
      })
      .in('id', orderIds)
      .eq('status', 'draft')
    if (error) return { error: formatError('restock ticket', error) }
  } else {
    const totalCents = Math.round(totalCost * 100)
    const baseCents = Math.floor(totalCents / drafts.length)
    const remainder = totalCents - baseCents * drafts.length
    const baseDollars = baseCents / 100
    const bumpedDollars = (baseCents + 1) / 100

    // Deterministic order so the same input always produces the
    // same per-line distribution. PostgREST doesn't guarantee
    // SELECT result order without ORDER BY.
    const sortedIds = drafts.map((d) => d.id).sort()
    const bumpedIds = sortedIds.slice(0, remainder)

    // Pass 1: bulk update everyone with shared fields + base cost.
    const { error: bulkErr } = await ctx.supabase
      .from('restock_orders')
      .update({
        vendor,
        expected_cost: baseDollars,
        expected_date: expectedDate,
        notes,
        status: 'ordered',
        ordered_at: orderedAt,
      })
      .in('id', orderIds)
      .eq('status', 'draft')
    if (bulkErr) return { error: formatError('restock ticket', bulkErr) }

    // Pass 2: bump the first `remainder` lines by one cent each.
    // No-op when totalCents is evenly divisible by drafts.length.
    if (bumpedIds.length > 0) {
      const { error: bumpErr } = await ctx.supabase
        .from('restock_orders')
        .update({ expected_cost: bumpedDollars })
        .in('id', bumpedIds)
      // Best-effort: if the bump fails, the ticket is already
      // placed at base cents. Finance bridge will be short by the
      // remainder cents — but this is the same as the pre-fix
      // behavior, and partial-state corruption is preferable to
      // leaving the placement uncommitted.
      if (bumpErr) {
        console.error('restock ticket: cent-bump update failed', bumpErr)
      }
    }
  }

  await logAudit(
    ctx,
    drafts[0]?.location_id ?? null,
    'place_restock_ticket',
    'restock_orders',
    undefined,
    {
      count: drafts.length,
      vendor,
      expected_total: totalCost,
      expected_date: expectedDate,
    },
  )
  revalidatePath('/inventory')
  revalidatePath('/web/inventory')
  return null
}
