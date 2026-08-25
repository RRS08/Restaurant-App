-- Places pivot (2026-08-25). Locations now carry a `kind` so the
-- app can tell physical shops apart from the virtual "Online"
-- location that houses web-checkout orders. The picker at /places
-- reads locations.kind to render the right glyph + workspace nav
-- (retail vs online) and every per-location query composes with
-- the new concept without any join fanout.
--
-- This migration:
--   1. adds locations.kind with default 'retail' + a check
--      constraint (retail | online)
--   2. seeds one Online location per restaurant that owns a
--      site, inheriting timezone from an existing retail
--      location where possible (falls back to 'UTC')
--   3. points each site's config.web_order_location_id at that
--      restaurant's Online location so future web checkouts
--      land there. Existing web orders keep whatever
--      location they were stamped with.

alter table public.locations
  add column if not exists kind text not null default 'retail';

alter table public.locations
  drop constraint if exists locations_kind_check;
alter table public.locations
  add constraint locations_kind_check check (kind in ('retail','online'));

insert into public.locations (restaurant_id, name, kind, timezone)
select r.id,
       'Online storefront',
       'online',
       coalesce(
         (select l2.timezone from public.locations l2
           where l2.restaurant_id = r.id
           order by l2.created_at limit 1),
         'UTC'
       )
from public.restaurants r
where exists (select 1 from public.sites where restaurant_id = r.id)
  and not exists (select 1 from public.locations where restaurant_id = r.id and kind = 'online');

update public.sites s
set config = jsonb_set(coalesce(config, '{}'::jsonb), '{web_order_location_id}', to_jsonb(l.id::text))
from public.locations l
where l.restaurant_id = s.restaurant_id
  and l.kind = 'online';
