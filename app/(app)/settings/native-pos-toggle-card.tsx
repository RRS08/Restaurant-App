'use client'

// ----------------------------------------------------------------
// NativePosToggleCard — "Activate local POS" opt-in for external_pos
// merchants.
//
// Owner action. When a restaurant's operating_mode is 'external_pos'
// (they run sales through GoDaddy / Square / Clover) the /pos link
// hides from the sidebar because they don't need it. Some merchants
// want to gradually migrate onto the in-app POS while keeping their
// external terminal live — this toggle exposes /pos in the sidebar
// so they can try it without flipping their source-of-truth.
//
// Only meaningful when:
//   • operating_mode = 'external_pos'  (native_pos merchants already
//                                       have the link)
//   • user is an owner                (server action rejects others)
//
// The card is intentionally quiet: a small toggle + one sentence.
// Full migration off external POS still requires a mode change,
// which stays in the setup / onboarding paths.
// ----------------------------------------------------------------

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setNativePosEnabled } from '@/app/actions/operations'
import { makeT, type Lang } from '@/lib/i18n'

interface Props {
  lang: Lang
  initialEnabled: boolean
}

export default function NativePosToggleCard({ lang, initialEnabled }: Props) {
  const t = makeT(lang)
  const router = useRouter()
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const onToggle = () => {
    const next = !enabled
    setError(null)
    // Optimistic update — flip the visual immediately, roll back on
    // error. Toggles like this feel broken with an in-flight spinner
    // and no visible state change.
    setEnabled(next)
    startTransition(async () => {
      const r = await setNativePosEnabled(next)
      if ('error' in r) {
        setEnabled(!next)
        setError(r.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
            {t('Local POS', 'POS local')}
          </p>
          <p className="mt-1.5 text-base font-semibold text-gray-900">
            {t('Activate the in-app POS', 'Activar POS de la app')}
          </p>
          <p className="mt-1 text-xs text-gray-500 max-w-md leading-relaxed">
            {t(
              'Adds the POS link to the sidebar so you can ring up sales inside Checked while your GoDaddy terminal keeps running. Both sources feed into Sales.',
              'Añade el enlace POS a la barra lateral para que puedas cobrar dentro de Checked mientras tu terminal de GoDaddy sigue funcionando. Ambas fuentes alimentan Ventas.',
            )}
          </p>
        </div>

        {/* Toggle. Native <button> role="switch" is more accessible
            than a plain checkbox and keeps the styling under our
            control — no vendored switch component. */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t('Activate local POS', 'Activar POS local')}
          onClick={onToggle}
          disabled={pending}
          className={`flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
            enabled ? 'bg-gray-900' : 'bg-gray-200'
          }`}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${
              enabled ? 'translate-x-[22px]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {error && (
        <p className="mt-3 text-xs text-red-600">{error}</p>
      )}
    </section>
  )
}
