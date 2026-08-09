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
//   • External item with no category          → category_id = null
//                                                (surfaces in the
//                                                "Awaiting a section"
//                                                band on /menu)
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
import { businessDateInTimezone } from '@/lib/sales/business-date'
import { convertQty } from '@/lib/units'

// Cap on how many per-row rejection notes we surface. Keeps result
// strings short while still making partial failure honest.
const MAX_INGEST_NOTES = 5

// Marker used by older ingest revisions to identify the auto-created
// "Imported · Uncategorized" bucket. We no longer create that
// category — items without an upstream category get `category_id =
// null` and surface in the menu page's "Awaiting a section" band
// instead. This constant stays around solely as the query key for
// the cleanup pass at the top of ingestMenu / ingestOrders, which
// deletes any stale bucket rows the old code path left behind. The
// `on delete set null` FK on menu_items.category_id nulls affected
// items automatically, so they land in the awaiting band without
// any manager action required.
const UNCATEGORIZED_EXTERNAL_ID = '__uncategorized__'

// One-time cleanup shared by both ingest entry points. Idempotent
// and cheap — the lookup is indexed and usually returns 0 rows.
async function cleanupLegacyUncategorizedBucket(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<void> {
  await supabase
    .from('menu_categories')
    .delete()
    .eq('restaurant_id', restaurantId)
    .eq('external_id', UNCATEGORIZED_EXTERNAL_ID)
}

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
  // Cleanup: earlier ingest revisions auto-created an "Imported ·
  // Uncategorized" category for items with no upstream category.
  // We no longer do that — those items now get `category_id = null`
  // and surface in the "Awaiting a section" band on /menu. Zap any
  // stale bucket rows so managers don't keep seeing them as a chip.
  // FK is `on delete set null`, so items reparent to null cleanly.
  await cleanupLegacyUncategorizedBucket(supabase, restaurantId)

  // ---- Upsert categories ----
  //
  // Three-step lookup so newly-imported items naturally home into
  // the manager's existing categories when the names line up:
  //
  //   1. ID match — `(external_provider, external_id)` already
  //      links this Square category to a local category from a
  //      previous sync. Refresh metadata and move on.
  //
  //   2. Name match — no ID link yet, but a local category with
  //      the same name exists and isn't claimed by another source.
  //      "Adopt" it by backfilling external_provider + external_id
  //      so future syncs follow the fast ID path. The local name
  //      stays untouched (manager's preference wins on display).
  //
  //   3. Create — no match anywhere. Insert a new Square-named
  //      category tagged `source = 'imported'` so the menu mapping
  //      drawer (Phase B) can spot it as "needs assignment".
  //
  // Name matching is case-insensitive and trimmed. Categories
  // already bound to a different external_provider are ineligible
  // for adoption to keep multi-source restaurants safe.
  //
  // Sort order: newly-created categories from path #3 land *below*
  // the manager's existing categories on the menu page, so an
  // import never visually pushes their existing layout down. We
  // query the current max sort_order once, then hand out the next
  // available values to each create-path category in import order.
  // Adopted categories keep the manager's sort_order untouched.
  const { data: maxSortRow } = await supabase
    .from('menu_categories')
    .select('sort_order')
    .eq('restaurant_id', restaurantId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  const baseSort = Number(maxSortRow?.sort_order ?? 0)
  let nextImportedSort = baseSort + 1000

  const categoryIdByExternalId = new Map<string, string>()
  let categoriesUpserted = 0

  for (const cat of menu.categories) {
    // 1. ID match
    const { data: idMatch } = await supabase
      .from('menu_categories')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('external_provider', sourceId)
      .eq('external_id', cat.externalId)
      .limit(1)

    if (idMatch && idMatch.length > 0) {
      // Re-sync: refresh the name only. The local sort_order is
      // preserved — the manager (or a prior adopt) owns where the
      // category appears in the menu, and we don't want subsequent
      // syncs reshuffling that order.
      await supabase
        .from('menu_categories')
        .update({ name: cat.name })
        .eq('id', idMatch[0].id)
      categoryIdByExternalId.set(cat.externalId, idMatch[0].id)
      categoriesUpserted++
      continue
    }

    // 2. Name match (case-insensitive trimmed)
    const trimmedName = cat.name.trim()
    const { data: nameMatches } = await supabase
      .from('menu_categories')
      .select('id, name, external_provider')
      .eq('restaurant_id', restaurantId)
      .is('external_provider', null)
      .ilike('name', trimmedName)

    const adoptable = (nameMatches ?? []).find(
      (m) => (m.name as string).trim().toLowerCase() === trimmedName.toLowerCase(),
    )

    if (adoptable) {
      // Adopt: bind this local category to Square without touching
      // the display name or sort order. Source stays whatever the
      // manager had (e.g., 'manual') so we can still tell user-
      // owned categories from auto-created ones downstream.
      await supabase
        .from('menu_categories')
        .update({
          external_provider: sourceId,
          external_id: cat.externalId,
        })
        .eq('id', adoptable.id)
      categoryIdByExternalId.set(cat.externalId, adoptable.id as string)
      categoriesUpserted++
      continue
    }

    // 3. Create — no local match. Sort_order is pushed past the
    // manager's existing categories so the new auto-imported
    // category lands at the bottom of the menu, not interleaved
    // with the layout they already had.
    const { data: inserted, error: catErr } = await supabase
      .from('menu_categories')
      .insert({
        restaurant_id: restaurantId,
        name: cat.name,
        sort_order: nextImportedSort,
        source: 'imported',
        external_provider: sourceId,
        external_id: cat.externalId,
      })
      .select('id')
      .single()
    nextImportedSort += 10
    if (!catErr && inserted) {
      categoryIdByExternalId.set(cat.externalId, inserted.id)
    }
    categoriesUpserted++
  }

  // ---- Upsert items ----
  // IMPORTANT: we never wipe `recipe_components`. Updates only touch
  // name/price/category so manual mapping work is preserved. The
  // `active` column is owned by the local app once a row exists —
  // see the rationale below.
  let itemsUpserted = 0

  for (const item of menu.items) {
    // No upstream category, or upstream category didn't survive the
    // upsert pass → null, which surfaces the item in the "Awaiting a
    // section" band on /menu for the manager to assign.
    const categoryId: string | null = item.categoryExternalId
      ? (categoryIdByExternalId.get(item.categoryExternalId) ?? null)
      : null

    const { data: existing } = await supabase
      .from('menu_items')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('external_provider', sourceId)
      .eq('external_id', item.externalId)
      .limit(1)

    if (existing && existing.length > 0) {
      // Re-sync: refresh provider-owned fields only. The `active`
      // column is intentionally NOT touched here — once a manager
      // has activated an imported item locally (via the menu
      // mapping drawer), an upstream Square change shouldn't yank
      // it back to inactive. Source truth lives upstream for
      // identity (name/price/category), local truth lives here for
      // operational state (active / recipe).
      await supabase
        .from('menu_items')
        .update({
          name: item.name,
          current_price: item.price,
          category_id: categoryId,
        })
        .eq('id', existing[0].id)
    } else {
      // First-time insert: explicitly inactive. New imports go into
      // a "pending review" bucket where the manager must categorize
      // + recipe + activate before the item starts taking sales or
      // depleting inventory. This is what gates the menu-mapping
      // drawer's workflow and what keeps imports from silently
      // landing on the live menu.
      await supabase
        .from('menu_items')
        .insert({
          restaurant_id: restaurantId,
          name: item.name,
          current_price: item.price,
          category_id: categoryId,
          active: false,
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

  // 1. Cleanup: earlier ingest revisions auto-created an "Imported ·
  //    Uncategorized" bucket for placeholder items. Placeholders now
  //    land with category_id = null and surface in the "Awaiting a
  //    section" band on /menu. FK is `on delete set null`, so any
  //    stale items reparent to null cleanly.
  await cleanupLegacyUncategorizedBucket(supabase, restaurantId)

  // 2. Pre-resolve all external_item_ids → local menu_item snapshot
  //    in one query. Returning name + category_id lets each line item
  //    persist a per-row snapshot (menu_item_name_snapshot,
  //    menu_category_id_snapshot) for future historical-fidelity
  //    reports — same foundation columns the native createOrder path
  //    populates.
  //
  //    Provider-scope note: the Poynt integration syncs the merchant's
  //    product catalog under external_provider='godaddy_pos'. Both
  //    channels (godaddy_pos AND godaddy_online orders) share that
  //    catalog — a merchant sells the same SKUs whether the sale
  //    happens at the terminal or the website. So for a godaddy_online
  //    order, we look up menu_items under BOTH slugs and prefer any
  //    hit. Non-godaddy sources (square, clover, csv) keep the old
  //    single-slug behavior.
  const lookupProviders: string[] =
    sourceId === 'godaddy_online' || sourceId === 'godaddy_pos'
      ? ['godaddy_pos', 'godaddy_online']
      : [sourceId]
  const allExternalItemIds = [
    ...new Set(orders.flatMap((o) => o.lineItems.map((li) => li.externalItemId))),
  ]
  const { data: existingItems } = await supabase
    .from('menu_items')
    .select('id, external_id, name, category_id, external_provider')
    .eq('restaurant_id', restaurantId)
    .in('external_provider', lookupProviders)
    .in('external_id', allExternalItemIds)

  type MenuSnapshot = { id: string; name: string; categoryId: string | null; provider: string }
  const itemSnapByExternalId = new Map<string, MenuSnapshot>()
  for (const row of existingItems ?? []) {
    const extId = row.external_id as string | null
    if (!extId) continue
    // If multiple providers have the same external_id (unlikely
    // but possible after a re-org), prefer the CATALOG provider
    // (godaddy_pos) over the channel-specific one.
    const existing = itemSnapByExternalId.get(extId)
    if (existing && existing.provider === 'godaddy_pos') continue
    itemSnapByExternalId.set(extId, {
      id: row.id as string,
      name: (row.name as string | null) ?? '',
      categoryId: (row.category_id as string | null) ?? null,
      provider: (row.external_provider as string) ?? sourceId,
    })
  }

  // 3. Create placeholder items for unknown externals so sales
  //    never fail. This is a fallback path — Poynt sources should
  //    have populated menu_items via the catalog sync above, so
  //    placeholders should be rare. When they are needed, insert
  //    under the CATALOG provider (godaddy_pos) so the next
  //    channel-flipped sync (INSTORE vs WEB) also finds the row
  //    and doesn't double-create. Non-godaddy sources keep their
  //    own provider slug.
  const placeholderProvider: string =
    (sourceId === 'godaddy_online' || sourceId === 'godaddy_pos') ? 'godaddy_pos' : sourceId
  let placeholdersCreated = 0
  for (const order of orders) {
    for (const li of order.lineItems) {
      if (itemSnapByExternalId.has(li.externalItemId)) continue
      const placeholderName = li.itemName || `Imported item ${li.externalItemId}`
      const { data: placeholder, error: placeholderErr } = await supabase
        .from('menu_items')
        .insert({
          restaurant_id: restaurantId,
          name: placeholderName,
          current_price: li.unitPrice,
          category_id: null,
          active: true,
          source: 'imported',
          external_provider: placeholderProvider,
          external_id: li.externalItemId,
        })
        .select('id')
        .single()
      if (!placeholderErr && placeholder) {
        itemSnapByExternalId.set(li.externalItemId, {
          id: placeholder.id as string,
          name: placeholderName,
          categoryId: null,
          provider: placeholderProvider,
        })
        placeholdersCreated++
      }
    }
  }

  // 4. Inventory activation state — read once for the whole batch.
  const { activatedAt: inventoryActivatedAt } = await getInventoryActivation(supabase, restaurantId)

  // 4b. Resolve the location's timezone once so every imported order
  //     can carry a correct business_date (date in restaurant-local
  //     time at the moment the order was POSTED, not at import time).
  const { data: locationRow } = await supabase
    .from('locations')
    .select('timezone')
    .eq('id', locationId)
    .maybeSingle()
  const locationTimezone = (locationRow?.timezone as string | null) ?? null

  // 5. Dedupe existing orders. Two lookup passes so we catch both
  //    - orders we already imported via THIS adapter (order-id key)
  //    - orders our web checkout wrote directly (transaction-id key,
  //      because /cards/tokenize/charge returns a transaction id, not
  //      an order id — different id spaces, same real-world sale).
  //    Location_id + external_provider narrow the pass (sources re-use
  //    external order ids across stores; skipping location would drop
  //    valid sales from other locations).
  const externalIds = orders.map((o) => o.externalId)
  // Flatten every incoming order's transactions[].id into one list
  // for the sibling lookup below. Deduped so a repeated txn id in
  // the payload only queries once.
  const incomingTxnIds = Array.from(
    new Set(
      orders.flatMap((o) => o.transactionIds ?? [])
    )
  )

  const { data: existingOrders } = await supabase
    .from('orders')
    .select('id, external_id')
    .eq('restaurant_id', restaurantId)
    .eq('location_id', locationId)
    .eq('external_provider', sourceId)
    .in('external_id', externalIds)

  const existingIdByExternal = new Map<string, string>()
  for (const row of existingOrders ?? []) {
    existingIdByExternal.set(row.external_id as string, row.id as string)
  }

  // Second lookup: orders whose external_id is one of the incoming
  // orders' transaction ids. Scoped to the same restaurant+location+
  // provider so a truly-different order that happens to share a UUID
  // (astronomically unlikely, but) doesn't bleed across.
  const existingIdByTxn = new Map<string, string>()
  if (incomingTxnIds.length > 0) {
    const { data: txnMatches } = await supabase
      .from('orders')
      .select('id, external_id')
      .eq('restaurant_id', restaurantId)
      .eq('location_id', locationId)
      .eq('external_provider', sourceId)
      .in('external_id', incomingTxnIds)
    for (const row of txnMatches ?? []) {
      existingIdByTxn.set(row.external_id as string, row.id as string)
    }
  }

  // 6. Insert each new order + its line items, conditionally deplete inventory.
  let ordersInserted = 0
  let ordersSkipped = 0
  let ordersFailed = 0
  let inventoryDepletionsWritten = 0

  for (const o of orders) {
    // Prefer the direct order-id hit; fall back to the transaction-id
    // sibling lookup so a web-checkout row already in the DB (which
    // uses a Poynt transaction id for external_id) is treated as
    // existing and gets backfilled instead of duplicated.
    let existingOrderId = existingIdByExternal.get(o.externalId)
    if (!existingOrderId && o.transactionIds) {
      for (const tid of o.transactionIds) {
        const hit = existingIdByTxn.get(tid)
        if (hit) { existingOrderId = hit; break }
      }
    }
    // Final fallback: fuzzy sibling match against web-checkout rows.
    // Some Poynt account types don't expose a matching transaction
    // id in the /orders response, so id-based dedup misses even
    // though it's the same real sale. Match by (same location, same
    // total_amount, source='web', created_at within ±10 min of this
    // Poynt order's postedAt). Scoped tight enough that a second
    // coincidental $5.41 web sale within 20 minutes at the same
    // store is the only failure mode — vanishingly rare at pilot
    // volumes, and even then the false-positive is a missed insert,
    // not corrupted data (the existing row is still correct).
    if (!existingOrderId) {
      const postedMs = new Date(o.postedAt).getTime()
      if (Number.isFinite(postedMs)) {
        const lo = new Date(postedMs - 10 * 60 * 1000).toISOString()
        const hi = new Date(postedMs + 10 * 60 * 1000).toISOString()
        const { data: fuzzy } = await supabase
          .from('orders')
          .select('id')
          .eq('restaurant_id', restaurantId)
          .eq('location_id', locationId)
          .eq('source', 'web')
          .eq('total_amount', o.totalAmount)
          .gte('created_at', lo)
          .lte('created_at', hi)
          .limit(1)
        if (fuzzy && fuzzy.length > 0) {
          existingOrderId = fuzzy[0].id as string
        }
      }
    }
    if (existingOrderId) {
      // Backfill pass: an order we've already imported still gets
      // its enriched fields refreshed on re-sync so historical
      // rows synced before those columns existed pick up subtotal
      // / discount / tax / card / customer / channel the next time
      // "Sync now" fires. We deliberately do NOT touch total_amount,
      // line items, or business_date — those are locked at first
      // import so reporting stays stable. Payment_type does get
      // refreshed because early syncs stored 'other' for every card
      // sale (transactions weren't inspected yet).
      //
      // Status propagates ONE-WAY: completed → voided when the
      // incoming order is voided upstream (merchant voided/refunded
      // on Poynt's side). Never voided → completed — Checked-side
      // voids are terminal by design; if the merchant un-refunds
      // on Poynt afterwards, that's a manual reconciliation task,
      // not something we auto-flip back. Requires looking up the
      // existing row's current status since the map only carried
      // the id.
      const refreshedType = o.paymentType ?? undefined
      const patch: Record<string, unknown> = {}
      if (refreshedType && refreshedType !== 'other') patch.payment_type = refreshedType
      if (o.subtotal !== undefined)      patch.subtotal = o.subtotal
      if (o.discountTotal !== undefined) patch.discount_total = o.discountTotal
      if (o.taxTotal !== undefined)      patch.tax_total = o.taxTotal
      if (o.cardBrand)                   patch.card_brand = o.cardBrand
      if (o.cardLast4)                   patch.card_last4 = o.cardLast4
      if (o.customerName)                patch.customer_name = o.customerName
      if (o.channelSource)               patch.channel_source = o.channelSource
      if (o.status === 'voided') {
        const { data: existingRow } = await supabase
          .from('orders')
          .select('status')
          .eq('id', existingOrderId)
          .maybeSingle()
        if (existingRow && existingRow.status !== 'voided') {
          patch.status = 'voided'
          patch.voided_at = o.postedAt
        }
      }
      if (Object.keys(patch).length > 0) {
        await supabase.from('orders').update(patch).eq('id', existingOrderId)
      }
      // Backfill variant labels on existing line items. Match by
      // menu_item_id (resolved from li.externalItemId via the
      // snapshot map built earlier). Multiple physical rows can
      // share the same menu_item_id inside one order (rare — e.g.
      // two separate rings of the same SKU); we set the same
      // variant on all of them since the variant is a property
      // of the SKU, not of the ring.
      for (const li of o.lineItems) {
        if (!li.variantLabel) continue
        const snap = itemSnapByExternalId.get(li.externalItemId)
        if (!snap) continue
        await supabase.from('order_items').update({ variant_label: li.variantLabel })
          .eq('order_id', existingOrderId)
          .eq('menu_item_id', snap.id)
          .is('variant_label', null)
      }
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

    // business_date / voided_at are part of the reporting foundation
    // (see schema.sql notes). business_date is the local-tz date at
    // POSTED time so cross-day imports bucket correctly. voided_at
    // is set only for orders that arrive already in the voided state
    // — adapters that emit voided rows preserve "when it happened"
    // for free; later in-app voids set it via voidOrder.
    const businessDate = businessDateInTimezone(o.postedAt, locationTimezone)
    const voidedAt = status === 'voided' ? o.postedAt : null

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
        business_date: businessDate,
        voided_at: voidedAt,
        // Receipt-shaped enrichment — undefined fields insert as
        // NULL so we don't fabricate zeros. Column set added in
        // migration 2026-07-22-orders-enriched-fields.sql.
        subtotal: o.subtotal ?? null,
        discount_total: o.discountTotal ?? null,
        tax_total: o.taxTotal ?? null,
        card_brand: o.cardBrand ?? null,
        card_last4: o.cardLast4 ?? null,
        customer_name: o.customerName ?? null,
        channel_source: o.channelSource ?? null,
      })
      .select('id')
      .single()

    if (orderErr || !orderRow) {
      console.error('[import-ingest] order insert failed', o.externalId, orderErr)
      ordersFailed++
      pushNote(`Order ${o.externalId}: ${orderErr?.message ?? 'insert failed'}`)
      continue
    }

    // Line items.
    // Each row carries the menu item's name + category at sale time
    // so future weekly summaries can preserve historical fidelity if
    // the menu is later renamed or items are moved between sections.
    // Falls back to the adapter-supplied li.itemName when the local
    // record's name is empty (rare, mostly for fresh placeholders).
    const skippedItems: string[] = []
    const lineRows = o.lineItems
      .map((li) => {
        const snap = itemSnapByExternalId.get(li.externalItemId)
        if (!snap) {
          skippedItems.push(li.externalItemId)
          return null
        }
        return {
          order_id: orderRow.id,
          menu_item_id: snap.id,
          quantity: Math.max(1, Math.round(li.quantity)),
          unit_price: li.unitPrice,
          total_price: li.totalPrice,
          menu_item_name_snapshot: snap.name || li.itemName || null,
          menu_category_id_snapshot: snap.categoryId,
          variant_label: li.variantLabel ?? null,
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
    // Mirrors app/actions/sales.ts createOrder depletion, unit-aware.
    // A component whose recipe unit can't convert to the inventory
    // unit is silently skipped so the import never fails a whole
    // order over one bad recipe row — the missed depletion is
    // observable via inventoryDepletionsWritten dropping below the
    // component count.
    if (
      status !== 'voided' &&
      inventoryActivatedAt !== null &&
      new Date(o.postedAt) >= inventoryActivatedAt
    ) {
      const menuItemIds = [...new Set(lineRows.map((l) => l.menu_item_id))]
      const { data: recipeComponents } = await supabase
        .from('recipe_components')
        .select('menu_item_id, inventory_item_id, quantity_required, unit')
        .in('menu_item_id', menuItemIds)

      if (recipeComponents && recipeComponents.length > 0) {
        const invIds = [...new Set(recipeComponents.map((rc) => rc.inventory_item_id as string))]
        const { data: invRows } = await supabase
          .from('inventory_items')
          .select('id, unit_of_measure')
          .in('id', invIds)
        const invUnitById = new Map<string, string>()
        for (const r of invRows ?? []) {
          invUnitById.set(r.id as string, (r.unit_of_measure as string | null) ?? '')
        }

        const usageRows: Array<{
          restaurant_id: string; location_id: string;
          inventory_item_id: string; transaction_type: string; quantity_change: number
        }> = []
        for (const li of lineRows) {
          for (const comp of recipeComponents.filter((rc) => rc.menu_item_id === li.menu_item_id)) {
            const required = Number(comp.quantity_required)
            if (!Number.isFinite(required) || required <= 0) continue
            const invUnit = invUnitById.get(comp.inventory_item_id as string) ?? ''
            const recipeUnit = (comp.unit as string | null) ?? invUnit
            const converted = convertQty(required, recipeUnit, invUnit)
            if (converted === null) {
              console.warn('[import-ingest] skipping component with incompatible units', {
                menu_item_id: comp.menu_item_id,
                inventory_item_id: comp.inventory_item_id,
                recipe_unit: recipeUnit,
                inventory_unit: invUnit,
                quantity_required: required,
              })
              continue
            }
            usageRows.push({
              restaurant_id: restaurantId,
              location_id: locationId,
              inventory_item_id: comp.inventory_item_id,
              transaction_type: 'usage',
              quantity_change: -(converted * li.quantity),
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
