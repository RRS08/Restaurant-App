-- ============================================================
-- 2026-07-23 — role_colors on staffing_config
--
-- Lets the owner pick a color for each role instead of relying
-- on the auto-color regex that matches known role names
-- (server, cook, host, etc.). Custom roles like "cashier" fell
-- back to gray with no way to override; this JSONB map is the
-- override storage.
--
-- Shape: { <normalized role key>: <color slug> }
-- Color slugs correspond to Tailwind tone families the
-- staffing client already uses:
--   'purple' | 'teal' | 'rose' | 'slate' | 'emerald' |
--   'zinc'   | 'stone'| 'red'  | 'lime'  | 'violet'  |
--   'amber'  | 'sky'  | 'gray'
--
-- Storing normalized keys (lowercase, trimmed) so the lookup
-- matches regardless of whether the role was typed "Cashier"
-- or "cashier".
--
-- Old rows default to '{}' so behavior is unchanged until the
-- owner explicitly picks a color.
-- ============================================================

alter table public.staffing_config
  add column if not exists role_colors jsonb not null default '{}'::jsonb;
