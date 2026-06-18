// ----------------------------------------------------------------
// System i18n — client-safe helpers
//
// This file is import-safe from BOTH server and client components.
// The Server-Component-only helpers (anything that reads cookies()
// or headers()) live in lib/i18n-server.ts to keep the module
// boundary clean: client bundles never accidentally pull in
// next/headers and explode the production build.
//
// Translation is incremental: the helper accepts an optional `es`
// argument and falls back to `en` when it's missing. Pages can
// translate strategic strings first and fill in deeper ones
// without breaking compilation.
// ----------------------------------------------------------------

export type Lang = 'en' | 'es'

// Pure helper for client components that received `lang` as a prop
// from a Server Component above. Returns a translator bound to
// the language.
//
// Usage:
//   const t = makeT(lang)
//   <h1>{t('Welcome back', 'Bienvenido de vuelta')}</h1>
export function makeT(lang: Lang): (en: string, es?: string) => string {
  return (en, es) => (lang === 'es' && es ? es : en)
}
