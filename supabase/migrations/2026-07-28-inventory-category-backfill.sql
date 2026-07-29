-- ============================================================
-- 2026-07-28 — one-time backfill: inventory_items.category
--                from linked menu_categories.name
--
-- The category column shipped earlier today with a nullable
-- default, so every existing row reads as "Uncategorized" in
-- the UI. Meanwhile the taxonomy already exists on the menu
-- side: an inventory item like "Açai Berry Powder" is linked
-- via recipe_components to menu items in the "Single herbs"
-- menu_category. This migration copies that name over so the
-- inventory list picks up the existing grouping without any
-- manager click-work.
--
-- Guardrails:
--   • ONLY updates rows where category IS NULL — never
--     overrides a manager's manual entry, and re-running the
--     migration is a no-op.
--   • ONLY applies when the inventory item resolves to exactly
--     one distinct menu_category across all its recipe links.
--     Multi-category items (e.g. an ingredient used in both
--     "Powders" and "Sauces") stay NULL so the manager makes
--     the judgement call.
--   • ONLY within the same restaurant_id — belt-and-suspenders
--     against a stray cross-tenant recipe_components row.
-- ============================================================

UPDATE public.inventory_items ii
SET category = sub.category_name
FROM (
  SELECT
    rc.inventory_item_id AS inv_id,
    MAX(mc.name)         AS category_name  -- single value; guaranteed by the HAVING below
  FROM public.recipe_components rc
  JOIN public.menu_items      mi ON mi.id = rc.menu_item_id
  JOIN public.menu_categories mc ON mc.id = mi.category_id
  GROUP BY rc.inventory_item_id
  HAVING COUNT(DISTINCT mc.id) = 1
) sub
WHERE ii.id = sub.inv_id
  AND ii.category IS NULL;
