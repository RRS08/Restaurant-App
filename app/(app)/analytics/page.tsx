// ----------------------------------------------------------------
// Analytics Page  →  /analytics
//
// Descriptive-only surface (2026-07 pass). The prior Diagnostic +
// Predictive tabs were retired; the single-page client just needs
// three pre-aggregated inputs:
//
//   • 60 days of daily revenue / order buckets (chart + KPIs)
//   • payment mix bucketed at both 7d and 30d windows
//   • category mix bucketed at both 7d and 30d windows
//
// Labor cost is intentionally NOT loaded here — that's a money
// interpretation question and lives in Finance.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import AnalyticsClient from './client'
import AnalyticsLocked from './locked'
import { computeReadiness } from '@/lib/readiness'

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
  payment_type: string | null
  order_items: OrderItemRow[] | null
}

type PaymentBucket = 'cash' | 'card' | 'other'

interface PaymentMix {
  cash: { revenue: number; orders: number }
  card: { revenue: number; orders: number }
  other: { revenue: number; orders: number }
  totalRevenue: number
  totalOrders: number
}

function emptyPaymentMix(): PaymentMix {
  return {
    cash: { revenue: 0, orders: 0 },
    card: { revenue: 0, orders: 0 },
    other: { revenue: 0, orders: 0 },
    totalRevenue: 0,
    totalOrders: 0,
  }
}

function normalizePaymentType(raw: string | null): PaymentBucket {
  if (raw === 'cash' || raw === 'card') return raw
  return 'other'
}

export default async function AnalyticsPage() {
  const supabase = await createClient()
  const lang = await getLang()

  // Readiness gate — Analytics uses a setup + live-data gate. Dev
  // bypass and per-pillar overrides are already baked into the
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
        return <AnalyticsLocked readiness={readiness} lang={lang} />
      }
    }
  }

  const now = new Date()
  const windowStart = new Date(now)
  windowStart.setDate(windowStart.getDate() - WINDOW_DAYS)
  windowStart.setHours(0, 0, 0, 0)

  const current30Start = new Date(now)
  current30Start.setDate(current30Start.getDate() - 30)
  current30Start.setHours(0, 0, 0, 0)

  const current7Start = new Date(now)
  current7Start.setDate(current7Start.getDate() - 7)
  current7Start.setHours(0, 0, 0, 0)

  const { data: orders } = await supabase
    .from('orders')
    .select(`
      id, total_amount, created_at, payment_type,
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
    .order('created_at', { ascending: true })

  // ---- Daily revenue / order buckets (60d) ----
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

  // ---- Window-scoped mix aggregates ----
  // Payment mix + category mix bucketed for BOTH 7d and 30d so the
  // composition cards track the Week/Month toggle on the client.
  const paymentMix7d = emptyPaymentMix()
  const paymentMix30d = emptyPaymentMix()
  const catMix7d = new Map<string, { id: string; name: string; revenue: number; qty: number }>()
  const catMix30d = new Map<string, { id: string; name: string; revenue: number; qty: number }>()

  for (const o of typedOrders) {
    const created = new Date(o.created_at)
    const inCurrent30 = created >= current30Start
    const inCurrent7 = created >= current7Start
    const total = Number(o.total_amount)
    const bucket = normalizePaymentType(o.payment_type ?? null)

    if (inCurrent30) {
      paymentMix30d[bucket].revenue += total
      paymentMix30d[bucket].orders += 1
      paymentMix30d.totalRevenue += total
      paymentMix30d.totalOrders += 1
    }
    if (inCurrent7) {
      paymentMix7d[bucket].revenue += total
      paymentMix7d[bucket].orders += 1
      paymentMix7d.totalRevenue += total
      paymentMix7d.totalOrders += 1
    }

    for (const oi of o.order_items ?? []) {
      const item = oi.menu_items
      if (!item) continue
      const cat = item.menu_categories
      if (!cat) continue
      const qty = Number(oi.quantity)
      const revenue = Number(oi.total_price)

      if (inCurrent30) {
        const r30 = catMix30d.get(cat.id) ?? { id: cat.id, name: cat.name, revenue: 0, qty: 0 }
        r30.revenue += revenue
        r30.qty += qty
        catMix30d.set(cat.id, r30)
      }
      if (inCurrent7) {
        const r7 = catMix7d.get(cat.id) ?? { id: cat.id, name: cat.name, revenue: 0, qty: 0 }
        r7.revenue += revenue
        r7.qty += qty
        catMix7d.set(cat.id, r7)
      }
    }
  }

  // Round payment mix totals so the client doesn't render
  // floating-point drift.
  for (const m of [paymentMix7d, paymentMix30d]) {
    for (const k of ['cash', 'card', 'other'] as const) {
      m[k].revenue = round2(m[k].revenue)
    }
    m.totalRevenue = round2(m.totalRevenue)
  }

  const categoryMix7d = Array.from(catMix7d.values())
    .map((r) => ({ ...r, revenue: round2(r.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)

  const categoryMix30d = Array.from(catMix30d.values())
    .map((r) => ({ ...r, revenue: round2(r.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)

  return (
    <AnalyticsClient
      lang={lang}
      dailyBuckets={dailyBuckets}
      categoryMix7d={categoryMix7d}
      categoryMix30d={categoryMix30d}
      paymentMix7d={paymentMix7d}
      paymentMix30d={paymentMix30d}
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
