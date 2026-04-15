'use client'

// ----------------------------------------------------------------
// Login Page  →  /login
//
// 'use client' is required because we use React hooks (useActionState).
// The actual login logic runs on the server inside app/actions/auth.ts.
//
// useActionState(action, initialState) wires up a server action to a form:
//   - `state`   = the last value the server action returned (starts as null)
//   - `action`  = pass this to the form's `action` prop
//   - `pending` = true while the server is processing the submission
//
// The form will work even if JavaScript fails to load (progressive
// enhancement), because the action is a server action on a real <form>.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import Link from 'next/link'
import { login } from '@/app/actions/auth'

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, null)

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">

        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Welcome back</h1>
          <p className="mt-1 text-sm text-gray-500">Sign in to your restaurant account</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          <form action={action} className="space-y-5">

            {/* Email field */}
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

            {/* Password field */}
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                           placeholder:text-gray-400
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Error message from the server */}
            {/* state?.error uses optional chaining — safe even when state is null */}
            {state?.error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
                <p className="text-sm text-red-700">{state.error}</p>
              </div>
            )}

            {/* Submit button */}
            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold
                         text-white hover:bg-blue-700 transition-colors
                         disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {/* pending is true while the server action is running */}
              {pending ? 'Signing in…' : 'Sign in'}
            </button>

          </form>
        </div>

        {/* Link to signup */}
        <p className="mt-6 text-center text-sm text-gray-500">
          Don&apos;t have an account?{' '}
          <Link href="/signup" className="font-medium text-blue-600 hover:text-blue-500">
            Create one
          </Link>
        </p>

      </div>
    </div>
  )
}
