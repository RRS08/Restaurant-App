'use server'

// ----------------------------------------------------------------
// Auth Server Actions
//
// 'use server' at the top of this file marks every exported function
// as a "Server Action". This means:
//   - They always run on the server, never in the browser.
//   - They can be called directly from forms or client components.
//   - They have access to cookies, environment variables, and the DB.
//
// Think of these as secure API endpoints, but simpler to write.
// ----------------------------------------------------------------

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { validateAndConsumeInviteCode } from './invites'

// ----------------------------------------------------------------
// SIGN UP
//
// Creates a new user in Supabase Auth.
// The profile row (in public.profiles) is created automatically by
// the database trigger we set up in schema.sql — we don't need to
// do that here. The trigger reads `full_name` from the metadata
// object we pass into signUp().
//
// This function signature follows the useActionState pattern:
//   - prevState: the last value this action returned (starts as null)
//   - formData: the form fields the user submitted
// ----------------------------------------------------------------
export async function signup(
  prevState: { error: string } | null,
  formData: FormData
) {
  const supabase = await createClient()

  // Read the form fields.
  // formData.get() returns FormDataEntryValue | null, so we cast to string.
  const email = formData.get('email') as string
  const password = formData.get('password') as string
  const fullName = formData.get('full_name') as string
  const inviteCode = (formData.get('invite_code') as string | null) ?? ''

  // Basic validation. Return early with an error if anything is missing.
  // The error object is passed back to the form via useActionState.
  if (!email || !password || !fullName) {
    return { error: 'All fields are required.' }
  }

  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters.' }
  }

  // Invite-gate. /signup is closed to the public — every account
  // must come from a code minted at /dev-tools (or, later, by the
  // Stripe checkout.session.completed webhook). We validate +
  // atomically consume the code BEFORE creating the auth user so
  // a wrong code never produces a stranded auth record.
  const inviteResult = await validateAndConsumeInviteCode(inviteCode)
  if (!inviteResult.ok) {
    return { error: inviteResult.error }
  }

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // This is stored in auth.users.raw_user_meta_data.
      // Our database trigger reads `full_name` from here to populate profiles.
      data: { full_name: fullName },
    },
  })

  if (error) {
    // Return Supabase's error message (e.g. "User already registered")
    return { error: error.message }
  }

  // Signup succeeded. Send the user to onboarding to create their restaurant.
  // redirect() throws a special exception — it does NOT return a value,
  // so nothing after it will run.
  redirect('/onboarding')
}

// ----------------------------------------------------------------
// LOGIN
//
// Signs in an existing user with email and password.
// Supabase handles the token and stores it in a cookie automatically.
// ----------------------------------------------------------------
export async function login(
  prevState: { error: string } | null,
  formData: FormData
) {
  const supabase = await createClient()

  const email = formData.get('email') as string
  const password = formData.get('password') as string

  if (!email || !password) {
    return { error: 'Email and password are required.' }
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    // "Invalid login credentials" is the message Supabase returns
    // for wrong email or password.
    return { error: error.message }
  }

  // Login succeeded. Redirect to the dashboard.
  // The (app)/layout.tsx will check if they have a restaurant.
  // If they don't, it redirects them to /onboarding automatically.
  redirect('/dashboard')
}

// ----------------------------------------------------------------
// LOGOUT
//
// Signs the user out and clears their session cookie.
// Called from a simple form with a submit button — no useActionState
// needed here because there's nothing to show on error.
// ----------------------------------------------------------------
export async function logout() {
  const supabase = await createClient()
  await supabase.auth.signOut()

  // Send them back to the public landing page.
  redirect('/login')
}

