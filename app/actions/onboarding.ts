'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'
import {
  BUSINESS_TYPE_LABEL,
  splitRolesForStorage,
  type BusinessType,
  type OnboardingAnswers,
  type SchedulingStyle,
  type TeamModel,
} from '@/lib/onboarding/types'
import { STARTER_MENU_SECTIONS, isRoleSelectionValid } from '@/lib/onboarding/defaults'

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
// completeOnboarding — single write path for the new flow.
//
// Uses the admin (service-role) client for all bootstrap writes
// to avoid the circular RLS dependency. The normal client is used
// only for auth.getUser() to identify the caller.
//
// Writes, in order:
//   1. restaurants
//   2. user_roles (owner)
//   3. locations (first location)
//   4. restaurant_setup_state (business_type + operating_mode)
//   5. staffing_config (team model + scheduling + role buckets)
//   6. menu_categories (starter sections from business type)
// ----------------------------------------------------------------
export async function completeOnboarding(
  prevState: { error: string } | null,
  formData: FormData
): Promise<{ error: string } | { ok: true; restaurantId: string; usesExternalPos: boolean }> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'You must be signed in to complete setup.' }

  let parsed: OnboardingAnswers
  try {
    const raw = formData.get('answers_json') as string | null
    if (!raw) return { error: 'Missing onboarding answers.' }
    parsed = JSON.parse(raw) as OnboardingAnswers
  } catch {
    return { error: 'Could not read onboarding answers.' }
  }

  const validBiz: BusinessType[] = ['full_service', 'quick_service', 'food_truck', 'cafe', 'bar']
  const validTeam: TeamModel[] = ['foh_boh', 'unified', 'prep_service']
  const validSched: SchedulingStyle[] = ['by_role', 'by_shift_block']

  if (!parsed.restaurantName?.trim()) return { error: 'Restaurant name is required.' }
  if (!parsed.locationName?.trim()) return { error: 'Location name is required.' }
  if (!validBiz.includes(parsed.businessType)) return { error: 'Unknown business type.' }
  if (!validTeam.includes(parsed.teamModel)) return { error: 'Unknown team model.' }
  if (!validSched.includes(parsed.schedulingStyle)) return { error: 'Unknown scheduling style.' }
  if (!isRoleSelectionValid(parsed.teamModel, parsed.rolesGroupA ?? [], parsed.rolesGroupB ?? [])) {
    return { error: 'Pick at least one role in each section.' }
  }

  // 1. Restaurant
  const { data: restaurant, error: restErr } = await admin
    .from('restaurants')
    .insert({ name: parsed.restaurantName.trim(), owner_user_id: user.id })
    .select('id')
    .single()
  if (restErr || !restaurant) return { error: formatError('restaurant', restErr) }

  // 2. Owner role
  const { error: roleErr } = await admin.from('user_roles').insert({
    user_id: user.id, restaurant_id: restaurant.id, role: 'owner',
  })
  if (roleErr) return { error: formatError('owner role', roleErr) }

  // 3. First location
  const { error: locErr } = await admin.from('locations').insert({
    restaurant_id: restaurant.id,
    name: parsed.locationName.trim(),
    address: parsed.locationAddress?.trim() || null,
    timezone: parsed.locationTimezone || 'UTC',
  })
  if (locErr) return { error: formatError('location', locErr) }

  // 4. Setup state: business_type + operating_mode
  const operatingMode = parsed.usesExternalPos ? 'external_pos' : 'native_pos'
  const { error: stateErr } = await admin
    .from('restaurant_setup_state')
    .upsert({
      restaurant_id: restaurant.id,
      operating_mode: operatingMode,
      business_type: parsed.businessType,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'restaurant_id' })
  if (stateErr) return { error: formatError('setup state', stateErr) }

  // 5. Staffing config
  const { fohRoles, bohRoles } = splitRolesForStorage(
    parsed.teamModel, parsed.rolesGroupA, parsed.rolesGroupB
  )
  const { error: staffErr } = await admin
    .from('staffing_config')
    .upsert({
      restaurant_id: restaurant.id,
      house_model: parsed.teamModel,
      scheduling_style: parsed.schedulingStyle,
      foh_roles: fohRoles,
      boh_roles: bohRoles,
      setup_complete: true,
    }, { onConflict: 'restaurant_id' })
  if (staffErr) return { error: formatError('staffing config', staffErr) }

  // 6. Starter menu categories
  const starter = STARTER_MENU_SECTIONS[parsed.businessType]
  const toInsert = starter.map((name, i) => ({
    restaurant_id: restaurant.id, name, sort_order: i + 1, source: 'manual' as const,
  }))
  if (toInsert.length > 0) {
    await admin.from('menu_categories').insert(toInsert)
  }

  return { ok: true, restaurantId: restaurant.id, usesExternalPos: parsed.usesExternalPos }
}

// ----------------------------------------------------------------
// getOnboardingContext — read helper for preview screens.
// Returns the persisted onboarding answers so preview pages can
// render business-type-shaped content without re-asking anything.
// ----------------------------------------------------------------
export async function getOnboardingContext(): Promise<
  | { ok: true; businessType: BusinessType; businessTypeLabel: string; operatingMode: 'native_pos' | 'external_pos' | null; teamModel: TeamModel; schedulingStyle: SchedulingStyle; rolesGroupA: string[]; rolesGroupB: string[] }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not authenticated.' }

  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role?.restaurant_id) return { ok: false, error: 'No restaurant found.' }

  const [{ data: setup }, { data: staffing }] = await Promise.all([
    supabase.from('restaurant_setup_state')
      .select('business_type, operating_mode')
      .eq('restaurant_id', role.restaurant_id)
      .maybeSingle(),
    supabase.from('staffing_config')
      .select('house_model, scheduling_style, foh_roles, boh_roles')
      .eq('restaurant_id', role.restaurant_id)
      .maybeSingle(),
  ])

  if (!setup?.business_type) return { ok: false, error: 'Onboarding incomplete.' }

  const bt = setup.business_type as BusinessType
  return {
    ok: true,
    businessType: bt,
    businessTypeLabel: BUSINESS_TYPE_LABEL[bt],
    operatingMode: (setup.operating_mode ?? null) as 'native_pos' | 'external_pos' | null,
    teamModel: (staffing?.house_model ?? 'unified') as TeamModel,
    schedulingStyle: (staffing?.scheduling_style ?? 'by_shift_block') as SchedulingStyle,
    rolesGroupA: staffing?.foh_roles ?? [],
    rolesGroupB: staffing?.boh_roles ?? [],
  }
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
