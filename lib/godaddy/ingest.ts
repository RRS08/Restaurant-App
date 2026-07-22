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
