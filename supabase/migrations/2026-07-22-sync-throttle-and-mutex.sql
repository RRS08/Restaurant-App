-- ============================================================
-- 2026-07-22 — sync throttle + per-merchant mutex
--
-- Two adds on godaddy_poynt_tokens to make the sync loop smarter:
--
--   sync_locked_until     — lease timestamp. A sync run stamps
--                           `now() + 10 min` at start and clears
--                           on exit. Other callers (concurrent
--                           cron tick + manual click + webhook)
--                           see the lease and skip early. Stale
--                           lease (crashed run) self-heals after
--                           10 min so a bug can't wedge the sync
--                           forever.
--
--   last_products_synced_at — timestamp of the last successful
--                           /products fetch. Product catalogs
--                           change rarely (Hatziri's ~400 SKUs
--                           don't turn over hourly), so the
--                           sync throttles /products to once
--                           per 24 h. Big API-cost saving —
--                           /products was 4 pages fetched every
--                           15 min = 96 × 4 = 384 requests/day
--                           for near-zero data change.
--
-- Both nullable — legacy token rows without them behave as if
-- the lock is free / the catalog was never synced.
-- ============================================================

alter table public.godaddy_poynt_tokens
  add column if not exists sync_locked_until       timestamptz,
  add column if not exists last_products_synced_at timestamptz;
