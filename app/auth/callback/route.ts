// ----------------------------------------------------------------
// /auth/callback
//
// The landing target for any Supabase email magic link — currently
// used by the password-reset flow (see requestPasswordReset in
// app/actions/auth.ts). Supabase's resetPasswordForEmail() sends
// the user an email with a link to:
//
//   https://<site>/auth/callback?code=<auth_code>&next=<path>
//
// This route exchanges that one-time `code` for a session cookie,
// then redirects to `next` (defaulting to /reset-password). By the
// time the user reaches the reset form they're already authenticated
// — `resetPassword` just writes the new password against the live
// session.
//
// The same callback pattern is reusable for future email-link flows
// (signup confirmations, magic-link signin, email change confirms).
// ----------------------------------------------------------------

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // `next` is where we want to send the user after the code exchange.
  // Default to /reset-password since that's currently the only flow,
  // but make it overridable so future email links can reuse this.
  const next = searchParams.get('next') ?? '/reset-password'

  if (!code) {
    // Someone landed here without a code — link was tampered with,
    // bookmarked, or arrived via a stale browser session. Send them
    // back to login with a hint they can request a new link.
    return NextResponse.redirect(`${origin}/login?reset=invalid`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    // Common causes: link already used, link expired, link tampered
    // with. Send them back to /forgot-password so they can request
    // a fresh one without typing /forgot-password into the URL bar.
    return NextResponse.redirect(`${origin}/forgot-password?error=expired`)
  }

  // Session is now live in the cookies. Forward to the intended page.
  // Use origin so the absolute URL is correct in any environment.
  return NextResponse.redirect(`${origin}${next}`)
}
