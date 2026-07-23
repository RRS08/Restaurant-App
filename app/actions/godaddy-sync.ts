'use server'

// ----------------------------------------------------------------
// GoDaddy Poynt — "Sync now" server action
//
// The sync has grown from a straight "fetch everything" pull into
// a small pipeline with intelligence:
//
//   • Mutex — per-merchant lease on godaddy_poynt_tokens.
//     Cron ticks + webhook fallback + manual clicks all try to
//     acquire; anyone who can't just returns quietly. Prevents
//     three concurrent syncs from stacking DB writes on top of
//     each other.
//
//   • /products throttle — catalog changes rarely; skip the fetch
//     unless it's been >24 h since we last pulled it (or the
//     caller explicitly forces a refresh).
//
//   • /orders — incremental startAt from the highest created_at
//     we already have for this merchant.
//
//   • /transactions — 3-day rolling window instead of 30. Catches
//     late-captured pre-auths and refunds without re-fetching a
//     month of history every 15 min.
//
//   • Per-order enrichment backfill — capped at 10 GET
//     /orders/{id} calls per invocation so a big backlog drains
//     over several ticks without blowing Vercel's 10s ceiling.
//
// Every leg wraps in try/catch so one bad response from Poynt
// doesn't cascade — the manual sync remains our safety net.
// ----------------------------------------------------------------

import { getAuthContext } from '@/lib/auth'
import { fetchPoyntOrders, fetchPoyntTransactions, fetchPoyntProducts } from '@/lib/godaddy/api'
import { ingestPoyntOrders, ingestPoyntTransactions, ingestPoyntProducts, enrichOrdersFromTransactions, backfillOrdersFromApi, type IngestBatchResult } from '@/lib/godaddy/ingest'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@supabase/supabase-js'

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

// Lease duration for the sync mutex. Long enough for the slowest
// legit run (backfill + all four Poynt legs) to finish comfortably;
// short enough that a crashed run self-heals inside one cron cycle.
const SYNC_LEASE_MS = 10 * 60 * 1000

// Refresh /products at most once per day. A merchant's SKU list
// rarely changes hourly; skipping the fetch on 95/96 of the daily
// cron ticks saves the biggest single Poynt API cost.
const PRODUCTS_STALE_MS = 24 * 60 * 60 * 1000

// Rolling window for /transactions. Wide enough to catch delayed
// captures (pre-auth on Monday captures Wednesday) and refunds
// that hit after the order was already ingested. Historical
// enrichment beyond this window flows through the per-order
// backfill pass instead.
const TRANSACTIONS_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

export async function syncGodaddyOrders(): Promise<SyncResult> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { ...EMPTY, error: authError ?? 'Authentication error.' }
  if (ctx.role !== 'owner') return { ...EMPTY, error: 'Only the owner can trigger a sync.' }
  // Manual click bypasses the /products throttle — if the owner
  // just added a SKU in Poynt and clicked Sync now, they should
  // see it immediately without waiting for the 24 h window.
  return await runSyncForRestaurant(ctx.restaurantId, { forceProducts: true })
}

interface SyncOpts {
  /** Ignore the /products 24 h throttle and always refresh the
   *  catalog. Set by the manual "Sync now" click; cron leaves it
   *  false so the throttle applies. */
  forceProducts?: boolean
}

/** Auth-agnostic sync core. Callable from the cron worker (no
 *  user session) or from the owner-facing "Sync now" button.
 *  See the file header for the full pipeline shape. */
