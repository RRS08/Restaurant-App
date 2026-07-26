// ----------------------------------------------------------------
// /auth/callback  — auto-exchange landing for email links.
//
// Landing target for any Supabase email magic link (password reset
// today; signup / magic-link signin later). Instead of exchanging
// the one-time `code` on plain GET — which link scanners like
// Outlook Safe Links consume via prefetch before the human clicks
// — we render a tiny "Continuing…" page whose form auto-submits
// via a client-side island. Real browsers run the JS and hit the
// exchange action within ~300 ms; scanners that only prefetch
// (no JS) never trigger it, leaving the token alive.
//
// JS-disabled users still see the plain button as a fallback so
// the flow degrades cleanly.
// ----------------------------------------------------------------

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getLang } from '@/lib/i18n-server'
import { makeT } from '@/lib/i18n'
import { BrandLockup } from '@/components/brand'
import { completeAuthCodeExchange } from '@/app/actions/auth'
import AutoSubmit from './auto-submit'

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

  const formId = 'auth-callback-form'

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm text-center">

        <div className="mb-8">
          <Link href="/" className="inline-flex">
            <BrandLockup size="md" variant="solid" />
          </Link>
          <h1 className="mt-6 text-lg font-semibold text-gray-900 tracking-tight">
            {t('Continuing…', 'Continuando…')}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {t('Confirming your reset link.', 'Confirmando tu enlace.')}
          </p>
        </div>

        {/* Form is auto-submitted by the AutoSubmit client island
            on mount. The button below is a fallback for the tiny
            slice of users who have JS disabled — they see it and
            can tap it manually. Everyone else sees "Continuing…"
            for ~300 ms before the redirect. */}
        <form id={formId} action={completeAuthCodeExchange} className="space-y-4">
          <input type="hidden" name="code" value={code} />
          <input type="hidden" name="next" value={next} />
          <noscript>
            <button
              type="submit"
              className="w-full rounded-lg bg-[#18181B] px-4 py-2.5 text-sm font-semibold text-[#FAF9F6] hover:bg-black transition-colors"
            >
              {t('Continue', 'Continuar')}
            </button>
          </noscript>
        </form>
        <AutoSubmit formId={formId} />

        <p className="mt-6 text-center text-xs text-gray-400">
          <Link href="/login" className="hover:text-gray-600 transition-colors">
            {t('Back to sign in', 'Volver a iniciar sesión')}
          </Link>
        </p>
      </div>
    </div>
  )
}
