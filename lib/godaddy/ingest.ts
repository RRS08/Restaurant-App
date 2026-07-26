// ----------------------------------------------------------------
// GoDaddy Poynt — shared normalize/ingest helpers
//
// Two callers today:
//
//   • app/actions/godaddy-sync.ts — the "Sync now" button in
//     Settings. Manual pull, up to 200 recent orders.
//
//   • app/api/godaddy/webhooks/route.ts — Poynt-pushed events.
//     Per-order ingest triggered as sales close on the merchant's
//     terminal or storefront.
//
// Both paths converge on the same normalization + ingest here so
// the shape of a Poynt order in Checked is identical regardless of
// how it arrived. If we ever add polling reconciliation on top of
// webhooks, that third caller lands here too.
//
// Channel routing (spec §6): Poynt tags each order with
// `context.source`. Historic values include INSTORE / WEB /
// MOBILE / CALLIN. Anything web-flavored ingests as
// `godaddy_online`; everything else (including unknown values)
// falls into `godaddy_pos` so a storefront-less merchant still
// gets their sales — over-attributing to POS is safer than
// inventing an online channel that doesn't exist.
// ----------------------------------------------------------------

import { ingestOrders } from '@/lib/import/ingest'
import type { NormalizedOrder } from '@/lib/import/types'
import type { PoyntOrder, PoyntTransaction, PoyntProduct } from './api'
import { fetchSinglePoyntOrder } from './api'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@supabase/supabase-js'

// Canonical provider slug for the Poynt merchant catalog. Same
// slug is used by the ORDER ingest lookup so both POS-channel
// (INSTORE) and WEB-channel orders join to the same catalog
// row — one product row per SKU, regardless of which surface
// the sale came through.
const CATALOG_PROVIDER = 'godaddy_pos' as const

export interface IngestBatchResult {
  ordersInserted: number
  ordersSkipped: number
  ordersFailed: number
  placeholdersCreated: number
  inventoryDepletionsWritten: number
  channelBreakdown: { pos: number; online: number }
  notes: string[]
  error: string | null
}

const EMPTY_BATCH: IngestBatchResult = {
  ordersInserted: 0,
  ordersSkipped: 0,
  ordersFailed: 0,
  placeholdersCreated: 0,
  inventoryDepletionsWritten: 0,
  channelBreakdown: { pos: 0, online: 0 },
  notes: [],
  error: null,
}

const ONLINE_SOURCES = new Set(['WEB', 'MOBILE', 'ONLINE'])

/** Ingest a batch of raw Poynt orders under the given restaurant.
 *  Splits by channel, resolves the primary location, and hands
 *  each side to the shared ingestOrders pipeline. Callers pass
 *  their own supabase client so route handlers can reuse an
 *  already-instantiated admin client. */
export async function ingestPoyntOrders(args: {
  supabase: SupabaseClient
  restaurantId: string
  raw: PoyntOrder[]
}): Promise<IngestBatchResult> {
  const { supabase, restaurantId, raw } = args
  const result: IngestBatchResult = {
    ...EMPTY_BATCH,
    channelBreakdown: { pos: 0, online: 0 },
    notes: [],
  }

  if (raw.length === 0) return result

  const pos: NormalizedOrder[] = []
  const online: NormalizedOrder[] = []
  for (const o of raw) {
    const normalized = normalizePoyntOrder(o, result.notes)
    if (!normalized) continue
    const src = (o.context?.source ?? '').toUpperCase()
    if (ONLINE_SOURCES.has(src)) online.push(normalized)
    else pos.push(normalized)
  }
  result.channelBreakdown = { pos: pos.length, online: online.length }

  const { data: loc } = await supabase
    .from('locations')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!loc) return { ...result, error: 'No location found for this restaurant.' }
  const locationId = loc.id as string

  if (pos.length > 0) {
    const r = await ingestOrders({
      supabase, restaurantId, locationId,
      sourceId: 'godaddy_pos', orders: pos,
    })
    fold(result, r)
  }
  if (online.length > 0) {
    const r = await ingestOrders({
      supabase, restaurantId, locationId,
      sourceId: 'godaddy_online', orders: online,
    })
    fold(result, r)
  }
  return result
}

// ================================================================
// Product catalog ingest
// ================================================================
//
// Poynt is the source of truth for what a merchant sells. We
// upsert every product into menu_items keyed by (restaurant_id,
// external_provider='godaddy_pos', external_id=SKU). Existing
// placeholder rows created by the old order-ingest fallback get
// PROMOTED to real catalog rows on first sync — same external_id
// matches, upsert refreshes name/price/active.
//
// Owner-side flags we deliberately don't touch:
//   • hidden_from_menu — set by owner via bulk-delete. Catalog
//     sync leaves it alone so a delete decision stays sticky
//     across subsequent product syncs.
//   • category_id — owner assigns categories in Checked; Poynt's
//     category taxonomy is a phase-2 concern (their category
//     endpoint is separate from products). We only overwrite it
//     when it was previously null AND we discover a category on
//     the product — otherwise leave as-is.

