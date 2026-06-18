-- ============================================================
-- 2026-06-18 — Relax menu_categories uniqueness for seeds
--
-- The original unique_category_per_restaurant constraint enforces
-- (restaurant_id, name) uniqueness across the whole table. That's
-- correct for real customer data — a customer shouldn't have two
-- categories named "Bebidas" — but it BLOCKS installing multiple
-- demo seed concepts that share a category name (Taqueria's
-- "Bebidas" + Mariscos's "Bebidas" + Bakery's "Bebidas", etc.).
--
-- Fix: replace the table-wide constraint with a PARTIAL unique
-- index that fires only when concept_key IS NULL — i.e. only for
-- real customer rows. Seed rows (concept_key non-null) can
-- duplicate names freely across concepts.
-- ============================================================

alter table public.menu_categories
  drop constraint if exists unique_category_per_restaurant;

create unique index if not exists menu_categories_unique_name_per_restaurant
  on public.menu_categories (restaurant_id, name)
  where concept_key is null;