export async function runSyncForRestaurant(
  restaurantId: string,
  opts: SyncOpts = {},
): Promise<SyncResult> {
  const supabase = createAdminClient()
  const merged: SyncResult = { ...EMPTY, channelBreakdown: { pos: 0, online: 0 }, notes: [] }

  // ---- Mutex acquisition ----
  // Try to take the per-merchant lease. If another sync is
  // already running, this UPDATE affects 0 rows and we exit
  // quietly. Stale leases (older than SYNC_LEASE_MS) get
  // reclaimed so a crashed run doesn't wedge things.
  const lease = await acquireSyncLease(supabase, restaurantId)
  if (!lease.acquired) {
    return { ...EMPTY, notes: [`Sync already running (lease held until ${lease.heldUntil ?? 'unknown'}) — skipped.`] }
  }

  try {
    // 0. /products — pull the merchant's product catalog FIRST so
    //    the subsequent order/transaction ingest finds a real menu
    //    row for each sale's SKU instead of spawning a throwaway
    //    placeholder. Throttled: skip if the last successful pull
    //    was < 24 h ago and the caller didn't force. Failure is
    //    non-fatal — the order legs still run against the current
    //    catalog in the DB.
    const shouldFetchProducts =
      opts.forceProducts || isProductsStale(lease.lastProductsSyncedAt)
    if (shouldFetchProducts) {
      try {
        const pullProducts = await fetchPoyntProducts({ restaurantId, maxProducts: 5000 })
        if ('error' in pullProducts) {
          merged.notes.push(`/products fetch failed: ${pullProducts.error}`)
        } else {
          const r = await ingestPoyntProducts({
            supabase, restaurantId, raw: pullProducts.products,
          })
          if (r.error) merged.notes.push(`/products ingest error: ${r.error}`)
          else {
            if (r.productsUpserted > 0) {
              merged.notes.push(`Catalog: ${r.productsUpserted} product${r.productsUpserted === 1 ? '' : 's'} synced.`)
            }
            // Stamp the throttle regardless of upsert count — a
            // successful fetch that returned 0 changes is still
            // a valid "we're up to date" signal.
            await stampProductsSynced(supabase, restaurantId)
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[godaddy/sync] /products leg threw', err)
        merged.notes.push(`/products leg threw: ${msg}`)
      }
    } else {
      merged.notes.push('Catalog: throttled (last synced <24h ago).')
    }

    // Incremental startAt for /orders — highest created_at we
    // already have from Poynt for this restaurant. +1s so we don't
    // refetch the exact same order on the boundary.
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

    // 2. /transactions — terminal charges + linked-transaction
    //    enrichment. 3-day rolling window instead of the 30-day
    //    default — enough to catch delayed captures + refunds
    //    without re-fetching a month of history every tick.
    //    Historical enrichment beyond 3 days flows through the
    //    per-order backfill pass below.
    const txStartAt = new Date(Date.now() - TRANSACTIONS_WINDOW_MS).toISOString()
    try {
      const pullTx = await fetchPoyntTransactions({
        restaurantId, maxTransactions: 1000, startAt: txStartAt,
      })
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

    // 4. Per-order backfill — GET /orders/{id} for rows still
    //    missing receipt-shape fields. Cap tuned for Vercel Hobby's
    //    10s function timeout. Big backlogs drain over successive
    //    ticks; once drained the query returns 0 rows and this
    //    pass is a cheap no-op.
    try {
      const bf = await backfillOrdersFromApi({ supabase, restaurantId, cap: 10 })
      if (bf.considered > 0) merged.notes.push(...bf.notes)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[godaddy/sync] backfill leg threw', err)
      merged.notes.push(`backfill leg threw: ${msg}`)
    }

    return merged
  } finally {
    // Release the lease. Runs even on unhandled throw so the next
    // caller isn't blocked by our crash. Stale-lease reclamation
    // (SYNC_LEASE_MS) is the ultimate backstop.
    await releaseSyncLease(supabase, restaurantId)
  }
}

// ================================================================
// Mutex + throttle helpers
// ================================================================

interface LeaseResult {
  acquired: boolean
  heldUntil: string | null
  lastProductsSyncedAt: string | null
}

/** Atomically claim the sync lease for this restaurant.
 *
 *  The single UPDATE is the concurrency guarantee: two callers
 *  racing both send the same WHERE clause, but only one row
 *  update actually commits — the other sees 0 rows affected and
 *  bails. We use `.select()` after so we can return the timestamp
 *  the winning caller now holds (and the products-synced-at we
 *  need for throttling downstream). */
async function acquireSyncLease(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<LeaseResult> {
  const nowIso = new Date().toISOString()
  const leaseUntil = new Date(Date.now() + SYNC_LEASE_MS).toISOString()

  const { data } = await supabase
    .from('godaddy_poynt_tokens')
    .update({ sync_locked_until: leaseUntil })
    .eq('restaurant_id', restaurantId)
    .or(`sync_locked_until.is.null,sync_locked_until.lt.${nowIso}`)
    .select('sync_locked_until, last_products_synced_at')

  const rows = data ?? []
  if (rows.length === 0) {
    // Someone else holds the lease. Try to read what it says
    // for the caller's info — pure diagnostic, not on the hot
    // path.
    const { data: held } = await supabase
      .from('godaddy_poynt_tokens')
      .select('sync_locked_until')
      .eq('restaurant_id', restaurantId)
      .maybeSingle()
    return {
      acquired: false,
      heldUntil: (held?.sync_locked_until as string | null) ?? null,
      lastProductsSyncedAt: null,
    }
  }

  return {
    acquired: true,
    heldUntil: leaseUntil,
    lastProductsSyncedAt: (rows[0].last_products_synced_at as string | null) ?? null,
  }
}

async function releaseSyncLease(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<void> {
  await supabase
    .from('godaddy_poynt_tokens')
    .update({ sync_locked_until: null })
    .eq('restaurant_id', restaurantId)
}

async function stampProductsSynced(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<void> {
  await supabase
    .from('godaddy_poynt_tokens')
    .update({ last_products_synced_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
}

function isProductsStale(lastSyncedAt: string | null): boolean {
  if (!lastSyncedAt) return true
  const ageMs = Date.now() - new Date(lastSyncedAt).getTime()
  return ageMs >= PRODUCTS_STALE_MS
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
