// ----------------------------------------------------------------
// Dashboard  →  /dashboard
//
// Today's Operations — the daily command center for the restaurant
// operating system. Answers: what's happening today, what needs
// attention, what's stable, what action should happen next, and
// which pillar should I enter.
//
// NOT Analytics (no pattern interpretation).
// NOT Finance  (no money interpretation).
// NOT Sales    (no ledger review).
// NOT Staffing (no scheduling work).
// NOT Inventory (no stock management workflow).
//
// Dashboard only summarizes operating state and routes the user
// toward action. Honest about partial setup — reads from the
// shared readiness model so it never pretends a pillar is fully
// live when it isn't.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import DashboardClient from './client'
import {
  computeReadiness,
  hasConnectedButUnsyncedBank,
  isInventoryWriteLive,
  type PillarKey,
  type PillarState,
} from '@/lib/readiness'

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
    { data: latestExpenseRow },
    { data: latestInventoryTxRow },
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

    // Current-week shifts. Selecting more fields than the count
    // alone needs so the Today's Rhythm selected-day summary can
    // look up "first scheduled shift on day X" without a second
    // round-trip.
    supabase
      .from('shifts')
      .select('id, employee_id, role, start_time, end_time, employees ( name )')
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

    // 12. Latest single expense — for the Recent Movement card.
    //     Compact pulse, not an expense feed.
    supabase
      .from('expenses')
      .select('id, amount, expense_date')
      .order('expense_date', { ascending: false })
      .limit(1)
      .maybeSingle(),

    // 13. Latest single inventory transaction — for Recent Movement.
    //     The dashboard's bulk `inventoryTx` query above is unordered
    //     and capped at PostgREST's default page size, so we can't
    //     reliably read "most recent" from it. A small targeted query
    //     keeps the pulse honest.
    supabase
      .from('inventory_transactions')
      .select('quantity_change, transaction_datetime, inventory_items ( name )')
      .order('transaction_datetime', { ascending: false })
      .limit(1)
      .maybeSingle(),
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

  // ---- Per-day aggregations, aligned to the current Mon–Sun week
  //
  // Both arrays share the same 7 dates so the Today's Rhythm chart,
  // the interactive shift strip, and the selected-day summary all
  // index the same data. The rolling "last 7 days" sales metric
  // stays available separately as `salesLast7Days` /
  // `ordersLast7Days` above. Future days in the current week (e.g.,
  // Sat/Sun before they happen) naturally show zero — accurate,
  // not faked.
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  const salesByDay: { label: string; value: number; orders: number; date: string }[] = []
  const shiftsByDay: { label: string; value: number; employees: number; date: string }[] = []

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)

    const dayOrdersForSales = (weekOrders ?? []).filter((o) =>
      sameDay(new Date(o.created_at), d),
    )
    const dayRevenue = dayOrdersForSales.reduce((s, o) => s + Number(o.total_amount), 0)

    const dayShifts = (weekShifts ?? []).filter((s) =>
      sameDay(new Date(s.start_time), d),
    )
    const distinctEmployees = new Set(dayShifts.map((s) => s.employee_id)).size

    salesByDay.push({
      label: dayLabels[i],
      value: Math.round(dayRevenue * 100) / 100,
      orders: dayOrdersForSales.length,
      date: d.toISOString(),
    })
    shiftsByDay.push({
      label: dayLabels[i],
      value: dayShifts.length,
      employees: distinctEmployees,
      date: d.toISOString(),
    })
  }

  // Flat list of current-week shifts the client uses to look up
  // "first scheduled shift on day X" for the selected-day summary.
  const weekShiftDetails = (weekShifts ?? []).map((s) => ({
    id: s.id,
    employeeName:
      (s.employees as unknown as { name: string } | null)?.name ?? '—',
    role: s.role,
    startTime: s.start_time,
    endTime: s.end_time,
  }))

  // Note: the standalone alerts/notification-bell list used to live
  // here. It's been removed — the unified `Needs Attention` queue
  // in the Dashboard client is now the single operational triage
  // surface, sourcing its rows from the same underlying state
  // (inventory counts, staffing, readiness, etc.) so there's no
  // longer a duplicate alert system competing with it.

  const firstName = profile?.full_name?.split(' ')[0] ?? null

  // Truthful render-time stamp. Server-rendered at request time, so
  // it accurately answers "when did this view become this view?".
  // Reloading the page bumps it; the client renders it as-is.
  const renderedAt = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })

  // ---- Recent Movement data ----
  const latestExpense = latestExpenseRow
    ? {
        amount: Number(latestExpenseRow.amount),
        date: latestExpenseRow.expense_date as string,
      }
    : null

  const latestInventoryMovement = latestInventoryTxRow
    ? {
        itemName:
          (latestInventoryTxRow.inventory_items as unknown as { name: string } | null)?.name ?? '—',
        quantityChange: Number(latestInventoryTxRow.quantity_change),
        datetime: latestInventoryTxRow.transaction_datetime as string,
      }
    : null

  const latestSale = (recentOrders ?? [])[0]
    ? {
        amount: Number((recentOrders ?? [])[0].total_amount),
        datetime: (recentOrders ?? [])[0].created_at as string,
      }
    : null

  // Readiness-aware context — surfaces honest pillar states to the
  // dashboard client so it can show small "inactive / partial"
  // badges next to affected sections instead of pretending everything
  // is equally trustworthy. Uses the existing readiness model; dev
  // bypass and per-pillar overrides flow through automatically.
  //
  // We also forward two small derived booleans so the client can
  // distinguish "bank not connected" from "bank connected but never
  // synced" without re-reading the snapshot. Both come from the new
  // shared readiness helpers so every surface uses one definition.
  let readinessPillars: Record<PillarKey, PillarState> | null = null
  let bankConnectedUnsynced = false
  let inventoryWriteLive = false
  if (userRole?.restaurant_id) {
    const snapshot = await computeReadiness(supabase, userRole.restaurant_id)
    readinessPillars = snapshot.pillars
    bankConnectedUnsynced = hasConnectedButUnsyncedBank(snapshot)
    inventoryWriteLive = isInventoryWriteLive(snapshot)
  }

  return (
    <DashboardClient
      firstName={firstName}
      renderedAt={renderedAt}
      readiness={readinessPillars}
      bankConnectedUnsynced={bankConnectedUnsynced}
      inventoryWriteLive={inventoryWriteLive}
      inventory={{ outOfStockCount, lowStockCount, noCountCount, totalItems: inventoryItemCount }}
      staffing={{ employeeCount, shiftsToday, shiftsThisWeek }}
      sales={{ ordersToday, salesToday, ordersLast7Days, totalLast7Days: salesLast7Days }}
      finance={{ expenseCount30d, expenseTotal30d }}
      salesByDay={salesByDay}
      shiftsByDay={shiftsByDay}
      weekShiftDetails={weekShiftDetails}
      watchlist={watchlist}
      upcomingShifts={(upcomingShifts ?? []).map((s) => ({
        id: s.id,
        employeeName: (s.employees as unknown as { name: string } | null)?.name ?? '—',
        role: s.role,
        startTime: s.start_time,
        endTime: s.end_time,
      }))}
      latestSale={latestSale}
      latestExpense={latestExpense}
      latestInventoryMovement={latestInventoryMovement}
    />
  )
}
