// ----------------------------------------------------------------
// Finance Page  →  /finance
//
// Server Component — fetches expenses, sales, and staffing data,
// computes metrics, and passes everything to the Client Component.
//
// Bridges:
//   Sales → Finance:    revenue from orders as supporting context
//   Staffing → Finance: scheduled labor estimate from shifts + hourly_rate
//   Inventory → Finance: inventory-related expense flag + total
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import FinanceClient from './client'

export default async function FinancePage() {
  const supabase = await createClient()

  // ---- Locations ----
  const { data: locations } = await supabase
    .from('locations')
    .select('id, name')
    .order('created_at', { ascending: true })

  const defaultLocationId = locations?.[0]?.id ?? null

  // ---- Date boundaries ----
  const now = new Date()

  // Last 30 days (expenses + revenue)
  const thirtyDaysAgo = new Date(now)
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  thirtyDaysAgo.setHours(0, 0, 0, 0)

  // Current week Mon–Sun (scheduled labor estimate)
  const day = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
  monday.setHours(0, 0, 0, 0)
  const sundayEnd = new Date(monday)
  sundayEnd.setDate(monday.getDate() + 7)

  // ---- Parallel fetch ----
  const [
    { data: recentExpenses },
    { data: periodExpenses },
    { data: periodOrders },
    { data: weekShifts },
    { data: bankAccounts },
    { data: periodBankTxns },
  ] = await Promise.all([
    // 1. Recent expenses (for the list) — last 20
    supabase
      .from('expenses')
      .select('id, category, amount, expense_date, vendor_name, notes, is_inventory_related, location_id, locations ( name )')
      .order('expense_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(20),

    // 2. All expenses in last 30 days (for cards + category chart)
    supabase
      .from('expenses')
      .select('id, category, amount, is_inventory_related, location_id')
      .gte('expense_date', thirtyDaysAgo.toISOString().split('T')[0]),

    // 3. Revenue from orders in last 30 days (Sales → Finance bridge)
    // Voided orders are excluded so corrections don't inflate revenue.
    supabase
      .from('orders')
      .select('id, total_amount')
      .eq('status', 'completed')
      .gte('created_at', thirtyDaysAgo.toISOString()),

    // 4. Shifts this week with employee hourly rate (Staffing → Finance bridge)
    supabase
      .from('shifts')
      .select('id, start_time, end_time, employees ( hourly_rate )')
      .gte('start_time', monday.toISOString())
      .lt('start_time', sundayEnd.toISOString()),

    // 5. Connected bank accounts (display-safe subset only)
    supabase
      .from('connected_bank_accounts')
      .select('id, provider, account_name, account_mask, institution_name, active, last_synced_at')
      .eq('active', true)
      .order('created_at', { ascending: true }),

    // 6. Bank transaction aggregate — last 30 days. Capture-first/
    // display-minimally: the page only shows inflow / outflow / count,
    // NOT the raw rows. Raw intake lives in `bank_transactions`
    // specifically for future matching and analytics.
    supabase
      .from('bank_transactions')
      .select('amount, direction')
      .gte('posted_at', thirtyDaysAgo.toISOString()),
  ])

  // ---- Compute expense metrics ----
  const allPeriodExpenses = periodExpenses ?? []
  const expenseTotal30d = allPeriodExpenses.reduce((sum, e) => sum + Number(e.amount), 0)
  const expenseCount30d = allPeriodExpenses.length

  // Inventory-related spend (Inventory → Finance bridge)
  const inventorySpend30d = allPeriodExpenses
    .filter((e) => e.is_inventory_related)
    .reduce((sum, e) => sum + Number(e.amount), 0)

  // Revenue (Sales → Finance bridge)
  const revenue30d = (periodOrders ?? []).reduce((sum, o) => sum + Number(o.total_amount), 0)

  // ---- Scheduled labor estimate (Staffing → Finance bridge) ----
  // For each shift this week: hours × hourly_rate.
  // Shifts where the employee has no hourly_rate are excluded.
  let laborEstimate = 0
  let laborShiftCount = 0
  for (const shift of weekShifts ?? []) {
    const emp = shift.employees as unknown as { hourly_rate: number | null } | null
    if (!emp?.hourly_rate) continue
    const hours =
      (new Date(shift.end_time).getTime() - new Date(shift.start_time).getTime()) /
      (1000 * 60 * 60)
    laborEstimate += hours * Number(emp.hourly_rate)
    laborShiftCount++
  }
  laborEstimate = Math.round(laborEstimate * 100) / 100

  // ---- Category breakdown (last 30 days) ----
  const categoryMap = new Map<string, number>()
  for (const e of allPeriodExpenses) {
    categoryMap.set(e.category, (categoryMap.get(e.category) ?? 0) + Number(e.amount))
  }
  const categoryBreakdown = Array.from(categoryMap.entries())
    .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }))
    .sort((a, b) => b.value - a.value)

  // ---- Bank activity aggregates (last 30 days) ----
  // We intentionally summarize instead of rendering the raw feed.
  let bankInflow30d = 0
  let bankOutflow30d = 0
  let bankTxnCount30d = 0
  for (const tx of periodBankTxns ?? []) {
    const amt = Number(tx.amount)
    bankTxnCount30d++
    if (tx.direction === 'inflow') bankInflow30d += amt
    else bankOutflow30d += amt
  }

  return (
    <FinanceClient
      locations={locations ?? []}
      defaultLocationId={defaultLocationId}
      cards={{
        expenseTotal30d,
        expenseCount30d,
        revenue30d,
        inventorySpend30d,
        laborEstimate,
        laborShiftCount,
      }}
      bank={{
        accounts: (bankAccounts ?? []).map((a) => ({
          id: a.id,
          provider: a.provider,
          accountName: a.account_name ?? 'Bank account',
          accountMask: a.account_mask ?? null,
          institutionName: a.institution_name ?? null,
          lastSyncedAt: a.last_synced_at ?? null,
        })),
        inflow30d: Math.round(bankInflow30d * 100) / 100,
        outflow30d: Math.round(bankOutflow30d * 100) / 100,
        txnCount30d: bankTxnCount30d,
      }}
      categoryBreakdown={categoryBreakdown}
      recentExpenses={(recentExpenses ?? []).map((e) => ({
        id: e.id,
        category: e.category,
        amount: Number(e.amount),
        expenseDate: e.expense_date,
        vendorName: e.vendor_name,
        notes: e.notes,
        isInventoryRelated: e.is_inventory_related,
        locationId: e.location_id,
        locationName: (e.locations as unknown as { name: string } | null)?.name ?? null,
      }))}
    />
  )
}