export interface ProductIngestResult {
  productsUpserted: number
  productsSkipped: number
  notes: string[]
  error: string | null
}

export async function ingestPoyntProducts(args: {
  supabase: SupabaseClient
  restaurantId: string
  raw: PoyntProduct[]
}): Promise<ProductIngestResult> {
  const { supabase, restaurantId, raw } = args
  const result: ProductIngestResult = {
    productsUpserted: 0,
    productsSkipped: 0,
    notes: [],
    error: null,
  }
  if (raw.length === 0) return result

  // Build the upsert rows first. Skip anything without a usable
  // SKU (SKU is what links line items to menu rows).
  type UpsertRow = {
    restaurant_id: string
    name: string
    current_price: number
    active: boolean
    source: string
    external_provider: string
    external_id: string
  }
  const rows: UpsertRow[] = []
  const seenSku = new Set<string>()

  for (const p of raw) {
    const sku = safeIdStr(p.sku) || safeIdStr(p.id)
    if (!sku) {
      result.productsSkipped++
      continue
    }
    // Dedupe within-batch: two products with the same SKU (rare
    // but possible in test data) would collide on the upsert.
    // Take the first one; upsert semantics later can refresh.
    if (seenSku.has(sku)) continue
    seenSku.add(sku)

    const rawPrice = p.pricing?.price ?? p.pricing?.listPrice ?? p.price ?? p.unitPrice ?? p.amount ?? 0
    const price = normalizeAmount(Number(rawPrice))

    const name = (p.name ?? p.shortName ?? '').trim() || `Imported item ${sku}`
    const active = !p.status || p.status.toUpperCase() === 'ACTIVE'

    rows.push({
      restaurant_id: restaurantId,
      name,
      current_price: price > 0 ? price : 0,
      active,
      source: 'imported',
      external_provider: CATALOG_PROVIDER,
      external_id: sku,
    })
  }

  if (rows.length === 0) return result

  // Chunk the upsert — Poynt's docs allow 100 products per page
  // but a merchant with 400 products fits comfortably in one
  // batch. Cap at 500 per query to keep single-request payload
  // small and avoid API gateway limits.
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const { error } = await supabase
      .from('menu_items')
      .upsert(slice, {
        onConflict: 'restaurant_id,external_provider,external_id',
        // ignoreDuplicates=false so an existing row is UPDATED
        // (name/price/active refresh from Poynt), not skipped.
        // hidden_from_menu is intentionally NOT in the upsert
        // payload so the owner's hide decision survives.
        ignoreDuplicates: false,
      })
    if (error) {
      result.error = `Product upsert failed: ${error.message}`
      return result
    }
    result.productsUpserted += slice.length
  }

  return result
}

/** Ingest a batch of Poynt Transactions (terminal / MOTO / VT
 *  charges that don't necessarily create Order objects) under
 *  the given restaurant. Every non-void CAPTURED sale becomes a
 *  synthetic Order in Checked with one line item ("In-person
 *  sale") since Transactions don't carry line-item detail.
 *  Voids/refunds are marked as `voided` so downstream reporting
 *  can back them out.
 *
 *  All transactions ingest under `godaddy_pos` since terminal +
 *  MOTO are both in-person / operator-driven flows. */
export async function ingestPoyntTransactions(args: {
  supabase: SupabaseClient
  restaurantId: string
  raw: PoyntTransaction[]
}): Promise<IngestBatchResult> {
  const { supabase, restaurantId, raw } = args
  const result: IngestBatchResult = {
    ...EMPTY_BATCH,
    channelBreakdown: { pos: 0, online: 0 },
    notes: [],
  }
  if (raw.length === 0) return result

  const pos: NormalizedOrder[] = []
  for (const t of raw) {
    const normalized = normalizePoyntTransaction(t, result.notes)
    if (!normalized) continue
    pos.push(normalized)
  }
  result.channelBreakdown = { pos: pos.length, online: 0 }
  if (pos.length === 0) return result

  const { data: loc } = await supabase
    .from('locations')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!loc) return { ...result, error: 'No location found for this restaurant.' }

  const r = await ingestOrders({
    supabase, restaurantId, locationId: loc.id as string,
    sourceId: 'godaddy_pos', orders: pos,
  })
  fold(result, r)
  return result
}

/** Convenience wrapper for a single order — used by the webhook
 *  handler, which fetches one order at a time. Delegates to the
 *  batch path so all normalization + dedupe logic stays in one
 *  place. */
export async function ingestSinglePoyntOrder(args: {
  restaurantId: string
  order: PoyntOrder
}): Promise<IngestBatchResult> {
  const admin = createAdminClient()
  return await ingestPoyntOrders({
    supabase: admin,
    restaurantId: args.restaurantId,
    raw: [args.order],
  })
}

