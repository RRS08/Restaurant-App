// ----------------------------------------------------------------
// Analytics Page  →  /analytics
//
// Identity:
//   Analytics is the in-product analyst — the place that surfaces
//   patterns, drivers, and likely continuations beneath the raw
//   numbers. Distinct from:
//     Finance   — money interpretation (in/out, spend, net)
//     Dashboard — quick-summary / quick-action surface
//     Weekly    — narrated weekly memo
//
// The server pre-aggregates raw order / order_item data into the
// shape the descriptive + diagnostic + predictive blocks in the
// client need:
//   • current 30d vs previous 30d for revenue and *units* (qty)
//     per item and category (Diagnostic)
//   • payment mix and category mix bucketed at BOTH 7d and 30d
//     so Descriptive's composition blocks respect the comparison
//     window the user picks on the client
//   • 60 days of daily revenue/order buckets (Descriptive + Predictive)
//   • inventory: per-item current stock + recipe-component join to
//     menu items, used by the at-risk stock pressure block in
//     Predictive (the cross-pillar continuation signal)
//
// Labor cost is intentionally NOT loaded here — that's a money
// interpretation question and lives in Finance.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
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
        return <AnalyticsLocked readiness={readiness} />
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

  const [
    { data: orders },
    { data: inventoryItems },
    { data: inventoryCounts },
    { data: inventoryTxns },
    { data: recipeComponents },
  ] = await Promise.all([
    supabase
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
      .order('created_at', { ascending: true }),

    // Inventory cross-pillar data for the at-risk predictive block.
    // Only active items — archived items don't deplete.
    supabase
      .from('inventory_items')
      .select('id, name, unit_of_measure, low_stock_threshold, active')
      .eq('active', true),

    supabase
      .from('inventory_counts')
      .select('inventory_item_id, quantity_on_hand, count_date')
      .order('count_date', { ascending: false }),

    // Same defensive 5000-row limit Inventory uses so post-count
    // sales aren't silently dropped from the stock estimate.
    supabase
      .from('inventory_transactions')
      .select('inventory_item_id, quantity_change, transaction_datetime')
      .order('transaction_datetime', { ascending: false })
      .limit(5000),

    supabase
      .from('recipe_components')
      .select('inventory_item_id, menu_item_id, quantity'),
  ])

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

  // ---- Item + category aggregates (current 30d vs prior 30d) ----
  // Used by Diagnostic blocks (growth decomposition, category carry,
  // quiet declines, mix shift) and by the Predictive near-term
  // continuation block.
  type CatAgg = {
    id: string
    name: string
    currentRevenue: number
    currentQty: number
    previousRevenue: number
    previousQty: number
  }
  type ItemAgg = CatAgg & {
    categoryId: string | null
    categoryName: string | null
  }

  const itemAgg = new Map<string, ItemAgg>()
  const catAgg = new Map<string, CatAgg>()

  // ---- Window-scoped mix aggregates ----
  // Payment mix and category mix bucketed for both 7d and 30d so
  // the descriptive composition blocks track the user's comparison
  // window selection.
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
      const qty = Number(oi.quantity)
      const revenue = Number(oi.total_price)
      const cat = item.menu_categories

      // Diagnostic aggregates (current 30d vs prior 30d)
      const itemRow =
        itemAgg.get(item.id) ?? {
          id: item.id,
          name: item.name,
          categoryId: cat?.id ?? null,
          categoryName: cat?.name ?? null,
          currentRevenue: 0,
          currentQty: 0,
          previousRevenue: 0,
          previousQty: 0,
        }
      if (inCurrent30) {
        itemRow.currentRevenue += revenue
        itemRow.currentQty += qty
      } else {
        itemRow.previousRevenue += revenue
        itemRow.previousQty += qty
      }
      itemAgg.set(item.id, itemRow)

      if (cat) {
        const catRow =
          catAgg.get(cat.id) ?? {
            id: cat.id,
            name: cat.name,
            currentRevenue: 0,
            currentQty: 0,
            previousRevenue: 0,
            previousQty: 0,
          }
        if (inCurrent30) {
          catRow.currentRevenue += revenue
          catRow.currentQty += qty
        } else {
          catRow.previousRevenue += revenue
          catRow.previousQty += qty
        }
        catAgg.set(cat.id, catRow)

        // Descriptive mix (current 30d / current 7d)
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

  // ================================================================
  // At-risk inventory — predictive cross-pillar block
  //
  // For each active inventory item, compute current stock (latest
  // count + post-count transaction deltas, same logic Inventory
  // uses), then derive consumption-per-day by tracing recipe
  // components back to menu items and using the 30-day unit
  // velocity from itemAggregates. Items where days-of-supply at
  // current pace is below 14 are surfaced, with the highest-
  // consumption-contributing menu item attributed as the driver.
  //
  // The signal stays a continuation read, not a recommendation:
  // it says "if pace continues, this is when stock pressure lands."
  // ================================================================

  const latestCount = new Map<string, { qty: number; date: string }>()
  for (const c of inventoryCounts ?? []) {
    if (!latestCount.has(c.inventory_item_id)) {
      latestCount.set(c.inventory_item_id, {
        qty: Number(c.quantity_on_hand),
        date: c.count_date,
      })
    }
  }

  // Same `>=` cutoff as Inventory so same-millisecond ties don't
  // silently drop post-count depletion.
  const postCountSum = new Map<string, number>()
  for (const tx of inventoryTxns ?? []) {
    const count = latestCount.get(tx.inventory_item_id)
    if (!count) continue
    if (
      new Date(tx.transaction_datetime).getTime() >= new Date(count.date).getTime()
    ) {
      postCountSum.set(
        tx.inventory_item_id,
        (postCountSum.get(tx.inventory_item_id) ?? 0) + Number(tx.quantity_change),
      )
    }
  }

  // Group recipe components by inventory_item so we can fan out
  // each inventory item to its dependent menu items in one pass.
  type RecipeComp = { inventory_item_id: string; menu_item_id: string; quantity: number }
  const recipesByInventoryItem = new Map<string, RecipeComp[]>()
  for (const rc of (recipeComponents ?? []) as RecipeComp[]) {
    const arr = recipesByInventoryItem.get(rc.inventory_item_id) ?? []
    arr.push(rc)
    recipesByInventoryItem.set(rc.inventory_item_id, arr)
  }

  const itemById = new Map(itemAggregates.map((i) => [i.id, i]))

  interface AtRiskItem {
    id: string
    name: string
    unit: string
    currentStock: number
    threshold: number | null
    daysOfSupply: number
    consumptionPerDay: number
    driverItemName: string | null
  }

  const atRisk: AtRiskItem[] = []
  for (const inv of (inventoryItems ?? []) as Array<{
    id: string
    name: string
    unit_of_measure: string | null
    low_stock_threshold: number | null
    active: boolean
  }>) {
    const count = latestCount.get(inv.id)
    if (!count) continue // no count → no honest stock estimate

    const currentStock = count.qty + (postCountSum.get(inv.id) ?? 0)
    if (currentStock <= 0) continue // already out — Inventory's pillar surfaces this; don't double-count

    const recipes = recipesByInventoryItem.get(inv.id) ?? []
    if (recipes.length === 0) continue // not consumed via sales

    let totalConsumptionPerDay = 0
    let topDriverContribution = 0
    let topDriverName: string | null = null

    for (const rc of recipes) {
      const itemMovement = itemById.get(rc.menu_item_id)
      if (!itemMovement) continue
      const dailyUnits = itemMovement.currentQty / 30
      const contribution = dailyUnits * Number(rc.quantity)
      totalConsumptionPerDay += contribution
      if (contribution > topDriverContribution) {
        topDriverContribution = contribution
        topDriverName = itemMovement.name
      }
    }

    if (totalConsumptionPerDay <= 0) continue
    const days = currentStock / totalConsumptionPerDay
    if (days >= 14) continue // only surface near-term pressure

    atRisk.push({
      id: inv.id,
      name: inv.name,
      unit: inv.unit_of_measure ?? 'units',
      currentStock: round2(currentStock),
      threshold: inv.low_stock_threshold,
      daysOfSupply: Math.round(days * 10) / 10,
      consumptionPerDay: round2(totalConsumptionPerDay),
      driverItemName: topDriverName,
    })
  }

  // Soonest pressure first, capped so the block stays compact.
  const atRiskInventory = atRisk
    .sort((a, b) => a.daysOfSupply - b.daysOfSupply)
    .slice(0, 5)

  return (
    <AnalyticsClient
      dailyBuckets={dailyBuckets}
      itemAggregates={itemAggregates}
      categoryAggregates={categoryAggregates}
      categoryMix7d={categoryMix7d}
      categoryMix30d={categoryMix30d}
      paymentMix7d={paymentMix7d}
      paymentMix30d={paymentMix30d}
      atRiskInventory={atRiskInventory}
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
