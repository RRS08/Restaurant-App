// ----------------------------------------------------------------
// Analytics Page  →  /analytics
//
// Business pattern and performance workspace. Distinct from:
//   Dashboard — "what needs attention right now"
//   Finance   — "what's happening with money"
//   Analytics — "what patterns are happening across the business"
//
// Server component pre-aggregates the raw order / order_item data
// into the shapes the client needs, so the client stays focused on
// presentation + the small interaction toggles.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import AnalyticsClient from './client'
import AnalyticsLocked from './locked'
import { computeReadiness } from '@/lib/readiness'

// Number of days to load. 60 gives us "current 30d vs previous 30d"
// for trend + risers/decliners comparisons. The client decides which
// window to actually show (7d or 30d).
const WINDOW_DAYS = 60

interface OrderItemRow {
  quantity: number
  total_price: number | string
  menu_items: {
    id: string
    name: string
    category_id: string | null
    menu_categories: { id: string; name: string } | null
  } | null
}

interface OrderRow {
  id: string
  total_amount: number | string
  created_at: string
  order_items: OrderItemRow[] | null
}

export default async function AnalyticsPage() {
  const supabase = await createClient()

  // Readiness gate — Analytics uses a setup + live-data gate.
  // Dev bypass and per-pillar overrides are already baked into the
  // snapshot, so this branch respects both.
  const { data: { user } } = await supabase.auth.getUser()
  if (user) {
    const { data: role } = await supabase
      .from('user_roles')
      .select('restaurant_id')
      .eq('user_id', user.id)
      .single()
    if (role?.restaurant_id) {
      const readiness = await computeReadiness(supabase, role.restaurant_id)
      if (readiness.pillars.analytics !== 'active') {
        return <AnalyticsLocked readiness={readiness} />
      }
    }
  }

  const now = new Date()
  const windowStart = new Date(now)
  windowStart.setDate(windowStart.getDate() - WINDOW_DAYS)
  windowStart.setHours(0, 0, 0, 0)

  // Current / previous 30-day boundaries for comparative aggregates
  const current30Start = new Date(now)
  current30Start.setDate(current30Start.getDate() - 30)
  current30Start.setHours(0, 0, 0, 0)

  const [{ data: orders }, { data: shifts }] = await Promise.all([
    supabase
      .from('orders')
      .select(`
        id, total_amount, created_at,
        order_items (
          quantity, total_price,
          menu_items (
            id, name, category_id,
            menu_categories ( id, name )
          )
        )
      `)
      .eq('status', 'completed')
      .gte('created_at', windowStart.toISOString())
      .order('created_at', { ascending: true }),

    supabase
      .from('shifts')
      .select('id, start_time, end_time, employees ( hourly_rate )')
      .gte('start_time', windowStart.toISOString()),
  ])

  // ---- Daily revenue / order buckets ----
  const dailyMap = new Map<string, { revenue: number; orders: number }>()
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(windowStart)
    d.setDate(windowStart.getDate() + i)
    dailyMap.set(toDateKey(d), { revenue: 0, orders: 0 })
  }

  const typedOrders = (orders ?? []) as unknown as OrderRow[]

  for (const o of typedOrders) {
    const key = toDateKey(new Date(o.created_at))
    const bucket = dailyMap.get(key)
    if (!bucket) continue
    bucket.revenue += Number(o.total_amount)
    bucket.orders += 1
  }

  const dailyBuckets = Array.from(dailyMap.entries()).map(([date, b]) => ({
    date,
    revenue: round2(b.revenue),
    orders: b.orders,
  }))

  // ---- Item + category aggregates (current 30d + previous 30d) ----
  type Agg = { id: string; name: string; currentRevenue: number; currentQty: number; previousRevenue: number }
  const itemAgg = new Map<string, Agg>()
  const catAgg = new Map<string, Agg>()

  for (const o of typedOrders) {
    const created = new Date(o.created_at)
    const isCurrent = created >= current30Start
    for (const oi of o.order_items ?? []) {
      const item = oi.menu_items
      if (!item) continue
      const qty = Number(oi.quantity)
      const revenue = Number(oi.total_price)

      // Item bucket
      const itemRow = itemAgg.get(item.id) ?? { id: item.id, name: item.name, currentRevenue: 0, currentQty: 0, previousRevenue: 0 }
      if (isCurrent) {
        itemRow.currentRevenue += revenue
        itemRow.currentQty += qty
      } else {
        itemRow.previousRevenue += revenue
      }
      itemAgg.set(item.id, itemRow)

      // Category bucket
      const cat = item.menu_categories
      if (cat) {
        const catRow = catAgg.get(cat.id) ?? { id: cat.id, name: cat.name, currentRevenue: 0, currentQty: 0, previousRevenue: 0 }
        if (isCurrent) {
          catRow.currentRevenue += revenue
          catRow.currentQty += qty
        } else {
          catRow.previousRevenue += revenue
        }
        catAgg.set(cat.id, catRow)
      }
    }
  }

  const itemAggregates = Array.from(itemAgg.values()).map((r) => ({
    ...r,
    currentRevenue: round2(r.currentRevenue),
    previousRevenue: round2(r.previousRevenue),
  }))

  const categoryAggregates = Array.from(catAgg.values()).map((r) => ({
    ...r,
    currentRevenue: round2(r.currentRevenue),
    previousRevenue: round2(r.previousRevenue),
  }))

  // ---- Daily labor estimate (last 30d) for the relationship view ----
  const laborMap = new Map<string, number>()
  for (let i = 0; i < 30; i++) {
    const d = new Date(current30Start)
    d.setDate(current30Start.getDate() + i)
    laborMap.set(toDateKey(d), 0)
  }

  for (const shift of shifts ?? []) {
    const start = new Date(shift.start_time)
    if (start < current30Start) continue
    const key = toDateKey(start)
    if (!laborMap.has(key)) continue
    const end = new Date(shift.end_time)
    const emp = shift.employees as unknown as { hourly_rate: number | null } | null
    const rate = Number(emp?.hourly_rate ?? 0)
    if (!rate) continue
    const hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60)
    laborMap.set(key, (laborMap.get(key) ?? 0) + hours * rate)
  }

  const dailyLabor = Array.from(laborMap.entries()).map(([date, cost]) => ({
    date,
    laborCost: round2(cost),
  }))

  return (
    <AnalyticsClient
      dailyBuckets={dailyBuckets}
      itemAggregates={itemAggregates}
      categoryAggregates={categoryAggregates}
      dailyLabor={dailyLabor}
    />
  )
}

// ----------------------------------------------------------------
function toDateKey(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
