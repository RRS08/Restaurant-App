-- Restaurants gain a `kind` column classifying what type of
-- business the tenant is. Determines the module bundle the
-- sidebar/dashboard renders once the UI branches on it (a
-- follow-up PR — this migration just gets the classification
-- into the DB).
--
--   restaurant   food service: POS, Menu, Inventory, Orders, Sales, Staffing, Finance, Website
--   retail       non-food retail store: POS, Inventory, Orders, Sales, Staffing, Finance, Website
--   online       online-only storefront (no physical POS): Inventory, Orders, Sales, Finance, Website
--   lead_gen     website-only, no commerce (Valley Carriers): Leads, Website, Finance
--   appointment  spa/salon, booking-driven: Appointments, Staffing, Finance, Website
--
-- Existing rows default to 'restaurant' so Hatziri and any
-- pre-existing tenants keep their current surface unchanged.

alter table public.restaurants
  add column if not exists kind text not null default 'restaurant';

alter table public.restaurants
  drop constraint if exists restaurants_kind_check;

alter table public.restaurants
  add constraint restaurants_kind_check
    check (kind in ('restaurant', 'retail', 'online', 'lead_gen', 'appointment'));
