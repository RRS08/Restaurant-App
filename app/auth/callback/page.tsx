// ----------------------------------------------------------------
// /auth/callback  — click-through confirmation for email links.
//
// Landing target for any Supabase email magic link (password reset
// today; signup / magic-link signin later). Instead of exchanging
// the one-time `code` for a session on GET — which link scanners
// like Outlook Safe Links consume before the human can click —
// we render a small "Continue" screen and only exchange when the
// user hits the button. Bots don't click buttons.
//
// PKCE remains the real defense: the code_verifier cookie was set
// in the browser that requested the reset, so even a bot that
// clicks Continue can't complete the exchange from a different
// context. The click gate just stops the code from being
// invalidated by a bot who couldn't have succeeded anyway.
// ----------------------------------------------------------------

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'
import { BrandLockup } from '@/components/brand'
import { completeAuthCodeExchange } from '@/app/actions/auth'

interface Props {
  searchParams?: Promise<{
    code?: string
    next?: string
    error?: string
    error_description?: string
  }>
}

export default async function AuthCallbackPage({ searchParams }: Props) {
  const lang = await getLang()
  const t = makeT(lang)
  const sp = (await searchParams) ?? {}

  // Supabase can redirect back with an error param when the link
  // was malformed / expired before we even try to exchange. Bounce
  // to /forgot-password so the user can start over cleanly.
  if (sp.error) {
    redirect('/forgot-password?error=expired')
  }

  const code = (sp.code ?? '').trim()
  const next = (sp.next ?? '/reset-password').trim()

  // No code = bookmark, stale link, or someone typed /auth/callback
  // into the URL bar. Send them back to /forgot-password rather
  // than showing a broken confirm screen.
  if (!code) {
    redirect('/forgot-password?error=invalid')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">

        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex">
            <BrandLockup size="md" variant="solid" />
          </Link>
          <h1 className="mt-6 text-2xl font-bold text-gray-900 tracking-tight">
            {t('Confirm your reset link', 'Confirma tu enlace')}
          </h1>
          <p className="mt-1 text-sm text-gray-500 leading-relaxed">
            {t(
              'Tap Continue to reset your password. This extra step keeps automatic email scanners from invalidating your link before you can use it.',
              'Toca Continuar para restablecer tu contraseña. Este paso extra evita que los escáneres automáticos de correo invaliden tu enlace antes de que puedas usarlo.',
            )}
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          <form action={completeAuthCodeExchange} className="space-y-4">
            <input type="hidden" name="code" value={code} />
            <input type="hidden" name="next" value={next} />
            <button
              type="submit"
              className="w-full rounded-lg bg-[#18181B] px-4 py-2.5 text-sm font-semibold text-[#FAF9F6] hover:bg-black transition-colors"
            >
              {t('Continue', 'Continuar')}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-gray-500">
          {t('Didn’t request this?', '¿No solicitaste esto?')}{' '}
          <Link href="/login" className="text-blue-600 hover:text-blue-700 font-medium">
            {t('Back to sign in', 'Volver a iniciar sesión')}
          </Link>
        </p>
      </div>
    </div>
  )
}
