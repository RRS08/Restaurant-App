-- ============================================================
-- 2026-07-26 — role_wages on staffing_config
--
-- Wages are moving from per-employee (employees.hourly_rate) to
-- per-role (staffing_config.role_wages). The role map is a
-- normalized-key JSONB — e.g. {"cashier": 17.5, "server": 18.0}
-- — so the staffing calendar can show and edit one rate per
-- role without touching the employees table.
--
-- Existing employees.hourly_rate stays as-is for now; when the
-- labor-cost surface lands it'll prefer role_wages[role_key] and
-- fall back to employees.hourly_rate as an override slot.
--
-- Non-null default '{}' so every existing config row starts with
-- a valid (empty) map; the setRoleWage server action can then
-- upsert entries without a null-check dance.
-- ============================================================

alter table public.staffing_config
  add column if not exists role_wages jsonb not null default '{}'::jsonb;
