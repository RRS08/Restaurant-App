// ----------------------------------------------------------------
// System i18n helper
//
// Same cookie (`lang`) as the marketing site so a visitor who picks
// Spanish on /  carries the preference straight into the app once
// they sign in. No DB column needed — language is a device-level
// preference, set via the toggle in the sidebar (or marketing nav).
//
// Server Components get an awaited `t` from getT(). Client
// components receive `lang: Lang` as a prop from a Server Component
// above them and build their own one-liner: `(en, es) => ...`.
//
// Translation is incremental: this helper accepts an optional `es`
// argument and falls back to `en` when it's missing. Pages can
// translate strategic strings first and fill in deeper ones
// without breaking compilation.
// ----------------------------------------------------------------

import { cookies } from 'next/headers'

export type Lang = 'en' | 'es'

export async function getLang(): Promise<Lang> {
  const c = await cookies()
  const v = c.get('lang')?.value
  return v === 'es' ? 'es' : 'en'
}

// Returns a translator bound to the current request's language.
// Usage:
//   const t = await getT()
//   <h1>{t('Welcome back', 'Bienvenido de vuelta')}</h1>
export async function getT(): Promise<(en: string, es?: string) => string> {
  const lang = await getLang()
  return (en: string, es?: string): string => (lang === 'es' && es ? es : en)
}

// Pure helper for client components that received `lang` as a prop.
// Avoids re-declaring the same fallback logic in every file.
export function makeT(lang: Lang): (en: string, es?: string) => string {
  return (en, es) => (lang === 'es' && es ? es : en)
}
