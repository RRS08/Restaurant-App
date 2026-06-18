'use server'

// ----------------------------------------------------------------
// Access passcode server actions
//
// The kiosk model: one owner email account signs into the device,
// then a 4-digit passcode decides which "mode" the device is in.
// Owner mode unlocks the full system. Staff mode pins the device
// to /pos in fullscreen, and signing out also requires the owner
// passcode (so staff can't end the session and walk off with the
// device).
//
// Mode is tracked by an httpOnly cookie `pos_mode` set here, read
// by proxy.ts. Owner mode = 30 days (a typical owner won't want
// to re-enter daily on their own device). Staff mode = 12 hours
// (one shift) — re-prompt at the start of each new shift.
// ----------------------------------------------------------------

import { createHash } from 'crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

const POS_MODE_COOKIE = 'pos_mode'
const OWNER_MODE_MAX_AGE = 60 * 60 * 24 * 30   // 30 days
const STAFF_MODE_MAX_AGE = 60 * 60 * 12        // 12 hours

// SHA-256 of the passcode, hex-encoded. The hash sits behind RLS
// and is never sent to the client. See migration for the threat
// model — a 4-digit space is brute-forceable, so the boundary is
// "casual sight" not "leaked database."
function hashPasscode(passcode: string): string {
  return createHash('sha256').update(passcode).digest('hex')
}

function isValidPasscode(s: string): boolean {
  return /^\d{4}$/.test(s)
}

// ----------------------------------------------------------------
// setPasscodes — owner sets/changes both passcodes from Settings.
//
// Either field can be left blank to clear that passcode. Clearing
// the owner passcode disables the gate entirely (and implicitly
// clears the staff passcode too, since staff mode would be
// nonsensical without an owner code to escape back to). Setting
// the owner passcode for the first time enables the gate; the
// caller's current device is auto-bumped into owner mode so they
// don't get locked out mid-config.
// ----------------------------------------------------------------
export async function setPasscodes(
  prevState: { error?: string; ok?: boolean } | null,
  formData: FormData,
): Promise<{ error?: string; ok?: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Owner-only. We resolve the restaurant via user_roles and reject
  // anyone whose role isn't 'owner'. The reason this isn't pushed
  // down to RLS only: the staff_passcode_hash UPDATE would otherwise
  // succeed silently for non-owners since restaurants UPDATE is
  // restaurant-scoped, not role-scoped.
  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('restaurant_id, role')
    .eq('user_id', user.id)
    .single()
  if (!roleRow) return { error: 'No restaurant found.' }
  if (roleRow.role !== 'owner') return { error: 'Only the owner can set access codes.' }

  const rawOwner = (formData.get('owner_passcode') as string | null)?.trim() ?? ''
  const rawStaff = (formData.get('staff_passcode') as string | null)?.trim() ?? ''

  // Blank means "don't change this one." Use an explicit "clear" form
  // field if the owner wants to remove a code (the UI surfaces a
  // separate "Disable" button rather than overloading the input).
  const keepOwner = rawOwner === ''
  const keepStaff = rawStaff === ''

  if (!keepOwner && !isValidPasscode(rawOwner)) {
    return { error: 'Owner code must be 4 digits.' }
  }
  if (!keepStaff && !isValidPasscode(rawStaff)) {
    return { error: 'Staff code must be 4 digits.' }
  }
  // Don't let owner + staff collapse to the same hash — then staff
  // mode would also pass the owner check and undo the whole point.
  if (!keepOwner && !keepStaff && rawOwner === rawStaff) {
    return { error: 'Owner and staff codes must be different.' }
  }

  const update: Record<string, string> = {}
  if (!keepOwner) update.owner_passcode_hash = hashPasscode(rawOwner)
  if (!keepStaff) update.staff_passcode_hash = hashPasscode(rawStaff)

  if (Object.keys(update).length === 0) {
    return { ok: true }
  }

  const { error } = await supabase
    .from('restaurants')
    .update(update)
    .eq('id', roleRow.restaurant_id)

  if (error) return { error: 'Could not save access codes.' }

  // If we just set the owner code for the first time, auto-bump the
  // caller into owner mode so they don't get redirected to /access
  // on the next request. Without this the owner-only setup screen
  // would kick its own author out as soon as they save.
  if (!keepOwner) {
    const c = await cookies()
    c.set(POS_MODE_COOKIE, 'owner', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: OWNER_MODE_MAX_AGE,
    })
  }

  return { ok: true }
}

