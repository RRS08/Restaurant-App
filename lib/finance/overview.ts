// ----------------------------------------------------------------
// Overview-tab computations.
//
// Reduced to the shapes the redesigned Overview still needs — the
// two-card layout dropped KPI cards, weekly bars, and top-merchant
// list, so their derivations came out with them. The report's
// deeper P&L math lives inline in app/(app)/finance/report/page.tsx
// where it can evolve with the report design.
//
// Every function tolerates an empty movement list.
// ----------------------------------------------------------------

import type { FinanceMovement } from './types'

/** A movement counts toward operational cash flow only when it's
 *  not marked as an internal transfer or a transfer-kind category
 *  (Personal, Owner draw, Between accounts). Kept exported because
 *  the P&L totals in the report use the same rule. */
export function isOperational(m: FinanceMovement): boolean {
  if (m.direction === 'transfer') return false
  if (m.category?.kind === 'transfer') return false
  return true
}

export interface CategorySlice {
  name: string
  color: string | null
  total: number
  share: number  // 0-1
  count: number
}

export function expenseByCategory(movements: FinanceMovement[]): CategorySlice[] {
  const map = new Map<string, { name: string; color: string | null; total: number; count: number }>()
  let grand = 0
  for (const m of movements) {
    if (m.direction !== 'expense') continue
    if (!isOperational(m)) continue
    const name = m.category?.name ?? 'Uncategorized'
    const color = m.category?.color ?? null
    const cur = map.get(name) ?? { name, color, total: 0, count: 0 }
    cur.total += m.amount
    cur.count += 1
    grand += m.amount
    map.set(name, cur)
  }
  const rows = [...map.values()]
    .map(r => ({
      ...r,
      total: round2(r.total),
      share: grand > 0 ? r.total / grand : 0,
    }))
    // A category that nets to zero has nothing to show. Cannot
    // happen from a single movement (amount > 0 is enforced), but
    // refunds or a future signed-amount path could zero one out —
    // and an entry in the legend with no visible arc reads as a
    // rendering bug rather than as data.
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total)
  return rows
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
