'use server'

// ----------------------------------------------------------------
// GoDaddy Poynt — "Sync now" server action
//
// Manual pull triggered by the Settings card. Two data sources
// combined into one click:
//
//   1. /orders       — online storefront + POS orders that
//                       created full Order objects.
//   2. /transactions — terminal / Virtual Terminal / MOTO
//                       charges that don't create Order objects
//                       (Poynt terminal payments live here).
//
// Both get normalized and handed to the shared ingest pipeline.
// Idempotent thanks to dedupe on (provider, external_id) —
// re-clicking Sync now is safe.
//
// Owner-gated; the shared helpers are auth-agnostic so a webhook
// invocation can reuse them without threading a user session
// through.
// ----------------------------------------------------------------

import { getAuthContext } from '@/lib/auth'
import { fetchPoyntOrders, fetchPoyntTransactions, fetchPoyntProducts } from '@/lib/godaddy/api'
import { ingestPoyntOrders, ingestPoyntTransactions, ingestPoyntProducts, enrichOrdersFromTransactions, type IngestBatchResult } from '@/lib/godaddy/ingest'
import { createAdminClient } from '@/lib/supabase/admin'

export type SyncResult = IngestBatchResult

const EMPTY: SyncResult = {
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
  if (authError || !ctx) return { ...EMPTY, error: authError ?? 'Authentication error.' }
  if (ctx.role !== 'owner') return { ...EMPTY, error: 'Only the owner can trigger a sync.' }
  return await runSyncForRestaurant(ctx.restaurantId)
}

/** Auth-agnostic sync core. Callable from the cron worker (no
 *  user session) or from the owner-facing "Sync now" button.
 *  Fetches an incremental window (from the newest order we've
 *  already ingested for this merchant + 1s, or the last 30 days
 *  if we have nothing yet) so recurring cron runs don't
 *  re-fetch data that's already in the DB. */
export async function runSyncForRestaurant(restaurantId: string): Promise<SyncResult> {
  const supabase = createAdminClient()
  const merged: SyncResult = { ...EMPTY, channelBreakdown: { pos: 0, online: 0 }, notes: [] }

  // 0. /products — pull the merchant's product catalog FIRST so
  //    the subsequent order/transaction ingest finds a real menu
  //    row for each sale's SKU instead of spawning a throwaway
  //    placeholder. This is the "menu = mirror of Poynt catalog"
  //    architecture — placeholder creation in the order path is
  //    only a fallback for the rare unmapped SKU. Failure is
  //    non-fatal: if the products endpoint is unavailable, the
  //    order/transaction legs still run against whatever catalog
  //    is currently in the DB.
  try {
    const pullProducts = await fetchPoyntProducts({ restaurantId, maxProducts: 5000 })
    if ('error' in pullProducts) {
      merged.notes.push(`/products fetch failed: ${pullProducts.error}`)
    } else {
      const r = await ingestPoyntProducts({
        supabase, restaurantId, raw: pullProducts.products,
      })
      if (r.error) merged.notes.push(`/products ingest error: ${r.error}`)
      else if (r.productsUpserted > 0) {
        merged.notes.push(`Catalog: ${r.productsUpserted} product${r.productsUpserted === 1 ? '' : 's'} synced.`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[godaddy/sync] /products leg threw', err)
    merged.notes.push(`/products leg threw: ${msg}`)
  }

  // Incremental startAt — highest created_at we already have from
  // Poynt for this restaurant. Add 1s so we don't refetch the
  // exact same order on the boundary. When nothing exists yet
  // (first sync), leave undefined so fetchPoynt* falls back to
  // its 30-day default.
  const { data: latestRow } = await supabase
    .from('orders')
    .select('created_at')
    .eq('restaurant_id', restaurantId)
    .in('external_provider', ['godaddy_pos', 'godaddy_online'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  let startAt: string | undefined
  if (latestRow?.created_at) {
    const bumpedMs = new Date(latestRow.created_at as string).getTime() + 1000
    startAt = new Date(bumpedMs).toISOString()
  }

  // 1. /orders — online + Order-shaped POS sales.
  //    Wrapped so an unhandled throw here can't kill the whole
  //    action — /transactions still gets a chance to run.
  try {
    const pullOrders = await fetchPoyntOrders({ restaurantId, maxOrders: 1000, startAt })
    if ('error' in pullOrders) {
      merged.notes.push(`/orders fetch failed: ${pullOrders.error}`)
    } else {
      const r = await ingestPoyntOrders({
        supabase, restaurantId, raw: pullOrders.orders,
      })
      mergeIn(merged, r)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[godaddy/sync] /orders leg threw', err)
    merged.notes.push(`/orders leg threw: ${msg}`)
  }

  // 2. /transactions — terminal charges that skip the Order table.
  //    Critical for merchants (Hatziri) who use the Poynt terminal
  //    heavily; without this we miss all in-person card sales.
  //    Also feeds the enrichment pass below: /orders LIST rarely
  //    embeds transactions[] on each order, so we cross-reference
  //    /transactions here to fill in card brand + last-4 + payment
  //    type on orders that were tendered by card.
  //    Same defensive wrap — an unexpected shape from Poynt on this
  //    endpoint shouldn't undo the /orders leg's work.
  //    Pull WITHOUT the incremental startAt window since we want
  //    to enrich historical orders too. The transaction ingest path
  //    dedupes by transaction id so re-fetching is safe.
  try {
    const pullTx = await fetchPoyntTransactions({ restaurantId, maxTransactions: 1000 })
    if ('error' in pullTx) {
      merged.notes.push(`/transactions fetch failed: ${pullTx.error}`)
    } else {
      const r = await ingestPoyntTransactions({
        supabase, restaurantId, raw: pullTx.transactions,
      })
      mergeIn(merged, r)

      // 3. Enrich linked orders with card brand + last-4 pulled
      //    from the transactions that reference them. Only fills
      //    fields that are currently missing, so it's a cheap
      //    no-op on subsequent syncs.
      try {
        const en = await enrichOrdersFromTransactions({
          supabase, restaurantId, transactions: pullTx.transactions,
        })
        if (en.enriched > 0) {
          merged.notes.push(`Enriched ${en.enriched} order${en.enriched === 1 ? '' : 's'} with card details.`)
        }
        merged.notes.push(...en.notes)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[godaddy/sync] enrich leg threw', err)
        merged.notes.push(`enrich leg threw: ${msg}`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[godaddy/sync] /transactions leg threw', err)
    merged.notes.push(`/transactions leg threw: ${msg}`)
  }

  return merged
}

function mergeIn(target: SyncResult, src: SyncResult) {
  target.ordersInserted += src.ordersInserted
  target.ordersSkipped += src.ordersSkipped
  target.ordersFailed += src.ordersFailed
  target.placeholdersCreated += src.placeholdersCreated
  target.inventoryDepletionsWritten += src.inventoryDepletionsWritten
  target.channelBreakdown.pos += src.channelBreakdown.pos
  target.channelBreakdown.online += src.channelBreakdown.online
  target.notes.push(...src.notes)
  if (src.error && !target.error) target.error = src.error
}