// ================================================================
// Enrich existing orders from linked transactions
// ================================================================
//
// The /orders LIST endpoint often does not embed transactions[]
// on each order — the payment leg (funding source, card brand,
// last 4) lives on the /transactions endpoint. We already fetch
// both in the same sync, so cross-reference: for every captured
// transaction that carries an orderId, patch the matching order
// row with the card details.
//
// This only writes when the existing row is missing a value
// (payment_type = 'other', card_brand null, card_last4 null) so
// re-runs are cheap no-ops and we never overwrite a value the
// order-leg already captured from an embedded transaction.

export async function enrichOrdersFromTransactions(args: {
  supabase: SupabaseClient
  restaurantId: string
  transactions: PoyntTransaction[]
}): Promise<{ enriched: number; notes: string[] }> {
  const { supabase, restaurantId, transactions } = args
  const notes: string[] = []
  let enriched = 0

  // Diagnostic counters — every drop-off point along the pipeline
  // logs so we can tell the difference between "Poynt didn't
  // return the field", "the transaction wasn't captured", and
  // "no matching order in DB." Surface a summary line so the
  // sync toast shows the shape of the data.
  let txTotal = 0
  let txWithLink = 0
  let txCaptured = 0
  let txCardable = 0
  let dbMatched = 0
  const unmatchedSample: string[] = []

  // Build a map: Poynt orderId → best-available payment metadata.
  // Prefer CAPTURED sale transactions (skip voids/refunds — those
  // shouldn't rewrite the paid-order's card details).
  interface Patch { payment_type?: 'card' | 'cash'; card_brand?: string; card_last4?: string }
  const patchByPoyntOrderId = new Map<string, Patch>()
  for (const t of transactions) {
    txTotal++
    // Match ANY reference type that mentions "ORDER" (POYNT_ORDER,
    // ORDER, EXTERNAL_ORDER, etc.) OR the customType field. Also
    // accept a top-level `parentId` when we can't find anything
    // else — some Poynt transactions link to the order via parentId
    // instead of orderId.
    const linkedOrderId =
      safeIdStr(t.orderId)
      || safeIdStr((t.references ?? []).find((r) => {
        const type = ((r.type ?? '') + ' ' + (r.customType ?? '')).toUpperCase()
        return type.includes('ORDER')
      })?.id)
      || safeIdStr((t.references ?? []).find((r) => !!r.id)?.id)
    if (!linkedOrderId) continue
    txWithLink++
    const status = (t.status ?? '').toUpperCase()
    if (status !== 'CAPTURED') continue
    txCaptured++

    const patch: Patch = {}
    const fundingType = (t.fundingSource?.type ?? '').toUpperCase()
    if (fundingType.includes('CASH')) patch.payment_type = 'cash'
    else if (fundingType.includes('CREDIT') || fundingType.includes('DEBIT') || fundingType.includes('CARD')) {
      patch.payment_type = 'card'
      const brand = (t.fundingSource?.card?.type ?? '').trim().toUpperCase()
      if (brand) patch.card_brand = brand
      const last4 = (t.fundingSource?.card?.numberLast4 ?? '').trim()
      if (last4) patch.card_last4 = last4
    }
    if (Object.keys(patch).length === 0) continue
    if (patch.payment_type === 'card') txCardable++
    // First capture wins — a subsequent refund shouldn't clobber
    // the sale's card. (Refunds are already status-filtered out
    // above but the guard is cheap.)
    if (!patchByPoyntOrderId.has(linkedOrderId)) {
      patchByPoyntOrderId.set(linkedOrderId, patch)
    }
  }

  console.info('[godaddy/enrich] tx pipeline', {
    txTotal, txWithLink, txCaptured, txCardable,
    distinctLinkedOrders: patchByPoyntOrderId.size,
  })

  if (patchByPoyntOrderId.size === 0) {
    notes.push(`Enrich: 0 transactions carried a linked orderId (of ${txTotal} fetched).`)
    return { enriched, notes }
  }

  // Resolve Poynt orderIds → local order row ids in one query.
  const poyntIds = [...patchByPoyntOrderId.keys()]
  const { data: rows } = await supabase
    .from('orders')
    .select('id, external_id, payment_type, card_brand, card_last4')
    .eq('restaurant_id', restaurantId)
    .in('external_provider', ['godaddy_pos', 'godaddy_online'])
    .in('external_id', poyntIds)

  const matchedIds = new Set((rows ?? []).map((r) => r.external_id as string))
  for (const id of poyntIds) {
    if (!matchedIds.has(id) && unmatchedSample.length < 3) unmatchedSample.push(id)
  }
  dbMatched = matchedIds.size

  for (const row of rows ?? []) {
    const patch = patchByPoyntOrderId.get(row.external_id as string)
    if (!patch) continue
    // Only fill fields that are currently missing so we don't
    // overwrite anything the /orders leg already captured from an
    // embedded transaction.
    const update: Record<string, unknown> = {}
    if ((row.payment_type ?? 'other') === 'other' && patch.payment_type) {
      update.payment_type = patch.payment_type
    }
    if (!row.card_brand && patch.card_brand) update.card_brand = patch.card_brand
    if (!row.card_last4 && patch.card_last4) update.card_last4 = patch.card_last4
    if (Object.keys(update).length === 0) continue
    const { error } = await supabase.from('orders').update(update).eq('id', row.id)
    if (error) {
      notes.push(`Enrich ${row.external_id}: ${error.message}`)
      continue
    }
    enriched++
  }

  console.info('[godaddy/enrich] db pass', {
    linkedOrderIds: poyntIds.length,
    dbMatched,
    enriched,
    unmatchedSample,
  })
  notes.push(
    `Enrich: ${txTotal} tx → ${txWithLink} linked → ${txCaptured} captured → ${patchByPoyntOrderId.size} distinct orders → ${dbMatched} matched in DB → ${enriched} updated.`
  )

  return { enriched, notes }
}

