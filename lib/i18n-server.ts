// ----------------------------------------------------------------
// System i18n — Server-Component-only helpers
//
// These read the `lang` cookie via next/headers, which is a
// Server-Component-only API. Keep this file out of any client
// component import graph or the Turbopack build will fail with
// "You're importing a module that depends on next/headers."
//
// Client components should import { Lang, makeT } from '@/lib/i18n'
// and receive `lang` as a prop from a Server Component above.
// ----------------------------------------------------------------

import { cookies } from 'next/headers'
import { makeT, type Lang } from './i18n'

export async function getLang(): Promise<Lang> {
  const c = await cookies()
  const v = c.get('lang')?.value
  return v === 'es' ? 'es' : 'en'
}

// Returns a translator bound to the current request's language.
// Usage in a Server Component:
//   const t = await getT()
//   <h1>{t('Welcome back', 'Bienvenido de vuelta')}</h1>
export async function getT(): Promise<(en: string, es?: string) => string> {
  const lang = await getLang()
  return makeT(lang)
}
