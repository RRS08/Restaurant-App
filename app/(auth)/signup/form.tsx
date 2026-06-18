'use client'

// ----------------------------------------------------------------
// SignupForm — client island for /signup.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import Link from 'next/link'
import { signup } from '@/app/actions/auth'
import { BrandLockup } from '@/components/brand'
import { makeT, type Lang } from '@/lib/i18n'

export default function SignupForm({ lang }: { lang: Lang }) {
  const t = makeT(lang)
  const [state, action, pending] = useActionState(signup, null)

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">

        {/* Header — brand lockup, then the contextual greeting. */}
        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex">
            <BrandLockup size="md" variant="solid" />
          </Link>
          <h1 className="mt-6 text-2xl font-bold text-gray-900 tracking-tight">
            {t('Create your account', 'Crea tu cuenta')}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {t(
              'Get started with Checked — operations for your restaurant in one place.',
              'Empieza con Checked — la operación de tu restaurante en un solo lugar.'
            )}
          </p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          <form action={action} className="space-y-5">

            {/* Full name */}
            <div>
              <label
                htmlFor="full_name"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                {t('Full name', 'Nombre completo')}
              </label>
              <input
                id="full_name"
                name="full_name"
                type="text"
                required
                autoComplete="name"
                placeholder="Mario Rossi"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                           placeholder:text-gray-400
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Email */}
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

            {/* Password */}
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                {t('Password', 'Contraseña')}
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="new-password"
                placeholder={t('At least 8 characters', 'Al menos 8 caracteres')}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                           placeholder:text-gray-400
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Error from server */}
            {state?.error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
                <p className="text-sm text-red-700">{state.error}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold
                         text-white hover:bg-gray-800 transition-colors
                         disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {pending ? t('Creating account…', 'Creando cuenta…') : t('Create account', 'Crear cuenta')}
            </button>

          </form>
        </div>

        {/* Link to login */}
        <p className="mt-6 text-center text-sm text-gray-500">
          {t('Already have an account?', '¿Ya tienes una cuenta?')}{' '}
          <Link href="/login" className="font-medium text-blue-600 hover:text-blue-500">
            {t('Sign in', 'Iniciar sesión')}
          </Link>
        </p>

      </div>
    </div>
  )
}
