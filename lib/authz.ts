// ----------------------------------------------------------------
// Server-side Authorization Guards
//
// Small, typed, throw-on-failure guard layer that reinforces the
// current security model across server actions, route handlers, and
// Server Components.
//
// Design notes:
//   • Throw-on-failure style (not { context, error } returns) so call
//     sites stay short: one `await require…` line at the top of an
//     action, then the action code assumes a valid context.
//   • Throws a single typed error class (`AuthzError`) with a stable
//     `.status` hint so API / route handlers can map it to HTTP.
//   • Guards are tiny wrappers over one private resolver —
//     `getRestaurantAccessContext` — which hits the DB once and
//     caches nothing. That keeps behavior predictable and avoids
//     request-scoped state that could leak between requests.
//   • Reuses the existing Supabase server client. Does NOT replace
//     `lib/auth.ts`'s `getAuthContext` — the older function is still
//     the right tool for the graceful-return pattern inside existing
//     server actions. New actions can use either; sensitive writes
//     should prefer the throw-style guards here.
//
// Role model (from user_roles.role check constraint):
//   'owner'    → full access across the restaurant's locations
//   'manager'  → scoped to one location_id stored on user_roles
//
// Staff / other roles are intentionally NOT represented. When/if
// they're added, this module is the single place that needs to know
// about them.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

// ================================================================
// Types
// ================================================================

export type AuthzRole = 'owner' | 'manager'

/**
 * The shape every guard resolves to (or returns, for the non-
 * location guards). Kept deliberately narrow.
 */
export interface RestaurantAccessContext {
  supabase: SupabaseClient
  userId: string
  restaurantId: string
  role: AuthzRole
  /**
   * The location a manager is scoped to.
   *   • owner   → null (no scope restriction)
   *   • manager → the single location_id the manager can touch
   */
  managedLocationId: string | null
}

/**
 * Minimal "just tell me who's signed in" context. Used by `requireSelf`
 * and any action that doesn't care about restaurants yet.
 */
export interface AuthenticatedUser {
  supabase: SupabaseClient
  userId: string
}

// ================================================================
// Typed error
// ================================================================

/**
 * Every guard in this module throws `AuthzError` on failure. The
 * `.status` hint lets route handlers / API layers translate to HTTP
 * cleanly without introducing an HTTP dependency here.
 *
 *   401 — not authenticated
 *   403 — authenticated but not allowed (includes the "not a member
 *         of this restaurant" case, deliberately collapsed into 403
 *         for opacity — we don't want to leak the existence of
 *         restaurants to non-members)
 *
 * The `.code` field discriminates the specific reason for logs and
 * for call sites that want to branch on something more meaningful
 * than an HTTP status.
 */
export class AuthzError extends Error {
  public readonly status: 401 | 403
  public readonly code:
    | 'not_authenticated'
    | 'not_a_member'
    | 'not_owner'
    | 'not_this_location'
    | 'not_self'
    | 'invalid_manager_config'

  constructor(
    code: AuthzError['code'],
    message: string,
    status: 401 | 403
  ) {
    super(message)
    this.name = 'AuthzError'
    this.code = code
    this.status = status
  }
}

// ================================================================
// Guard 1 — requireAuthenticatedUser
// ================================================================

/**
 * Resolves the current user from Supabase auth. Throws `AuthzError`
 * with status 401 if nobody is signed in.
 *
 * Use when an action only needs "a signed-in user" and doesn't care
 * about restaurant membership yet (e.g. onboarding's first step).
 */
export async function requireAuthenticatedUser(): Promise<AuthenticatedUser> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    throw new AuthzError('not_authenticated', 'Not authenticated.', 401)
  }
  return { supabase, userId: user.id }
}

// ================================================================
// Guard 2 — getRestaurantAccessContext (core resolver)
// ================================================================

/**
 * Core access resolver. Given a `restaurantId`, figures out whether
 * the current user has any relationship with that restaurant and,
 * if so, whether they're an owner or a manager.
 *
 * Throws:
 *   401 AuthzError('not_authenticated') — no signed-in user
 *   403 AuthzError('not_a_member')      — signed in but not part
 *                                          of this restaurant
 *
 * Recognizes ownership two ways (mirrors the SQL helper functions):
 *   1. `restaurants.owner_user_id = auth.uid()` — the original owner
 *      row written during onboarding.
 *   2. A `user_roles` row with `role = 'owner'` — multi-owner setups
 *      or future cases where ownership is reassigned.
 *
 * Managers come from `user_roles` rows with `role = 'manager'` and
 * carry their assigned `location_id`.
 *
 * Precedence: owner > manager. If the same user has both (unlikely
 * but possible), they're treated as an owner — no manager scope.
 */
