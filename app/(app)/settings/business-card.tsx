// ----------------------------------------------------------------
// BusinessCard — compact identity card.
//
// Top: BUSINESS eyebrow + business name (prominent) + "location ·
// role" meta line. Footer: thin divider + "Signed in as Name".
// No row-per-field grid; the information is tight enough to read
// as a single block without dividers between every key/value.
// ----------------------------------------------------------------

import { makeT, type Lang } from '@/lib/i18n'

export default function BusinessCard({
  lang,
  businessName,
  locationName,
  userDisplayName,
  userEmail,
  role,
}: {
  lang: Lang
  businessName: string | null
  locationName: string | null
  userDisplayName: string | null
  userEmail: string | null
  role: 'owner' | 'manager' | 'staff' | null
}) {
  const t = makeT(lang)
  const roleLabel =
    role === 'owner' ? t('Owner', 'Dueño')
      : role === 'manager' ? t('Manager', 'Gerente')
      : role === 'staff' ? t('Staff', 'Personal')
      : null

  // Compose the meta line. "McAllen · Owner" reads naturally; when
  // one piece is missing we degrade gracefully without leaving a
  // dangling separator.
  const metaParts: string[] = []
  if (locationName) metaParts.push(locationName)
  if (roleLabel) metaParts.push(roleLabel)
  const metaLine = metaParts.length > 0 ? metaParts.join(' · ') : null

  const signedInLabel = userDisplayName ?? userEmail ?? t('Unknown', 'Desconocido')

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-5 py-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
        {t('Business', 'Negocio')}
      </p>
      <p className="mt-1.5 text-base font-semibold text-gray-900 truncate">
        {businessName ?? t('Not set', 'Sin configurar')}
      </p>
      {metaLine && (
        <p className="mt-0.5 text-[11px] text-gray-500 truncate">{metaLine}</p>
      )}
      <p className="mt-3 pt-3 border-t border-gray-100 text-[11px] text-gray-500 truncate">
        <span className="text-gray-400">{t('Signed in as ', 'Sesión iniciada como ')}</span>
        <span className="text-gray-700">{signedInLabel}</span>
      </p>
    </section>
  )
}
