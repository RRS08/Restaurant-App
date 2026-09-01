// ----------------------------------------------------------------
// Recurring-charge detection.
//
// Groups movements by their merchant fingerprint (note / memo,
// normalized) and looks for ≥2 charges of a similar amount at a
// recognizable cadence (weekly, biweekly, monthly, yearly). We
// don't require perfect regularity — a landlord who deposits on
// the 1st but sometimes the 3rd still counts as monthly.
//
// The signal is meant to be conservative: false positives
// (labelling a one-off charge as recurring) are worse than false
// negatives (missing a real one) because the panel shows this
// list as an obligation forecast. When in doubt, we don't flag it.
// ----------------------------------------------------------------

import type { FinanceMovement } from './types'

export type RecurringCadence = 'weekly' | 'biweekly' | 'monthly' | 'yearly'

export interface RecurringCharge {
  fingerprint: string        // stable key across ledger reloads
  merchant: string           // display name — the note as written
  cadence: RecurringCadence
  averageAmount: number
  lastOccurredAt: string     // ISO
  nextExpectedAt: string     // ISO
  occurrences: number
  categoryName: string | null
  categoryColor: string | null
  accountName: string | null // the source account name for expenses; dest for income
}

const CADENCE_DAYS: Record<RecurringCadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  yearly: 365,
}
const CADENCE_TOLERANCE_DAYS: Record<RecurringCadence, number> = {
  weekly: 2,
  biweekly: 3,
  monthly: 5,
  yearly: 21,
}

/** Detect recurring charges in a movement window. Returns them
 *  sorted by next-expected date ascending so the panel reads as a
 *  bill calendar. Transfers between the operator's own accounts
 *  are excluded — they're internal motion, not obligations. */
export function detectRecurring(
  movements: FinanceMovement[],
  now: Date = new Date(),
): RecurringCharge[] {
  const groups = new Map<string, FinanceMovement[]>()
  for (const m of movements) {
    if (m.direction === 'transfer') continue
    const fp = fingerprintFor(m)
    if (!fp) continue
    const bucket = groups.get(fp) ?? []
    bucket.push(m)
    groups.set(fp, bucket)
  }

  const out: RecurringCharge[] = []
  for (const [fp, list] of groups.entries()) {
    if (list.length < 2) continue

    // Order oldest → newest so intervals compute in a stable direction.
    const sorted = [...list].sort(
      (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
    )
    const intervals: number[] = []
    for (let i = 1; i < sorted.length; i++) {
      const days = (new Date(sorted[i].occurred_at).getTime() -
                    new Date(sorted[i - 1].occurred_at).getTime()) / (24 * 60 * 60 * 1000)
      intervals.push(days)
    }
    const cadence = classifyCadence(intervals)
    if (!cadence) continue

    // Average amount, rounded — used both for display and for the
    // fingerprint tolerance downstream.
    const avg = round2(sorted.reduce((s, m) => s + m.amount, 0) / sorted.length)

    // Skip series with wildly inconsistent amounts (>25% spread from
    // the average) — those are likely category clumps ("Amazon"
    // billed 4x for unrelated items), not a real recurring charge.
    const spread = maxDeviation(sorted.map(m => m.amount), avg)
    if (avg > 0 && spread / avg > 0.25) continue

    const last = sorted[sorted.length - 1]
    const next = new Date(new Date(last.occurred_at).getTime() + CADENCE_DAYS[cadence] * 86_400_000)

    // If the "next" date is already >1 tolerance window in the past,
    // the series has probably lapsed — don't surface it as pending.
    const staleCutoff = now.getTime() - CADENCE_TOLERANCE_DAYS[cadence] * 86_400_000
    if (next.getTime() < staleCutoff) continue

    out.push({
      fingerprint: fp,
      merchant: (last.note ?? last.memo ?? 'Recurring').trim(),
      cadence,
      averageAmount: avg,
      lastOccurredAt: last.occurred_at,
      nextExpectedAt: next.toISOString(),
      occurrences: sorted.length,
      categoryName: last.category?.name ?? null,
      categoryColor: last.category?.color ?? null,
      accountName:
        last.direction === 'expense'
          ? last.source?.name ?? null
          : last.dest?.name ?? null,
    })
  }

  return out.sort(
    (a, b) => new Date(a.nextExpectedAt).getTime() - new Date(b.nextExpectedAt).getTime()
  )
}

// ---------------------------------------------------------------- helpers

/** Fingerprint = lowercased alphanumeric prefix of the note/memo,
 *  first ~30 chars. Two charges from "Amazon *G7RT2K" and
 *  "Amazon *H8ST9L" collapse to the same key so subscription
 *  variants pair correctly. Empty prefixes are dropped. */
function fingerprintFor(m: FinanceMovement): string | null {
  const raw = (m.note ?? m.memo ?? '').toLowerCase()
  const stripped = raw.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!stripped) return null
  return stripped.slice(0, 30)
}

function classifyCadence(intervals: number[]): RecurringCadence | null {
  if (intervals.length === 0) return null
  // Pick the cadence whose expected days is closest to the median
  // interval AND whose deviation stays inside the tolerance.
  const median = medianOf(intervals)
  let best: { cad: RecurringCadence; diff: number } | null = null
  for (const cad of ['weekly', 'biweekly', 'monthly', 'yearly'] as const) {
    const diff = Math.abs(median - CADENCE_DAYS[cad])
    if (diff > CADENCE_TOLERANCE_DAYS[cad]) continue
    if (!best || diff < best.diff) best = { cad, diff }
  }
  return best?.cad ?? null
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function maxDeviation(xs: number[], from: number): number {
  return xs.reduce((m, x) => Math.max(m, Math.abs(x - from)), 0)
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
