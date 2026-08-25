-- Pickup fulfillment workflow (2026-08-25).
--
-- orders.fulfillment_state carries the pickup lifecycle:
--   new       → placed, not yet handled
--   ready     → staff marked ready; buyer notified via email
--   completed → handed off / picked up
-- Voided orders keep whatever state they had; the sales/orders
-- pages ignore fulfillment_state for voided rows.
--
-- orders.ready_at stamps when a staff member advanced 'new' →
-- 'ready' so the Orders drawer can show "Marked ready at 3:14 PM".
--
-- Backfill sets every existing row to 'completed' so today's
-- pickup badge starts at zero even if historical web orders sit
-- in the ledger. Future web orders default to 'new'.

alter table public.orders
  add column if not exists fulfillment_state text not null default 'new';

alter table public.orders
  drop constraint if exists orders_fulfillment_state_check;
alter table public.orders
  add constraint orders_fulfillment_state_check
  check (fulfillment_state in ('new','ready','completed'));

alter table public.orders
  add column if not exists ready_at timestamptz;

update public.orders
set fulfillment_state = 'completed'
where fulfillment_state = 'new';
