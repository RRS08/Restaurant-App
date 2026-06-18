-- ============================================================
-- 2026-06-18 — Invite-only signup
--
-- Closes the open `/signup` route. Going forward, a fresh sign-up
-- requires a valid invite_code in the form. The dev (via
-- /dev-tools) generates one code per pilot, hands it out by text
-- or email, and the prospective owner uses it once during signup.
--
-- This is the pre-Stripe-paywall gate. Once Stripe Billing is
-- wired in, an automatic code can be issued by the
-- checkout.session.completed webhook so paid customers never see
-- a manual step. Until then: manual codes are how we prove
-- "you've talked to Renato and we agreed to a pilot."
--
-- Schema:
--   code        — short uppercase string we hand out (e.g., XB7K-3MWQ)
--   notes       — what this code is for (free-text; "Pilot #1 — Tacos Don Pedro")
--   max_uses    — how many times the code can be redeemed (default 1)
--   used_count  — incremented every time a signup consumes the code
--   expires_at  — optional kill-switch
--   created_by_user_id — which dev account minted the code
--
-- All access is through server actions (auth-side: validate +
-- consume; dev-side: create + list + revoke). The RLS policy
-- denies direct reads from the client so leaked codes can't be
-- enumerated by anonymous browsing.
-- ============================================================

create table public.invite_codes (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,
  notes               text,
  max_uses            int not null default 1,
  used_count          int not null default 0,
  expires_at          timestamptz,
  created_by_user_id  uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now()
);

create index if not exists invite_codes_code_idx
  on public.invite_codes (code);

alter table public.invite_codes enable row level security;

-- Block all direct table access from PostgREST. Server actions go
-- through the admin client (lib/supabase/admin.ts) which bypasses
-- RLS, and the signup action validates + increments via the same
-- admin client. There's no good reason for a logged-in user to
-- read this table directly — even owners shouldn't see codes for
-- other restaurants.
create policy "invite_codes locked"
  on public.invite_codes
  for all
  using (false)
  with check (false);