// ================================================================
// Reconcile missing orders from linked transactions
// ================================================================
//
// Poynt's /orders LIST endpoint has an intermittent read-side lag
// — sometimes an order closes on the terminal and doesn't show up
// via /orders for minutes to hours. Meanwhile the payment
// transaction for that order IS queryable via /transactions right
// away (with a `orderId` reference). Since normalizePoyntTransaction
// deliberately skips linked transactions (to avoid duplicating
// what /orders should provide), those sales would be lost until
// /orders finally catches up.
//
// This pass closes the gap: for each transaction with an orderId
// whose linked order isn't in our DB, fetch the order individually
// via GET /orders/{id} (which is authoritative and immediate,
// unlike the LIST endpoint) and ingest it through the normal
// pipeline. Capped per invocation to stay inside Vercel's function
// timeout; the backlog drains over successive cron ticks.

export async function reconcileOrdersFromTransactions(args: {
  supabase: SupabaseClient
  restaurantId: string
  transactions: PoyntTransaction[]
  /** Max GET /orders/{id} calls this invocation. Each is one
   *  Poynt API request + one ingest write. */
  cap?: number
}): Promise<{ reconciled: number; considered: number; notes: string[] }> {
  const { supabase, restaurantId, transactions } = args
  // Default matches the caller in godaddy-sync.ts (was 20 by mistake,
  // out of sync with the comment on the caller side that said 50).
  const cap = args.cap ?? 50
  const notes: string[] = []

  // Extract distinct Poynt orderIds referenced by CAPTURED
  // transactions in the batch. Skip voids/refunds (they'd point
  // at an already-ingested order or nothing meaningful).
  //
  // ID-quality filter: /orders/{id} only accepts Poynt's UUID
  // form. Some transactions carry the merchant's own custom
  // order id in `t.orderId` (e.g. `Order_Fv…`) — Poynt returns
  // 400 INVALID_PARAMETER for those. Prefer an explicit
  // POYNT_ORDER reference (guaranteed UUID) and only fall back
  // to `t.orderId` when it's UUID-shaped. Non-UUID IDs are
  // dropped so we don't burn API slots on 100%-fail fetches.
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const isUuid = (s: string) => UUID_RE.test(s)

  const referencedOrderIds = new Set<string>()
  let skippedNonUuid = 0
  for (const t of transactions) {
    const status = (t.status ?? '').toUpperCase()
    if (status !== 'CAPTURED') continue

    // First-choice: an explicit POYNT_ORDER reference in references[].
    // These are always the Poynt-side UUID.
    const poyntOrderRef = (t.references ?? []).find((r) => {
      const type = (r.type ?? '').toUpperCase()
      return type === 'POYNT_ORDER'
    })
    let linked = safeIdStr(poyntOrderRef?.id)

    // Fallback: top-level orderId, but only if UUID-shaped.
    if (!linked) {
      const candidate = safeIdStr(t.orderId)
      if (candidate) {
        if (isUuid(candidate)) linked = candidate
        else skippedNonUuid++
      }
    }
    // Last resort: any references[] entry with an ORDER-ish type.
    if (!linked) {
      const orderIsh = (t.references ?? []).find((r) => {
        const type = ((r.type ?? '') + ' ' + (r.customType ?? '')).toUpperCase()
        return type.includes('ORDER')
      })
      const candidate = safeIdStr(orderIsh?.id)
      if (candidate && isUuid(candidate)) linked = candidate
    }

    if (linked && isUuid(linked)) referencedOrderIds.add(linked)
  }

  if (referencedOrderIds.size === 0) {
    if (skippedNonUuid > 0) {
      notes.push(`Reconcile: skipped ${skippedNonUuid} tx with non-UUID orderIds (Poynt would 400).`)
    }
    return { reconciled: 0, considered: 0, notes }
  }

  // Which of those are missing from our DB? One IN query resolves
  // it in a single roundtrip regardless of the transaction count.
  const referencedList = [...referencedOrderIds]
  const { data: existing } = await supabase
    .from('orders')
    .select('external_id')
    .eq('restaurant_id', restaurantId)
    .in('external_provider', ['godaddy_pos', 'godaddy_online'])
    .in('external_id', referencedList)

  const haveIds = new Set((existing ?? []).map((r) => r.external_id as string))
  const missing = referencedList.filter((id) => !haveIds.has(id))
  if (missing.length === 0) return { reconciled: 0, considered: 0, notes }

  // Fetch and ingest up to `cap` missing orders. Newest-first
  // isn't easy without a per-transaction createdAt lookup, so we
  // just take the first N in Set-iteration order. Since the
  // /transactions leg already fetches 3 days of transactions
  // sorted by Poynt's default ordering, this tends to hit newer
  // orders first anyway.
  const toFetch = missing.slice(0, cap)
  let reconciled = 0
  let fetchFailed = 0
  let ingestFailed = 0
  const errorSamples: string[] = []
  const seenErrors = new Set<string>()

  for (const orderId of toFetch) {
    const res = await fetchSinglePoyntOrder({ restaurantId, orderId })
    if ('error' in res) {
      fetchFailed++
      // Dedupe error samples by first line so 50 identical 400s
      // collapse to one bullet with a count instead of spamming
      // the notes list.
      const key = res.error.slice(0, 40)
      if (!seenErrors.has(key) && errorSamples.length < 3) {
        seenErrors.add(key)
        errorSamples.push(`${orderId.slice(0, 8)}: ${res.error.slice(0, 80)}`)
      }
      continue
    }
    // Ingest through the shared batch path — it handles
    // normalization + dedupe + line items + inventory + audit.
    const ing = await ingestPoyntOrders({
      supabase, restaurantId, raw: [res.order],
    })
    if (ing.ordersInserted > 0) {
      reconciled++
    } else if (ing.error) {
      ingestFailed++
      const key = ing.error.slice(0, 40)
      if (!seenErrors.has(key) && errorSamples.length < 3) {
        seenErrors.add(key)
        errorSamples.push(`${orderId.slice(0, 8)}: ${ing.error}`)
      }
    }
  }

  if (skippedNonUuid > 0) {
    notes.push(`Reconcile: skipped ${skippedNonUuid} tx with non-UUID orderIds.`)
  }
  if (fetchFailed > 0) {
    notes.push(`Reconcile: ${fetchFailed}/${toFetch.length} fetches failed (Poynt API errors).`)
  }
  if (ingestFailed > 0) {
    notes.push(`Reconcile: ${ingestFailed} orders fetched OK but ingest rejected.`)
  }
  notes.push(...errorSamples)
  console.info('[godaddy/reconcile] pass', {
    referencedInBatch: referencedOrderIds.size,
    missingFromDb: missing.length,
    fetched: toFetch.length,
    reconciled,
  })
  notes.push(
    `Reconcile: ${referencedOrderIds.size} tx-linked orders → ${missing.length} missing → ${toFetch.length} fetched → ${reconciled} newly ingested.`,
  )
  return { reconciled, considered: toFetch.length, notes }
}

