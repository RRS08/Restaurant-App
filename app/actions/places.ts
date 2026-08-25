'use server'

// ----------------------------------------------------------------
// Places selection — server action that flips the active place
// cookie and lands the operator on the picked place's dashboard.
//
// Called from the picker tile's <form action={selectPlace}> so it
// stays inside the standard server-action envelope: the response
// carries a Set-Cookie header and a redirect, no JS required for
// the swap to work. Cross-restaurant tampering is guarded on the
// verify step — a place id from another tenant is refused, so a
// stolen cookie value never elevates access.
// ----------------------------------------------------------------

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ACTIVE_PLACE_COOKIE, ACTIVE_PLACE_MAX_AGE_SECONDS } from '@/lib/places'

export async function selectPlace(formData: FormData): Promise<void> {
  const placeId = (formData.get('place_id') as string | null)?.trim()
  if (!placeId) redirect('/places')

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRole } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!userRole) redirect('/onboarding')

  // Verify the requested place actually belongs to this operator's
  // restaurant. Without this guard, a manually-crafted form POST
  // could set the cookie to any location id on the planet.
  const { data: place } = await supabase
    .from('locations')
    .select('id')
    .eq('id', placeId)
    .eq('restaurant_id', userRole.restaurant_id)
    .maybeSingle()
  if (!place) redirect('/places')

  const jar = await cookies()
  jar.set(ACTIVE_PLACE_COOKIE, place.id as string, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ACTIVE_PLACE_MAX_AGE_SECONDS,
  })

  // Landing on /dashboard drops the operator into that place's
  // workspace. The dashboard itself renders per-place content off
  // resolveActivePlace(), so the swap is fully server-driven.
  redirect('/dashboard')
}

/** Clear the active place cookie and land back on /places. Wired
 *  from the sidebar's "Change place" affordance so the operator
 *  can pivot between locations without a full sign-out. */
export async function changePlace(): Promise<void> {
  const jar = await cookies()
  jar.delete(ACTIVE_PLACE_COOKIE)
  redirect('/places')
}
