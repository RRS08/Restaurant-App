-- ============================================================
-- 2026-07-26 — manual reorder for employees.
--
-- Adds sort_order so the bench cards can be dragged into any
-- order the manager wants. Default 0 means "no preference" —
-- the client falls back to (role priority, name) when everyone
-- shares that value, so this migration doesn't disrupt any
-- existing UI on the first read.
--
-- reorderEmployees rewrites sort_order = 10 * index for the
-- whole visible bench, so the gap-of-10 pattern leaves room
-- for future in-between inserts without a full renumber.
-- ============================================================

alter table public.employees
  add column if not exists sort_order integer not null default 0;

-- Combined index so the sort_order lookup is cheap on the
-- restaurant-scoped queries the staffing page runs.
create index if not exists idx_employees_restaurant_sort
  on public.employees (restaurant_id, sort_order);
