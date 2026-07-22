-- ============================================================
-- 2026-07-22 — menu_items.hidden_from_menu
--
-- Owner-controlled "hide from menu" flag. Two reasons this can't
-- reuse `active`:
--
--   1. `active` now mirrors Poynt's status. When we sync the
--      merchant's product catalog, we set active=true/false
--      based on their upstream flag. Any owner action that also
--      set active would fight the next sync tick.
--
--   2. Different semantic. `active` = should this item be
--      SELLABLE (POS strip, inventory depletion). `hidden_from_menu`
--      = should this item appear in the /menu management UI.
--      A merchant might want a product hidden from their own
--      menu edit surface but still sellable via terminal (or
--      vice versa).
--
-- Delete action on imported items sets hidden_from_menu=true.
-- Awaiting band + section blocks filter it out client-side so
-- deleted items disappear. Catalog sync never touches this
-- column — the owner's decision is authoritative.
--
-- Index keyed on (restaurant_id, hidden_from_menu) so the menu
-- page's "give me the visible items" query is a range scan
-- rather than a full-table filter as merchants accumulate
-- catalog rows.
-- ============================================================

alter table public.menu_items
  add column hidden_from_menu boolean not null default false;

create index if not exists menu_items_hidden_idx
  on public.menu_items (restaurant_id, hidden_from_menu);
