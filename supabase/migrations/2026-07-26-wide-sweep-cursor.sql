-- ============================================================
-- 2026-07-26 — last_wide_sweep_at cursor
--
-- The incremental /orders leg uses `startAt = latest.created_at
-- - 30 min`. If Poynt's /orders LIST has a longer read lag on
-- some sales (minutes-to-hours per their own docs), those sales
-- are permanently skipped by the incremental leg — its cursor
-- has already advanced past them.
--
-- Fix: add a periodic WIDE sweep (last 24h) that runs at most
-- once per hour and re-lists the whole recent window. DB dedupe
-- on orders_external_unique absorbs the overlap so the wide
-- sweep is a cheap safety net most ticks and a real catch on
-- ticks that recover a laggy sale.
--
-- Cursor stored on the token row so it's per-merchant. Nullable
-- default — first tick after deploy triggers the sweep.
-- ============================================================

alter table public.godaddy_poynt_tokens
  add column if not exists last_wide_sweep_at timestamptz;
