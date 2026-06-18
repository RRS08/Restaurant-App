-- ============================================================
-- 2026-06-18 — Restaurant access passcodes
--
-- Adds two shared, device-level passcodes per restaurant so a
-- single signed-in owner account can hand the iPad to floor staff
-- without exposing finance/settings/etc. The owner enters a 4-digit
-- code to unlock the full system; staff enter a different code that
-- pins the device to /pos in fullscreen mode.
--
-- This is INTENTIONALLY not the per-user team model — the existing
-- user_roles + team_invitations flow stays in place for when payroll
-- and per-employee auth matter. For pre-revenue pilots the kiosk
-- model is what restaurants actually use day-to-day.
--
-- Storage: sha256 hex of the passcode. The hash sits behind RLS so
-- only an authenticated user with restaurant access can read it,
-- and even with the hash a 4-digit space is brute-forceable — the
-- security boundary is "staff can't see what they shouldn't," not
-- "passcode survives a database leak." Hash is the minimum to keep
-- it out of casual sight (e.g. a DB browser); for stronger guarantees
-- we'd salt + bcrypt, but that's overkill for a 4-digit space.
--
-- Either column can be NULL. The access gate only enforces when the
-- owner code is set — a freshly-onboarded restaurant skips the gate
-- entirely so the owner isn't locked out of their own product.
-- ============================================================

alter table public.restaurants
  add column if not exists owner_passcode_hash text,
  add column if not exists staff_passcode_hash text;
