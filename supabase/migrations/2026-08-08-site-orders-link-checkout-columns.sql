-- ============================================================
-- 2026-08-08 — site_orders_link: columns the checkout insert needs
--
-- writeSiteLink() in lib/sites/checkout.ts inserts 8 columns:
--   site_id, order_id, session_id, cart, contact, shipping,
--   payment_provider, payment_reference
-- The live table only had site_id, order_id, cart (+ id,
-- created_at). Five of the eight never existed, so every web
-- checkout logged PGRST204 and dropped the link row:
--
--   Could not find the 'contact' column of 'site_orders_link'
--   in the schema cache
--
-- PGRST204 names only the FIRST missing column, which is why this
-- adds five and not one.
--
-- Consequence while broken: the orders row saved and the card was
-- really charged, but the buyer's contact + shipping address, the
-- cart snapshot, and the Poynt transaction id (payment_reference)
-- were all lost — those live nowhere else. Orders placed before
-- this migration cannot be recovered from the DB.
--
-- Types are pinned to how the columns are read back:
--   contact / shipping  -> jsonb  (sales page casts to objects;
--                                  queried as contact->>'email')
--   session_id          -> text   (matches site_carts.session_id)
--   payment_provider    -> text   (sites.config.payment_provider)
--   payment_reference   -> text   (Poynt transaction id)
--
-- All nullable on purpose. The current insert always supplies
-- session_id/contact/cart, but a NOT NULL here buys no correctness
-- today and turns any future partial write into a hard failure on
-- a path that has already taken the buyer's money.
-- ============================================================

alter table public.site_orders_link
  add column if not exists session_id        text,
  add column if not exists contact           jsonb,
  add column if not exists shipping          jsonb,
  add column if not exists payment_provider  text,
  add column if not exists payment_reference text;

-- Reconciliation lookup: given a Poynt transaction id from their
-- dashboard, find our order. Partial — most rows are non-null
-- only once a card actually cleared.
create index if not exists site_orders_link_payment_reference_idx
  on public.site_orders_link (payment_reference)
  where payment_reference is not null;

-- Supabase ships a DDL event trigger that NOTIFYs PostgREST after
-- any schema change, so this is belt-and-braces — harmless, and
-- makes the reload explicit if the trigger is ever absent.
notify pgrst, 'reload schema';