// ================================================================
// Per-order backfill via GET /orders/{id}
// ================================================================
//
// The /orders LIST endpoint does not reliably embed transactions[]
// on each row, and the /transactions LIST endpoint often ships
// without the orderId reference either — so the cheap cross-
// reference path above only enriches a fraction of historical
// orders. GET /orders/{id} does embed transactions[] reliably,
// but it's one API call per order, so we cap at a per-invocation
// budget and let the sync click self-heal the backlog over a few
// repeats.
//
// Runs after /orders, /transactions, and enrichOrdersFromTransactions
// — so anything cheap has already been applied and this pass only
// hits orders that STILL don't have the receipt-shape fields.

export async function backfillOrdersFromApi(args: {
  supabase: SupabaseClient
  restaurantId: string
  /** Max orders to fetch individually in this invocation. Each
   *  call is one Poynt API request; a busy merchant with 400+
   *  historical orders will need multiple Sync-now clicks (or
   *  a few cron ticks) to drain the backlog. */
  cap?: number
}): Promise<{ backfilled: number; considered: number; notes: string[] }> {
  const { supabase, restaurantId } = args
  const cap = args.cap ?? 50
  const notes: string[] = []

  // Candidates: any Poynt-sourced, non-voided order where the
  // receipt-shape enrichment is still missing. Prefer the newest
  // first — that's what a manager is most likely to open next.
  const { data: candidates } = await supabase
    .from('orders')
    .select('id, external_id, external_provider')
    .eq('restaurant_id', restaurantId)
    .in('external_provider', ['godaddy_pos', 'godaddy_online'])
    .neq('status', 'voided')
    .or('payment_type.eq.other,card_brand.is.null,subtotal.is.null')
    .order('created_at', { ascending: false })
    .limit(cap)

  const rows = candidates ?? []
  if (rows.length === 0) return { backfilled: 0, considered: 0, notes }

  let backfilled = 0
  const noteBuf: string[] = []

  for (const row of rows) {
    const externalId = row.external_id as string
    if (!externalId) continue

    const res = await fetchSinglePoyntOrder({ restaurantId, orderId: externalId })
    if ('error' in res) {
      // Rate limit / 404 / auth blip — record a note (capped) and
      // keep going. A 404 for a specific order usually means it
      // was deleted upstream; the row can stay as-is.
      if (noteBuf.length < 3) noteBuf.push(`${externalId.slice(0, 8)}: ${res.error.slice(0, 80)}`)
      continue
    }

    const normalized = normalizePoyntOrder(res.order, noteBuf)
    if (!normalized) continue

    // Only patch the enrichment fields — never touch total, status,
    // or line items on a backfill. Payment_type is refreshed only
    // when the normalized value is more specific than 'other'.
    const patch: Record<string, unknown> = {}
    if (normalized.paymentType && normalized.paymentType !== 'other') patch.payment_type = normalized.paymentType
    if (normalized.subtotal !== undefined)      patch.subtotal = normalized.subtotal
    if (normalized.discountTotal !== undefined) patch.discount_total = normalized.discountTotal
    if (normalized.taxTotal !== undefined)      patch.tax_total = normalized.taxTotal
    if (normalized.cardBrand)                   patch.card_brand = normalized.cardBrand
    if (normalized.cardLast4)                   patch.card_last4 = normalized.cardLast4
    if (normalized.customerName)                patch.customer_name = normalized.customerName
    if (normalized.channelSource)               patch.channel_source = normalized.channelSource

    if (Object.keys(patch).length === 0) continue
    const { error: updErr } = await supabase.from('orders').update(patch).eq('id', row.id)
    if (updErr) {
      if (noteBuf.length < 3) noteBuf.push(`${externalId.slice(0, 8)}: ${updErr.message.slice(0, 80)}`)
      continue
    }

    // Also fill any missing variant labels on this order's line
    // items. Match by menu_item_id resolved from the SKU.
    for (const li of normalized.lineItems) {
      if (!li.variantLabel) continue
      const { data: menuItem } = await supabase
        .from('menu_items')
        .select('id')
        .eq('restaurant_id', restaurantId)
        .in('external_provider', ['godaddy_pos', 'godaddy_online'])
        .eq('external_id', li.externalItemId)
        .maybeSingle()
      if (!menuItem?.id) continue
      await supabase.from('order_items').update({ variant_label: li.variantLabel })
        .eq('order_id', row.id)
        .eq('menu_item_id', menuItem.id)
        .is('variant_label', null)
    }

    backfilled++
  }

  if (noteBuf.length > 0) notes.push(...noteBuf)
  console.info('[godaddy/backfill] pass', {
    considered: rows.length,
    backfilled,
    remaining: '(re-run Sync now to drain)',
  })
  notes.push(`Backfill: ${rows.length} candidates → ${backfilled} enriched via GET /orders/{id}.`)

  return { backfilled, considered: rows.length, notes }
}

