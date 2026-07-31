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
import { getLang } from '@/lib/i18n-server'
import DashboardClient from './client'
import {
  computeReadiness,
  hasConnectedButUnsyncedBank,
  isInventoryWriteLive,
  type PillarKey,
  type PillarState,
} from '@/lib/readiness'
import { groupBankTransactions } from '@/lib/finance/matching'

export default async function DashboardPage() {
  const supabase = await createClient()
  const lang = await getLang()

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
    { data: shiftSections },
    { data: recipeEdges },
    { data: pendingRestocks },
    { data: periodBankTxns },
    { data: bankAccountSyncs },
    { data: activeMenuItems },
    { data: todayOrderItems },
  ] = await Promise.all([
    supabase
      .from('orders')
      // Bands dashboard's Sales-today card needs payment_type per row
      // (for the card/cash tile hue) and a rough per-order item count
      // (for the "4 items" meta line). order_items(count) uses
      // Supabase's join-count shorthand — cheap when the FK exists.
      .select('id, total_amount, created_at, payment_type, locations ( name ), order_items(count)')
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
    // alone needs so the carousel can compute labor estimate
    // (hourly_rate × hours) and FOH/BOH coverage split without
    // a second round-trip.
    supabase
      .from('shifts')
      .select('id, employee_id, role, start_time, end_time, employees ( name, hourly_rate ), shift_sections ( area )')
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

    // 10. Expenses last 30 days (for Finance snapshot). Now also
    //     selects is_inventory_related so the dashboard carousel can
    //     split recorded inventory cost vs operating estimate.
    supabase
      .from('expenses')
      .select('id, amount, is_inventory_related')
      .gte('expense_date', thirtyDaysAgo.toISOString().split('T')[0]),

    // 11. Today's orders (for Sales card) — voided excluded.
    //     payment_type is included so we can compute the card/cash
    //     payment-mix metric.
    supabase
      .from('orders')
      .select('id, total_amount, payment_type')
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

    // 14. Shift sections defined for today's house — feeds the
    //     Staffing carousel's "Coverage gaps" metric. We compare
    //     this against the sections that actually have a shift
    //     today; the diff is the gap.
    supabase
      .from('shift_sections')
      .select('id, name'),

    // 15. Menu item ↔ inventory item dependency edges — feeds the
    //     Inventory carousel's "Menu impact" metric. We resolve
    //     this client-side after combining with out/low item ids.
    supabase
      .from('recipe_components')
      .select('menu_item_id, inventory_item_id'),

    // 16. Restock orders — feeds the Inventory carousel's "Restock
    //     queue" metric. Only draft + ordered are pending; received
    //     / canceled aren't queue.
    supabase
      .from('restock_orders')
      .select('id, status')
      .in('status', ['draft', 'ordered']),

    // 17. Bank transactions last 7 days — feeds the Finance
    //     carousel's Money Review + Deposits + Settled metrics.
    //     Same column shape Finance uses, so groupBankTransactions
    //     can run over it without a second fetch.
    supabase
      .from('bank_transactions')
      .select('id, amount, direction, raw_category, merchant_name, description, posted_at, review_state, settled_kind')
      .gte('posted_at', sevenDaysAgo.toISOString()),

    // 18. Connected bank accounts — feeds the Finance carousel's
    //     "Bank sync" metric (most recent sync timestamp).
    supabase
      .from('connected_bank_accounts')
      .select('last_synced_at')
      .eq('active', true),

    // 19. Active menu items — count is used as the denominator
    //     for the "X / Y affected" inventory menu-impact metric.
    supabase
      .from('menu_items')
      .select('id')
      .eq('active', true),

    // 20. Today's order line items — feeds the Sales carousel's
    //     "Best seller today" metric. Joins to menu_items for the
    //     name + to orders to scope by today's status='completed'.
    //     We rely on the inner-join semantics of `orders!inner` to
    //     drop line items whose parent order isn't a today's
    //     completed order.
    supabase
      .from('order_items')
      .select('quantity, menu_items ( name ), orders!inner ( status, created_at )')
      .eq('orders.status', 'completed')
      .gte('orders.created_at', todayStart.toISOString())
      .lt('orders.created_at', todayEnd.toISOString()),
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

  // ================================================================
  // Top-card carousel metrics — four per pillar, computed once on
  // the server and shipped down as a flat shape so the client never
  // has to recompute on rotation. Each pillar's metrics are
  // independent and don't overlap (Sales owns customer activity,
  // Staffing owns coverage, Inventory owns sellability, Finance
  // owns money truth).
  // ================================================================

  // ---- SALES ----
  // Sales today + average ticket from todayOrders. Best seller is
  // computed from today's order_items (quantity rolled up by
  // menu item). Payment mix splits today's completed orders by
  // payment_type (card / cash / other).
  const avgTicketToday = ordersToday > 0 ? salesToday / ordersToday : 0

  // Best seller today — rank by total quantity sold today.
  const bestSellerCounts = new Map<string, number>()
  for (const row of todayOrderItems ?? []) {
    const name = ((row.menu_items as unknown) as { name: string } | null)?.name
    if (!name) continue
    bestSellerCounts.set(name, (bestSellerCounts.get(name) ?? 0) + Number(row.quantity ?? 0))
  }
  let bestSellerName: string | null = null
  let bestSellerCount = 0
  for (const [name, q] of bestSellerCounts.entries()) {
    if (q > bestSellerCount) {
      bestSellerName = name
      bestSellerCount = q
    }
  }

  // Payment mix today — % share by payment_type. `total` is the
  // denominator the carousel uses to compute percentages.
  let paymentMixCard = 0
  let paymentMixCash = 0
  let paymentMixOther = 0
  for (const o of todayOrders ?? []) {
    const pt = (o.payment_type as string | null) ?? 'cash'
    if (pt === 'card') paymentMixCard++
    else if (pt === 'cash') paymentMixCash++
    else paymentMixOther++
  }
  const paymentMixTotal = paymentMixCard + paymentMixCash + paymentMixOther

  // ---- STAFFING ----
  // Today's-only slice of weekShifts. Labor estimate sums hours ×
  // hourly_rate over this slice (rated shifts only); FOH/BOH split
  // counts shifts with a section.area === 'foh' vs 'boh'.
  const todaysWeekShifts = (weekShifts ?? []).filter((s) => {
    const t = new Date(s.start_time)
    return t >= todayStart && t < todayEnd
  })
  let totalShiftsScheduledHoursToday = 0
  let laborEstimateToday = 0
  let fohShiftsToday = 0
  let bohShiftsToday = 0
  let ratedShiftCountToday = 0
  for (const s of todaysWeekShifts) {
    const start = new Date(s.start_time).getTime()
    const end = new Date(s.end_time).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const hours = (end - start) / (1000 * 60 * 60)
    totalShiftsScheduledHoursToday += hours
    const emp = s.employees as unknown as { name: string; hourly_rate: number | null } | null
    const rate = emp?.hourly_rate ? Number(emp.hourly_rate) : 0
    if (rate > 0) {
      laborEstimateToday += rate * hours
      ratedShiftCountToday++
    }
    const section = s.shift_sections as unknown as { area: 'foh' | 'boh' } | null
    if (section?.area === 'foh') fohShiftsToday++
    else if (section?.area === 'boh') bohShiftsToday++
  }
  const houseSplitAvailable = (fohShiftsToday + bohShiftsToday) > 0

  // ---- INVENTORY ----
  // Inventory cost (recorded) — sum of expense rows flagged
  // is_inventory_related in the 30-day window. No bank-settlement
  // path exists yet that exposes a separable "settled inventory
  // cost" per the spec; we label this clearly as "Recorded" on
  // the carousel so it can't be confused with a settled total.
  // Pending restocks = orders in 'draft' or 'ordered' status.
  const recordedInventoryCost30d = (periodExpenses ?? [])
    .filter((e) => e.is_inventory_related === true)
    .reduce((sum, e) => sum + Number(e.amount), 0)

  const restockDrafts = (pendingRestocks ?? []).filter((r) => r.status === 'draft').length
  const restockOrdered = (pendingRestocks ?? []).filter((r) => r.status === 'ordered').length

  // ---- FINANCE ----
  // Money review = same grouping engine as /finance. We hand the
  // unreviewed bank rows to groupBankTransactions and count groups
  // by triage. Deposits-to-confirm is the inflow attention slice.
  // Settled spend = sum of settled outflows in the 7-day window.
  // Bank sync = most recent last_synced_at across active accounts.
  type FinanceTxnLite = {
    id: string
    amount: number
    direction: 'inflow' | 'outflow'
    rawCategory: string | null
    merchantName: string | null
    description: string | null
    postedAt: string
    reviewState: 'unreviewed' | 'settled' | 'ignored' | 'not_a_match'
    settledKind: string | null
  }
  const txnLite: FinanceTxnLite[] = (periodBankTxns ?? []).map((tx) => ({
    id: tx.id as string,
    amount: Number(tx.amount),
    direction: tx.direction as 'inflow' | 'outflow',
    rawCategory: (tx.raw_category as string | null) ?? null,
    merchantName: (tx.merchant_name as string | null) ?? null,
    description: (tx.description as string | null) ?? null,
    postedAt: tx.posted_at as string,
    reviewState:
      ((tx.review_state as string | null) ?? 'unreviewed') as FinanceTxnLite['reviewState'],
    settledKind: (tx.settled_kind as string | null) ?? null,
  }))
  const unreviewedTxns = txnLite.filter((t) => t.reviewState === 'unreviewed')
  const reviewGroups = groupBankTransactions(
    unreviewedTxns.map((t) => ({
      id: t.id,
      direction: t.direction,
      amount: t.amount,
      rawCategory: t.rawCategory,
      merchantName: t.merchantName,
      description: t.description,
      postedAt: t.postedAt,
    })),
  )
  const moneyReviewAttention = reviewGroups.filter((g) => g.triage !== 'auto').length
  const moneyReviewAuto = reviewGroups.filter((g) => g.triage === 'auto').length
  const depositsAttention = reviewGroups.filter(
    (g) => g.direction === 'inflow' && g.triage === 'attention',
  ).length
  // Operating estimate — non-inventory expenses in the 30-day
  // window. Matches the Finance page's "manualNonInventorySpend"
  // half of the operating bucket; clearly labeled "estimated" in
  // the carousel since it doesn't include bank-confirmed signals.
  const operatingEstimate30d = (periodExpenses ?? [])
    .filter((e) => e.is_inventory_related !== true)
    .reduce((sum, e) => sum + Number(e.amount), 0)

  const mostRecentBankSyncAt = (bankAccountSyncs ?? [])
    .map((a) => a.last_synced_at as string | null)
    .filter((v): v is string => !!v)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null

  const topCards = {
    sales: {
      salesToday,
      ordersToday,
      avgTicketToday: Math.round(avgTicketToday * 100) / 100,
      bestSeller: bestSellerName
        ? { name: bestSellerName, count: bestSellerCount }
        : null,
      paymentMix: paymentMixTotal > 0
        ? {
            card: paymentMixCard,
            cash: paymentMixCash,
            other: paymentMixOther,
            total: paymentMixTotal,
          }
        : null,
    },
    staffing: {
      shiftsToday,
      hoursToday: Math.round(totalShiftsScheduledHoursToday * 10) / 10,
      activeStaff: employeeCount,
      laborEstimateToday: ratedShiftCountToday > 0
        ? Math.round(laborEstimateToday * 100) / 100
        : null,
      houseCoverage: houseSplitAvailable
        ? { foh: fohShiftsToday, boh: bohShiftsToday }
        : null,
    },
    inventory: {
      outItems: outOfStockCount,
      lowItems: lowStockCount,
      recordedInventoryCost30d: Math.round(recordedInventoryCost30d * 100) / 100,
      pendingRestocks: {
        drafts: restockDrafts,
        ordered: restockOrdered,
      },
    },
    finance: {
      moneyReview: {
        attention: moneyReviewAttention,
        auto: moneyReviewAuto,
        scanned: unreviewedTxns.length,
      },
      depositsToConfirm: depositsAttention,
      operatingEstimate30d: Math.round(operatingEstimate30d * 100) / 100,
      bankSyncedAt: mostRecentBankSyncAt,
    },
  }

  // Bands "Sales today" card wants the last 5 completed orders with
  // per-order item count and the payment type (drives the tile hue).
  // order_items(count) comes back as `[{ count: N }]`; flatten to a
  // single number per row.
  const recentSales = (recentOrders ?? []).map((o) => {
    const oi = (o as { order_items?: Array<{ count: number }> }).order_items
    const itemCount = Array.isArray(oi) && oi.length > 0 ? Number(oi[0].count) || 0 : 0
    return {
      id: o.id as string,
      amount: Number((o as { total_amount: number | string }).total_amount),
      createdAt: (o as { created_at: string }).created_at,
      paymentType: ((o as { payment_type: string | null }).payment_type ?? 'other') as 'card' | 'cash' | 'other',
      itemCount,
    }
  })

  return (
    <DashboardClient
      lang={lang}
      firstName={firstName}
      renderedAt={renderedAt}
      recentSales={recentSales}
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
      topCards={topCards}
    />
  )
}
