'use client'

// ----------------------------------------------------------------
// Forgot Password Page  →  /forgot-password
//
// Step 1 of the password-reset flow. The user enters their email;
// `requestPasswordReset` (server action) calls Supabase Auth's
// resetPasswordForEmail() which sends a magic-link email.
//
// We never disclose whether the email is registered — both the
// "we sent it" and "no such user" branches show the same success
// state. That defeats account-enumeration probes.
//
// Same visual treatment as /login and /signup so the auth pages
// read as a single flow.
// ----------------------------------------------------------------

import { useActionState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { requestPasswordReset } from '@/app/actions/auth'
import { BrandLockup } from '@/components/brand'

function ForgotPasswordContent() {
  const [state, action, pending] = useActionState(requestPasswordReset, null)
  const params = useSearchParams()
  // If the user landed here from /auth/callback after a failed
  // code exchange (link expired, already used), surface a hint so
  // they know to request a new link rather than retry the old one.
  const linkExpired = params.get('error') === 'expired'

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">

        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex">
            <BrandLockup size="md" variant="solid" />
          </Link>
          <h1 className="mt-6 text-2xl font-bold text-gray-900 tracking-tight">Reset your password</h1>
          <p className="mt-1 text-sm text-gray-500">
            We&apos;ll email you a link to set a new one.
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          {state?.ok ? (
            // Same neutral success copy whether or not the email
            // exists — defeats account enumeration. If we said
            // "we couldn't find that account" an attacker could
            // probe addresses one at a time.
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 text-xl">✓</div>
              <h2 className="mt-4 text-lg font-semibold text-gray-900">Check your inbox</h2>
              <p className="mt-2 text-sm text-gray-500 leading-relaxed">
                If an account exists for that email, a reset link is on its way.
                The link expires in one hour.
              </p>
              <Link
                href="/login"
                className="mt-6 inline-block text-sm font-medium text-blue-600 hover:text-blue-500"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <form action={action} className="space-y-5">
              {linkExpired && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
                  <p className="text-sm text-amber-800">
                    That reset link is no longer valid — links expire after one use or one hour. Request a new one below.
                  </p>
                </div>
              )}

              <div>
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-gray-700 mb-1.5"
                >
                  Email address
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                             placeholder:text-gray-400
                             focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

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
                {pending ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-gray-500">
          Remembered it?{' '}
          <Link href="/login" className="font-medium text-blue-600 hover:text-blue-500">
            Sign in
          </Link>
        </p>

      </div>
    </div>
  )
}

export default function ForgotPasswordPage() {
  // useSearchParams() requires a Suspense boundary in Next.js 15+
  // so the page can stream the rest while client params resolve.
  return (
    <Suspense fallback={null}>
      <ForgotPasswordContent />
    </Suspense>
  )
}
