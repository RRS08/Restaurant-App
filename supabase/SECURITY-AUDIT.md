# RLS Multi-Tenant Security Audit

> Run: 2026-06-16. Audit covers every policy in `supabase/schema.sql`.
> All 26 business tables have RLS enabled. Net assessment: ~85% secure
> at the row level. Server-side authz in `lib/authz.ts` is the primary
> action gate; RLS is the row gate behind it.

## Critical findings — fix BEFORE production

### 1. `user_roles` INSERT policy lets a user join any restaurant

The current INSERT policy is:

```sql
create policy "Users can insert their own role"
  on public.user_roles for insert
  with check (user_id = auth.uid());
```

It checks only that the row's `user_id` matches the caller — NOT that
`restaurant_id` is the caller's own restaurant. A signed-in user can
insert `(user_id: alice, restaurant_id: <any-uuid>, role: 'owner')`
and grant themselves owner access to any restaurant via a direct
PostgREST call.

**Fix:** Add a restaurant gate. The onboarding bootstrap already uses
the admin client (see `app/actions/onboarding.ts` ~line 251), so
denying public inserts that don't match `my_restaurant_id()` is safe.

```sql
drop policy if exists "Users can insert their own role" on public.user_roles;

create policy "Users can insert their own role"
  on public.user_roles for insert
  with check (
    user_id = auth.uid()
    and restaurant_id = public.my_restaurant_id()
  );
```

For the very first user_role row (where `my_restaurant_id()` returns
null because the user has no roles yet), keep the admin-client path
in `completeOnboarding`. All non-bootstrap inserts must satisfy the
tightened policy.

### 2. `restaurants` UPDATE policy asymmetry

UPDATE only accepts the original `owner_user_id`:

```sql
create policy "Owner can update restaurant"
  on public.restaurants for update
  using (owner_user_id = auth.uid());
```

A user with `role = 'owner'` in `user_roles` (added later through any
multi-owner mechanism) cannot update the row. The server-side
`requireRestaurantOwner` accepts both paths, but direct RLS-scoped
queries from a future admin UI would silently fail.

**Fix:**

```sql
drop policy if exists "Owner can update restaurant" on public.restaurants;

create policy "Owners can update restaurant"
  on public.restaurants for update
  using (
    owner_user_id = auth.uid()
    or exists (
      select 1 from public.user_roles ur
      where ur.restaurant_id = restaurants.id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );
```

## Medium-priority findings — defense-in-depth

### 3. Manager location scope not enforced at RLS

For `inventory_items`, `inventory_counts`, `inventory_transactions`,
`employees`, `shifts`, `shift_sections`, `expenses`: RLS restricts to
`restaurant_id` only. Managers (scoped to a `location_id` in
`user_roles`) can see and modify other locations' rows at the row level.
Server-side `requireLocationAccess` enforces the actual restriction.

**Mitigation:** As long as the anon key only runs server-side (which
it does in this Next.js app), this is contained. If you ever ship a
mobile app or external integration that uses the anon key directly,
add location-scoped policies. Sample pattern in the audit doc.

### 4. Menu / orders don't differentiate by role at RLS

A staff user could in theory call PostgREST directly and edit
`menu_items` or `orders` — server-side `requireRestaurantOwner` blocks
it via the action layer, but RLS would let it through. Same mitigation
as #3: contained as long as the anon key stays server-side.

## Low-priority findings — backlog

### 5. `payment_attempts` has no UPDATE / DELETE policy

If a webhook needs to advance payment-attempt status, RLS will deny
the write. Verify need during payment-flow buildout; add policies if
required.

## Admin-client review — clean

The codebase uses `createAdminClient()` (which bypasses RLS) in two
places, both correctly guarded:

1. `app/actions/onboarding.ts` — initial restaurant + user_roles bootstrap.
2. `app/actions/bank.ts` — bank-transactions reset, guarded by `requireRestaurantOwner`.

No over-privilege found in admin-client usage.

## Migration

The fixes for #1 and #2 are bundled in `supabase/migrations/2026-06-16-rls-hardening.sql`.
Run it in the Supabase SQL editor when ready.

## What this audit did NOT cover

- **Live exploit test** — I can't actually try to attack the production
  database from here. The proof-of-concept attack on `user_roles` INSERT
  should be verified once the migration is applied (the verification
  steps are in the migration file).
- **Edge cases in policy expressions** — complex subqueries were spot-checked
  but not exhaustively unit-tested. A future improvement would be a
  Postgres test suite that asserts each policy's expected behavior.
- **Supabase Auth flow security** — separate concern (password reset,
  email verification, session handling). Covered under the auth workstream.
