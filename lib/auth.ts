import { createClient } from '@/lib/supabase/server'

// ----------------------------------------------------------------
// Shared authorization helper
//
// Every server action and Server Component that needs to know
// "who is this user and what can they do?" calls this function.
//
// It returns:
//   supabase      — authenticated Supabase client
//   userId        — the auth user's UUID
//   restaurantId  — their restaurant
//   role          — 'owner' or 'manager'
//   locationId    — the location this user is scoped to:
//                     • owner: null (cross-location access)
//                     • manager: their assigned location_id
//   error         — null if everything is fine, string if not
//
// Location scoping logic:
//   • Owners: locationId is null → they can access any location
//     in the restaurant. Server actions that need a location_id
//     should accept it from the form or use a default.
//   • Managers: locationId is set → they can ONLY access this
//     location. Server actions must enforce this.
// ----------------------------------------------------------------

export interface AuthContext {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  restaurantId: string
  role: 'owner' | 'manager' | 'staff'
  locationId: string | null  // null = owner (all locations), set = scoped
}

export async function getAuthContext(): Promise<
  | { context: AuthContext; error: null }
  | { context: null; error: string }
> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { context: null, error: 'Not logged in.' }
  }

  const { data: userRole } = await supabase
    .from('user_roles')
    .select('restaurant_id, role, location_id')
    .eq('user_id', user.id)
    .single()

  if (!userRole) {
    return { context: null, error: 'No restaurant found.' }
  }

  return {
    context: {
      supabase,
      userId: user.id,
      restaurantId: userRole.restaurant_id,
      role: userRole.role as AuthContext['role'],
      locationId: userRole.location_id ?? null,
    },
    error: null,
  }
}

// ----------------------------------------------------------------
// resolveLocationId
//
// Determines which location_id to use for a write operation.
//
// Rules:
//   • Manager: MUST use their assigned location. If the form sends
//     a different location, it's rejected. This prevents a manager
//     from tampering with the form to write to another location.
//   • Owner: uses the location from the form. If none provided,
//     falls back to the restaurant's first location.
// ----------------------------------------------------------------
export async function resolveLocationId(
  ctx: AuthContext,
  formLocationId?: string | null
): Promise<{ locationId: string; error: string | null }> {
  // Manager: enforce their assigned location
  if (ctx.role === 'manager') {
    if (!ctx.locationId) {
      return { locationId: '', error: 'Manager has no assigned location.' }
    }
    // If form sends a location, it must match the manager's
    if (formLocationId && formLocationId !== ctx.locationId) {
      return { locationId: '', error: 'You do not have access to this location.' }
    }
    return { locationId: ctx.locationId, error: null }
  }

  // Owner: use form value or fall back to first location
  if (formLocationId) {
    // Verify the location belongs to this restaurant
    const { data: loc } = await ctx.supabase
      .from('locations')
      .select('id')
      .eq('id', formLocationId)
      .eq('restaurant_id', ctx.restaurantId)
      .single()

    if (!loc) {
      return { locationId: '', error: 'Location not found in your restaurant.' }
    }
    return { locationId: loc.id, error: null }
  }

  // No location provided — use first
  const { data: firstLoc } = await ctx.supabase
    .from('locations')
    .select('id')
    .eq('restaurant_id', ctx.restaurantId)
    .order('created_at', { ascending: true })
    .limit(1)
    .single()

  if (!firstLoc) {
    return { locationId: '', error: 'No location found.' }
  }
  return { locationId: firstLoc.id, error: null }
}

// ----------------------------------------------------------------
// logAudit
//
// Writes one row to audit_logs. Fire-and-forget — if it fails,
// the main action still succeeds. Audit should never block operations.
// ----------------------------------------------------------------
export async function logAudit(
  ctx: AuthContext,
  locationId: string | null,
  action: string,
  entityType?: string,
  entityId?: string,
  metadata?: Record<string, unknown>
) {
  try {
    await ctx.supabase.from('audit_logs').insert({
      restaurant_id: ctx.restaurantId,
      location_id: locationId,
      user_id: ctx.userId,
      action,
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
      metadata: metadata ?? null,
    })
  } catch {
    // Audit failure must never block the main operation
    console.error('Audit log write failed for action:', action)
  }
}

// ----------------------------------------------------------------
// formatError — shared across all server actions
// ----------------------------------------------------------------
export function formatError(
  step: string,
  err: { message?: string; code?: string } | null
): string {
  if (process.env.NODE_ENV === 'development' && err) {
    return `[DEV] ${step} failed — ${err.message ?? 'unknown error'}${err.code ? ` (code: ${err.code})` : ''}`
  }
  return `Could not create ${step}. Please try again.`
}
