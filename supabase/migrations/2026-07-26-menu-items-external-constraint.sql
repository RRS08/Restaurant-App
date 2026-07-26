-- ============================================================
-- 2026-07-26 — menu_items external constraint (real one)
--
-- We already have `menu_items_external_unique`, a PARTIAL unique
-- index with WHERE external_provider IS NOT NULL. Uniqueness is
-- enforced correctly — but PostgREST's `onConflict` parameter
-- can't target partial unique indexes. Every ingestPoyntProducts
-- upsert was failing with:
--
--   "there is no unique or exclusion constraint matching the
--    ON CONFLICT specification"
--
-- Net effect: new/updated Poynt products never landed. Owners
-- would add a SKU on Poynt and it'd never appear in Checked's
-- menu until they re-triggered something that hit the ingest
-- path (which itself was broken).
--
-- Fix: add a proper unique CONSTRAINT (not a partial index).
-- Postgres treats NULLs as distinct in unique constraints, so
-- multiple manual menu_items (external_provider=null) can still
-- coexist. The old partial index is left in place — harmless
-- overlap.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'menu_items_external_unique_constraint'
      and conrelid = 'public.menu_items'::regclass
  ) then
    alter table public.menu_items
      add constraint menu_items_external_unique_constraint
      unique (restaurant_id, external_provider, external_id);
  end if;
end $$;
