// ----------------------------------------------------------------
// /auth/callback  — auto-exchange landing for email links that
// still need a session established BEFORE the destination page
// runs (invite acceptance today; other confirm flows later).
//
// Password reset no longer routes through here — it lands on
// /reset-password directly and folds the exchange into the
// form submit, giving a clean "tap email → land on reset form"
// UX with zero intermediate page.
//
// For the remaining consumers (invites), we still need a
// session live before the destination page's logic runs, so
// this page renders a tiny "Continuing…" surface and auto-
// submits via a client island. Link scanners without JS never
// trigger the exchange; real browsers redirect in ~300 ms.
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

  if (sp.error) redirect('/login?reset=invalid')

  const code = (sp.code ?? '').trim()
  const next = (sp.next ?? '/dashboard').trim()

  if (!code) redirect('/login?reset=invalid')

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
            {t('One moment.', 'Un momento.')}
          </p>
        </div>

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
