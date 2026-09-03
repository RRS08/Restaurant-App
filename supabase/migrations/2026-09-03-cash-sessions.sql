-- ================================================================
-- cash_sessions -- the register open/close cycle.
--
-- One row per open-to-close cycle at a location. Counting is done
-- by denomination (the jsonb columns hold the per-denomination
-- counts; the numeric columns hold the summed total so every query
-- that just wants the amount does not have to re-add the jsonb).
--
-- Two reconciliation moments, deliberately separated:
--
--   1. AT CLOSE -- variance. Expected (opening + cash sales - cash
--      payouts) vs what was actually counted. A non-zero variance
--      means a till error during the day.
--
--   2. AT NEXT OPEN -- the gap. Whatever was counted at close vs
--      the amount in the drawer the next morning. Cash legitimately
--      leaves the drawer between sessions (bank run, moved to a
--      safe), so a shortfall here is NOT automatically a loss. The
--      open flow asks whether it was a deposit. Answering "deposit"
--      books a Register-to-Bank transfer for that amount. Answering
--      "no" records an unexplained shortfall with a required note.
--
-- Owner-only for now (the workflow lives on the Finance Register
-- tile). When it moves to the POS for staff, opened_by and
-- closed_by already carry the audit trail.
--
-- NOTE: no apostrophes anywhere in this file. The Supabase SQL
-- editor statement splitter tracks quote state naively and reads
-- an apostrophe inside a -- comment as opening a string literal,
-- which breaks the parse further down.
-- ================================================================

create table if not exists public.cash_sessions (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id   uuid not null references public.locations(id)   on delete cascade,

  -- ---- Open ----
  opened_at             timestamptz not null default now(),
  opened_by             uuid references auth.users(id) on delete set null,
  opening_amount        numeric(10,2) not null,
  opening_denominations jsonb,

  -- ---- Gap reconciliation vs the previous close ----
  -- Null on the very first session at a location.
  prior_close_amount  numeric(10,2),
  opening_gap         numeric(10,2),
  gap_reason          text check (gap_reason in ('deposit', 'unexplained', 'none')),
  gap_deposit_amount  numeric(10,2),
  gap_note            text,

  -- ---- Close ----
  closed_at             timestamptz,
  closed_by             uuid references auth.users(id) on delete set null,
  closing_amount        numeric(10,2),
  closing_denominations jsonb,
  expected_amount       numeric(10,2),
  variance              numeric(10,2),
  variance_note         text,

  status     text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only ONE open session per location at a time. Partial unique
-- index rather than a constraint so closed sessions stack freely.
create unique index if not exists cash_sessions_one_open_per_location
  on public.cash_sessions (location_id)
  where status = 'open';

-- Session history lookups: the tile reads the current open row,
-- the open flow reads the most recent closed row.
create index if not exists cash_sessions_lookup
  on public.cash_sessions (restaurant_id, location_id, status, opened_at desc);

-- ---------------------------------------------------------------- RLS
alter table public.cash_sessions enable row level security;

drop policy if exists "Members read cash sessions" on public.cash_sessions;
create policy "Members read cash sessions"
  on public.cash_sessions for select
  using (
    restaurant_id in (
      select restaurant_id from public.user_roles where user_id = auth.uid()
    )
  );

drop policy if exists "Members insert cash sessions" on public.cash_sessions;
create policy "Members insert cash sessions"
  on public.cash_sessions for insert
  with check (
    restaurant_id in (
      select restaurant_id from public.user_roles where user_id = auth.uid()
    )
  );

drop policy if exists "Members update cash sessions" on public.cash_sessions;
create policy "Members update cash sessions"
  on public.cash_sessions for update
  using (
    restaurant_id in (
      select restaurant_id from public.user_roles where user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------- verify
select
  (select count(*) from information_schema.columns
    where table_name = 'cash_sessions') as column_count,
  (select count(*) from pg_indexes
    where tablename = 'cash_sessions') as index_count,
  (select count(*) from pg_policies
    where tablename = 'cash_sessions') as policy_count;
-- Expected: column_count = 23, index_count = 3, policy_count = 3
