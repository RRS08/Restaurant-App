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
import { fetchPoyntOrders, fetchPoyntTransactions, fetchPoyntProducts, fetchPoyntNotifications } from '@/lib/godaddy/api'
import { ingestPoyntOrders, ingestPoyntTransactions, ingestPoyntProducts, enrichOrdersFromTransactions, backfillOrdersFromApi, reconcileOrdersFromTransactions, replayOrdersFromNotifications, type IngestBatchResult } from '@/lib/godaddy/ingest'
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

// Overlap window for /orders incremental sync. Instead of asking
// Poynt for "orders strictly after our newest known order", we
// walk back 30 minutes and let DB dedupe skip anything we already
// have. This absorbs any read-side lag on Poynt's `/orders` list
// (an order closed at T on the terminal may not become queryable
// until T + N seconds) — with a strict +1s bump we'd advance past
// slow-visible orders and never fetch them via the /orders leg.
// 30 min is generous but bounded — even a busy merchant returns
// only a few dozen orders in that window; dedupe is a cheap
// SELECT on an indexed column.
const ORDERS_OVERLAP_MS = 30 * 60 * 1000

// Wide /orders sweep: re-list the last 72h at most hourly.
// Recovers sales that appeared in Poynt's LIST after the
// incremental cursor had already moved past them (Poynt's LIST
// endpoint has documented "minutes-to-hours" read lag on some
// sales). DB dedupe absorbs the ~all-overlap most ticks; ticks
// that recover a laggy sale earn their keep. Every 4 cron ticks
// at 15 min = every hour.
//
// Widened from 24h → 72h after diagnostic: a hobby-tier merchant
// caught 5 orders that fell outside the 24h window in a single
// manual sync. Poynt's LIST-side lag can exceed 24h in rare
// cases; 72h costs a few extra dedupe SELECTs per hour and eats
// no meaningful API budget.
const WIDE_SWEEP_WINDOW_MS = 72 * 60 * 60 * 1000
const WIDE_SWEEP_STALE_MS  = 60 * 60 * 1000

