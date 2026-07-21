-- ============================================================
-- 2026-07-21 — GoDaddy Poynt webhook wiring
--
-- Two columns on godaddy_poynt_tokens, per-merchant:
--
--   webhook_secret — a random string we generate at install
--     time and hand to Poynt when registering the webhook.
--     Every incoming event carries a signature (SHA1 HMAC per
--     Poynt spec §8) that we verify against this secret. Not
--     shared across merchants — a leak of one is not a
--     compromise of all.
--
--   webhook_id — the id Poynt returned when we registered.
--     Stored so we can delete / rotate the hook later without
--     having to list-and-find on Poynt's side.
-- ============================================================

alter table public.godaddy_poynt_tokens
  add column webhook_id     text,
  add column webhook_secret text;
