// ----------------------------------------------------------------
// /access — passcode gate
//
// Two modes, distinguished by the `?signout=1` query string:
//
//   1. Default — Owner or staff enters their 4-digit code. Owner
//      code unlocks the full system; staff code pins the device to
//      /pos. The submitted code is checked against the hashed
//      values stored on `restaurants` (see app/actions/access.ts).
//
//   2. Signout — The bottom-of-sidebar Sign out link routes here
//      with ?signout=1. The owner enters the owner code to
//      confirm; on success Supabase auth is signed out and the
//      pos_mode cookie cleared, returning to /login. Staff can't
//      sign out — they can only re-enter the gate with their own
//      code (which lands them right back on /pos).
//
// This is the ONE screen a signed-in user lands on if their
// pos_mode cookie isn't set, regardless of which path they typed.
// Middleware bounces all protected paths here.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AccessForm from './form'

interface Props {
  searchParams: Promise<{ signout?: string }>
}

export default async function AccessPage({ searchParams }: Props) {
  const params = await searchParams
  const signout = params.signout === '1'

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Resolve restaurant + gate status. If no owner code is set we
  // skip the gate entirely (freshly-onboarded user, no kiosk yet)
  // and bounce to /dashboard.
  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!roleRow) redirect('/onboarding')

  const { data: r } = await supabase
    .from('restaurants')
    .select('name, owner_passcode_hash, staff_passcode_hash')
    .eq('id', roleRow.restaurant_id)
    .single()

  // No owner code configured → no gate. Don't even ask. The owner
  // can set codes from Settings → Access codes when they want the
  // kiosk model on.
  if (!r?.owner_passcode_hash && !signout) {
    redirect('/dashboard')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAF9F6] p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-xs uppercase tracking-[0.16em] text-zinc-500 mb-3">
            {r?.name ?? 'Checked'}
          </div>
          <h1 className="text-2xl font-semibold text-zinc-900">
            {signout ? 'Sign out' : 'Enter your code'}
          </h1>
          <p className="text-sm text-zinc-500 mt-2">
            {signout
              ? 'The owner code is required to end this session.'
              : r?.staff_passcode_hash
                ? 'Owner or staff code, whichever applies.'
                : 'Enter the owner code to continue.'}
          </p>
        </div>
        <AccessForm signout={signout} />
      </div>
    </div>
  )
}
