-- ============================================================
-- 2026-07-26 — employee profile: trained roles, employment,
-- weekly availability.
--
-- Three new columns on employees for the redesigned drawer:
--
--   trained_roles  jsonb[]   Extra role names this person is
--                            trained on beyond employees.role
--                            (their primary role). Order-preserved
--                            display, stored as normalized-key
--                            strings so shift.role comparisons
--                            work uniformly. Empty by default.
--
--   employment     text      'part_time' | 'full_time'. Drives
--                            OT warning thresholds (28h vs 40h)
--                            in future labor-cost surfaces.
--                            Defaults to part_time.
--
--   availability   jsonb[]   7-boolean array, Mon..Sun. Used by
--                            quickAssignShift to block assigning
--                            someone to a day they're unavailable.
--                            Defaults to all-true (open week).
--
-- All defaults chosen so every existing row is instantly valid
-- and the drawer can safely read + write without a data-fix.
-- ============================================================

alter table public.employees
  add column if not exists trained_roles jsonb not null default '[]'::jsonb,
  add column if not exists employment text not null default 'part_time',
  add column if not exists availability jsonb not null default '[true,true,true,true,true,true,true]'::jsonb;

-- Employment value guard — matches the two-option segmented
-- picker in the drawer. Extend the check if we ever add
-- 'contractor' or other statuses.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'employees_employment_check'
  ) then
    alter table public.employees
      add constraint employees_employment_check
      check (employment in ('part_time', 'full_time'));
  end if;
end$$;