export async function getRestaurantAccessContext(
  restaurantId: string
): Promise<RestaurantAccessContext> {
  const { supabase, userId } = await requireAuthenticatedUser()

  // Check direct ownership via restaurants.owner_user_id first — it's
  // a single-row lookup and covers the onboarding path.
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('id, owner_user_id')
    .eq('id', restaurantId)
    .maybeSingle()

  const isDirectOwner =
    restaurant !== null && restaurant.owner_user_id === userId

  // Look up any user_roles row for this user + restaurant. Pick the
  // most privileged one (owner > manager) if both exist.
  const { data: roleRows } = await supabase
    .from('user_roles')
    .select('role, location_id')
    .eq('user_id', userId)
    .eq('restaurant_id', restaurantId)

  const rows = (roleRows ?? []) as Array<{ role: string; location_id: string | null }>
  const hasOwnerRole = rows.some((r) => r.role === 'owner')
  const managerRow = rows.find((r) => r.role === 'manager')

  if (isDirectOwner || hasOwnerRole) {
    return {
      supabase,
      userId,
      restaurantId,
      role: 'owner',
      managedLocationId: null,
    }
  }

  if (managerRow) {
    // A manager MUST have a real assigned location. A row with
    // location_id = null is an invalid configuration — better to
    // fail clearly here than to let the user through and crash
    // later inside requireLocationAccess with a misleading message.
    if (!managerRow.location_id) {
      throw new AuthzError(
        'invalid_manager_config',
        'Your manager role has no assigned location. Please contact an owner.',
        403
      )
    }
    return {
      supabase,
      userId,
      restaurantId,
      role: 'manager',
      managedLocationId: managerRow.location_id,
    }
  }

  throw new AuthzError(
    'not_a_member',
    'You do not have access to this restaurant.',
    403
  )
}

// ================================================================
// Guard 3 — requireRestaurantOwner
// ================================================================

/**
 * Throws unless the current user is an owner of the given restaurant.
 *
 * Use for owner-only actions: user role management, setup state
 * changes, external POS connection writes, bank integration writes,
 * global menu/config writes, staffing config writes, dev / admin
 * overrides. Anything sensitive.
 */
export async function requireRestaurantOwner(
  restaurantId: string
): Promise<RestaurantAccessContext> {
  const ctx = await getRestaurantAccessContext(restaurantId)
  if (ctx.role !== 'owner') {
    throw new AuthzError(
      'not_owner',
      'Only the owner can perform this action.',
      403
    )
  }
  return ctx
}

// ================================================================
// Guard 4 — requireLocationAccess
// ================================================================

/**
 * Throws unless the current user can operate on the given location.
 *
 *   • Owners pass for any location within their restaurant.
 *   • Managers pass only when `managedLocationId === locationId`.
 *
 * Use for location-scoped operational actions: orders, inventory,
 * employees, shifts, expenses — anything a single-store manager
 * should be able to touch for their own store but not across stores.
 */
export async function requireLocationAccess(
  restaurantId: string,
  locationId: string
): Promise<RestaurantAccessContext> {
  const ctx = await getRestaurantAccessContext(restaurantId)

  if (ctx.role === 'owner') return ctx

  if (ctx.role === 'manager' && ctx.managedLocationId === locationId) {
    return ctx
  }

  throw new AuthzError(
    'not_this_location',
    'You do not have access to this location.',
    403
  )
}

// ================================================================
// Guard 5 — requireSelf
// ================================================================

/**
 * Throws unless the current signed-in user's id equals `userId`.
 *
 * Use for self-only actions: profile updates, personal preferences,
 * anything keyed by `auth.uid()` that should never be touched by
 * anyone else.
 */
export async function requireSelf(userId: string): Promise<AuthenticatedUser> {
  const authed = await requireAuthenticatedUser()
  if (authed.userId !== userId) {
    throw new AuthzError(
      'not_self',
      'You can only perform this action on your own account.',
      403
    )
  }
  return authed
}
