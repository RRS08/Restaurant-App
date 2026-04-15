// ----------------------------------------------------------------
// Dashboard V2  →  /dashboard
//
// Operational command surface for a restaurant manager.
// Answers: what needs attention? Are we ready to operate?
//
// NOT a finance page. NOT a reporting dashboard.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import DashboardClient from './client'
import { computeReadiness, type PillarKey, type PillarState } from '@/lib/readiness'

export default async function DashboardPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const [{ data: profile }, { data: userRole }] = await Promise.all([
    supabase.from('profiles').select('full_name').eq('id', user!.id).single(),
    supabase.from('user_roles').select('restaurant_id').eq('user_id', user!.id).single(),
  ])

  // ---- Date boundaries ----
  const now = new Date()

  const sevenDaysAgo = new Date(now)
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6)
  sevenDaysAgo.setHours(0, 0, 0, 0)

  const day = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
  monday.setHours(0, 0, 0, 0)
  const sundayEnd = new Date(monday)
  sundayEnd.setDate(monday.getDate() + 7)

  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(todayStart)
  todayEnd.setDate(todayStart.getDate() + 1)

  // ---- Parallel data fetch ----
  // 30 days ago for finance snapshot
  const thirtyDaysAgo = new Date(now)
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  thirtyDaysAgo.setHours(0, 0, 0, 0)

  const [
    { data: recentOrders },
    { data: weekOrders },
    { data: inventoryItems },
    { data: inventoryCounts },
    { data: inventoryTx },
    { data: employees },
    { data: weekShifts },
    { data: todayShifts },
    { data: upcomingShifts },
    { data: periodExpenses },
    { data: todayOrders },
  ] = await Promise.all([
    supabase
      .from('orders')
      .select('id, total_amount, created_at, locations ( name )')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(5),

    supabase
      .from('orders')
      .select('id, total_amount, created_at')
      .eq('status', 'completed')
      .gte('created_at', sevenDaysAgo.toISOString()),

    supabase
      .from('inventory_items')
      .select('id, name, low_stock_threshold')
      .eq('active', true),

    supabase
      .from('inventory_counts')
      .select('inventory_item_id, quantity_on_hand, count_date')
      .order('count_date', { ascending: false }),

    supabase
      .from('inventory_transactions')
      .select('inventory_item_id, quantity_change, transaction_datetime'),

    supabase
      .from('employees')
      .select('id')
      .eq('active', true),

    supabase
      .from('shifts')
      .select('id, start_time')
      .gte('start_time', monday.toISOString())
      .lt('start_time', sundayEnd.toISOString()),

    // Today's shifts specifically
    supabase
      .from('shifts')
      .select('id')
      .gte('start_time', todayStart.toISOString())
      .lt('start_time', todayEnd.toISOString()),

    supabase
      .from('shifts')
      .select('id, employee_id, role, start_time, end_time, employees ( name )')
      .gte('start_time', now.toISOString())
      .order('start_time', { ascending: true })
      .limit(6),

    // 10. Expenses last 30 days (for Finance snapshot)
    supabase
      .from('expenses')
      .select('id, amount')
      .gte('expense_date', thirtyDaysAgo.toISOString().split('T')[0]),

    // 11. Today's orders (for Sales card) — voided excluded
    supabase
      .from('orders')
      .select('id, total_amount')
      .eq('status', 'completed')
      .gte('created_at', todayStart.toISOString())
      .lt('created_at', todayEnd.toISOString()),
  ])

  // ---- Metrics ----
  const ordersLast7Days = (weekOrders ?? []).length
  const salesLast7Days = (weekOrders ?? []).reduce((sum, o) => sum + Number(o.total_amount), 0)
  const inventoryItemCount = (inventoryItems ?? []).length
  const employeeCount = (employees ?? []).length
  const shiftsThisWeek = (weekShifts ?? []).length
  const shiftsToday = (todayShifts ?? []).length

  // ---- Inventory status ----
  const latestCount = new Map<string, { qty: number; date: string }>()
  for (const c of inventoryCounts ?? []) {
    if (!latestCount.has(c.inventory_item_id)) {
      latestCount.set(c.inventory_item_id, { qty: Number(c.quantity_on_hand), date: c.count_date })
    }
  }

  const postCountSum = new Map<string, number>()
  for (const tx of inventoryTx ?? []) {
    const count = latestCount.get(tx.inventory_item_id)
    if (!count) continue
    if (new Date(tx.transaction_datetime) > new Date(count.date)) {
      postCountSum.set(tx.inventory_item_id, (postCountSum.get(tx.inventory_item_id) ?? 0) + Number(tx.quantity_change))
    }
  }

  let outOfStockCount = 0
  let lowStockCount = 0
  let noCountCount = 0
  const watchlistItems: { name: string; status: 'Out' | 'Low' | 'No count' }[] = []
  for (const item of inventoryItems ?? []) {
    const count = latestCount.get(item.id)
    if (!count) {
      noCountCount++
      watchlistItems.push({ name: item.name, status: 'No count' })
      continue
    }
    const estimated = count.qty + (postCountSum.get(item.id) ?? 0)
    const threshold = Number(item.low_stock_threshold ?? 5)
    if (estimated <= 0) {
      outOfStockCount++
      watchlistItems.push({ name: item.name, status: 'Out' })
    } else if (estimated <= threshold) {
      lowStockCount++
      watchlistItems.push({ name: item.name, status: 'Low' })
    }
  }
  // Sort: Out first, then Low, then No count. Max 6 items.
  const statusOrder = { Out: 0, Low: 1, 'No count': 2 }
  watchlistItems.sort((a, b) => statusOrder[a.status] - statusOrder[b.status])
  const watchlist = watchlistItems.slice(0, 6)

  // ---- Today's sales ----
  const ordersToday = (todayOrders ?? []).length
  const salesToday = (todayOrders ?? []).reduce((sum, o) => sum + Number(o.total_amount), 0)

  // ---- Finance snapshot ----
  const expenseCount30d = (periodExpenses ?? []).length
  const expenseTotal30d = (periodExpenses ?? []).reduce((sum, e) => sum + Number(e.amount), 0)

  // ---- Sales by day chart ----
  const salesByDay: { label: string; value: number }[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(sevenDaysAgo)
    d.setDate(sevenDaysAgo.getDate() + i)
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short' })
    const dayTotal = (weekOrders ?? [])
      .filter((o) => {
        const od = new Date(o.created_at)
        return od.getFullYear() === d.getFullYear() && od.getMonth() === d.getMonth() && od.getDate() === d.getDate()
      })
      .reduce((sum, o) => sum + Number(o.total_amount), 0)
    salesByDay.push({ label: dayLabel, value: Math.round(dayTotal * 100) / 100 })
  }

  // ---- Shifts by day chart (current week) ----
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const shiftsByDay: { label: string; value: number }[] = dayLabels.map((label, i) => {
    const dayDate = new Date(monday)
    dayDate.setDate(monday.getDate() + i)
    const count = (weekShifts ?? []).filter((s) => {
      const sd = new Date(s.start_time)
      return sd.getFullYear() === dayDate.getFullYear() && sd.getMonth() === dayDate.getMonth() && sd.getDate() === dayDate.getDate()
    }).length
    return { label, value: count }
  })

  // ---- Structured alerts (typed for the bell) ----
  const alerts: { label: string; type: 'critical' | 'warning' | 'info' }[] = []
  if (outOfStockCount > 0)
    alerts.push({ label: `${outOfStockCount} item${outOfStockCount > 1 ? 's' : ''} out of stock`, type: 'critical' })
  if (lowStockCount > 0)
    alerts.push({ label: `${lowStockCount} item${lowStockCount > 1 ? 's' : ''} running low`, type: 'warning' })
  if (noCountCount > 0)
    alerts.push({ label: `${noCountCount} item${noCountCount > 1 ? 's' : ''} never counted`, type: 'info' })
  if (employeeCount === 0)
    alerts.push({ label: 'No active employees yet', type: 'warning' })
  if (shiftsToday === 0)
    alerts.push({ label: 'No shifts scheduled for today', type: 'warning' })
  if (ordersLast7Days === 0)
    alerts.push({ label: 'No sales in the last 7 days', type: 'info' })

  const firstName = profile?.full_name?.split(' ')[0]

  // Readiness-aware context — surfaces honest pillar states to the
  // dashboard client so it can show small "inactive / partial"
  // badges next to affected sections instead of pretending everything
  // is equally trustworthy. Uses the existing readiness model; dev
  // bypass and per-pillar overrides flow through automatically.
  let readinessPillars: Record<PillarKey, PillarState> | null = null
  if (userRole?.restaurant_id) {
    const snapshot = await computeReadiness(supabase, userRole.restaurant_id)
    readinessPillars = snapshot.pillars
  }

  return (
    <DashboardClient
      greeting={firstName ? `Welcome back, ${firstName}` : 'Dashboard'}
      readiness={readinessPillars}
      inventory={{ outOfStockCount, lowStockCount, noCountCount, totalItems: inventoryItemCount }}
      staffing={{ employeeCount, shiftsToday, shiftsThisWeek }}
      sales={{ ordersToday, salesToday, ordersLast7Days, totalLast7Days: salesLast7Days }}
      finance={{ expenseCount30d, expenseTotal30d }}
      salesByDay={salesByDay}
      shiftsByDay={shiftsByDay}
      watchlist={watchlist}
      recentOrders={(recentOrders ?? []).map((o) => ({
        id: o.id,
        totalAmount: Number(o.total_amount),
        createdAt: o.created_at,
        locationName: (o.locations as unknown as { name: string } | null)?.name ?? null,
      }))}
      upcomingShifts={(upcomingShifts ?? []).map((s) => ({
        id: s.id,
        employeeName: (s.employees as unknown as { name: string } | null)?.name ?? '—',
        role: s.role,
        startTime: s.start_time,
        endTime: s.end_time,
      }))}
      alerts={alerts}
    />
  )
}
