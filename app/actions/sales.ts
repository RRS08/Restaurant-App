'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { getAuthContext, logAudit, formatError, resolveLocationId } from '@/lib/auth'
import { requireLocationAccess, AuthzError } from '@/lib/authz'
import { getInventoryActivation } from '@/lib/readiness'
import { convertQty } from '@/lib/units'
import {
  cancelOpenPaymentIntentsForOrder,
  verifyAndLinkTerminalIntent,
} from '@/app/actions/payments'
import { businessDateInTimezone } from '@/lib/sales/business-date'

// Graceful wrapper around requireLocationAccess so we can keep the
// existing { error: string } action-style returns without a broad
// error-handling rewrite across each action body.
async function requireLocResult(restaurantId: string, locationId: string): Promise<string | null> {
  try {
    await requireLocationAccess(restaurantId, locationId)
    return null
  } catch (err) {
    if (err instanceof AuthzError) return err.message
    throw err
  }
}

interface LineItem {
  menu_item_id: string
  quantity: number
}

type OrderSource = 'manual' | 'native_pos' | 'external_pos'
type PaymentType = 'cash' | 'card' | 'other'
type PaymentStatus = 'paid' | 'unpaid'
type OrderStatus = 'completed' | 'voided'

const VALID_SOURCES: OrderSource[] = ['manual', 'native_pos', 'external_pos']
const VALID_PAYMENT_TYPES: PaymentType[] = ['cash', 'card', 'other']
const VALID_PAYMENT_STATUSES: PaymentStatus[] = ['paid', 'unpaid']
const VALID_ORDER_STATUSES: OrderStatus[] = ['completed', 'voided']

function pickEnum<T extends string>(value: FormDataEntryValue | null, allowed: T[], fallback: T): T {
  const v = (value as string | null)?.trim() ?? ''
  return (allowed as string[]).includes(v) ? (v as T) : fallback
}

