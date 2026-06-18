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
import Link from 'next/link'
import { BrandLockup } from '@/components/brand'
import { getLang, getT } from '@/lib/i18n-server'
import AccessForm from './form'

interface Props {
  searchParams: Promise<{ signout?: string }>
}

export default async function AccessPage({ searchParams }: Props) {
  const params = await searchParams
  const signout = params.signout === '1'

  const lang = await getLang()
  const t = await getT()

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

  // Column-tolerant fetch — if the migration hasn't run yet the
  // select fails and we treat r as null. Middleware also bypasses
  // the gate in that case, so this is only hit if the user typed
  // /access directly before the gate exists.
  let r: { name?: string | null; owner_passcode_hash?: string | null; staff_passcode_hash?: string | null } | null = null
  try {
    const { data } = await supabase
      .from('restaurants')
      .select('name, owner_passcode_hash, staff_passcode_hash')
      .eq('id', roleRow.restaurant_id)
      .single()
    r = data
  } catch {
    // fall through with r=null
  }

  // No owner code configured → just bounce to /dashboard. Middleware
  // will set the pos_mode cookie on that request (Server Components
  // can't write cookies, only middleware and Server Actions can).
  if (!r?.owner_passcode_hash && !signout) {
    redirect('/dashboard')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-sm">
        {/* Brand + contextual greeting — same shape as /login so the
            auth-adjacent screens read as one family. */}
        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex">
            <BrandLockup size="md" variant="solid" />
          </Link>
          {r?.name && (
            <div className="mt-5 text-xs font-mono uppercase tracking-[0.16em] text-gray-400">
              {r.name}
            </div>
          )}
          <h1 className="mt-3 text-2xl font-bold text-gray-900 tracking-tight">
            {signout ? t('Sign out', 'Cerrar sesión') : t('Enter your code', 'Ingresa tu código')}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {signout
              ? t('The owner code is required to end this session.', 'Se requiere el código del dueño para cerrar la sesión.')
              : r?.staff_passcode_hash
                ? t('Owner or staff code, whichever applies.', 'Código del dueño o del personal, según corresponda.')
                : t('Enter the owner code to continue.', 'Ingresa el código del dueño para continuar.')}
          </p>
        </div>

        {/* Card — matches login/signup chrome (white, rounded-2xl,
            subtle border + shadow). The 4-digit input lives inside. */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          <AccessForm signout={signout} lang={lang} />
        </div>

        {/* Cancel link only on the signout flow — the default flow has
            no escape (user is gated until they enter a code). */}
        {signout && (
          <div className="text-center mt-5">
            <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700">
              {t('Cancel and go back', 'Cancelar y volver')}
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
