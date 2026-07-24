-- ============================================================
-- 2026-07-23 — native_pos_enabled toggle
--
-- Lets an owner unlock the in-app POS while their restaurant
-- is still primarily on an external POS (GoDaddy Poynt, Square,
-- etc.). Set at Settings → "Activate local POS." When true, the
-- sidebar shows the /pos link even for external_pos merchants;
-- when false, behavior is unchanged.
--
-- Existing external_pos rows default to false so behavior is
-- backward-compatible: nothing appears until the owner opts in.
-- Native_pos merchants are unaffected — they always see the POS
-- link regardless of this flag.
--
-- Doesn't touch operating_mode itself. A merchant staying on
-- external_pos as their "source of truth" while trialing the
-- in-app POS should keep the mode reflecting where sales
-- actually flow from, and just add on the second surface via
-- this flag. Later, if the trial converts, the mode can flip.
-- ============================================================

alter table public.restaurant_setup_state
  add column if not exists native_pos_enabled boolean not null default false;
