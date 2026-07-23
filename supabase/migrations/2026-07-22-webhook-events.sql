-- ============================================================
-- 2026-07-22 — webhook_events audit table
--
-- Persistent record of every inbound webhook hit, so we can
-- diagnose delivery failures without depending on Vercel log
-- retention (Hobby caps at ~1h). Every POST to
-- /api/godaddy/webhooks writes one row, whether it ingested,
-- was dropped for a signature mismatch, or was ignored because
-- the businessId didn't map to a merchant.
--
-- Column notes:
--   provider          Source system ('godaddy_poynt' today;
--                     future integrations get their own value).
--   business_id       The remote merchant id from the payload.
--                     Nullable — an unparseable body has none.
--   restaurant_id     Local restaurant we mapped it to via
--                     findByBusinessId. Nullable when no match.
--   event_type        Raw event name from the envelope
--                     ('ORDER_COMPLETED', 'ORDER_UPDATED', …).
--   http_status       What we returned to the sender. Always
--                     200 today (see route contract comment)
--                     but future variants could 4xx explicitly.
--   drop_reason       Null when successfully ingested; otherwise
--                     a short slug for the drop path (see the
--                     route handler for the enum values):
--                       unparseable_body
--                       payload_missing_required_fields
--                       no_linked_restaurant
--                       no_webhook_secret
--                       signature_mismatch
--                       order_fetch_failed
--                       handler_threw
--   raw_body          Truncated snippet of the incoming body
--                     (first 2000 chars) so we can reconstruct
--                     what Poynt actually sent. Truncation is
--                     both a size guardrail and a small hedge
--                     against accidentally logging card data
--                     if Poynt ever changes the envelope shape.
--   header_keys       List of header NAMES (no values) present
--                     on the request. Reveals the signature
--                     header name Poynt uses without leaking
--                     the signature itself.
--   error_msg         Human-readable error text for drop paths
--                     that carry one (order_fetch_failed,
--                     handler_threw). Nullable.
--
-- Retention: no automatic purge yet — pilot volume is trivial
-- (a few dozen rows/day). Add a periodic delete when the table
-- gets big.
--
-- RLS: enabled with no policies (denies all client access).
-- Diagnostic reads happen through the admin client / SQL editor.
-- ============================================================

create table if not exists public.webhook_events (
  id                uuid primary key default gen_random_uuid(),
  received_at       timestamptz not null default now(),
  provider          text not null default 'godaddy_poynt',
  business_id       text,
  restaurant_id     uuid references public.restaurants(id) on delete set null,
  event_type        text,
  http_status       int not null default 200,
  drop_reason       text,
  raw_body          text,
  header_keys       text[],
  error_msg         text
);

create index if not exists webhook_events_received_at_idx
  on public.webhook_events (received_at desc);

create index if not exists webhook_events_business_id_idx
  on public.webhook_events (business_id);

-- Partial index for the "what did we drop" query — most rows are
-- successes (drop_reason = null) so a filtered index stays cheap.
create index if not exists webhook_events_dropped_idx
  on public.webhook_events (received_at desc)
  where drop_reason is not null;

alter table public.webhook_events enable row level security;
