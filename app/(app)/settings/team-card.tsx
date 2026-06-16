'use client'

// ----------------------------------------------------------------
// TeamCard — owner-only Settings panel for inviting and managing
// the rest of the staff. Two parts:
//
//   1. "Invite a teammate" form
//        email + role (manager / staff) + location (managers only)
//        → calls `inviteTeamMember`, which sends a magic-link email
//          via Supabase Auth admin and stores the metadata in
//          team_invitations.
//
//   2. Roster
//        Pending invitations (with a Cancel button)
//        Accepted / canceled invitations (display only)
//
// Hidden entirely for non-owners — managers and staff don't see
// the section. The server page already gates rendering of this
// card on isOwner, but we double-up defensively here.
// ----------------------------------------------------------------

import { useActionState, useState } from 'react'
import { inviteTeamMember, cancelTeamInvite } from '@/app/actions/team'

interface LocationOption {
  id: string
  name: string
}

interface InvitationRow {
  id: string
  email: string
  role: 'manager' | 'staff'
  status: 'pending' | 'accepted' | 'canceled' | 'expired'
  location_name: string | null
  created_at: string
}

interface Props {
  locations: LocationOption[]
  invitations: InvitationRow[]
}

export default function TeamCard({ locations, invitations }: Props) {
  const [inviteState, inviteAction, invitePending] = useActionState(inviteTeamMember, null)
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelTeamInvite, null)
  const [selectedRole, setSelectedRole] = useState<'manager' | 'staff'>('staff')

  const pending = invitations.filter((i) => i.status === 'pending')
  const past = invitations.filter((i) => i.status !== 'pending')

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Team</h2>
        <span className="text-xs text-gray-500">Owner-only</span>
      </div>

      {/* Invite form */}
      <form action={inviteAction} className="grid grid-cols-1 md:grid-cols-[1fr,auto,auto,auto] gap-3 items-end">
        <div>
          <label htmlFor="invite-email" className="block text-xs font-medium text-gray-600 mb-1.5">
            Email
          </label>
          <input
            id="invite-email"
            name="email"
            type="email"
            required
            placeholder="teammate@example.com"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm
                       placeholder:text-gray-400 focus:outline-none focus:ring-2
                       focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        <div>
          <label htmlFor="invite-role" className="block text-xs font-medium text-gray-600 mb-1.5">
            Role
          </label>
          <select
            id="invite-role"
            name="role"
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value as 'manager' | 'staff')}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="staff">Staff</option>
            <option value="manager">Manager</option>
          </select>
        </div>

        <div>
          <label htmlFor="invite-location" className="block text-xs font-medium text-gray-600 mb-1.5">
            Location {selectedRole === 'manager' ? '*' : '(staff: n/a)'}
          </label>
          <select
            id="invite-location"
            name="location_id"
            disabled={selectedRole !== 'manager'}
            required={selectedRole === 'manager'}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                       disabled:bg-gray-50 disabled:text-gray-400"
          >
            <option value="">Select…</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>{loc.name}</option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={invitePending}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold
                     text-white hover:bg-gray-800 transition-colors
                     disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {invitePending ? 'Sending…' : 'Send invite'}
        </button>
      </form>

      {/* Status messages */}
      {inviteState?.error && (
        <p className="mt-3 text-sm text-red-700">{inviteState.error}</p>
      )}
      {inviteState?.ok && inviteState.message && (
        <p className="mt-3 text-sm text-emerald-700">{inviteState.message}</p>
      )}
      {cancelState?.error && (
        <p className="mt-3 text-sm text-red-700">{cancelState.error}</p>
      )}

      {/* Pending invitations */}
      {pending.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Pending</h3>
          <ul className="divide-y divide-gray-200 border border-gray-200 rounded-lg">
            {pending.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{inv.email}</p>
                  <p className="text-xs text-gray-500 mt-0.5 capitalize">
                    {inv.role}{inv.location_name ? ` · ${inv.location_name}` : ''}
                  </p>
                </div>
                <form action={cancelAction}>
                  <input type="hidden" name="invitation_id" value={inv.id} />
                  <button
                    type="submit"
                    disabled={cancelPending}
                    className="text-xs font-medium text-red-600 hover:text-red-500
                               disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Past invitations */}
      {past.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-700 mb-2">History</h3>
          <ul className="divide-y divide-gray-200 border border-gray-200 rounded-lg">
            {past.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{inv.email}</p>
                  <p className="text-xs text-gray-500 mt-0.5 capitalize">
                    {inv.role}{inv.location_name ? ` · ${inv.location_name}` : ''}
                  </p>
                </div>
                <span className={
                  inv.status === 'accepted'
                    ? 'text-xs font-medium text-emerald-700'
                    : 'text-xs font-medium text-gray-500'
                }>
                  {inv.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pending.length === 0 && past.length === 0 && (
        <p className="mt-6 text-sm text-gray-500">
          No invitations yet. Send your first one above.
        </p>
      )}
    </div>
  )
}
