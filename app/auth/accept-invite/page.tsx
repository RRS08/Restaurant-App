// ----------------------------------------------------------------
// /auth/accept-invite
//
// Server component. Where the invitation magic link lands the new
// user AFTER /auth/callback has already exchanged the code for a
// session.
//
// What this page does:
//   • Confirms the user is signed in.
//   • Looks up their pending team_invitations row by email.
//   • Renders the invitation summary (restaurant + role + location)
//     and an "Accept" button that calls `acceptTeamInvite`.
//   • On accept, the action writes the user_roles row and stamps
//     the invitation; we redirect to the dashboard.
//
// Edge cases:
//   • Not signed in → guide the user to log in (their session
//     should already exist via /auth/callback; if it doesn't, the
//     link expired or the callback failed).
//   • No pending invitation → tell the user to ask the owner for a
//     fresh invite.
//   • Already accepted → render a "you're in" success state.
// ----------------------------------------------------------------

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { BrandLockup } from '@/components/brand'
import AcceptInviteForm from './form'

interface RestaurantSummary {
  id: string
  name: string
}

interface LocationSummary {
  id: string
  name: string
}

interface PendingInvitation {
  id: string
  role: 'manager' | 'staff'
  restaurant: RestaurantSummary
  location: LocationSummary | null
}

export default async function AcceptInvitePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Not signed in → /auth/callback didn't deliver a session.
  // Most likely the link expired or was clicked from a different
  // device than the email was opened on. Bounce to login.
  if (!user || !user.email) {
    redirect('/login?invite=needs_link')
  }

  const userEmail = user.email!.toLowerCase()

  const { data: invitationRow } = await supabase
    .from('team_invitations')
    .select(`
      id,
      role,
      status,
      restaurant:restaurants ( id, name ),
      location:locations ( id, name )
    `)
    .eq('email', userEmail)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Already accepted — congratulate and send them to the app.
  if (invitationRow?.status === 'accepted') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm text-center">
          <div className="mb-8">
            <Link href="/" className="inline-flex"><BrandLockup size="md" variant="solid" /></Link>
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 text-xl">✓</div>
            <h1 className="mt-4 text-lg font-semibold text-gray-900">You&apos;re in</h1>
            <p className="mt-2 text-sm text-gray-500">This invitation has already been accepted.</p>
            <Link
              href="/dashboard"
              className="mt-6 inline-block w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
            >
              Open dashboard
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // No pending invitation for this email.
  if (!invitationRow || invitationRow.status !== 'pending') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm text-center">
          <div className="mb-8">
            <Link href="/" className="inline-flex"><BrandLockup size="md" variant="solid" /></Link>
          </div>
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
            <h1 className="text-lg font-semibold text-gray-900">No invitation found</h1>
            <p className="mt-2 text-sm text-gray-500 leading-relaxed">
              We couldn&apos;t find a pending invitation for <strong>{userEmail}</strong>.
              Ask the owner to send a fresh invite from their Settings page.
            </p>
            <Link
              href="/login"
              className="mt-6 inline-block text-sm font-medium text-blue-600 hover:text-blue-500"
            >
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // Supabase select with a nested ref returns the related row as an
  // object (not an array) when we use the foreign-key alias — but the
  // generated types can come back as either depending on relationships.
  // Normalize both shapes defensively so the JSX is straightforward.
  const restaurant = Array.isArray(invitationRow.restaurant)
    ? invitationRow.restaurant[0]
    : invitationRow.restaurant
  const location = Array.isArray(invitationRow.location)
    ? invitationRow.location[0]
    : invitationRow.location

  const invitation: PendingInvitation = {
    id: invitationRow.id as string,
    role: invitationRow.role as 'manager' | 'staff',
    restaurant: {
      id: restaurant?.id ?? '',
      name: restaurant?.name ?? 'this restaurant',
    },
    location: location ? { id: location.id as string, name: location.name as string } : null,
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex"><BrandLockup size="md" variant="solid" /></Link>
          <h1 className="mt-6 text-2xl font-bold text-gray-900 tracking-tight">You&apos;re invited</h1>
          <p className="mt-1 text-sm text-gray-500">
            Review the access you&apos;ll be granted, then accept to join.
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 space-y-5">
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Restaurant</span>
              <span className="font-medium text-gray-900">{invitation.restaurant.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Role</span>
              <span className="font-medium text-gray-900 capitalize">{invitation.role}</span>
            </div>
            {invitation.location && (
              <div className="flex justify-between">
                <span className="text-gray-500">Location</span>
                <span className="font-medium text-gray-900">{invitation.location.name}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-gray-500">Your email</span>
              <span className="font-medium text-gray-900">{userEmail}</span>
            </div>
          </div>

          <AcceptInviteForm />
        </div>
      </div>
    </div>
  )
}
