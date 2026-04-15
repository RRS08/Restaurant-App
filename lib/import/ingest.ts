// ----------------------------------------------------------------
// Shared Ingest Pipeline — source-agnostic.
//
// Once any adapter has normalized its payload into the shapes in
// `./types.ts`, this file is the single place that writes it into
// the canonical menu_categories / menu_items / orders / order_items
// tables. The rest of the product is completely unaware of whether
// the data came from an API, a CSV upload, a custom JSON feed, or
// a mock fixture.
//
// Two entry points:
//   ingestMenu(args)   — idempotent upsert of imported categories
//                        + items. Never touches recipe_components.
//   ingestOrders(args) — idempotent upsert of imported orders +
//                        line items. Respects the inventory
//                        activation gate; imported sales never
//                        silently corrupt stock.
//
// Safety rules encoded here (apply to every source):
//   • External item with no category          → fallback bucket
//   • Order references an unknown item         → create placeholder
//   • Duplicate external_id (same location)    → upsert, not insert
//   • Imported menu item name/price change     → update in place,
//                                                preserve mapping
//   • Sales preserved even when mapping gaps   → always
//   • Inventory only depletes when activated   → enforced via
//                                                getInventoryActivation
//                                                + order.postedAt
//
// Note on the column name `external_provider`: for historical
// compatibility the DB column is still called `external_provider`,
// but it now stores a generic source id (`SourceId`) — anything
// the adapter registry knows about, not just branded POS providers.
// ----------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedMenu, NormalizedOrder } from './types'
import type { SourceId, SyncMeta } from './adapter'
import { getInventoryActivation } from '@/lib/readiness'

// Cap on how many per-row rejection notes we surface. Keeps result
// strings short while still making partial failure honest.
const MAX_INGEST_NOTES = 5

const UNCATEGORIZED_NAME = 'Imported · Uncategorized'
const UNCATEGORIZED_EXTERNAL_ID = '__uncategorized__'

// ================================================================
// ingestMenu
// ================================================================

export interface IngestMenuArgs {
  supabase: SupabaseClient
  restaurantId: string
  sourceId: SourceId
  menu: NormalizedMenu
}

export interface IngestMenuResult {
  categoriesUpserted: number
  itemsUpserted: number
  error: string | null
}

export async function ingestMenu({
  supabase,
  restaurantId,
  sourceId,
  menu,
}: IngestMenuArgs): Promise<IngestMenuResult> {
  // ---- Resolve / ensure the Uncategorized fallback bucket ----
  const { data: uncatRows } = await supabase
    .from('menu_categories')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('external_provider', sourceId)
    .eq('external_id', UNCATEGORIZED_EXTERNAL_ID)
    .limit(1)

  let uncategorizedId: string
  if (uncatRows && uncatRows.length > 0) {
    uncategorizedId = uncatRows[0].id
  } else {
    const { data: inserted, error: insertUncatErr } = await supabase
      .from('menu_categories')
      .insert({
        restaurant_id: restaurantId,
        name: UNCATEGORIZED_NAME,
        source: 'imported',
        external_provider: sourceId,
        external_id: UNCATEGORIZED_EXTERNAL_ID,
        sort_order: 9999,
      })
      .select('id')
      .single()
    if (insertUncatErr || !inserted) {
      return { categoriesUpserted: 0, itemsUpserted: 0, error: insertUncatErr?.message ?? 'fallback category' }
    }
    uncategorizedId = inserted.id
  }

  // ---- Upsert categories ----
  const categoryIdByExternalId = new Map<string, string>()
  let categoriesUpserted = 0

  for (const cat of menu.categories) {
    const { data: existing } = await supabase
      .from('menu_categories')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('external_provider', sourceId)
      .eq('external_id', cat.externalId)
      .limit(1)

    if (existing && existing.length > 0) {
      await supabase
        .from('menu_categories')
        .update({ name: cat.name, sort_order: cat.sortOrder ?? 0 })
        .eq('id', existing[0].id)
      categoryIdByExternalId.set(cat.externalId, existing[0].id)
    } else {
      const { data: inserted, error: catErr } = await supabase
        .from('menu_categories')
        .insert({
          restaurant_id: restaurantId,
          name: cat.name,
          sort_order: cat.sortOrder ?? 0,
          source: 'imported',
          external_provider: sourceId,
          external_id: cat.externalId,
        })
        .select('id')
        .single()
      if (!catErr && inserted) {
        categoryIdByExternalId.set(cat.externalId, inserted.id)
      }
    }
    categoriesUpserted++
  }

  // ---- Upsert items ----
  // IMPORTANT: we never wipe `recipe_components`. Updates only touch
  // name/price/category/active so manual mapping work is preserved.
  let itemsUpserted = 0

  for (const item of menu.items) {
    const categoryId = item.categoryExternalId
      ? (categoryIdByExternalId.get(item.categoryExternalId) ?? uncategorizedId)
      : uncategorizedId

    const { data: existing } = await supabase
      .from('menu_items')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('external_provider', sourceId)
      .eq('external_id', item.externalId)
      .limit(1)

    if (existing && existing.length > 0) {
      await supabase
        .from('menu_items')
        .update({
          name: item.name,
          current_price: item.price,
          category_id: categoryId,
          active: item.active,
        })
        .eq('id', existing[0].id)
    } else {
      await supabase
        .from('menu_items')
        .insert({
          restaurant_id: restaurantId,
          name: item.name,
          current_price: item.price,
          category_id: categoryId,
          active: item.active,
          source: 'imported',
          external_provider: sourceId,
          external_id: item.externalId,
        })
    }
    itemsUpserted++
  }

  return { categoriesUpserted, itemsUpserted, error: null }
}