// ----------------------------------------------------------------
// clearStaffPasscode — owner toggles staff mode off. Owner code
// stays set; the gate still enforces (anyone entering the device
// will be asked for the owner code). Staff mode just becomes
// unavailable.
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// lockDevice — clears the pos_mode cookie WITHOUT signing out. The
// auth session stays alive; the next protected page request is
// redirected to /access for a fresh code entry.
//
// Use cases:
//   • Owner hands the device to a server and wants the staff code
//     prompt to come up
//   • Testing the gate after configuring codes (otherwise the
//     setPasscodes auto-bump cookie stays valid for 30 days)
// ----------------------------------------------------------------
export async function lockDevice(_formData?: FormData): Promise<void> {
  const c = await cookies()
  c.delete(POS_MODE_COOKIE)
  redirect('/access')
}

export async function clearStaffPasscode(_formData?: FormData): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('restaurant_id, role')
    .eq('user_id', user.id)
    .single()
  if (!roleRow || roleRow.role !== 'owner') return

  await supabase
    .from('restaurants')
    .update({ staff_passcode_hash: null })
    .eq('id', roleRow.restaurant_id)
  // The Settings page re-fetches on the next render so the "Disable
  // staff code" button disappears automatically — no toast needed.
}

// ----------------------------------------------------------------
// enterAccessMode — verifies a submitted passcode and sets the
// pos_mode cookie. Called from the /access entry form.
//
// Returns a useActionState-compatible { error, ok } shape. On
// success the caller redirects to the appropriate landing page.
// ----------------------------------------------------------------
export async function enterAccessMode(
  prevState: { error?: string } | null,
  formData: FormData,
): Promise<{ error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const raw = (formData.get('passcode') as string | null)?.trim() ?? ''
  if (!isValidPasscode(raw)) return { error: 'Enter your 4-digit code.' }

  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!roleRow) redirect('/onboarding')

  const { data: r } = await supabase
    .from('restaurants')
    .select('owner_passcode_hash, staff_passcode_hash')
    .eq('id', roleRow!.restaurant_id)
    .single()

  // No owner code set → gate is effectively off. Treat as owner mode
  // and let them through. This covers the freshly-onboarded case
  // before passcodes are configured.
  if (!r?.owner_passcode_hash) {
    const c = await cookies()
    c.set(POS_MODE_COOKIE, 'owner', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: OWNER_MODE_MAX_AGE,
    })
    redirect('/dashboard')
  }

  const submitted = hashPasscode(raw)
  const c = await cookies()
  if (submitted === r!.owner_passcode_hash) {
    c.set(POS_MODE_COOKIE, 'owner', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: OWNER_MODE_MAX_AGE,
    })
    redirect('/dashboard')
  }
  if (r!.staff_passcode_hash && submitted === r!.staff_passcode_hash) {
    c.set(POS_MODE_COOKIE, 'staff', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: STAFF_MODE_MAX_AGE,
    })
    redirect('/pos')
  }

  return { error: 'That code doesn’t match.' }
}

// ----------------------------------------------------------------
// signOutWithPasscode — the only sign-out path on the kiosk. The
// owner must enter the owner passcode to fully end the Supabase
// session and bounce back to /login.
//
// Staff code does NOT pass this check — staff can lock the device
// at end of shift by clearing the cookie, but they can't kick the
// owner out of their own account.
// ----------------------------------------------------------------
export async function signOutWithPasscode(
  prevState: { error?: string } | null,
  formData: FormData,
): Promise<{ error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const raw = (formData.get('passcode') as string | null)?.trim() ?? ''
  if (!isValidPasscode(raw)) return { error: 'Enter the 4-digit owner code.' }

  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!roleRow) redirect('/onboarding')

  const { data: r } = await supabase
    .from('restaurants')
    .select('owner_passcode_hash')
    .eq('id', roleRow!.restaurant_id)
    .single()

  // No owner code configured → fall back to a plain sign-out. This
  // covers the brand-new owner who hasn't set codes yet but hits
  // the sign-out button.
  if (!r?.owner_passcode_hash) {
    await supabase.auth.signOut()
    const c = await cookies()
    c.delete(POS_MODE_COOKIE)
    redirect('/login')
  }

  if (hashPasscode(raw) !== r!.owner_passcode_hash) {
    return { error: 'That’s not the owner code.' }
  }

  await supabase.auth.signOut()
  const c = await cookies()
  c.delete(POS_MODE_COOKIE)
  redirect('/login')
}
