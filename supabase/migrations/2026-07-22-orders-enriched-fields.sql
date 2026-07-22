-- ============================================================
-- 2026-07-22 — orders enriched fields
--
-- Poynt's transaction detail shows more than "total + payment
-- type" — every real sale has a subtotal, discount, tax, card
-- brand + last-4, customer name, and channel (WEB / INSTORE /
-- MOBILE). Storing only total_amount + a generic "card / cash /
-- other" makes Checked's ledger feel thinner than the receipt
-- the merchant already has. Add the columns so ingest can
-- capture what Poynt hands us and the drawer can render a
-- receipt-shaped breakdown.
--
-- All nullable — legacy manual + native_pos orders won't
-- populate them, and adapters that don't expose a field (older
-- CSV imports, etc.) shouldn't be forced to invent a value.
--
-- Column notes:
--   subtotal        Line-item total before discount + tax.
--                   Poynt: amounts.subTotal (integer cents).
--   discount_total  Sum of order-level + line-level discounts.
--                   Poynt: amounts.discountTotal.
--   tax_total       Sales tax on the order.
--                   Poynt: amounts.taxTotal.
--   card_brand      VISA / MASTERCARD / AMEX / DISCOVER / etc.
--                   Poynt: fundingSource.card.type on the
--                   linked transaction leg.
--   card_last4      Last 4 of the pan. Never store more.
--   customer_name   Combined firstName + lastName from
--                   order.customer, if provided.
--   channel_source  Raw Poynt context.source (WEB / INSTORE /
--                   MOBILE / CALLIN). We already route to
--                   godaddy_pos / godaddy_online for catalog
--                   sharing; this column keeps the original
--                   value for reporting.
-- ============================================================

alter table public.orders
  add column subtotal        numeric(10,2),
  add column discount_total  numeric(10,2),
  add column tax_total       numeric(10,2),
  add column card_brand      text,
  add column card_last4      text,
  add column customer_name   text,
  add column channel_source  text;
