// ----------------------------------------------------------------
// BusinessCard — compact identity card.
//
// Top: BUSINESS eyebrow + business name (prominent) + "location ·
// role" meta line. Footer: thin divider + "Signed in as Name".
// No row-per-field grid; the information is tight enough to read
// as a single block without dividers between every key/value.
// ----------------------------------------------------------------

export default function BusinessCard({
  businessName,
  locationName,
  userDisplayName,
  userEmail,
  role,
}: {
  businessName: string | null
  locationName: string | null
  userDisplayName: string | null
  userEmail: string | null
  role: 'owner' | 'manager' | 'staff' | null
}) {
  const roleLabel =
    role === 'owner' ? 'Owner' : role === 'manager' ? 'Manager' : role === 'staff' ? 'Staff' : null

  // Compose the meta line. "McAllen · Owner" reads naturally; when
  // one piece is missing we degrade gracefully without leaving a
  // dangling separator.
  const metaParts: string[] = []
  if (locationName) metaParts.push(locationName)
  if (roleLabel) metaParts.push(roleLabel)
  const metaLine = metaParts.length > 0 ? metaParts.join(' · ') : null

  const signedInLabel = userDisplayName ?? userEmail ?? 'Unknown'

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-5 py-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
        Business
      </p>
      <p className="mt-1.5 text-base font-semibold text-gray-900 truncate">
        {businessName ?? 'Not set'}
      </p>
      {metaLine && (
        <p className="mt-0.5 text-[11px] text-gray-500 truncate">{metaLine}</p>
      )}
      <p className="mt-3 pt-3 border-t border-gray-100 text-[11px] text-gray-500 truncate">
        <span className="text-gray-400">Signed in as </span>
        <span className="text-gray-700">{signedInLabel}</span>
      </p>
    </section>
  )
}