// Notification-replay window. Poynt keeps notifications for
// 30 days; we sweep the last 48h every cron tick. Anything older
// that's still missing after 30 days of ticks was never going
// to arrive — a bigger window is wasted API budget.
const NOTIFICATION_REPLAY_WINDOW_MS = 48 * 60 * 60 * 1000

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
    // already have from Poynt for this restaurant, walked BACK
    // 30 minutes so any orders that were slow to become queryable
    // on Poynt's side still get picked up on the next tick. DB
    // dedupe (unique on external_id) skips anything we already
    // have; the added fetch cost per tick is a few dozen orders
    // even for a busy merchant.
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
      const overlapped = new Date(latestRow.created_at as string).getTime() - ORDERS_OVERLAP_MS
      startAt = new Date(overlapped).toISOString()
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

    // 1b. Wide /orders sweep — safety net for Poynt's read-side lag.
    //     The incremental leg above uses `startAt = latest - 30 min`;
    //     any sale that appears in Poynt's LIST more than 30 min after
    //     it closed permanently escapes that cursor (since our next
    //     tick will start from an even newer high-water mark). This
    //     leg re-lists the last 24h at most once per hour so laggy
    //     sales get recovered. DB dedupe absorbs the overlap so ticks
    //     that don't discover anything cost only the API roundtrip.
    const wideSweepDueMs = lease.lastWideSweepAt
      ? Date.now() - new Date(lease.lastWideSweepAt).getTime()
      : Infinity
    if (wideSweepDueMs >= WIDE_SWEEP_STALE_MS) {
      const wideStartAt = new Date(Date.now() - WIDE_SWEEP_WINDOW_MS).toISOString()
      try {
        const pullWide = await fetchPoyntOrders({ restaurantId, maxOrders: 1000, startAt: wideStartAt })
        if ('error' in pullWide) {
          merged.notes.push(`Wide sweep fetch failed: ${pullWide.error}`)
        } else {
          const r = await ingestPoyntOrders({ supabase, restaurantId, raw: pullWide.orders })
          mergeIn(merged, r)
          if (r.ordersInserted > 0) {
            merged.notes.push(`Wide sweep recovered ${r.ordersInserted} laggy order${r.ordersInserted === 1 ? '' : 's'}.`)
          }
          await stampWideSweep(supabase, restaurantId)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[godaddy/sync] wide sweep threw', err)
        merged.notes.push(`wide sweep threw: ${msg}`)
      }
    }

    // 1c. Notification-replay — the authoritative backstop.
    //     Poynt's /orders LIST has documented "minutes-to-hours"
    //     read lag; the webhook path has been unreliable in
    //     practice (event-type mismatch, dead delivery URLs from
    //     older proxy config, etc.). Notifications is the API
    //     Poynt uses internally to fire hooks — pulling them
    //     directly and diffing against orders.external_id
    //     recovers anything the two LIST-based legs above missed.
    //
    //     Runs every tick, no throttle: the endpoint returns a
    //     bounded set (notifications are 1 per event, capped at
    //     30 days), the SELECT is one IN-clause on an indexed
    //     column, and the actual fetches are capped inside
    //     replayOrdersFromNotifications. Cheap even on ticks
    //     with 0 missing.
    try {
      const notifStartAt = new Date(Date.now() - NOTIFICATION_REPLAY_WINDOW_MS).toISOString()
      const pullNotif = await fetchPoyntNotifications({
        restaurantId, startAt: notifStartAt, maxNotifications: 500,
      })
      if ('error' in pullNotif) {
        merged.notes.push(`/notifications fetch failed: ${pullNotif.error}`)
      } else {
        const r = await replayOrdersFromNotifications({
          supabase, restaurantId, notifications: pullNotif.notifications, cap: 15,
        })
        merged.notes.push(...r.notes)
        // Fold the replayed count into the run's ordersInserted so
        // the "Sync now" toast reflects the total impact honestly.
        merged.ordersInserted += r.replayed
        merged.ordersFailed += r.failed
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[godaddy/sync] notification-replay leg threw', err)
      merged.notes.push(`notification-replay leg threw: ${msg}`)
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

        // 3a. Reconcile any orders that /transactions references
        //     but /orders LIST hasn't returned to us yet. This is
        //     the fix for Poynt's read-side lag: sales that closed
        //     but haven't propagated to the /orders list get pulled
        //     via GET /orders/{id} (which is authoritative and
        //     immediate). Capped so a big first-run backlog doesn't
        //     blow the function timeout. Cap raised from 20 → 50
        //     after the pilot merchant reported 4/8 sales still
        //     missing on a 15-min tick — a bigger drain each pass
        //     shortens the window a stranded order sits invisible.
        try {
          const rec = await reconcileOrdersFromTransactions({
            supabase, restaurantId, transactions: pullTx.transactions, cap: 50,
          })
          if (rec.considered > 0) merged.notes.push(...rec.notes)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[godaddy/sync] reconcile leg threw', err)
          merged.notes.push(`reconcile leg threw: ${msg}`)
        }

        // 3b. Enrich linked orders with card brand + last-4 pulled
        //     from the transactions that reference them. Only fills
        //     fields that are currently missing, so it's a cheap
        //     no-op on subsequent syncs.
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
  lastWideSweepAt: string | null
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
    .select('sync_locked_until, last_products_synced_at, last_wide_sweep_at')

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
      lastWideSweepAt: null,
    }
  }

  return {
    acquired: true,
    heldUntil: leaseUntil,
    lastProductsSyncedAt: (rows[0].last_products_synced_at as string | null) ?? null,
    lastWideSweepAt: (rows[0].last_wide_sweep_at as string | null) ?? null,
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

async function stampWideSweep(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<void> {
  await supabase
    .from('godaddy_poynt_tokens')
    .update({ last_wide_sweep_at: new Date().toISOString() })
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
