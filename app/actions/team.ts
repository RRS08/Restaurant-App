'use server'

// ----------------------------------------------------------------
// Team Invitation Server Actions
//
// Owner-facing surface for inviting a manager or staff member to
// the restaurant. Flow:
//
//   1. Owner submits email + role (+ location_id for manager).
//      `inviteTeamMember` inserts a team_invitations row AND
//      asks Supabase Auth's admin API to send a magic-link email.
//
//   2. Recipient clicks the email link. /auth/callback exchanges
//      the code for a session and redirects to
//      /auth/accept-invite, which renders the invitation summary
//      and calls `acceptTeamInvite`.
//
//   3. `acceptTeamInvite` writes the user_roles row using the
//      admin client (the tightened user_roles INSERT RLS policy
//      would otherwise reject it — a brand-new user has no
//      my_restaurant_id() yet). It also stamps the invitation
//      row with accepted_at / accepted_by_user_id.
//
//   4. Owner can revoke a pending invite with `cancelTeamInvite`.
//
// Roles affected:
//   manager — must pass location_id; gets scoped to that location.
//   staff   — no location scope today (the staff role is in the
//             schema but not yet differentiated in lib/authz.ts).
//
// Audit: every transition is logged via `logAudit`.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { getAuthContext, logAudit } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

type Result =
  | { error: string; ok?: undefined }
  | { ok: true; message?: string; error?: undefined }

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase()
}

function isValidEmail(email: string): boolean {
  // Same shape as the demo-form regex elsewhere — intentionally lax
  // because Supabase Auth will do the real validation on send.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// ----------------------------------------------------------------
// INVITE A TEAM MEMBER
// ----------------------------------------------------------------
export async function inviteTeamMember(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Owner-only — only the restaurant owner can extend invitations.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can invite team members.' }
  }

  const email = normalizeEmail(formData.get('email') as string | null)
  const role = (formData.get('role') as string | null)?.trim() ?? ''
  const locationId = ((formData.get('location_id') as string | null) ?? '').trim() || null

  if (!email) return { error: 'Enter an email address.' }
  if (!isValidEmail(email)) return { error: 'That doesn’t look like a valid email.' }
  if (role !== 'manager' && role !== 'staff') {
    return { error: 'Choose a role: manager or staff.' }
  }
  if (role === 'manager' && !locationId) {
    return { error: 'Managers need a location. Pick one above.' }
  }

  // If we're inviting a manager, verify the location belongs to this
  // restaurant. RLS would block a cross-tenant id, but the explicit
  // check gives a cleaner error message.
  if (locationId) {
    const { data: loc } = await ctx.supabase
      .from('locations')
      .select('id')
      .eq('id', locationId)
      .eq('restaurant_id', ctx.restaurantId)
      .maybeSingle()
    if (!loc) return { error: 'That location isn’t part of your restaurant.' }
  }

  // Insert the invitation row. The partial unique index on
  // (restaurant_id, email) where status='pending' enforces "no
  // duplicate live invites" — re-inviting after cancel works.
  const { data: inserted, error: insertErr } = await ctx.supabase
    .from('team_invitations')
    .insert({
      restaurant_id: ctx.restaurantId,
      email,
      role,
      location_id: role === 'manager' ? locationId : null,
      invited_by_user_id: ctx.userId,
    })
    .select('id')
    .single()

  if (insertErr) {
    // 23505 = unique violation → there's already a pending invite.
    if (insertErr.code === '23505') {
      return { error: 'That email already has a pending invitation.' }
    }
    return { error: 'Could not save the invitation. Please try again.' }
  }

  // Ask Supabase Auth to send the magic-link email. We use the
  // admin client because inviteUserByEmail is an admin-only API.
  // The redirectTo lands the recipient on /auth/callback, which
  // exchanges the code for a session and forwards to
  // /auth/accept-invite.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
  const redirectTo = `${siteUrl}/auth/callback?next=/auth/accept-invite`

  const admin = createAdminClient()
  const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
  })

  if (inviteErr) {
    // Roll back the invitation row so the owner can retry cleanly.
    // We don't await/error-check the rollback — worst case is a
    // leftover pending row the owner can cancel from Settings.
    await ctx.supabase.from('team_invitations').delete().eq('id', inserted.id)
    return { error: `Could not send the email: ${inviteErr.message}` }
  }

  await logAudit(ctx, null, 'invite_team_member', 'team_invitations', inserted.id, {
    email,
    role,
    location_id: locationId,
  })

  revalidatePath('/settings')
  return { ok: true, message: `Invitation sent to ${email}.` }
}

// ----------------------------------------------------------------
// CANCEL A PENDING INVITATION
// ----------------------------------------------------------------
export async function cancelTeamInvite(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can cancel invitations.' }
  }

  const invitationId = ((formData.get('invitation_id') as string | null) ?? '').trim()
  if (!invitationId) return { error: 'No invitation specified.' }

  const { data: existing } = await ctx.supabase
    .from('team_invitations')
    .select('id, status, email')
    .eq('id', invitationId)
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()

  if (!existing) return { error: 'Invitation not found.' }
  if (existing.status !== 'pending') {
    return { error: 'That invitation isn’t pending — nothing to cancel.' }
  }

  const { error: updErr } = await ctx.supabase
    .from('team_invitations')
    .update({ status: 'canceled' })
    .eq('id', invitationId)
    .eq('restaurant_id', ctx.restaurantId)

  if (updErr) return { error: 'Could not cancel the invitation.' }

  await logAudit(ctx, null, 'cancel_team_invite', 'team_invitations', invitationId, {
    email: existing.email,
  })

  revalidatePath('/settings')
  return { ok: true, message: 'Invitation canceled.' }
}

// ----------------------------------------------------------------
// ACCEPT THE INVITATION (called from /auth/accept-invite)
// ----------------------------------------------------------------
export async function acceptTeamInvite(
  prevState: Result | null,
  _formData: FormData
): Promise<Result> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !user.email) {
    return { error: 'You need to be signed in via the invitation link.' }
  }

  // Find a pending invitation for this email. We look case-
  // insensitively because the invite was stored lower-cased; Supabase
  // Auth stores the email as the user entered it.
  const userEmail = user.email.toLowerCase()
  const { data: invitation } = await supabase
    .from('team_invitations')
    .select('id, restaurant_id, role, location_id, status')
    .eq('email', userEmail)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!invitation) {
    return { error: 'No pending invitation found for your email. Ask the owner to re-send one.' }
  }

  // Write the user_roles row via the admin client. The tightened
  // RLS policy on user_roles requires restaurant_id = my_restaurant_id(),
  // which is null for a brand-new user — same circular dependency as
  // the onboarding bootstrap, same admin-client solution.
  const admin = createAdminClient()
  const { error: roleErr } = await admin.from('user_roles').insert({
    user_id: user.id,
    restaurant_id: invitation.restaurant_id,
    role: invitation.role,
    location_id: invitation.role === 'manager' ? invitation.location_id : null,
  })

  if (roleErr) {
    // 23505 = the user already has a role in this restaurant.
    // Be lenient — mark the invitation accepted anyway so the
    // owner sees the closed-out row.
    if (roleErr.code !== '23505') {
      return { error: 'Could not finish setting up your access. Contact the owner.' }
    }
  }

  // Stamp the invitation as accepted.
  await admin
    .from('team_invitations')
    .update({
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      accepted_by_user_id: user.id,
    })
    .eq('id', invitation.id)

  revalidatePath('/dashboard')
  return { ok: true }
}
