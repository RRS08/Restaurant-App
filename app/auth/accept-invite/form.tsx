'use client'

// ----------------------------------------------------------------
// AcceptInviteForm
//
// Tiny client island for the Accept button on /auth/accept-invite.
// `acceptTeamInvite` writes the user_roles row via the admin client
// and stamps the invitation. On success we send the user straight
// to /dashboard.
//
// Kept separate from the server page so the rest of /auth/accept-
// invite stays a Server Component (the invitation lookup runs there).
// ----------------------------------------------------------------

import { useActionState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { acceptTeamInvite } from '@/app/actions/team'

export default function AcceptInviteForm() {
  const [state, action, pending] = useActionState(acceptTeamInvite, null)
  const router = useRouter()

  useEffect(() => {
    if (state?.ok) {
      router.push('/dashboard')
    }
  }, [state, router])

  return (
    <form action={action} className="space-y-3">
      {state?.error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
          <p className="text-sm text-red-700">{state.error}</p>
        </div>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold
                   text-white hover:bg-gray-800 transition-colors
                   disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {pending ? 'Accepting…' : 'Accept invitation'}
      </button>
    </form>
  )
}