// ================================================================
// Normalization
// ================================================================

/** Poynt's Cloud API returns every monetary amount as an integer
 *  in minor units (cents for USD). My first pass used a "if it
 *  looks big, divide by 100" heuristic that was wrong — real
 *  merchant data has a lot of orders below $10 (400 cents = $4)
 *  that stayed unscaled and rendered as $400. Rule now:
 *
 *    integer   → treat as cents, divide by 100
 *    non-int   → treat as already-dollars (defensive; shouldn't
 *                happen on the Cloud API but a stray decimal from
 *                some payload variant shouldn't be double-scaled)
 *
 *  Applied uniformly to netTotal / subTotal / unitPrice / anything
 *  else the normalizer touches. */
export function normalizeAmount(raw: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0
  if (Number.isInteger(n)) return +(n / 100).toFixed(2)
  return +n.toFixed(2)
}

/** Coerce any Poynt id-like value to a trimmed string, safely.
 *  Poynt returns numeric ids in several places (line item `id`,
 *  employee ids, transaction ids…) and my first pass assumed
 *  strings, crashing on `.trim()`. */
function safeIdStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  return ''
}

export function normalizePoyntOrder(o: PoyntOrder, notes: string[]): NormalizedOrder | null {
  try {
    const externalId = safeIdStr(o.id) || safeIdStr(o.orderNumber)
    if (!externalId) return null

    const postedAt = (o.createdAt ?? o.updatedAt ?? '').trim()
    if (!postedAt) return null

    const netTotal = o.amounts?.netTotal ?? o.amounts?.subTotal ?? 0
    const totalAmount = normalizeAmount(netTotal)

    // Receipt-shaped breakdown. undefined (not 0) when Poynt
    // didn't send the field — 0 has a real meaning ("no tax
    // charged") that we don't want to conflate with absence.
    const subtotal = o.amounts?.subTotal !== undefined
      ? normalizeAmount(o.amounts.subTotal) : undefined
    const discountTotal = o.amounts?.discountTotal !== undefined
      ? normalizeAmount(o.amounts.discountTotal) : undefined
    const taxTotal = o.amounts?.taxTotal !== undefined
      ? normalizeAmount(o.amounts.taxTotal) : undefined

    const rawStatus = (o.statuses?.status ?? '').toUpperCase()
    let status: NormalizedOrder['status'] | undefined
    if (rawStatus.includes('VOID') || rawStatus.includes('CANCEL')) status = 'voided'
    else if (rawStatus === 'COMPLETED') status = 'completed'

    const lineItems = (o.items ?? [])
      .map((li) => {
        // Preference order for the external item id:
        //   1. sku    — stable product identifier across orders,
        //               used for menu-item resolution downstream.
        //   2. externalId — Poynt's own line-item id (LineItem_...).
        //   3. productId  — present on POS orders.
        //   4. numeric id — a per-order index. Not ideal (won't
        //               dedupe across orders) but keeps the sale
        //               from being lost.
        const externalItemId =
          safeIdStr(li.sku) ||
          safeIdStr(li.externalId) ||
          safeIdStr(li.productId) ||
          safeIdStr(li.id)
        const qty = Number(li.quantity ?? 0)
        const unit = normalizeAmount(li.unitPrice ?? 0)
        if (!externalItemId || !Number.isFinite(qty) || qty <= 0) return null
        // Base product name stays clean; the variant / modifier
        // lifts into its own field so the drawer can render it
        // on a subline (matching Poynt's transaction detail).
        const itemName = (li.name ?? '').trim() || `Imported item ${externalItemId}`
        const variantLabel = (li.selectedVariants ?? [])
          .map((v) => (v.value ?? v.name ?? '').trim())
          .filter(Boolean)
          .join(' · ')
        return {
          externalItemId,
          itemName,
          variantLabel: variantLabel.length > 0 ? variantLabel : undefined,
          quantity: qty,
          unitPrice: unit,
          totalPrice: +(unit * qty).toFixed(2),
        }
      })
      .filter(Boolean) as NormalizedOrder['lineItems']

    if (lineItems.length === 0) {
      notes.push(`Order ${externalId} had no resolvable line items — skipped.`)
      return null
    }

    // Payment leg — lift card details off the first captured
    // transaction, when one is embedded on the order. Voids /
    // refunds get skipped so we prefer a real capture; falling
    // back to the first transaction is fine when nothing captured
    // (rare on a completed order — but it beats null).
    const txs = o.transactions ?? []
    const capturedTx =
      txs.find((t) => (t.status ?? '').toUpperCase() === 'CAPTURED')
      ?? txs[0]
    let paymentType: NormalizedOrder['paymentType'] = 'other'
    let cardBrand: string | undefined
    let cardLast4: string | undefined
    if (capturedTx) {
      const fundingType = (capturedTx.fundingSource?.type ?? '').toUpperCase()
      if (fundingType.includes('CASH')) paymentType = 'cash'
      else if (fundingType.includes('CREDIT') || fundingType.includes('DEBIT') || fundingType.includes('CARD')) {
        paymentType = 'card'
        const brand = (capturedTx.fundingSource?.card?.type ?? '').trim().toUpperCase()
        if (brand) cardBrand = brand
        const last4 = (capturedTx.fundingSource?.card?.numberLast4 ?? '').trim()
        if (last4) cardLast4 = last4
      }
    }

    // Customer + channel. Both optional — leave undefined when
    // Poynt didn't send them.
    const firstName = (o.customer?.firstName ?? '').trim()
    const lastName = (o.customer?.lastName ?? '').trim()
    const combinedName = [firstName, lastName].filter(Boolean).join(' ')
    const customerName = combinedName.length > 0 ? combinedName : undefined
    const rawChannel = (o.context?.source ?? '').trim()
    const channelSource = rawChannel.length > 0 ? rawChannel.toUpperCase() : undefined

    return {
      externalId,
      postedAt,
      totalAmount,
      status,
      paymentType,
      paymentStatus: status === 'voided' ? 'unpaid' : 'paid',
      subtotal,
      discountTotal,
      taxTotal,
      cardBrand,
      cardLast4,
      customerName,
      channelSource,
      lineItems,
    }
  } catch (err) {
    // Defensive: one weird order shouldn't crash the whole sync.
    // Log the id so we can inspect the offender if it recurs.
    const idHint = safeIdStr(o.id) || safeIdStr(o.orderNumber) || '<unknown>'
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[godaddy/ingest] normalize threw — order skipped', { orderId: idHint, err: msg })
    notes.push(`Order ${idHint} failed to normalize (${msg}) — skipped.`)
    return null
  }
}

