'use client'

// ----------------------------------------------------------------
// Reset Password Page  →  /reset-password
//
// Step 2 of the password-reset flow. The user is already
// authenticated by the time they land here (the magic link from
// /forgot-password goes through /auth/callback, which exchanges
// the code for a session). All this page does is collect a new
// password + confirmation and submit to `resetPassword`.
//
// If the user reaches this page without an active session (deep
// link, expired flow, bookmark), the server action returns an
// error message and they're nudged back to /forgot-password.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import Link from 'next/link'
import { resetPassword } from '@/app/actions/auth'
import { BrandLockup } from '@/components/brand'

export default function ResetPasswordPage() {
  const [state, action, pending] = useActionState(resetPassword, null)

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">

        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex">
            <BrandLockup size="md" variant="solid" />
          </Link>
          <h1 className="mt-6 text-2xl font-bold text-gray-900 tracking-tight">Set a new password</h1>
          <p className="mt-1 text-sm text-gray-500">
            Choose something you&apos;ll remember next time.
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          <form action={action} className="space-y-5">

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                New password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                           placeholder:text-gray-400
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label
                htmlFor="confirm"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Confirm new password
              </label>
              <input
                id="confirm"
                name="confirm"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="Type it again"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                           placeholder:text-gray-400
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {state?.error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
                <p className="text-sm text-red-700">{state.error}</p>
                {/^.*expired.*$/i.test(state.error) && (
                  <Link
                    href="/forgot-password"
                    className="mt-2 inline-block text-sm font-medium text-red-700 underline"
                  >
                    Request a new link
                  </Link>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold
                         text-white hover:bg-gray-800 transition-colors
                         disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {pending ? 'Saving…' : 'Update password'}
            </button>

          </form>
        </div>

      </div>
    </div>
  )
}
