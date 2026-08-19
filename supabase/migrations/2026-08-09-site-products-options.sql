-- Extensible product options (form/size/color/…) for hosted-site
-- products. Shape:
--   [{ key, label, choices: [{ key, label, price? }] }]
-- Null / [] = single-variant product with no buyer-facing picker.
--
-- One column, one JSONB, room for future dimensions (color+size,
-- material, engraving, …) without another schema change. Every
-- rendering surface — PDP picker, cart lines, checkout summary,
-- order confirmation email, Checked's sales drawer — reads through
-- lib/sites/cart-options.ts so the same variant string prints
-- everywhere.
--
-- This migration only adds the column; the initial seed for
-- Hatziri's herb teas ("Loose leaf · 3 oz" vs "Tea bags · 30 ct")
-- was applied ad-hoc via the SQL editor when the feature landed.
alter table site_products
  add column if not exists options jsonb;