// ----------------------------------------------------------------
// REQUEST PASSWORD RESET
//
// Sends a magic-link email via Supabase Auth. Clicking the link
// hits /auth/callback?next=/reset-password, which exchanges the
// code for a session and lands the user on the reset form already
// authenticated. From there `resetPassword` (below) writes the
// new password to auth.users.
//
// We DON'T leak whether the email is known — always returning the
// same neutral success message defeats account-enumeration probes.
// Real errors (rate limit, malformed config) are surfaced; "no such
// user" is folded into the success path.
//
// IMPORTANT — Supabase configuration:
//   The redirect URL must be added to Supabase Dashboard →
//   Authentication → URL Configuration → Redirect URLs:
//     https://<your-prod-domain>/auth/callback
//     http://localhost:3000/auth/callback  (local dev)
//   Without this, Supabase silently rejects the redirect.
// ----------------------------------------------------------------
export async function requestPasswordReset(
  prevState: { error?: string; ok?: boolean } | null,
  formData: FormData
) {
  const supabase = await createClient()

  const email = (formData.get('email') as string | null)?.trim() ?? ''

  if (!email) {
    return { error: 'Enter your email address.' }
  }

  // Build the absolute URL Supabase will redirect to from the
  // reset email. NEXT_PUBLIC_SITE_URL must be set in production;
  // we fall back to localhost for dev.
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
  const redirectTo = `${siteUrl}/auth/callback?next=/reset-password`

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  })

  // Surface true config / rate-limit failures. Account-enumeration
  // errors (e.g., "user not found") are absorbed into the success
  // path — we never tell an attacker which emails exist.
  if (error && !/not\s*found|user/i.test(error.message)) {
    return { error: error.message }
  }

  return { ok: true }
}

// ----------------------------------------------------------------
// completeAuthCodeExchange — click-through step for email links.
//
// Called by the /auth/callback confirmation page when the user
// hits "Continue." We deliberately do NOT exchange on GET (the
// route was previously a bare redirect that did the exchange
// server-side), because link scanners like Outlook Safe Links
// prefetch the URL to check for phishing — that prefetch
// consumed the one-time code before the real user could click,
// leaving them with an "invalid link" error the moment they
// tapped the email.
//
// Requiring a user gesture (form submit / button click) makes
// bots stop but keeps the flow one-click for humans.
//
// PKCE is on by default in @supabase/ssr — the exchange still
// requires the code_verifier cookie set at reset-request time,
// so the exchange only succeeds inside the browser session that
// asked for the reset. That's the real defense; the click gate
// just stops the code from being CONSUMED by a bot who couldn't
// have succeeded anyway.
// ----------------------------------------------------------------
export async function completeAuthCodeExchange(formData: FormData): Promise<void> {
  const code = ((formData.get('code') as string) ?? '').trim()
  const nextRaw = ((formData.get('next') as string) ?? '/reset-password').trim()
  // Only allow app-internal `next` targets so a tampered link
  // can't redirect the freshly-authed user to an external site.
  const next = nextRaw.startsWith('/') ? nextRaw : '/reset-password'

  if (!code) redirect('/forgot-password?error=invalid')

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    // Same failure modes as before: link already used, expired, or
    // tampered with. Send them back to /forgot-password so they can
    // start over cleanly.
    redirect('/forgot-password?error=expired')
  }

  redirect(next)
}

// ----------------------------------------------------------------
// RESET PASSWORD
//
// Writes a new password for the currently signed-in user. The user
// must have an active session — they get one by clicking the magic
// link from `requestPasswordReset` above, which goes through
// /auth/callback and lands them here authenticated.
//
// If a logged-out user somehow reaches this action directly, the
// `updateUser` call rejects with a Supabase auth error and we
// surface it.
// ----------------------------------------------------------------
export async function resetPassword(
  prevState: { error?: string; ok?: boolean } | null,
  formData: FormData
) {
  const supabase = await createClient()

  const password = formData.get('password') as string
  const confirm = formData.get('confirm') as string

  if (!password || !confirm) {
    return { error: 'Enter and confirm your new password.' }
  }

  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters.' }
  }

  if (password !== confirm) {
    return { error: 'The two passwords don’t match.' }
  }

  // Confirm the link actually delivered a session before letting
  // someone write to auth.users. Otherwise updateUser would error
  // anyway, but the message would be less friendly.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { error: 'Your reset link expired. Request a new one.' }
  }

  const { error } = await supabase.auth.updateUser({ password })
  if (error) {
    return { error: error.message }
  }

  redirect('/dashboard')
}
