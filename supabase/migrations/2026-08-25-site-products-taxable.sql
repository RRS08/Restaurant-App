-- Per-product taxable flag on site_products (2026-08-25).
--
-- Default true so every existing product stays taxable and no
-- rows regress. Merchant flips individual items to exempt in
-- the catalog drawer; checkout then computes tax only on the
-- taxable subset of the cart (see lib/sites/checkout.ts). Delivery
-- price stays in the tax base — a per-delivery-option taxable
-- toggle is a future concern.
alter table public.site_products
  add column if not exists taxable boolean not null default true;
