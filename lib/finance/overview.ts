// ----------------------------------------------------------------
// Overview-tab computations.
//
// Pure functions that turn a movement list into the shapes the
// Overview panel renders — KPI figures, weekly income/expense
// series, expense-by-category breakdown, top merchants. Kept
// separate from the client so the same math can back a PDF, an
// email digest, or an API export later.
//
// Every function tolerates an empty movement list — the Overview
// panel handles empty-state UI itself; here we just return zeroed
// aggregates.
// ----------------------------------------------------------------

import type { FinanceMovement } from './types'

export interface OverviewKpis {
  revenue: number
  expenses: number
  net: number
  biggestExpense: { note: string; amount: number } | null
  txCount: number
}

export function computeKpis(movements: FinanceMovement[]): OverviewKpis {
  let revenue = 0
  let expenses = 0
  let biggest: { note: string; amount: number } | null = null
  for (const m of movements) {
    if (m.direction === 'income') revenue += m.amount
    else if (m.direction === 'expense') {
      expenses += m.amount
      if (!biggest || m.amount > biggest.amount) {
        biggest = { note: m.note ?? m.memo ?? m.category?.name ?? 'Charge', amount: m.amount }
      }
    }
  }
  return {
    revenue: round2(revenue),
    expenses: round2(expenses),
    net: round2(revenue - expenses),
    biggestExpense: biggest ? { note: biggest.note, amount: round2(biggest.amount) } : null,
    txCount: movements.length,
  }
}

export interface WeekPoint {
  weekStart: string   // ISO date, Monday
  income: number
  expense: number
}

/** Bucket movements into ISO weeks starting on Monday. `now`
 *  determines the last week — buckets are always filled through
 *  today's week even when the input contains no movements yet
 *  (so the chart doesn't collapse). */
export function weeklySeries(
  movements: FinanceMovement[],
  weeksBack: number,
  now: Date = new Date(),
): WeekPoint[] {
  const buckets: WeekPoint[] = []
  const thisWeekStart = startOfWeek(now)
  for (let i = weeksBack - 1; i >= 0; i--) {
    const d = new Date(thisWeekStart)
    d.setDate(d.getDate() - i * 7)
    buckets.push({ weekStart: d.toISOString().slice(0, 10), income: 0, expense: 0 })
  }
  const byKey = new Map(buckets.map(b => [b.weekStart, b]))
  for (const m of movements) {
    const wk = startOfWeek(new Date(m.occurred_at)).toISOString().slice(0, 10)
    const b = byKey.get(wk)
    if (!b) continue
    if (m.direction === 'income') b.income += m.amount
    else if (m.direction === 'expense') b.expense += m.amount
  }
  return buckets.map(b => ({ ...b, income: round2(b.income), expense: round2(b.expense) }))
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
    .sort((a, b) => b.total - a.total)
  return rows
}

export interface MerchantRow { name: string; total: number; count: number }
export function topMerchants(movements: FinanceMovement[], limit: number): MerchantRow[] {
  const map = new Map<string, MerchantRow>()
  for (const m of movements) {
    if (m.direction !== 'expense') continue
    const key = (m.note ?? m.memo ?? '').trim()
    if (!key) continue
    const cur = map.get(key) ?? { name: key, total: 0, count: 0 }
    cur.total += m.amount
    cur.count += 1
    map.set(key, cur)
  }
  return [...map.values()]
    .map(r => ({ ...r, total: round2(r.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
}

// ---------------------------------------------------------------- helpers

function startOfWeek(d: Date): Date {
  const out = new Date(d)
  const day = out.getDay()
  const diff = (day + 6) % 7 // Monday-based
  out.setDate(out.getDate() - diff)
  out.setHours(0, 0, 0, 0)
  return out
}

function round2(n: number): number { return Math.round(n * 100) / 100 }