/** Normalize a Poynt Transaction into our order shape. Terminal
 *  transactions don't have line items, so we synthesize one with
 *  a generic name + the transaction amount. Refunds / voids are
 *  marked as `voided` so reporting can subtract them cleanly.
 *
 *  Only CAPTURED sales count as real revenue. AUTHORIZED without
 *  a matching capture would double-count against a downstream
 *  capture event, so we skip AUTHORIZED and only ingest terminal
 *  charges once they've settled. */
export function normalizePoyntTransaction(t: PoyntTransaction, notes: string[]): NormalizedOrder | null {
  try {
    const externalId = safeIdStr(t.id)
    if (!externalId) return null
    const postedAt = (t.createdAt ?? t.updatedAt ?? '').trim()
    if (!postedAt) return null

    // Skip transactions that link back to a Poynt Order — the
    // /orders sync ingests those with real line-item detail
    // (product names, per-item unit prices, quantities). If we
    // also created a "synthetic order" from the transaction leg,
    // the ledger would show TWO rows for the same sale: one with
    // real items and one titled "In-person sale." Only orphan
    // transactions (Virtual Terminal, MOTO, standalone card
    // charges without an associated order object) should ingest
    // via this path.
    if (safeIdStr(t.orderId)) return null
    const refsOrder = (t.references ?? []).find((r) => {
      const type = ((r.type ?? '') + ' ' + (r.customType ?? '')).toUpperCase()
      return type.includes('ORDER')
    })
    if (refsOrder && safeIdStr(refsOrder.id)) return null

    const rawStatus = (t.status ?? '').toUpperCase()
    const rawAction = (t.action ?? '').toUpperCase()

    // Refunds & voids are still worth ingesting so the ledger
    // reflects them; they mark as voided so reporting subtracts.
    // Anything that isn't CAPTURED (and isn't a refund/void) is
    // skipped — an AUTHORIZED transaction gets counted when it
    // captures.
    let status: NormalizedOrder['status'] | undefined
    const isVoid = rawStatus.includes('VOID') || rawStatus.includes('CANCEL')
    const isRefund = rawStatus.includes('REFUND') || rawAction === 'REFUND'
    if (isVoid || isRefund) {
      status = 'voided'
    } else if (rawStatus === 'CAPTURED') {
      status = 'completed'
    } else {
      // Skip: authorized-not-yet-captured, pending, unknown.
      return null
    }

    const rawAmount =
      t.amounts?.orderAmount
      ?? t.amounts?.transactionAmount
      ?? 0
    const totalAmount = normalizeAmount(rawAmount)
    if (totalAmount <= 0) {
      notes.push(`Transaction ${externalId} has non-positive amount — skipped.`)
      return null
    }

    // Payment type inference from the funding source.
    const fundingType = (t.fundingSource?.type ?? '').toUpperCase()
    let paymentType: NormalizedOrder['paymentType'] = 'other'
    if (fundingType.includes('CASH')) paymentType = 'cash'
    else if (fundingType.includes('CREDIT') || fundingType.includes('DEBIT') || fundingType.includes('CARD')) paymentType = 'card'

    // Synthesize one line item so the sale isn't lost. Use the
    // transaction id as the external_item_id so re-syncs don't
    // duplicate the synthetic item as a "new" placeholder every
    // time. Downstream: the placeholder-item creation path will
    // make a menu_item on first sight and reuse it on next.
    return {
      externalId,
      postedAt,
      totalAmount,
      status,
      paymentType,
      paymentStatus: status === 'voided' ? 'unpaid' : 'paid',
      lineItems: [{
        externalItemId: `terminal-charge`,
        itemName: 'In-person sale',
        quantity: 1,
        unitPrice: totalAmount,
        totalPrice: totalAmount,
      }],
    }
  } catch (err) {
    const idHint = safeIdStr(t.id) || '<unknown>'
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[godaddy/ingest] normalize transaction threw', { txId: idHint, err: msg })
    notes.push(`Transaction ${idHint} failed to normalize (${msg}) — skipped.`)
    return null
  }
}

function fold(target: IngestBatchResult, r: {
  ordersInserted: number
  ordersSkipped: number
  ordersFailed: number
  placeholdersCreated: number
  inventoryDepletionsWritten: number
  rejectionNotes: string[]
  error: string | null
}) {
  target.ordersInserted += r.ordersInserted
  target.ordersSkipped += r.ordersSkipped
  target.ordersFailed += r.ordersFailed
  target.placeholdersCreated += r.placeholdersCreated
  target.inventoryDepletionsWritten += r.inventoryDepletionsWritten
  target.notes.push(...r.rejectionNotes)
  if (r.error && !target.error) target.error = r.error
}
