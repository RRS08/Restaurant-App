'use client'

// ----------------------------------------------------------------
// ResetPasswordForm — client island for /reset-password.
//
// Step 2 of the password-reset flow. The user is already
// authenticated by the time they land here (the magic link from
// /forgot-password goes through /auth/callback, which exchanges
// the code for a session). All this page does is collect a new
// password + confirmation and submit to `resetPassword`.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import Link from 'next/link'
import { resetPassword } from '@/app/actions/auth'
import { BrandLockup } from '@/components/brand'
import { makeT, type Lang } from '@/lib/i18n'

export default function ResetPasswordForm({ lang, code }: { lang: Lang; code: string | null }) {
  const t = makeT(lang)
  const [state, action, pending] = useActionState(resetPassword, null)

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">

        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex">
            <BrandLockup size="md" variant="solid" />
          </Link>
          <h1 className="mt-6 text-2xl font-bold text-gray-900 tracking-tight">
            {t('Set a new password', 'Crea una nueva contraseña')}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {t('Choose something you’ll remember next time.', 'Elige algo que recuerdes la próxima vez.')}
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          <form action={action} className="space-y-5">
            {/* Auth code from the email link, passed through to the
                server action so it can exchange for a session as
                part of the same submit that sets the new password.
                Absent when the user got here already signed in. */}
            {code && <input type="hidden" name="code" value={code} />}

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                {t('New password', 'Nueva contraseña')}
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder={t('At least 8 characters', 'Al menos 8 caracteres')}
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
                {t('Confirm new password', 'Confirma la nueva contraseña')}
              </label>
              <input
                id="confirm"
                name="confirm"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder={t('Type it again', 'Escríbela de nuevo')}
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
                    {t('Request a new link', 'Solicita un nuevo enlace')}
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
              {pending ? t('Saving…', 'Guardando…') : t('Update password', 'Actualizar contraseña')}
            </button>

          </form>
        </div>

      </div>
    </div>
  )
}
