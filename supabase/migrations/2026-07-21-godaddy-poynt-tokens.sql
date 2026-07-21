-- ============================================================
-- 2026-07-21 — GoDaddy Poynt Cloud App tokens (per-merchant)
--
-- Two tables:
--
-- 1. godaddy_poynt_tokens — per-merchant OAuth tokens.
--    When a Checked restaurant owner clicks "Connect GoDaddy
--    Commerce" in Settings, we send them through Poynt's OAuth
--    authorize flow. The callback comes back with a `code` JWT
--    whose `poynt.biz` claim is the merchant business id. We
--    exchange the code for an access + refresh token pair and
--    store them here, keyed by (restaurant_id, business_id).
--
--    Tokens have a 24h lifetime (Poynt's `expiresIn: 86400`) so
--    we compute expires_at at insert time and refresh preemptively
--    inside the adapter.
--
-- 2. godaddy_poynt_oauth_states — short-lived CSRF state used
--    during the install redirect. We generate a random state,
--    store {state, restaurant_id, expires_at}, redirect the user
--    to Poynt with `context=<state>`, and on the callback verify
--    the returned context matches an unexpired row and take the
--    restaurant_id from that row.
--
--    Rows expire after 15 minutes and are deleted on successful
--    consumption. A tiny table — a cron sweep is unnecessary at
--    our scale but the index supports one if we add it later.
--
-- Both tables are RLS-locked at policy level; every read/write
-- goes through the admin client inside server actions or the
-- OAuth route handlers.
-- ============================================================

create table public.godaddy_poynt_tokens (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  business_id    text not null,
  access_token   text not null,
  refresh_token  text not null,
  scope          text,
  token_type     text not null default 'BEARER',
  expires_at     timestamptz not null,
  connected_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- One connection per (restaurant, business). If a restaurant
  -- reconnects the same GoDaddy business, we upsert onto this row
  -- and refresh the tokens; we don't accumulate duplicates.
  unique(restaurant_id, business_id)
);

create index if not exists godaddy_poynt_tokens_restaurant_idx
  on public.godaddy_poynt_tokens (restaurant_id);
create index if not exists godaddy_poynt_tokens_expiring_idx
  on public.godaddy_poynt_tokens (expires_at);

alter table public.godaddy_poynt_tokens enable row level security;

create policy "godaddy_poynt_tokens locked"
  on public.godaddy_poynt_tokens
  for all
  using (false)
  with check (false);


create table public.godaddy_poynt_oauth_states (
  state          text primary key,
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '15 minutes')
);

create index if not exists godaddy_poynt_oauth_states_expires_idx
  on public.godaddy_poynt_oauth_states (expires_at);

alter table public.godaddy_poynt_oauth_states enable row level security;

create policy "godaddy_poynt_oauth_states locked"
  on public.godaddy_poynt_oauth_states
  for all
  using (false)
  with check (false);