export async function createOrder(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Resolve location — managers are locked to their assigned location
  const { locationId, error: locError } = await resolveLocationId(ctx)
  if (locError) return { error: locError }
  const locAuthErr = await requireLocResult(ctx.restaurantId, locationId)
  if (locAuthErr) return { error: locAuthErr }

  // Parse line items
  const lineItemsRaw = formData.get('line_items') as string
  let lineItems: LineItem[]
  try {
    lineItems = JSON.parse(lineItemsRaw)
  } catch {
    return { error: 'Invalid order data.' }
  }

  // Verified-Stripe-Terminal gate.
  // When the POS card workflow drives this finalization, it includes
  // a `verified_payment_intent_id` pointing at a Stripe Terminal
  // payment that has already returned succeeded on the terminal.
  // We do NOT trust the client — `verifyAndLinkTerminalIntent`
  // round-trips Stripe to confirm `status === 'succeeded'` before
  // we let the order insert + inventory depletion proceed. If
  // verification fails, this action returns early and nothing
  // touches Sales or Inventory.
  const verifiedIntentId = (formData.get('verified_payment_intent_id') as string | null)?.trim() || null
  let verifiedIntentRow: { id: string; provider_intent_id: string | null } | null = null
  if (verifiedIntentId) {
    const verifyResult = await verifyAndLinkTerminalIntent(
      ctx.supabase,
      ctx.restaurantId,
      locationId,
      verifiedIntentId
    )
    if (!verifyResult.ok) return { error: verifyResult.error }
    verifiedIntentRow = verifyResult.intentRow
  }

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return { error: 'Please add at least one item to the order.' }
  }

  for (const item of lineItems) {
    if (!item.menu_item_id || !Number.isInteger(item.quantity) || item.quantity < 1) {
      return { error: 'Each item must have a valid quantity of 1 or more.' }
    }
  }

  // Fetch real prices + name/category snapshots from menu_items
  // (never trust browser prices). Name + category come back so each
  // order_items row can preserve them at sale time — historical
  // fidelity for future weekly reports even if the menu item is
  // later renamed or moved between categories.
  const menuItemIds = lineItems.map((li) => li.menu_item_id)
  const { data: menuItems, error: menuError } = await ctx.supabase
    .from('menu_items')
    .select('id, current_price, name, category_id')
    .in('id', menuItemIds)

  if (menuError || !menuItems) {
    return { error: formatError('price lookup', menuError) }
  }

  type MenuSnapshot = { price: number; name: string; categoryId: string | null }
  const menuSnap = new Map<string, MenuSnapshot>()
  for (const mi of menuItems) {
    menuSnap.set(mi.id, {
      price: Number(mi.current_price),
      name: mi.name,
      categoryId: (mi.category_id as string | null) ?? null,
    })
  }

  for (const li of lineItems) {
    if (!menuSnap.has(li.menu_item_id)) {
      return { error: 'One or more items no longer exist. Please refresh.' }
    }
  }

  // Calculate totals + capture per-line snapshots.
  const orderItemRows = lineItems.map((li) => {
    const snap = menuSnap.get(li.menu_item_id)!
    return {
      menu_item_id: li.menu_item_id,
      quantity: li.quantity,
      unit_price: snap.price,
      total_price: snap.price * li.quantity,
      menu_item_name_snapshot: snap.name,
      menu_category_id_snapshot: snap.categoryId,
    }
  })
  const totalAmount = orderItemRows.reduce((sum, row) => sum + row.total_price, 0)

  // Resolve the location's timezone so we can stamp business_date
  // at insert. Single-row lookup; cheap. Falls back to UTC inside
  // the helper if the location row has no timezone set.
  const { data: locationRow } = await ctx.supabase
    .from('locations')
    .select('timezone')
    .eq('id', locationId)
    .maybeSingle()
  const businessDate = businessDateInTimezone(new Date(), locationRow?.timezone ?? null)

  // POS-ready metadata. Manual flow omits these; defaults apply.
  // POS / external POS callers should supply their own values so
  // every order reflects where it came from and how it was paid.
  const source        = pickEnum<OrderSource>(formData.get('source'), VALID_SOURCES, 'manual')
  const paymentType   = pickEnum<PaymentType>(formData.get('payment_type'), VALID_PAYMENT_TYPES, 'cash')
  // Honest default: cash is born paid (money physically on hand),
  // but card / other (processor-backed) orders are born UNPAID and
  // only promote to 'paid' once a payment_intent reaches succeeded.
  // The persistIntentResult bridge below (payments.ts) owns that
  // promotion — never `createOrder`. Callers can still override
  // the default explicitly via the form field (e.g. a cash-equivalent
  // card flow imported from a reconciled batch).
  const defaultPaymentStatus: PaymentStatus = paymentType === 'cash' ? 'paid' : 'unpaid'
  const paymentStatus = pickEnum<PaymentStatus>(formData.get('payment_status'), VALID_PAYMENT_STATUSES, defaultPaymentStatus)
  const orderStatus   = pickEnum<OrderStatus>(formData.get('status'), VALID_ORDER_STATUSES, 'completed')
  const note = ((formData.get('note') as string | null) ?? '').trim() || null

  // Insert order
  // - business_date is the local-tz date at insert moment, used by
  //   future weekly summaries to bucket sales without doing per-row
  //   timezone math.
  // - voided_at is set here (not later in voidOrder) ONLY when the
  //   caller explicitly opens the order as voided (rare — usually
  //   creation produces 'completed'). See voidOrder for the normal
  //   correction path.
  const { data: order, error: orderError } = await ctx.supabase
    .from('orders')
    .insert({
      restaurant_id: ctx.restaurantId,
      location_id: locationId,
      total_amount: totalAmount,
      source,
      payment_type: paymentType,
      payment_status: paymentStatus,
      status: orderStatus,
      note,
      business_date: businessDate,
      voided_at: orderStatus === 'voided' ? new Date().toISOString() : null,
    })
    .select('id')
    .single()

  if (orderError || !order) {
    console.error('Order creation failed:', orderError)
    return { error: formatError('order', orderError) }
  }

  // Insert order_items
  const { error: itemsError } = await ctx.supabase
    .from('order_items')
    .insert(orderItemRows.map((row) => ({ order_id: order.id, ...row })))

  if (itemsError) {
    console.error('Order items insertion failed:', itemsError)
    return { error: formatError('order items', itemsError) }
  }

  // Link the verified Stripe Terminal intent to this newly-created
  // order. The verify step above marked the intent succeeded;
  // setting order_id closes the loop so future refreshes (or this
  // order's voidOrder) can find the intent by order_id.
  if (verifiedIntentRow) {
    await ctx.supabase
      .from('payment_intents')
      .update({ order_id: order.id, updated_at: new Date().toISOString() })
      .eq('id', verifiedIntentRow.id)
  }

  // Inventory activation gate: only deplete stock when inventory
  // has been explicitly activated via /settings. Until then the
  // order still lands in the Sales ledger, but inventory stays
  // untouched — honoring the "setup is not activation" rule.
  const { activatedAt: inventoryActivatedAt } = await getInventoryActivation(ctx.supabase, ctx.restaurantId)
  const inventoryActive = inventoryActivatedAt !== null

  // Automatic inventory depletion via recipes — skipped for voided
  // orders so they stay in the record without affecting stock.
  if (orderStatus === 'voided') {
    await logAudit(ctx, locationId, 'create_order', 'orders', order.id, { total_amount: totalAmount, status: orderStatus, source })
    revalidatePath('/sales')
    revalidatePath('/web/sales')
    const voidRedirect = (formData.get('redirect_to') as string | null)?.trim()
    redirect(voidRedirect && voidRedirect.startsWith('/') ? voidRedirect : '/sales')
  }

  // ----------------------------------------------------------------
  // Depletion bridge — observable.
  //
  // The previous implementation could silently skip depletion in
  // three different ways (inventory not activated, no recipe
  // components found, INSERT error logged but not surfaced) — none
  // of which left a trail on the order itself. The block below
  // tracks every outcome and folds it into the order's audit_logs
  // payload so "why didn't this sale deplete stock?" can be answered
  // by reading one row instead of grepping server logs.
  //
  // No workflow change: the sale still succeeds if depletion fails;
  // depletion is a side-effect, not a precondition.
  // ----------------------------------------------------------------
  type DepletionOutcome =
    | 'skipped_inventory_not_active'
    | 'no_recipe_components'
    | 'no_usage_rows'
    | 'wrote'
    | 'insert_failed'

  let depletionOutcome: DepletionOutcome = 'skipped_inventory_not_active'
  let depletionRowsAttempted = 0
  let depletionRecipeRowsFound = 0
  let depletionInsertError: string | null = null

  if (inventoryActive) {
    const { data: recipeComponents, error: recipeError } = await ctx.supabase
      .from('recipe_components')
      .select('menu_item_id, inventory_item_id, quantity_required, unit')
      .in('menu_item_id', menuItemIds)

    depletionRecipeRowsFound = recipeComponents?.length ?? 0

    if (recipeError) {
      console.error('[sales/createOrder] recipe_components lookup failed:', recipeError)
      depletionOutcome = 'insert_failed'
      depletionInsertError = recipeError.message
    } else if (!recipeComponents || recipeComponents.length === 0) {
      depletionOutcome = 'no_recipe_components'
    } else {
      // Fetch the unit_of_measure for every inventory item involved
      // so the conversion step below can translate a recipe measured
      // in oz/g/ml into the units the inventory row is tracked in.
      // Pre-migration recipe rows have unit = null → we treat the
      // recipe's quantity as already being in the inventory unit
      // (identity convert), preserving old behavior exactly.
      const invIds = [...new Set(recipeComponents.map((rc) => rc.inventory_item_id as string))]
      const { data: invRows } = await ctx.supabase
        .from('inventory_items')
        .select('id, unit_of_measure')
        .in('id', invIds)
      const invUnitById = new Map<string, string>()
      for (const r of invRows ?? []) {
        invUnitById.set(r.id as string, (r.unit_of_measure as string | null) ?? '')
      }

      const usageRows: {
        restaurant_id: string; location_id: string
        inventory_item_id: string; transaction_type: string
        quantity_change: number; reference_note: string
      }[] = []

      for (const oi of orderItemRows) {
        const comps = recipeComponents.filter((rc) => rc.menu_item_id === oi.menu_item_id)
        for (const comp of comps) {
          const required = Number(comp.quantity_required)
          // Defensive: a 0 or invalid quantity_required would insert a
          // no-op transaction. Skip rather than write noise — but flag
          // it in the diagnostic so a misconfigured recipe is visible.
          if (!Number.isFinite(required) || required <= 0) {
            console.warn('[sales/createOrder] skipping recipe component with non-positive quantity_required', {
              menu_item_id: comp.menu_item_id,
              inventory_item_id: comp.inventory_item_id,
              quantity_required: comp.quantity_required,
            })
            continue
          }
          // Convert recipe unit → inventory unit. Null recipe unit
          // = "same as inventory", so convertQty is identity in the
          // common backward-compat path.
          const invUnit = invUnitById.get(comp.inventory_item_id as string) ?? ''
          const recipeUnit = (comp.unit as string | null) ?? invUnit
          const converted = convertQty(required, recipeUnit, invUnit)
          if (converted === null) {
            // Unit mismatch that can't be converted (e.g. recipe in
            // oz vs inventory in `case`). Skip depletion for THIS
            // component only — the order still commits. Loud log so
            // the manager can fix the recipe.
            console.warn('[sales/createOrder] skipping recipe component with incompatible units', {
              menu_item_id: comp.menu_item_id,
              inventory_item_id: comp.inventory_item_id,
              recipe_unit: recipeUnit,
              inventory_unit: invUnit,
              quantity_required: required,
            })
            continue
          }
          usageRows.push({
            restaurant_id: ctx.restaurantId,
            location_id: locationId,
            inventory_item_id: comp.inventory_item_id,
            transaction_type: 'usage',
            quantity_change: -(converted * oi.quantity),
            reference_note: `Order ${order.id}`,
          })
        }
      }

      depletionRowsAttempted = usageRows.length

      if (usageRows.length === 0) {
        depletionOutcome = 'no_usage_rows'
      } else {
        const { error: usageError } = await ctx.supabase
          .from('inventory_transactions')
          .insert(usageRows)
        if (usageError) {
          console.error('[sales/createOrder] inventory_transactions insert failed:', usageError)
          depletionOutcome = 'insert_failed'
          depletionInsertError = usageError.message
        } else {
          depletionOutcome = 'wrote'
        }
      }
    }
  }

  // Server-console diagnostic — easy to grep for "[sales/createOrder]"
  // when investigating "why didn't X deplete stock?" cases.
  // `recipe_rows_found` is the count returned by the .in() lookup —
  // distinguishes "lookup query found nothing for these IDs" (mapping
  // issue) from "lookup found rows but somehow none turned into usage
  // rows" (defensive quantity guard hit).
  console.info('[sales/createOrder] depletion', {
    order_id: order.id,
    source,
    inventory_active: inventoryActive,
    menu_item_ids: menuItemIds,
    recipe_rows_found: depletionRecipeRowsFound,
    outcome: depletionOutcome,
    usage_rows_attempted: depletionRowsAttempted,
    rows_written: depletionOutcome === 'wrote' ? depletionRowsAttempted : 0,
    insert_error: depletionInsertError,
  })

  // Audit — depletion outcome rides on the order's audit row.
  await logAudit(ctx, locationId, 'create_order', 'orders', order.id, {
    total_amount: totalAmount, source, payment_type: paymentType, payment_status: paymentStatus, status: orderStatus,
    depletion_outcome: depletionOutcome,
    depletion_recipe_rows_found: depletionRecipeRowsFound,
    depletion_rows_written: depletionOutcome === 'wrote' ? depletionRowsAttempted : 0,
    depletion_insert_error: depletionInsertError,
  })

  revalidatePath('/sales')
  revalidatePath('/web/sales')
  revalidatePath('/inventory')
  revalidatePath('/web/inventory')
  // Menu and POS both read inventory stock + transactions to compute
  // projected availability (and POS auto-disables on stock-out). A
  // sale that writes a depletion transaction must invalidate those
  // surfaces too, otherwise the new state shows up everywhere except
  // where the manager actually looks for it.
  revalidatePath('/menu')
  revalidatePath('/web/menu')
  revalidatePath('/pos')
  // Callers (e.g. /pos) can supply their own return target so the
  // POS surface stays on /pos after a sale instead of jumping away.
  const redirectTarget = (formData.get('redirect_to') as string | null)?.trim()
  redirect(redirectTarget && redirectTarget.startsWith('/') ? redirectTarget : '/sales')
}

