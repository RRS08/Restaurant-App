-- ============================================================
-- 2026-07-22 — order_items.variant_label
--
-- Modifier / variant string for a single line item. Poynt's
-- transaction detail renders the variant on its own subline
-- under the product name — "Pecan Pie Pu Erh (~50% Caffeine)"
-- with a smaller "1oz-Loose" beneath it. Storing the variant
-- separately (rather than concatenating into the name) lets
-- the drawer mirror that receipt layout, and keeps the base
-- product name clean for future join / grouping queries.
--
-- Nullable — most sources don't carry variant detail. Manual
-- entries and native POS orders leave it null; Poynt orders
-- populate it from item.selectedVariants[].value.
-- ============================================================

alter table public.order_items
  add column variant_label text;
