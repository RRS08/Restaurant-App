// ----------------------------------------------------------------
// POS current-batch cache.
//
// The Finance page reads the merchant's pending processor balance
// on every render. Without a cache that's a live Poynt round-trip
// (several paginated GETs) per page view, per tab, per refresh —
// enough to burn API quota on a single operator leaving /finance
// open. This memoizes the snapshot for 60 seconds.
//
// Deliberately an in-memory Map, not Redis or a DB table:
//   • The value is disposable. Losing it costs one extra fetch.
//   • It never needs to be read by another process to be correct.
//   • It must not outlive a deploy — a stale pending balance
//     surviving a release would be worse than refetching.
//
// Consequence worth knowing: on serverless this is per-instance,
// so N warm lambdas mean up to N fetches per 60s window rather
// than exactly one. That's still a ~99% reduction versus
// per-render and it's the right trade for a disposable value.
//
// No LRU eviction — the map is keyed by restaurant_id and only
// grows with the number of tenants that have a POS connected
// (currently 2). If that ever reaches the thousands, revisit.
// ----------------------------------------------------------------

import type { PosBatchSnapshot } from '@/lib/godaddy/api'

/** How long a snapshot stays fresh. The pending balance changes
 *  only when a sale lands or the processor settles one, so a
 *  minute of staleness is invisible to an operator but removes
 *  essentially all render-driven load. */
const TTL_MS = 60_000

interface CacheEntry {
  value: PosBatchSnapshot
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

/** In-flight fetches, keyed the same way. Two concurrent renders
 *  for one tenant on a cold entry would otherwise both hit Poynt;
 *  the second awaits the first instead. */
const inFlight = new Map<string, Promise<PosBatchSnapshot | null>>()

/** Read the cached batch snapshot, refreshing it when stale.
 *
 *  `fetcher` should THROW to signal a failed read. On a throw we
 *  fall back to the last known value if we have one — showing a
 *  slightly stale balance beats blanking a money tile — and
 *  return null only when there's nothing cached to fall back to.
 *  A fetcher that legitimately resolves to null (no POS wired)
 *  is cached like any other value. */
export async function getCachedPosBatch(
  restaurantId: string,
  fetcher: () => Promise<PosBatchSnapshot | null>,
): Promise<PosBatchSnapshot | null> {
  const now = Date.now()
  const hit = cache.get(restaurantId)
  if (hit && now - hit.fetchedAt < TTL_MS) return hit.value

  const pending = inFlight.get(restaurantId)
  if (pending) return pending

  const run = (async () => {
    try {
      const fresh = await fetcher()
      if (fresh) cache.set(restaurantId, { value: fresh, fetchedAt: Date.now() })
      return fresh
    } catch {
      // Serve the stale value rather than nothing. Deliberately
      // NOT re-stamping fetchedAt: the entry stays expired so the
      // next call retries instead of pinning a stale number for
      // another full TTL.
      return cache.get(restaurantId)?.value ?? null
    } finally {
      inFlight.delete(restaurantId)
    }
  })()

  inFlight.set(restaurantId, run)
  return run
}

/** Drop a tenant's cached snapshot so the next read refetches.
 *  Backs the manual refresh button on the POS tile. */
export function clearCachedPosBatch(restaurantId: string): void {
  cache.delete(restaurantId)
}