// ----------------------------------------------------------------
// voidOrder — the minimum clean correction workflow.
//
// What it does:
//   1. Flips orders.status → 'voided' (idempotent, no-op if already voided).
//   2. Reverses inventory usage by emitting compensating
//      `inventory_transactions` rows of type 'adjustment' with positive
//      quantity_change mirroring the original 'usage' deltas. The
//      reference_note links each reversal back to the source order.
//
// What it does NOT do:
//   • Delete or mutate historical `orders` / `order_items` rows
//     (auditability).
//   • Issue refunds or touch payment state.
//   • Edit line items.
//
// Why 'adjustment' instead of a new transaction type:
//   It's the existing type most aligned with "manual correction" and
//   needs zero schema change. The `reference_note` column carries the
//   semantic "Void reversal for order <id>" so reports can distinguish
//   reversals from generic adjustments.
// ----------------------------------------------------------------
export async function voidOrder(
  prevState: { error: string } | null,
  formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const orderId = (formData.get('order_id') as string | null)?.trim()
  if (!orderId) return { error: 'Missing order id.' }

  // Load the order (RLS already scopes by restaurant)
  const { data: order, error: orderError } = await ctx.supabase
    .from('orders')
    .select('id, location_id, status, source, total_amount, created_at, external_id')
    .eq('id', orderId)
    .single()

  if (orderError || !order) return { error: 'Order not found.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, order.location_id)
  if (locAuthErr) return { error: locAuthErr }
  if (order.status === 'voided') return null // idempotent — nothing to do

  // Cascade to sibling rows representing the same real-world
  // transaction. Both the web checkout (post-dedup-fix) and the
  // Poynt sync stamp the same Poynt txn id on orders.external_id;
  // when a dedup miss produces two rows for one payment, voiding
  // one should flip the other so a struck-through row doesn't
  // linger in another filter inflating totals for money that
  // already went back. Match on external_id only — payment_reference
  // lives on site_orders_link (not on orders), so we can't use it
  // here directly. Legacy web orders written before the dedup
  // commit have external_id=NULL and can't cascade; they need a
  // manual void.
  const cascadeToken = typeof order.external_id === 'string' && order.external_id.length > 0
    ? order.external_id
    : null
  let siblingIds: string[] = []
  if (cascadeToken) {
    const { data: siblings } = await ctx.supabase
      .from('orders')
      .select('id')
      .eq('restaurant_id', ctx.restaurantId)
      .eq('external_id', cascadeToken)
      .neq('id', order.id)
      .neq('status', 'voided')
    siblingIds = (siblings ?? []).map((s) => s.id as string)
  }

  // Reverse inventory ONLY if the original order actually depleted it.
  // That's true when inventory was active at the moment the order was
  // created. Orders created before activation have nothing to reverse.
  const { activatedAt: inventoryActivatedAt } = await getInventoryActivation(ctx.supabase, ctx.restaurantId)
  const orderDepletedInventory =
    inventoryActivatedAt !== null && new Date(order.created_at) >= inventoryActivatedAt

  // Compensating inventory adjustments for anything this order depleted.
  // We look up the line items + their recipe components, compute the
  // exact same deltas `createOrder` would have written as negative
  // `usage`, and write them as positive `adjustment` rows.
  const { data: orderItems } = orderDepletedInventory
    ? await ctx.supabase
        .from('order_items')
        .select('menu_item_id, quantity')
        .eq('order_id', order.id)
    : { data: null }

  if (orderDepletedInventory && orderItems && orderItems.length > 0) {
    const menuItemIds = [...new Set(orderItems.map((oi) => oi.menu_item_id))]
    const { data: recipeComponents } = await ctx.supabase
      .from('recipe_components')
      .select('menu_item_id, inventory_item_id, quantity_required, unit')
      .in('menu_item_id', menuItemIds)

    if (recipeComponents && recipeComponents.length > 0) {
      // Mirror createOrder's unit-aware depletion so the reversal
      // exactly cancels what was written. Components with
      // incompatible units were skipped on deplete → we must skip
      // them here too (otherwise a void would add stock we never
      // removed).
      const invIds = [...new Set(recipeComponents.map((rc) => rc.inventory_item_id as string))]
      const { data: invRows } = await ctx.supabase
        .from('inventory_items')
        .select('id, unit_of_measure')
        .in('id', invIds)
      const invUnitById = new Map<string, string>()
      for (const r of invRows ?? []) {
        invUnitById.set(r.id as string, (r.unit_of_measure as string | null) ?? '')
      }

      const reversalRows: {
        restaurant_id: string; location_id: string; inventory_item_id: string
        transaction_type: string; quantity_change: number; reference_note: string
      }[] = []

      for (const oi of orderItems) {
        for (const comp of recipeComponents.filter((rc) => rc.menu_item_id === oi.menu_item_id)) {
          const required = Number(comp.quantity_required)
          if (!Number.isFinite(required) || required <= 0) continue
          const invUnit = invUnitById.get(comp.inventory_item_id as string) ?? ''
          const recipeUnit = (comp.unit as string | null) ?? invUnit
          const converted = convertQty(required, recipeUnit, invUnit)
          if (converted === null) continue
          reversalRows.push({
            restaurant_id: ctx.restaurantId,
            location_id: order.location_id,
            inventory_item_id: comp.inventory_item_id,
            transaction_type: 'adjustment',
            quantity_change: converted * oi.quantity,
            reference_note: `Void reversal for order ${order.id}`,
          })
        }
      }

      if (reversalRows.length > 0) {
        const { error: reversalError } = await ctx.supabase
          .from('inventory_transactions')
          .insert(reversalRows)
        if (reversalError) {
          console.error('Void reversal failed:', reversalError)
          return { error: formatError('inventory reversal', reversalError) }
        }
      }
    }
  }

  // Cascade payment intents BEFORE flipping status. Open intents
  // are canceled via the canonical payments path so provider-side
  // state matches. Succeeded intents are left alone (refunds are
  // not in scope for this phase) but reported as `needsRefund` so
  // the caller can surface an honest warning. A provider-side
  // failure is a warning, not a blocker — the order should still
  // be voidable so operational truth isn't held hostage to a
  // provider outage.
  const intentsSummary = await cancelOpenPaymentIntentsForOrder(ctx.supabase, order.id)

  // Flip status last, so if the reversal fails we haven't voided yet.
  // voided_at is stamped alongside status so future weekly summaries
  // can answer "what changed this week" without a join to audit_log.
  // Cascade to any siblings resolved above so a dupe pair (e.g. web
  // + sync-imported for the same Poynt txn) flips together — reads
  // as one transaction, reconciles to one Poynt refund/void.
  const idsToVoid = [order.id, ...siblingIds]
  const { error: updateError } = await ctx.supabase
    .from('orders')
    .update({ status: 'voided', voided_at: new Date().toISOString() })
    .in('id', idsToVoid)

  if (updateError) {
    console.error('Order void failed:', updateError)
    return { error: formatError('void order', updateError) }
  }

  await logAudit(ctx, order.location_id, 'void_order', 'orders', order.id, {
    total_amount: Number(order.total_amount),
    source: order.source,
    intents_canceled: intentsSummary.canceled,
    intents_needs_refund: intentsSummary.needsRefund,
    intents_warnings: intentsSummary.warnings,
    cascaded_to: siblingIds,
  })
  // Separate audit rows for each cascaded sibling so a per-order
  // history query surfaces the void on both. Reason field records
  // WHY the void happened here (cascade from the sibling) instead
  // of a direct user click — future disputes can trace the intent.
  for (const sid of siblingIds) {
    await logAudit(ctx, order.location_id, 'void_order', 'orders', sid, {
      cascaded_from: order.id,
      reason: 'same payment_reference / external_id as the voided sibling',
    })
  }

  revalidatePath('/sales')
  revalidatePath('/web/sales')
  revalidatePath('/inventory')
  revalidatePath('/web/inventory')
  revalidatePath('/finance')
  revalidatePath('/web/finance')
  return null
}
