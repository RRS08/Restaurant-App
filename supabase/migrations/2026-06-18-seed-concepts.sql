-- ============================================================
-- 2026-06-18 — Demo seed concepts
--
-- Adds a `concept_key` tag to seedable rows and an
-- `active_seed_concept` switcher on `restaurants`. The purpose is
-- demo-only — a dev account can pre-load several restaurant concepts
-- (taqueria, mariscos, bakery, cafe, bbq, burgers, tortilleria, …),
-- keep them all in the DB, and toggle which one is "active" before
-- each sales call. Switching shows / hides without destroying data.
--
-- Filter semantics (applied in POS, Menu, Inventory queries):
--
--   WHERE concept_key = active_seed_concept     -- the loaded seed
--      OR concept_key IS NULL                   -- real user content
--
-- NULL = real customer-created content; always visible. Real
-- customers never set `concept_key` and never set
-- `active_seed_concept`, so this filter is a no-op for them. Dev
-- accounts tag their seed rows so they collapse cleanly when not
-- active.
--
-- All gating + write UI lives at /dev-tools (already isDevEmail-only).
-- ============================================================

-- Per-row concept tag. NULL = always visible (real user content).
alter table public.menu_categories add column if not exists concept_key text;
alter table public.menu_items      add column if not exists concept_key text;
alter table public.inventory_items add column if not exists concept_key text;

-- Indexes — the filter hits these columns on every POS / Menu /
-- Inventory page load, so make sure restaurant_id + concept_key
-- composite lookups are cheap.
create index if not exists menu_items_concept_idx
  on public.menu_items (restaurant_id, concept_key);
create index if not exists menu_categories_concept_idx
  on public.menu_categories (restaurant_id, concept_key);
create index if not exists inventory_items_concept_idx
  on public.inventory_items (restaurant_id, concept_key);

-- Switcher column on the restaurant. NULL = no seed active (real
-- content only). Demo flow sets this to 'taqueria' / 'burgers' / etc.
alter table public.restaurants add column if not exists active_seed_concept text;
