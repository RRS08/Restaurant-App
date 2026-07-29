// ----------------------------------------------------------------
// Analytics Page  →  /analytics
//
// Descriptive-only surface (2026-07 pass). The client renders a
// Monday-anchored week (or 4-week month) view; server ships:
//
//   • 60 days of daily revenue / order buckets (chart + KPIs)
//   • per-day payment breakdown (feeds the payment card)
//   • per-day category revenue rows (feed the category card)
//
// Per-day granularity is what lets the composition cards match
// the exact visible window on the client — including partial
// current weeks that "build up" as the days accumulate — instead
// of showing a stale rolling-7d snapshot.
//
// Labor cost is intentionally NOT loaded here — that's a money
// interpretation question and lives in Finance.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import AnalyticsClient from './client'
import AnalyticsLocked from './locked'
import { computeReadiness } from '@/lib/readiness'
import { businessDateInTimezone } from '@/lib/sales/business-date'

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
  business_date: string | null
  status: string | null
  payment_type: string | null
  order_items: OrderItemRow[] | null
}

type PaymentBucket = 'cash' | 'card' | 'other'

interface DailyPaymentBucket {
  date: string
  cash: { revenue: number; orders: number }
  card: { revenue: number; orders: number }
  other: { revenue: number; orders: number }
}

interface DailyCategoryEntry {
  date: string
  categoryId: string
  categoryName: string
  revenue: number
  qty: number
}

function emptyDailyPayment(date: string): DailyPaymentBucket {
  return {
    date,
    cash: { revenue: 0, orders: 0 },
    card: { revenue: 0, orders: 0 },
    other: { revenue: 0, orders: 0 },
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
  // snapshot, so this branch respects both. We also grab the
  // restaurant's location timezone here so the daily bucketing
  // below can key off business_date in local time (matching the
  // Sales page) instead of UTC-drifted created_at.
  let timezone: string | null = null
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
      const { data: loc } = await supabase
        .from('locations')
        .select('timezone')
        .eq('restaurant_id', role.restaurant_id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      timezone = (loc?.timezone as string | null) ?? null
    }
  }

  // Build the 60-day window in the restaurant's local calendar.
  // These keys match the plain YYYY-MM-DD values Sales writes into
  // orders.business_date at insert time via businessDateInTimezone.
  // Using them for both the query filter and the daily bucketing
  // means Analytics and Sales agree on which orders belong to
  // which day, no matter what timezone the server runs in.
  const todayKey = businessDateInTimezone(new Date(), timezone)
  const dateKeys: string[] = []
  {
    const [y, m, d] = todayKey.split('-').map(Number)
    const anchor = new Date(y, m - 1, d)
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const dd = new Date(anchor.getTime() - i * 86400000)
      dateKeys.push(toDateKey(dd))
    }
  }
  const windowStartKey = dateKeys[0]

  const { data: orders } = await supabase
    .from('orders')
    .select(`
      id, total_amount, created_at, business_date, payment_type, status,
      order_items (
        quantity, total_price,
        menu_items (
          id, name, category_id,
          menu_categories ( id, name )
        )
      )
    `)
    // Filter by business_date instead of created_at so late-evening
    // orders in the restaurant's timezone don't roll into the next
    // UTC day and disappear from their real business day.
    .gte('business_date', windowStartKey)
    .order('created_at', { ascending: true })

  // ---- Seed per-day maps for the full window ----
  // Pre-populating every date-key means the client can index into
  // the arrays without null-checking, and gaps still render as
  // zero-bar days on the chart.
  const dailyMap = new Map<string, { revenue: number; orders: number }>()
  const dailyPaymentMap = new Map<string, DailyPaymentBucket>()
  const dailyCategoryMap = new Map<string, Map<string, DailyCategoryEntry>>()

  for (const key of dateKeys) {
    dailyMap.set(key, { revenue: 0, orders: 0 })
    dailyPaymentMap.set(key, emptyDailyPayment(key))
    dailyCategoryMap.set(key, new Map())
  }

  const typedOrders = (orders ?? []) as unknown as OrderRow[]

  for (const o of typedOrders) {
    // Match Sales' status semantics: NULL status is treated as
    // completed. Only voided orders are excluded from analytics.
    // Doing this in the loop (instead of an SQL `.eq('status',
    // 'completed')`) is what fixes the "some orders missing"
    // discrepancy — SQL equality drops NULL rows outright.
    if (o.status === 'voided') continue

    const key = o.business_date
    if (!key) continue
    const bucket = dailyMap.get(key)
    if (!bucket) continue

    const total = Number(o.total_amount)
    bucket.revenue += total
    bucket.orders += 1

    const dayPayment = dailyPaymentMap.get(key)!
    const paymentBucket = normalizePaymentType(o.payment_type ?? null)
    dayPayment[paymentBucket].revenue += total
    dayPayment[paymentBucket].orders += 1

    const dayCatMap = dailyCategoryMap.get(key)!
    for (const oi of o.order_items ?? []) {
      const item = oi.menu_items
      if (!item?.menu_categories) continue
      const cat = item.menu_categories
      const entry = dayCatMap.get(cat.id) ?? {
        date: key,
        categoryId: cat.id,
        categoryName: cat.name,
        revenue: 0,
        qty: 0,
      }
      entry.revenue += Number(oi.total_price)
      entry.qty += Number(oi.quantity)
      dayCatMap.set(cat.id, entry)
    }
  }

  const dailyBuckets = Array.from(dailyMap.entries()).map(([date, b]) => ({
    date,
    revenue: round2(b.revenue),
    orders: b.orders,
  }))

  const dailyPayments = Array.from(dailyPaymentMap.values()).map((p) => ({
    date: p.date,
    cash:  { revenue: round2(p.cash.revenue),  orders: p.cash.orders },
    card:  { revenue: round2(p.card.revenue),  orders: p.card.orders },
    other: { revenue: round2(p.other.revenue), orders: p.other.orders },
  }))

  const dailyCategories: DailyCategoryEntry[] = []
  for (const dayMap of dailyCategoryMap.values()) {
    for (const entry of dayMap.values()) {
      dailyCategories.push({ ...entry, revenue: round2(entry.revenue) })
    }
  }

  return (
    <AnalyticsClient
      lang={lang}
      dailyBuckets={dailyBuckets}
      dailyPayments={dailyPayments}
      dailyCategories={dailyCategories}
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
