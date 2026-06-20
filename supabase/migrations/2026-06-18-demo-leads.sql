-- ============================================================
-- 2026-06-18 — Demo lead capture
--
-- The marketing site's "Book a demo" form currently shows a
-- success state but the payload goes nowhere (see the TODO at the
-- top of components/marketing/demo-form.tsx). This migration adds
-- the demo_leads table the form will start writing to.
--
-- It also gives us the structural pieces for spam control:
--   • rejected / rejection_reason — when the server action drops
--     a submission (honeypot tripped, rate limit hit, etc.) we
--     still log a row so we can see scale-of-attack
--   • ip_address / user_agent — for IP-based rate limiting and
--     for spotting bot patterns post-hoc
--
-- Everything happens through server actions; the table is
-- RLS-locked so no one can browse leads by URL.
-- ============================================================

create table public.demo_leads (
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  concept           text,
  message           text,
  ip_address        text,
  user_agent        text,
  rejected          boolean not null default false,
  rejection_reason  text,
  created_at        timestamptz not null default now()
);

-- Recent-first lookup on the dev-tools list, plus an IP+time index
-- so the rate-limit check stays cheap as the table grows.
create index if not exists demo_leads_created_idx
  on public.demo_leads (created_at desc);
create index if not exists demo_leads_ip_recent_idx
  on public.demo_leads (ip_address, created_at desc);

alter table public.demo_leads enable row level security;

-- Lock down direct access. All reads + writes go through the admin
-- client inside server actions, exactly like invite_codes.
create policy "demo_leads locked"
  on public.demo_leads
  for all
  using (false)
  with check (false);
