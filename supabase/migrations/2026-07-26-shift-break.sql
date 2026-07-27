-- ============================================================
-- 2026-07-26 — unpaid break minutes on shifts
--
-- The redesigned shift drawer lets the manager set an unpaid
-- break per shift (None / 30 / 60 minutes today; free entry
-- later). Stored inline on the shift row so labor-cost math
-- has one denormalized read path.
--
-- Default 0 keeps every existing shift as "no break," which
-- matches how they were entered before this column existed.
-- Bounded 0..480 (8h) so a nonsense value can't sneak in and
-- flip paid hours negative in downstream reporting.
-- ============================================================

alter table public.shifts
  add column if not exists break_minutes integer not null default 0;

-- Named check so a future value tweak can drop-and-recreate
-- cleanly without dropping the column.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'shifts_break_minutes_check'
  ) then
    alter table public.shifts
      add constraint shifts_break_minutes_check
      check (break_minutes >= 0 and break_minutes <= 480);
  end if;
end$$;
