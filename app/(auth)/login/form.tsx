'use client'

// ----------------------------------------------------------------
// LoginForm — client island for /login.
//
// 'use client' is required because we use React hooks (useActionState).
// The actual login logic runs on the server inside app/actions/auth.ts.
//
// useActionState(action, initialState) wires up a server action to a form:
//   - `state`   = the last value the server action returned (starts as null)
//   - `action`  = pass this to the form's `action` prop
//   - `pending` = true while the server is processing the submission
// ----------------------------------------------------------------

import { useActionState } from 'react'
import Link from 'next/link'
import { login } from '@/app/actions/auth'
import { BrandLockup } from '@/components/brand'
import { makeT, type Lang } from '@/lib/i18n'

export default function LoginForm({ lang }: { lang: Lang }) {
  const t = makeT(lang)
  const [state, action, pending] = useActionState(login, null)

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">

        {/* Header — brand lockup as the first thing the user sees,
            then the contextual greeting underneath. */}
        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex">
            <BrandLockup size="md" variant="solid" />
          </Link>
          <h1 className="mt-6 text-2xl font-bold text-gray-900 tracking-tight">
            {t('Welcome back', 'Bienvenido de vuelta')}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {t('Sign in to your Checked account', 'Inicia sesión en tu cuenta de Checked')}
          </p>
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
                {t('Email address', 'Correo electrónico')}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder={t('you@example.com', 'tu@ejemplo.com')}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                           placeholder:text-gray-400
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Password field — label row carries the "Forgot
                password?" link so the recovery path is reachable
                exactly when a user needs it (next to the field
                they're about to fumble). */}
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-gray-700"
                >
                  {t('Password', 'Contraseña')}
                </label>
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium text-blue-600 hover:text-blue-500"
                >
                  {t('Forgot password?', '¿Olvidaste tu contraseña?')}
                </Link>
              </div>
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
              className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold
                         text-white hover:bg-gray-800 transition-colors
                         disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {/* pending is true while the server action is running */}
              {pending ? t('Signing in…', 'Iniciando sesión…') : t('Sign in', 'Iniciar sesión')}
            </button>

          </form>
        </div>

        {/* Link to signup */}
        <p className="mt-6 text-center text-sm text-gray-500">
          {t('Don’t have an account?', '¿No tienes una cuenta?')}{' '}
          <Link href="/signup" className="font-medium text-blue-600 hover:text-blue-500">
            {t('Create one', 'Crea una')}
          </Link>
        </p>

      </div>
    </div>
  )
}
