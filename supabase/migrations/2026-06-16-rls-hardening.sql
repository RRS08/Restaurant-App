-- ============================================================
-- 2026-06-16 — RLS Hardening
--
-- Fixes the two critical findings from supabase/SECURITY-AUDIT.md:
--
--   1. user_roles INSERT lets any authenticated user grant themselves
--      a role in ANY restaurant. We add a restaurant_id gate so
--      non-bootstrap inserts must target the caller's own restaurant.
--      The onboarding bootstrap uses the admin client (which bypasses
--      RLS), so the first user_role row for a brand-new owner still
--      goes through cleanly.
--
--   2. restaurants UPDATE only accepts the original owner_user_id,
--      breaking RLS-scoped updates from users with role='owner' in
--      user_roles. We add an OR clause that accepts either path,
--      matching the server-side requireRestaurantOwner behavior.
--
-- Run this in the Supabase SQL Editor.
-- ============================================================

-- ------------------------------------------------------------
-- 1. user_roles INSERT — add restaurant_id gate
-- ------------------------------------------------------------

drop policy if exists "Users can insert their own role" on public.user_roles;

create policy "Users can insert their own role"
  on public.user_roles for insert
  with check (
    user_id = auth.uid()
    and restaurant_id = public.my_restaurant_id()
  );

-- ------------------------------------------------------------
-- 2. restaurants UPDATE — accept either owner_user_id OR role='owner'
-- ------------------------------------------------------------

drop policy if exists "Owner can update restaurant" on public.restaurants;

create policy "Owners can update restaurant"
  on public.restaurants for update
  using (
    owner_user_id = auth.uid()
    or exists (
      select 1
      from public.user_roles ur
      where ur.restaurant_id = restaurants.id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );

-- ============================================================
-- Verification — run these AFTER applying the migration above.
-- They should all behave as the comments describe.
-- ============================================================

-- Verification 1: A signed-in user cannot insert a role into a
-- restaurant they don't belong to.
--
--   Expected: ERROR — new row violates row-level security policy
--
-- Test as a non-owner user via the anon Supabase client:
--
--   insert into public.user_roles (user_id, restaurant_id, role)
--   values (auth.uid(), '<some-other-restaurant-uuid>', 'owner');

-- Verification 2: A user with role='owner' (added later via the
-- admin client, not the original owner_user_id) can update their
-- restaurant row.
--
--   Expected: 1 row updated.
--
--   update public.restaurants
--     set name = name
--     where id = public.my_restaurant_id();

-- Verification 3: A user from Restaurant A cannot update Restaurant B.
--
--   Expected: 0 rows updated (silently — RLS filters the row out).
--
--   update public.restaurants
--     set name = 'pwned'
--     where id = '<restaurant-B-uuid>';
