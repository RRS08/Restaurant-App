-- Finance sync observability.
--
-- One current-status row per restaurant recording the outcome of
-- the most recent materialize run (webhook / cron / manual /
-- bridge). Exists because a materialize failure was previously
-- invisible: Hatziri's Finance read "Nothing has moved yet" across
-- 237 real bank transactions while the only evidence was a
-- console.error in Vercel logs.
--
-- Additive only. Creates a new table; touches no existing table,
-- column, or data.

create table if not exists public.finance_sync_status (
  restaurant_id        uuid primary key
                       references public.restaurants(id) on delete cascade,
  -- When the last run finished, success or failure.
  last_run_at          timestamptz not null default now(),
  -- Which caller drove it: webhook | cron | manual | bridge | unknown.
  source               text        not null default 'unknown',
  inserted             integer     not null default 0,
  transfers_paired     integer     not null default 0,
  -- Rows in the window that did not become movements.
  rejected             integer     not null default 0,
  -- {reason: count}, e.g. {"non_positive_amount": 3}.
  rejected_reasons     jsonb       not null default '{}'::jsonb,
  -- Batch-level error; null when the run was clean.
  error                text,
  -- Last run with no error. Survives subsequent failures, so
  -- "healthy 6 days ago" stays legible during an outage.
  last_success_at      timestamptz,
  -- Repeat-failure signal: climbs while runs fail, resets to 0 on
  -- the first clean run. This is what turns a one-off blip into a
  -- visible, persistent outage.
  consecutive_failures integer     not null default 0,
  updated_at           timestamptz not null default now()
);

-- Supports "show me every tenant currently broken" without a scan.
create index if not exists finance_sync_status_failing_idx
  on public.finance_sync_status (consecutive_failures)
  where consecutive_failures > 0;

-- RLS on, no policies: same posture as the other server-only
-- tables. Every read and write goes through the Supabase admin
-- client server-side; no client ever queries this directly.
alter table public.finance_sync_status enable row level security;
