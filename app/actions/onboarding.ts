'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'

export async function createRestaurantAndLocation(
  prevState: { error: string } | null,
  formData: FormData
) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { error: 'You must be logged in to complete setup.' }
  }

  const restaurantName = (formData.get('restaurant_name') as string)?.trim()
  const locationName = (formData.get('location_name') as string)?.trim()
  const address = (formData.get('address') as string)?.trim()
  const timezone = (formData.get('timezone') as string) || 'UTC'

  if (!restaurantName) {
    return { error: 'Restaurant name is required.' }
  }
  if (!locationName) {
    return { error: 'Location name is required.' }
  }

  // ---- Step 1: Create the restaurant ----
  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .insert({
      name: restaurantName,
      owner_user_id: user.id,
    })
    .select()
    .single()

  if (restaurantError || !restaurant) {
    console.error('Restaurant creation failed:', restaurantError)
    return { error: formatError('restaurant', restaurantError) }
  }

  // ---- Step 2: Assign the owner role ----
  //
  // THIS MUST HAPPEN BEFORE creating the location.
  //
  // Why: the RLS policy on `locations` for INSERT is:
  //   with check (restaurant_id = public.my_restaurant_id())
  //
  // my_restaurant_id() reads from user_roles. If user_roles doesn't
  // exist yet when we try to insert the location, my_restaurant_id()
  // returns NULL, the check fails, and the insert is blocked by RLS.
  //
  // Creating user_roles first means my_restaurant_id() returns the
  // correct restaurant.id when the location insert runs.
  const { error: roleError } = await supabase.from('user_roles').insert({
    user_id: user.id,
    restaurant_id: restaurant.id,
    role: 'owner',
  })

  if (roleError) {
    console.error('Role assignment failed:', roleError)
    return { error: formatError('owner role', roleError) }
  }

  // ---- Step 3: Create the first location ----
  // Now that user_roles exists, my_restaurant_id() returns restaurant.id
  // and the RLS check passes.
  const { error: locationError } = await supabase.from('locations').insert({
    restaurant_id: restaurant.id,
    name: locationName,
    address: address || null,
    timezone,
  })

  if (locationError) {
    console.error('Location creation failed:', locationError)
    return { error: formatError('location', locationError) }
  }

  redirect('/dashboard')
}

// ----------------------------------------------------------------
// setOperatingMode
//   Owner-only. Upserts restaurant_setup_state with the chosen mode.
//   Manual sales are NOT an operating mode — only native_pos and
//   external_pos are accepted.
// ----------------------------------------------------------------
export async function setOperatingMode(
  prevState: { error: string } | null,
  formData: FormData
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }

  // Resolve which restaurant this action operates on. We still need
  // the lookup because the action signature doesn't carry a
  // restaurant_id parameter — the guard below then enforces that
  // the signed-in user is actually an owner of it.
  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!roleRow?.restaurant_id) return { error: 'No restaurant found.' }

  // Centralized owner-only guard — replaces the inline role check.
  // Writes to restaurant_setup_state are sensitive and must be
  // restricted to restaurant owners.
  try {
    await requireRestaurantOwner(roleRow.restaurant_id)
  } catch (err) {
    if (err instanceof AuthzError) return { error: err.message }
    throw err
  }

  const raw = (formData.get('operating_mode') as string)?.trim()
  if (raw !== 'native_pos' && raw !== 'external_pos') {
    return { error: 'Operating mode must be native_pos or external_pos.' }
  }

  const { error } = await supabase
    .from('restaurant_setup_state')
    .upsert(
      { restaurant_id: roleRow.restaurant_id, operating_mode: raw, updated_at: new Date().toISOString() },
      { onConflict: 'restaurant_id' }
    )

  if (error) return { error: formatError('operating mode', error) }
  return null
}

// ----------------------------------------------------------------
// activateInventory
//   Owner-only. The explicit "turn on live tracking" moment.
//   Preconditions: at least 1 inventory item and at least 1 recorded
//   count (the baseline). Idempotent.
// ----------------------------------------------------------------
export async function activateInventory(
  prevState: { error: string } | null,
  _formData: FormData
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }

  // Resolve the restaurant this action operates on (see
  // setOperatingMode comment for why).
  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!roleRow?.restaurant_id) return { error: 'No restaurant found.' }

  // Owner-only — activation flips the inventory bridge live and is
  // sensitive enough to require the highest-privileged role.
  try {
    await requireRestaurantOwner(roleRow.restaurant_id)
  } catch (err) {
    if (err instanceof AuthzError) return { error: err.message }
    throw err
  }

  const { data: items } = await supabase
    .from('inventory_items')
    .select('id')
    .eq('active', true)
    .limit(1)
  if (!items || items.length === 0) {
    return { error: 'Add at least one inventory item before activating.' }
  }

  const { data: counts } = await supabase
    .from('inventory_counts')
    .select('id')
    .limit(1)
  if (!counts || counts.length === 0) {
    return { error: 'Record an initial count before activating tracking.' }
  }

  const { error } = await supabase
    .from('restaurant_setup_state')
    .upsert(
      {
        restaurant_id: roleRow.restaurant_id,
        inventory_activated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'restaurant_id' }
    )

  if (error) return { error: formatError('inventory activation', error) }
  return null
}

// ----------------------------------------------------------------
// formatError — surfaces the real Supabase error in development
//
// In production, users see a friendly message.
// In development (your local machine), you see the exact Supabase
// error code and message so you can diagnose problems quickly.
// ----------------------------------------------------------------
function formatError(
  step: string,
  err: { message?: string; code?: string; details?: string } | null
): string {
  if (process.env.NODE_ENV === 'development' && err) {
    return `[DEV] ${step} failed — ${err.message ?? 'unknown error'}${err.code ? ` (code: ${err.code})` : ''}`
  }
  return `Could not create ${step}. Please try again.`
}
