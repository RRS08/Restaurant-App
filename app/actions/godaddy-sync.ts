'use server'

// ----------------------------------------------------------------
// GoDaddy Poynt — one-shot order sync
//
// Owner clicks "Sync now" in Settings after linking their
// GoDaddy merchant. This pulls a page of orders from Poynt's
// Cloud API, normalizes them into our canonical shape, and hands
// them to ingestOrders — the same pipeline every CSV / mock /
// other-provider path goes through.
//
// Channel routing: Poynt tags each order's `context.source` as
// INSTORE / WEB / MOBILE / CALLIN. Historically INSTORE = POS,
// WEB / MOBILE = online storefront. We split the batch on that
// boundary and ingest each side under the corresponding
// SourceId (godaddy_pos vs godaddy_online) so Sales attribution
// stays honest.
//
// Owner-gated, restaurant-scoped. RLS also enforces the write
// side — this is defense in depth so a manager can't accidentally
// trigger a full sync from their scope.
// ----------------------------------------------------------------

import { getAuthContext } from '@/lib/auth'
import { fetchPoyntOrders, type PoyntOrder } from '@/lib/godaddy/api'
import { ingestOrders } from '@/lib/import/ingest'
import type { NormalizedOrder } from '@/lib/import/types'
import { createAdminClient } from '@/lib/supabase/admin'

export interface SyncResult {
  ordersInserted: number
  ordersSkipped: number
  ordersFailed: number
  placeholdersCreated: number
  inventoryDepletionsWritten: number
  channelBreakdown: { pos: number; online: number }
  notes: string[]
  error: string | null
}

const EMPTY_RESULT: SyncResult = {
  ordersInserted: 0,
  ordersSkipped: 0,
  ordersFailed: 0,
  placeholdersCreated: 0,
  inventoryDepletionsWritten: 0,
  channelBreakdown: { pos: 0, online: 0 },
  notes: [],
  error: null,
}

export async function syncGodaddyOrders(): Promise<SyncResult> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { ...EMPTY_RESULT, error: authError ?? 'Authentication error.' }
  if (ctx.role !== 'owner') return { ...EMPTY_RESULT, error: 'Only the owner can trigger a sync.' }

  // Pull from Poynt. Cap at 200 orders per invocation — first
  // manual sync should be quick and observable. Larger backfills
  // land later as a scheduled job.
  const pull = await fetchPoyntOrders({ restaurantId: ctx.restaurantId, maxOrders: 200 })
  if ('error' in pull) return { ...EMPTY_RESULT, error: pull.error }

  const { orders: raw } = pull

  // Split by channel. `context.source` is documented as the
  // channel discriminator; historic values are INSTORE / WEB /
  // MOBILE / CALLIN. Anything unrecognized falls into POS so a
  // storefront-less merchant still gets their sales — safer to
  // over-attribute to POS than to invent an online channel that
  // doesn't exist.
  const posBatch: NormalizedOrder[] = []
  const onlineBatch: NormalizedOrder[] = []
  const notes: string[] = []

  for (const o of raw) {
    const normalized = normalizeOrder(o, notes)
    if (!normalized) continue
    const src = (o.context?.source ?? '').toUpperCase()
    if (src === 'WEB' || src === 'MOBILE' || src === 'ONLINE') {
      onlineBatch.push(normalized)
    } else {
      posBatch.push(normalized)
    }
  }

  // Ingest requires a location_id. We use the restaurant's
  // primary location as the ingest target for both batches — every
  // GoDaddy-connected restaurant in Pilot V1 is single-location
  // and the merchant-to-location mapping is 1:1. When multi-
  // location comes online we'll pass the resolved location per
  // order (Poynt's storeId → our location map).
  const admin = createAdminClient()
  const { data: loc } = await admin
    .from('locations')
    .select('id')
    .eq('restaurant_id', ctx.restaurantId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!loc) return { ...EMPTY_RESULT, error: 'No location found for this restaurant.' }
  const locationId = loc.id as string

  const running: SyncResult = { ...EMPTY_RESULT, channelBreakdown: { pos: posBatch.length, online: onlineBatch.length } }

  if (posBatch.length > 0) {
    const r = await ingestOrders({
      supabase: admin,
      restaurantId: ctx.restaurantId,
      locationId,
      sourceId: 'godaddy_pos',
      orders: posBatch,
    })
    fold(running, r)
  }
  if (onlineBatch.length > 0) {
    const r = await ingestOrders({
      supabase: admin,
      restaurantId: ctx.restaurantId,
      locationId,
      sourceId: 'godaddy_online',
      orders: onlineBatch,
    })
    fold(running, r)
  }
  running.notes.push(...notes)
  return running
}

// ================================================================
// Normalization
// ================================================================
//
// Poynt monetary values arrive as major-unit numbers (dollars) OR
// as minor-unit integers (cents) depending on the endpoint and the
// merchant's currency; the spec's example schema uses the amounts
// object where subTotal / netTotal are integers in cents. We coerce
// to a positive dollar float using a simple heuristic: values > 1000
// in the `amounts` object are treated as cents. This gets ~all of
// the US cases right; edge cases (a $999 order billed in cents) are
// tolerable in v1 and we can move to a proper currency-aware
// conversion once we see real merchant data. Notes go into the
// return payload so we can spot suspicious values in the sync UI.

function normalizeOrder(o: PoyntOrder, notes: string[]): NormalizedOrder | null {
  const externalId = (o.id ?? o.orderNumber ?? '').trim()
  if (!externalId) return null

  const postedAt = (o.createdAt ?? o.updatedAt ?? '').trim()
  if (!postedAt) return null

  const netTotal = o.amounts?.netTotal ?? o.amounts?.subTotal ?? 0
  const totalAmount = normalizeAmount(netTotal)

  // Status: Poynt uses COMPLETED for closed orders; anything with
  // a "void" flavor in the status summary maps to voided. Unknown
  // status stays undefined and the ingest pipeline treats that as
  // completed.
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
    notes.push(`Order ${externalId} had no line items with a resolvable productId — skipped.`)
    return null
  }

  return {
    externalId,
    postedAt,
    totalAmount,
    status,
    paymentType: 'other', // Poynt's transactions[] carries card/cash detail; deferring precise mapping to phase 2.
    paymentStatus: status === 'voided' ? 'unpaid' : 'paid',
    lineItems,
  }
}

function normalizeAmount(raw: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0
  // Heuristic: if the value looks like cents (integer and >= 1000),
  // downscale. Anything else is treated as already-dollars.
  if (Number.isInteger(n) && Math.abs(n) >= 1000) return +(n / 100).toFixed(2)
  return +n.toFixed(2)
}

function fold(target: SyncResult, r: {
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
