-- ============================================================
-- 2026-07-26 — per-location business hours.
--
-- Two tables:
--   business_hours   the recurring weekday rule
--   hours_override   one-off dates (holidays, special closes)
--
-- Weekday convention: 0 = Monday … 6 = Sunday (matches the JS
-- helper used in the calendar; getDay() ≠ 0 branch remaps it).
--
-- Times stored as minutes-from-midnight (open_min 720 = 12:00).
-- Matches the drawer's DayHours contract 1:1 — no conversion at
-- the read edge.
--
-- Per-location: multi-location restaurants can run different
-- schedules per spot. Both tables cascade off locations.
--
-- Both tables reach through public.my_restaurant_id() for RLS,
-- matching the pattern every other staffing table uses.
-- ============================================================

create table if not exists public.business_hours (
  location_id   uuid not null references public.locations(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  weekday       integer not null check (weekday between 0 and 6),
  closed        boolean not null default false,
  open_min      integer not null default 720  check (open_min >= 0 and open_min < 1440),
  close_min     integer not null default 1260 check (close_min >= 0 and close_min <= 1440),
  updated_at    timestamptz not null default now(),
  primary key (location_id, weekday),
  check (close_min > open_min)
);

create table if not exists public.hours_override (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  date          date not null,
  closed        boolean not null default false,
  open_min      integer not null default 720  check (open_min >= 0 and open_min < 1440),
  close_min     integer not null default 1260 check (close_min >= 0 and close_min <= 1440),
  updated_at    timestamptz not null default now(),
  unique (location_id, date),
  check (close_min > open_min)
);

alter table public.business_hours enable row level security;
alter table public.hours_override enable row level security;

-- Same shape as shifts/employees policies — the restaurant_id
-- column is what actually gates access.
drop policy if exists "Users can view business hours" on public.business_hours;
create policy "Users can view business hours"
  on public.business_hours for select
  using (restaurant_id = public.my_restaurant_id());

drop policy if exists "Users can insert business hours" on public.business_hours;
create policy "Users can insert business hours"
  on public.business_hours for insert
  with check (restaurant_id = public.my_restaurant_id());

drop policy if exists "Users can update business hours" on public.business_hours;
create policy "Users can update business hours"
  on public.business_hours for update
  using (restaurant_id = public.my_restaurant_id());

drop policy if exists "Users can delete business hours" on public.business_hours;
create policy "Users can delete business hours"
  on public.business_hours for delete
  using (restaurant_id = public.my_restaurant_id());

drop policy if exists "Users can view hours override" on public.hours_override;
create policy "Users can view hours override"
  on public.hours_override for select
  using (restaurant_id = public.my_restaurant_id());

drop policy if exists "Users can insert hours override" on public.hours_override;
create policy "Users can insert hours override"
  on public.hours_override for insert
  with check (restaurant_id = public.my_restaurant_id());

drop policy if exists "Users can update hours override" on public.hours_override;
create policy "Users can update hours override"
  on public.hours_override for update
  using (restaurant_id = public.my_restaurant_id());

drop policy if exists "Users can delete hours override" on public.hours_override;
create policy "Users can delete hours override"
  on public.hours_override for delete
  using (restaurant_id = public.my_restaurant_id());

-- Read-path index — the calendar filters overrides to the
-- current week (7 dates), so a (location, date) index is what
-- speeds that up.
create index if not exists idx_hours_override_location_date
  on public.hours_override (location_id, date);