// ================================================================
// ingestOrders
// ================================================================

export interface IngestOrdersArgs {
  supabase: SupabaseClient
  restaurantId: string
  locationId: string
  sourceId: SourceId
  orders: NormalizedOrder[]
  /** Optional SyncMeta bucket the ingest pipeline writes into for
   *  per-row rejection transparency. The calling action reads
   *  `recordsSkipped` and `notes` after the call and folds them
   *  into the sync result message. When omitted, rejection reasons
   *  are still collected into the returned `rejectionNotes` array,
   *  so newer callers that don't pass meta can still surface them. */
  meta?: SyncMeta
}

export interface IngestOrdersResult {
  ordersInserted: number
  ordersSkipped: number
  /** Rows that failed a DB write mid-batch. Distinct from
   *  `ordersSkipped` (dedupe skips, which are success cases). */
  ordersFailed: number
  placeholdersCreated: number
  inventoryDepletionsWritten: number
  /** Short human-readable rejection reasons — capped at
   *  MAX_INGEST_NOTES so the UI message stays bounded. */
  rejectionNotes: string[]
  error: string | null
}

export async function ingestOrders({
  supabase,
  restaurantId,
  locationId,
  sourceId,
  orders,
  meta,
}: IngestOrdersArgs): Promise<IngestOrdersResult> {
  const rejectionNotes: string[] = []
  const pushNote = (note: string) => {
    if (rejectionNotes.length < MAX_INGEST_NOTES) rejectionNotes.push(note)
  }

  if (orders.length === 0) {
    return {
      ordersInserted: 0,
      ordersSkipped: 0,
      ordersFailed: 0,
      placeholdersCreated: 0,
      inventoryDepletionsWritten: 0,
      rejectionNotes,
      error: null,
    }
  }

  // 1. Find the source's Uncategorized bucket for placeholder items.
  const { data: uncat } = await supabase
    .from('menu_categories')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('external_provider', sourceId)
    .eq('external_id', UNCATEGORIZED_EXTERNAL_ID)
    .maybeSingle()

  let uncategorizedId = uncat?.id ?? null
  if (!uncategorizedId) {
    const { data: insertedUncat } = await supabase
      .from('menu_categories')
      .insert({
        restaurant_id: restaurantId,
        name: UNCATEGORIZED_NAME,
        source: 'imported',
        external_provider: sourceId,
        external_id: UNCATEGORIZED_EXTERNAL_ID,
        sort_order: 9999,
      })
      .select('id')
      .single()
    uncategorizedId = insertedUncat?.id ?? null
  }

  // 2. Pre-resolve all external_item_ids → local menu_item.id in one query.
  const allExternalItemIds = [
    ...new Set(orders.flatMap((o) => o.lineItems.map((li) => li.externalItemId))),
  ]
  const { data: existingItems } = await supabase
    .from('menu_items')
    .select('id, external_id')
    .eq('restaurant_id', restaurantId)
    .eq('external_provider', sourceId)
    .in('external_id', allExternalItemIds)

  const itemIdByExternalId = new Map<string, string>()
  for (const row of existingItems ?? []) {
    if (row.external_id) itemIdByExternalId.set(row.external_id, row.id)
  }

  // 3. Create placeholder items for unknown externals so sales never fail.
  let placeholdersCreated = 0
  for (const order of orders) {
    for (const li of order.lineItems) {
      if (itemIdByExternalId.has(li.externalItemId)) continue
      const { data: placeholder, error: placeholderErr } = await supabase
        .from('menu_items')
        .insert({
          restaurant_id: restaurantId,
          name: li.itemName || `Imported item ${li.externalItemId}`,
          current_price: li.unitPrice,
          category_id: uncategorizedId,
          active: true,
          source: 'imported',
          external_provider: sourceId,
          external_id: li.externalItemId,
        })
        .select('id')
        .single()
      if (!placeholderErr && placeholder) {
        itemIdByExternalId.set(li.externalItemId, placeholder.id)
        placeholdersCreated++
      }
    }
  }

  // 4. Inventory activation state — read once for the whole batch.
  const { activatedAt: inventoryActivatedAt } = await getInventoryActivation(supabase, restaurantId)

  // 5. Dedupe existing orders by
  //    (restaurant_id, location_id, external_provider, external_id).
  //    Location_id is REQUIRED — sources re-use external order ids
  //    across stores, so skipping without location would drop valid
  //    sales from other locations.
  const externalIds = orders.map((o) => o.externalId)
  const { data: existingOrders } = await supabase
    .from('orders')
    .select('id, external_id')
    .eq('restaurant_id', restaurantId)
    .eq('location_id', locationId)
    .eq('external_provider', sourceId)
    .in('external_id', externalIds)

  const alreadyImported = new Set((existingOrders ?? []).map((o) => o.external_id))

  // 6. Insert each new order + its line items, conditionally deplete inventory.
  let ordersInserted = 0
  let ordersSkipped = 0
  let ordersFailed = 0
  let inventoryDepletionsWritten = 0

  for (const o of orders) {
    if (alreadyImported.has(o.externalId)) {
      ordersSkipped++
      continue
    }

    const status = o.status ?? 'completed'
    const paymentType = o.paymentType ?? 'other'
    // Honest passthrough: adapters that know the real paid state
    // forward it. Sources that genuinely can't tell leave it
    // undefined and we fall back to 'paid' — the overwhelming
    // default for closed-ticket exports. The ingest layer no
    // longer flattens unilaterally.
    const paymentStatus = o.paymentStatus ?? 'paid'

    const { data: orderRow, error: orderErr } = await supabase
      .from('orders')
      .insert({
        restaurant_id: restaurantId,
        location_id: locationId,
        total_amount: o.totalAmount,
        source: 'external_pos',
        external_provider: sourceId,
        external_id: o.externalId,
        payment_type: paymentType,
        payment_status: paymentStatus,
        status,
        created_at: o.postedAt,
      })
      .select('id')
      .single()

    if (orderErr || !orderRow) {
      console.error('[import-ingest] order insert failed', o.externalId, orderErr)
      ordersFailed++
      pushNote(`Order ${o.externalId}: ${orderErr?.message ?? 'insert failed'}`)
      continue
    }

    // Line items
    const skippedItems: string[] = []
    const lineRows = o.lineItems
      .map((li) => {
        const menuItemId = itemIdByExternalId.get(li.externalItemId)
        if (!menuItemId) {
          skippedItems.push(li.externalItemId)
          return null
        }
        return {
          order_id: orderRow.id,
          menu_item_id: menuItemId,
          quantity: Math.max(1, Math.round(li.quantity)),
          unit_price: li.unitPrice,
          total_price: li.totalPrice,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)

    if (skippedItems.length > 0) {
      pushNote(`Order ${o.externalId}: ${skippedItems.length} line item${skippedItems.length === 1 ? '' : 's'} unmapped`)
    }

    if (lineRows.length > 0) {
      const { error: liErr } = await supabase.from('order_items').insert(lineRows)
      if (liErr) {
        console.error('[import-ingest] line items insert failed', o.externalId, liErr)
        pushNote(`Order ${o.externalId}: line items — ${liErr.message}`)
      }
    }

    ordersInserted++

    // ---- Inventory bridge (gated by activation) ----
    if (
      status !== 'voided' &&
      inventoryActivatedAt !== null &&
      new Date(o.postedAt) >= inventoryActivatedAt
    ) {
      const menuItemIds = [...new Set(lineRows.map((l) => l.menu_item_id))]
      const { data: recipeComponents } = await supabase
        .from('recipe_components')
        .select('menu_item_id, inventory_item_id, quantity_required')
        .in('menu_item_id', menuItemIds)

      if (recipeComponents && recipeComponents.length > 0) {
        const usageRows: Array<{
          restaurant_id: string; location_id: string;
          inventory_item_id: string; transaction_type: string; quantity_change: number
        }> = []
        for (const li of lineRows) {
          for (const comp of recipeComponents.filter((rc) => rc.menu_item_id === li.menu_item_id)) {
            usageRows.push({
              restaurant_id: restaurantId,
              location_id: locationId,
              inventory_item_id: comp.inventory_item_id,
              transaction_type: 'usage',
              quantity_change: -(Number(comp.quantity_required) * li.quantity),
            })
          }
        }
        if (usageRows.length > 0) {
          const { error: txErr } = await supabase.from('inventory_transactions').insert(usageRows)
          if (!txErr) inventoryDepletionsWritten += usageRows.length
        }
      }
    }
  }

  // Fold rejection transparency into the optional SyncMeta bucket so
  // existing callers (pos-import.ts) can surface it in their result
  // message without a broad refactor. `recordsSkipped` here means
  // "rows we tried to import but failed" — NOT dedupe skips, which
  // are successful no-ops.
  if (meta) {
    meta.recordsSkipped = (meta.recordsSkipped ?? 0) + ordersFailed
    if (rejectionNotes.length > 0) {
      meta.notes = [...(meta.notes ?? []), ...rejectionNotes]
    }
  }

  return {
    ordersInserted,
    ordersSkipped,
    ordersFailed,
    placeholdersCreated,
    inventoryDepletionsWritten,
    rejectionNotes,
    error: null,
  }
}
