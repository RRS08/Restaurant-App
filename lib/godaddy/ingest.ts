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
import type { PoyntOrder } from './api'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@supabase/supabase-js'

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

/** Poynt monetary amounts arrive as major-unit numbers (dollars)
 *  OR as minor-unit integers (cents) depending on the endpoint
 *  and merchant currency. Heuristic: integers >= 1000 are treated
 *  as cents. Not perfect (a $999 order in cents lands as $99.9)
 *  but tolerable for v1 and easy to revisit once we see real
 *  merchant amounts. */
export function normalizeAmount(raw: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0
  if (Number.isInteger(n) && Math.abs(n) >= 1000) return +(n / 100).toFixed(2)
  return +n.toFixed(2)
}

export function normalizePoyntOrder(o: PoyntOrder, notes: string[]): NormalizedOrder | null {
  const externalId = (o.id ?? o.orderNumber ?? '').trim()
  if (!externalId) return null

  const postedAt = (o.createdAt ?? o.updatedAt ?? '').trim()
  if (!postedAt) return null

  const netTotal = o.amounts?.netTotal ?? o.amounts?.subTotal ?? 0
  const totalAmount = normalizeAmount(netTotal)

  const rawStatus = (o.statuses?.status ?? '').toUpperCase()
  let status: NormalizedOrder['status'] | undefined
  if (rawStatus.includes('VOID') || rawStatus.includes('CANCEL')) status = 'voided'
  else if (rawStatus === 'COMPLETED') status = 'completed'

  const lineItems = (o.items ?? [])
    .map((li) => {
      const externalItemId = (li.productId ?? li.id ?? '').trim()
      const qty = Number(li.quantity ?? 0)
      const unit = normalizeAmount(li.unitPrice ?? 0)
      if (!externalItemId || !Number.isFinite(qty) || qty <= 0) return null
      return {
        externalItemId,
        itemName: (li.name ?? '').trim() || `Imported item ${externalItemId}`,
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

  return {
    externalId,
    postedAt,
    totalAmount,
    status,
    paymentType: 'other',
    paymentStatus: status === 'voided' ? 'unpaid' : 'paid',
    lineItems,
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
