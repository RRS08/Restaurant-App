// ----------------------------------------------------------------
// Web-native Analytics  →  /web/analytics
//
// V1 display: daily revenue trend (last 14 days), category mix,
// payment mix, and at-risk inventory. Deeper analytics (item growth
// / decline tables, predictive depletion) stay in the classic
// route until they get their own web-native deepening.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import WebAnalyticsClient from './client'

export default async function WebAnalyticsPage() {
  const supabase = await createClient()
  const lang = await getLang()

  const now = new Date()
  const fourteenDaysAgo = new Date(now)
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 13)
  fourteenDaysAgo.setHours(0, 0, 0, 0)

  const [
    { data: orders },
    { data: orderItems },
  ] = await Promise.all([
    supabase
      .from('orders')
      .select('id, total_amount, created_at, payment_type, status')
      .eq('status', 'completed')
      .gte('created_at', fourteenDaysAgo.toISOString()),
    supabase
      .from('order_items')
      .select(`
        id, order_id, quantity, total_price,
        menu_items ( id, name, menu_categories ( id, name ) ),
        orders!inner ( created_at, status )
      `)
      .eq('orders.status', 'completed')
      .gte('orders.created_at', fourteenDaysAgo.toISOString()),
  ])

  // Daily revenue buckets (14 days)
  const dailyMap = new Map<string, number>()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    d.setHours(0, 0, 0, 0)
    dailyMap.set(d.toISOString().split('T')[0], 0)
  }
  for (const o of (orders ?? [])) {
    const key = new Date(o.created_at).toISOString().split('T')[0]
    if (dailyMap.has(key)) {
      dailyMap.set(key, (dailyMap.get(key) ?? 0) + Number(o.total_amount))
    }
  }
  const daily = [...dailyMap.entries()].map(([date, revenue]) => ({ date, revenue }))

  // Payment mix
  const paymentCounts = { cash: 0, card: 0, other: 0 }
  for (const o of (orders ?? [])) {
    const p = (o.payment_type ?? 'other') as keyof typeof paymentCounts
    if (p in paymentCounts) paymentCounts[p] += 1
    else paymentCounts.other += 1
  }
  const paymentTotal = paymentCounts.cash + paymentCounts.card + paymentCounts.other

  // Category mix (revenue per category)
  type OI = {
    quantity: number; total_price: number
    menu_items: { id: string; name: string; menu_categories: { id: string; name: string } | null } | null
  }
  const categoryMap = new Map<string, { name: string; revenue: number; qty: number }>()
  for (const oi of ((orderItems ?? []) as unknown as OI[])) {
    const cat = oi.menu_items?.menu_categories
    if (!cat) continue
    const entry = categoryMap.get(cat.id) ?? { name: cat.name, revenue: 0, qty: 0 }
    entry.revenue += Number(oi.total_price)
    entry.qty += Number(oi.quantity)
    categoryMap.set(cat.id, entry)
  }
  const categoryMix = [...categoryMap.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6)
  const categoryTotal = categoryMix.reduce((s, c) => s + c.revenue, 0)

  // Total revenue
  const totalRevenue = (orders ?? []).reduce((s, o) => s + Number(o.total_amount), 0)
  const totalOrders = (orders ?? []).length
  const avgTicket = totalOrders > 0 ? totalRevenue / totalOrders : 0

  return (
    <WebAnalyticsClient
      lang={lang}
      daily={daily}
      paymentCounts={paymentCounts}
      paymentTotal={paymentTotal}
      categoryMix={categoryMix}
      categoryTotal={categoryTotal}
      totalRevenue={totalRevenue}
      totalOrders={totalOrders}
      avgTicket={avgTicket}
    />
  )
}
