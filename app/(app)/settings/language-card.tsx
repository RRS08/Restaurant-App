'use client'

// ----------------------------------------------------------------
// LanguageCard — device-level language toggle on Settings.
//
// Sets the `lang` cookie (same one the marketing site uses) and
// hard-reloads so all server components re-render in the new
// language. Stored as a one-year cookie so it survives normal
// sessions; staff/owner mode does NOT change it because the
// language is a device preference, not a mode preference.
// ----------------------------------------------------------------

import { useTransition } from 'react'

interface Props {
  currentLang: 'en' | 'es'
}

export default function LanguageCard({ currentLang }: Props) {
  const [isPending, startTransition] = useTransition()

  const t = (en: string, es: string) => (currentLang === 'es' ? es : en)

  const switchTo = (next: 'en' | 'es') => {
    if (next === currentLang || isPending) return
    document.cookie = `lang=${next}; path=/; max-age=${365 * 24 * 60 * 60}; SameSite=Lax`
    startTransition(() => {
      window.location.reload()
    })
  }

  const isEn = currentLang === 'en'

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
          {t('Language', 'Idioma')}
        </p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400">
          {t('Device preference', 'Preferencia del dispositivo')}
        </p>
      </div>
      <p className="mt-1.5 text-base font-semibold text-gray-900">
        {t('Choose the language for this device.', 'Elige el idioma de este dispositivo.')}
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-gray-500">
        {t(
          'Switching changes the menus, labels, and access screen. The setting is per-device — staff and owner share the same language on this iPad.',
          'Cambiar el idioma actualiza los menús, las etiquetas y la pantalla de acceso. La configuración es por dispositivo — personal y dueño comparten el mismo idioma en esta tableta.'
        )}
      </p>

      <div role="group" aria-label={t('Language', 'Idioma')} className="mt-4 inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
        <button
          type="button"
          onClick={() => switchTo('en')}
          aria-pressed={isEn}
          disabled={isPending}
          className={
            'px-4 py-1.5 text-sm font-medium rounded-md transition-colors ' +
            (isEn
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-900')
          }
        >
          English
        </button>
        <button
          type="button"
          onClick={() => switchTo('es')}
          aria-pressed={!isEn}
          disabled={isPending}
          className={
            'px-4 py-1.5 text-sm font-medium rounded-md transition-colors ' +
            (!isEn
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-900')
          }
        >
          Español
        </button>
      </div>
      {isPending && (
        <p className="mt-2 text-[11px] text-gray-400">
          {t('Reloading…', 'Recargando…')}
        </p>
      )}
    </section>
  )
}
