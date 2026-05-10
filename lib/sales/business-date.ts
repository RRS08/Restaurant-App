// ----------------------------------------------------------------
// Business-date helper
//
// "Business date" = the calendar date a sale belongs to, in the
// restaurant's local timezone. Computed at insert time and stored
// on `orders.business_date` so weekly summaries and other reports
// can bucket sales without re-doing timezone math on every read.
//
// Why a helper instead of a SQL trigger or generated column:
//   • Generated columns can't reference other tables (we'd need
//     locations.timezone), and a trigger that joins per-row would
//     pay a lookup cost every insert.
//   • The action-layer code already has the location row in hand
//     (or fetches it cheaply); converting once at the app layer is
//     simpler, faster, and visible in code review.
// ----------------------------------------------------------------

/**
 * Format a Date (or ISO string) as a YYYY-MM-DD calendar date in
 * the given IANA timezone. Returns the same shape Postgres `date`
 * columns accept directly.
 *
 * `en-CA` is used as the locale because it formats as `YYYY-MM-DD`
 * by default — the only locale that does so without manual padding.
 */
export function businessDateInTimezone(
  when: Date | string,
  timezone: string | null | undefined
): string {
  const d = typeof when === 'string' ? new Date(when) : when
  // Fallback to UTC if the location somehow has no timezone set —
  // never throw at the app boundary just because tz config is sparse.
  const tz = timezone && timezone.trim().length > 0 ? timezone : 'UTC'
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
  } catch {
    // Invalid timezone string — fall back to UTC rather than crash.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
  }
}
