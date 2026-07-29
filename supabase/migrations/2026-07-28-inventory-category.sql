-- ============================================================
-- 2026-07-28 — category on inventory_items
--
-- Free-text category so managers can group inventory items in
-- the list ("Powders", "Sauces", "Cleaning supplies"). Nullable;
-- existing rows stay NULL and the UI renders "Uncategorized"
-- until an owner fills it in.
--
-- Deliberately a plain text column — no lookup table, no FK,
-- no parent/child hierarchy. Two reasons:
--   1. Pilot-phase item catalogs are small (dozens, not
--      hundreds). A dropdown built off a distinct-values query
--      gives autocomplete-style reuse without another table.
--   2. If pilots outgrow this, the migration path to a proper
--      inventory_categories table is a data-copy + FK-add, not
--      a rewrite of the UI contract.
--
-- No index yet — filtering by category is a client-side
-- operation on the already-loaded rows; if list size grows past
-- ~500 items we can add `create index on public.inventory_items
-- (restaurant_id, location_id, category)`.
-- ============================================================

alter table public.inventory_items
  add column if not exists category text;
