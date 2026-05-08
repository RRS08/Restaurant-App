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
import { isPlaidConfigured, isPlaidSandbox } from '@/lib/plaid/client'
import { isDevEmail } from '@/lib/dev'
import { maybeAutoSyncBankTransactions } from '@/app/actions/bank'
import FinanceClient from './client'

// Plaid Personal Finance Category primaries → short human labels.
// Keeps the External money UI readable without pretending the
// classification is more than what Plaid actually returns.
function friendlyExternalCategory(raw: string): string {
  const map: Record<string, string> = {
    RENT_AND_UTILITIES: 'Rent & utilities',
    GENERAL_SERVICES: 'Services & subscriptions',
    FOOD_AND_DRINK: 'Food & drink',
    GENERAL_MERCHANDISE: 'Supplies & merchandise',
    TRANSPORTATION: 'Transportation',
    TRAVEL: 'Travel',
    ENTERTAINMENT: 'Marketing & entertainment',
    BANK_FEES: 'Bank fees',
    LOAN_PAYMENTS: 'Loan payments',
    TRANSFER_OUT: 'Transfers out',
    HOME_IMPROVEMENT: 'Maintenance',
    MEDICAL: 'Medical',
    PERSONAL_CARE: 'Personal care',
    GOVERNMENT_AND_NON_PROFIT: 'Government & other',
  }
  if (map[raw]) return map[raw]
  // Fallback: title-case any unknown raw value.
  return raw
    .toLowerCase()
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ')
}

export default async function FinancePage() {
  const supabase = await createClient()

  // ---- Auto-sync (5-minute staleness threshold) ----
  // Runs server-side before the main fetch so the rest of the page
  // sees freshly-synced bank rows. No-op when no bank is connected,
  // when the most recent sync is recent, or when Plaid is offline.
  await maybeAutoSyncBankTransactions().catch(() => null)

  // Dev allowlist check — drives optional sandbox affordances in
  // the UI (e.g. "Create sandbox rent expense" button).
  const { data: { user } } = await supabase.auth.getUser()
  const isDev = isDevEmail(user?.email)

  // ---- Locations ----
  const { data: locations } = await supabase
    .from('locations')
    .select('id, name')
    .order('created_at', { ascending: true })

  const defaultLocationId = locations?.[0]?.id ?? null

  // ---- Date boundaries ----
  const now = new Date()

  // Last 7 days (expenses + revenue + bank aggregates)
  const sevenDaysAgo = new Date(now)
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  sevenDaysAgo.setHours(0, 0, 0, 0)

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
    { data: ratedEmployees },
  ] = await Promise.all([
    // 1. Recent expenses (for the list) — last 20
    supabase
      .from('expenses')
      .select('id, category, amount, expense_date, vendor_name, notes, is_inventory_related, source, location_id, locations ( name )')
      .order('expense_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(20),

    // 2. All expenses in last 7 days (for cards + inventory-spend
    // breakdown drawer)
    supabase
      .from('expenses')
      .select('id, category, amount, vendor_name, is_inventory_related, source, location_id')
      .gte('expense_date', sevenDaysAgo.toISOString().split('T')[0]),

    // 3. Revenue from orders in last 7 days (Sales → Finance bridge)
    // Voided orders are excluded so corrections don't inflate revenue.
    supabase
      .from('orders')
      .select('id, total_amount')
      .eq('status', 'completed')
      .gte('created_at', sevenDaysAgo.toISOString()),

    // 4. Shifts this week with employee + section context. The labor
    // drawer needs employee names, roles, and section areas for the
    // by-house / by-role / by-employee breakdowns.
    supabase
      .from('shifts')
      .select('id, start_time, end_time, role, employees ( id, name, hourly_rate ), shift_sections ( area )')
      .gte('start_time', monday.toISOString())
      .lt('start_time', sundayEnd.toISOString()),

    // 5. Connected bank accounts (display-safe subset only)
    supabase
      .from('connected_bank_accounts')
      .select('id, provider, account_name, account_mask, institution_name, active, last_synced_at')
      .eq('active', true)
      .order('created_at', { ascending: true }),

    // 6. Bank transactions — last 7 days. Selects enough to drive
    // the External money card + drawer (outside-the-system spend
    // focus): per-row amount, direction, raw category, merchant
    // and description for unresolved-activity rows. Bank row IDs
    // never reach the UI as identifiers — only content.
    supabase
      .from('bank_transactions')
      .select('id, amount, direction, raw_category, merchant_name, description, posted_at')
      .gte('posted_at', sevenDaysAgo.toISOString()),

    // 7. Active employees with positive hourly_rate. Used to tell the
    // difference between "no shifts scheduled this week" and
    // "shifts exist but no hourly rates configured" — Finance must
    // be honest about which empty state we're actually in.
    supabase
      .from('employees')
      .select('id')
      .eq('active', true)
      .gt('hourly_rate', 0),
  ])

  // ---- Compute expense metrics ----
  const allPeriodExpenses = periodExpenses ?? []
  const expenseTotal7d = allPeriodExpenses.reduce((sum, e) => sum + Number(e.amount), 0)
  const expenseCount7d = allPeriodExpenses.length

  // Inventory-related spend (Inventory → Finance bridge)
  const inventorySpend7d = allPeriodExpenses
    .filter((e) => e.is_inventory_related)
    .reduce((sum, e) => sum + Number(e.amount), 0)

  // Revenue (Sales → Finance bridge)
  const revenue7d = (periodOrders ?? []).reduce((sum, o) => sum + Number(o.total_amount), 0)

  // ---- Scheduled labor estimate (Staffing → Finance bridge) ----
  // For each shift this week: hours × hourly_rate. We keep both the
  // top-line total and three drawer-friendly aggregates so the
  // labor card can open a detail panel without a second round-trip.
  let laborEstimate = 0
  let laborRatedShiftCount = 0
  let laborUnratedShiftCount = 0

  type AreaKey = 'foh' | 'boh' | 'unassigned'
  const laborByAreaMap = new Map<AreaKey, { hours: number; cost: number; shiftCount: number }>()
  const laborByRoleMap = new Map<string, { hours: number; cost: number; shiftCount: number; missingRate: boolean }>()
  const laborByEmployeeMap = new Map<string, {
    name: string; hours: number; cost: number; shiftCount: number; hourlyRate: number | null
  }>()

  for (const shift of weekShifts ?? []) {
    const emp = shift.employees as unknown as { id: string; name: string; hourly_rate: number | null } | null
    const section = shift.shift_sections as unknown as { area: 'foh' | 'boh' } | null
    const hours =
      (new Date(shift.end_time).getTime() - new Date(shift.start_time).getTime()) /
      (1000 * 60 * 60)
    const rate = emp?.hourly_rate && Number(emp.hourly_rate) > 0 ? Number(emp.hourly_rate) : 0
    const cost = rate * hours
    const hasRate = rate > 0

    if (hasRate) { laborEstimate += cost; laborRatedShiftCount++ }
    else { laborUnratedShiftCount++ }

    // by area
    const areaKey: AreaKey = (section?.area === 'foh' || section?.area === 'boh') ? section.area : 'unassigned'
    const a = laborByAreaMap.get(areaKey) ?? { hours: 0, cost: 0, shiftCount: 0 }
    a.hours += hours; a.cost += cost; a.shiftCount += 1
    laborByAreaMap.set(areaKey, a)

    // by role
    const roleKey = (shift.role as string | null) ?? 'Unassigned'
    const r = laborByRoleMap.get(roleKey) ?? { hours: 0, cost: 0, shiftCount: 0, missingRate: false }
    r.hours += hours; r.cost += cost; r.shiftCount += 1
    if (!hasRate) r.missingRate = true
    laborByRoleMap.set(roleKey, r)

    // by employee
    if (emp) {
      const e = laborByEmployeeMap.get(emp.id) ?? {
        name: emp.name, hours: 0, cost: 0, shiftCount: 0, hourlyRate: hasRate ? rate : null,
      }
      e.hours += hours; e.cost += cost; e.shiftCount += 1
      if (hasRate && e.hourlyRate === null) e.hourlyRate = rate
      laborByEmployeeMap.set(emp.id, e)
    }
  }
  laborEstimate = Math.round(laborEstimate * 100) / 100

  const round2 = (n: number) => Math.round(n * 100) / 100
  const laborByArea = Array.from(laborByAreaMap.entries())
    .map(([area, v]) => ({ area, hours: round2(v.hours), cost: round2(v.cost), shiftCount: v.shiftCount }))
    .sort((a, b) => b.cost - a.cost)
  const laborByRole = Array.from(laborByRoleMap.entries())
    .map(([role, v]) => ({ role, hours: round2(v.hours), cost: round2(v.cost), shiftCount: v.shiftCount, missingRate: v.missingRate }))
    .sort((a, b) => b.cost - a.cost)
  const laborByEmployee = Array.from(laborByEmployeeMap.values())
    .map((v) => ({ name: v.name, hours: round2(v.hours), cost: round2(v.cost), shiftCount: v.shiftCount, hourlyRate: v.hourlyRate }))
    .sort((a, b) => b.cost - a.cost)

  const totalShiftCount = (weekShifts ?? []).length
  const ratedEmployeeCount = (ratedEmployees ?? []).length

  // Labor data-quality state — drives the UI between honest variants:
  //   no_employees  no employees with hourly rates configured at all
  //   no_shifts     rated employees exist but no shifts this week
  //   missing_rates shifts exist but the relevant employees lack rates
  //   ok            we have at least one shift × rate to compute
  type LaborState = 'no_employees' | 'no_shifts' | 'missing_rates' | 'ok'
  const laborState: LaborState = (() => {
    if (laborRatedShiftCount > 0) return 'ok'
    if (ratedEmployeeCount === 0) return 'no_employees'
    if (totalShiftCount === 0) return 'no_shifts'
    return 'missing_rates'
  })()

  // ---- Inventory spend breakdowns (drawer) ----
  // Subset of period expenses flagged as inventory-related, then
  // grouped by category + vendor for the drill-down drawer.
  const inventoryExpenses = allPeriodExpenses.filter((e) => e.is_inventory_related)
  const invByCatMap = new Map<string, { amount: number; count: number }>()
  const invByVendorMap = new Map<string, { amount: number; count: number }>()
  for (const e of inventoryExpenses) {
    const c = invByCatMap.get(e.category) ?? { amount: 0, count: 0 }
    c.amount += Number(e.amount); c.count += 1
    invByCatMap.set(e.category, c)
    const vendor = (e.vendor_name as string | null)?.trim() || '—'
    const v = invByVendorMap.get(vendor) ?? { amount: 0, count: 0 }
    v.amount += Number(e.amount); v.count += 1
    invByVendorMap.set(vendor, v)
  }
  const inventoryByCategory = Array.from(invByCatMap.entries())
    .map(([label, v]) => ({ label, amount: round2(v.amount), count: v.count }))
    .sort((a, b) => b.amount - a.amount)
  const inventoryByVendor = Array.from(invByVendorMap.entries())
    .map(([label, v]) => ({ label, amount: round2(v.amount), count: v.count }))
    .sort((a, b) => b.amount - a.amount)

  // ---- Bank activity aggregates (last 7 days) ----
  // External money is reframed around outside-the-system spend, so
  // outflows are the load-bearing signal here. Inflows are still
  // computed but never lead the UI — Revenue is system-defined,
  // not bank-derived. Rows without a Plaid PFC primary category
  // are bucketed as "unresolved" so the UI can be honest about
  // what the bank reveals vs what the system already knows.
  let bankInflow7d = 0
  let bankOutflow7d = 0
  let bankTxnCount7d = 0
  let externalSpendCount7d = 0
  let unresolvedCount7d = 0

  const externalByCategoryMap = new Map<string, { amount: number; count: number }>()
  type UnresolvedRow = {
    id: string; description: string | null; merchantName: string | null
    amount: number; postedAt: string
  }
  const unresolvedRows: UnresolvedRow[] = []

  for (const tx of periodBankTxns ?? []) {
    const amt = Number(tx.amount)
    bankTxnCount7d++
    if (tx.direction === 'inflow') {
      bankInflow7d += amt
      continue
    }
    // Outflow path — counts toward external spend.
    bankOutflow7d += amt
    externalSpendCount7d++

    const rawCat = (tx.raw_category as string | null)?.trim() || null
    if (!rawCat) {
      unresolvedCount7d++
      unresolvedRows.push({
        id: tx.id as string,
        description: (tx.description as string | null) ?? null,
        merchantName: (tx.merchant_name as string | null) ?? null,
        amount: round2(amt),
        postedAt: tx.posted_at as string,
      })
      continue
    }
    const bucket = externalByCategoryMap.get(rawCat) ?? { amount: 0, count: 0 }
    bucket.amount += amt
    bucket.count += 1
    externalByCategoryMap.set(rawCat, bucket)
  }

  const externalByCategory = Array.from(externalByCategoryMap.entries())
    .map(([rawLabel, v]) => ({
      label: friendlyExternalCategory(rawLabel),
      rawLabel,
      amount: round2(v.amount),
      count: v.count,
    }))
    .sort((a, b) => b.amount - a.amount)

  // Recognized external spend = bank outflows that Plaid classified
  // with a Personal Finance Category. Unresolved (uncategorized)
  // outflows are deliberately excluded — the system has no basis
  // to call them "spend" yet, so they don't affect Net activity.
  // This is the only external aggregate that flows into Net.
  const recognizedExternalSpend7d = externalByCategory.reduce((s, c) => s + c.amount, 0)

  // Most recent unresolved outflows. Cap so the drawer stays bounded.
  const recentUnresolved = unresolvedRows
    .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
    .slice(0, 8)

  // Bank state — used by the header chip and by the connected-accounts
  // card to make Finance's source-of-truth posture explicit:
  //   not_connected       no bank linked, system-only finance
  //   connected_unsynced  bank linked but no rows have ever synced
  //   connected_synced    at least one account has a real sync timestamp
  const accountList = bankAccounts ?? []
  const anySynced = accountList.some((a) => !!a.last_synced_at)
  const bankState: 'not_connected' | 'connected_unsynced' | 'connected_synced' =
    accountList.length === 0
      ? 'not_connected'
      : anySynced
        ? 'connected_synced'
        : 'connected_unsynced'

  return (
    <FinanceClient
      locations={locations ?? []}
      defaultLocationId={defaultLocationId}
      plaidConfigured={isPlaidConfigured()}
      plaidSandbox={isPlaidSandbox()}
      isDev={isDev}
      cards={{
        expenseTotal7d,
        expenseCount7d,
        revenue7d,
        inventorySpend7d,
        laborEstimate,
        laborRatedShiftCount,
        laborUnratedShiftCount,
        totalShiftCount,
        ratedEmployeeCount,
        laborState,
      }}
      laborBreakdown={{
        byArea: laborByArea,
        byRole: laborByRole,
        byEmployee: laborByEmployee,
      }}
      inventoryBreakdown={{
        byCategory: inventoryByCategory,
        byVendor: inventoryByVendor,
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
        externalSpend7d: Math.round(bankOutflow7d * 100) / 100,
        recognizedExternalSpend7d: round2(recognizedExternalSpend7d),
        externalSpendCount7d,
        unresolvedCount7d,
        inflow7d: Math.round(bankInflow7d * 100) / 100,
        outflow7d: Math.round(bankOutflow7d * 100) / 100,
        txnCount7d: bankTxnCount7d,
        externalByCategory,
        recentUnresolved,
        state: bankState,
      }}
      recentExpenses={(recentExpenses ?? []).map((e) => ({
        id: e.id,
        category: e.category,
        amount: Number(e.amount),
        expenseDate: e.expense_date,
        vendorName: e.vendor_name,
        notes: e.notes,
        isInventoryRelated: e.is_inventory_related,
        source: e.source ?? 'manual',
        locationId: e.location_id,
        locationName: (e.locations as unknown as { name: string } | null)?.name ?? null,
      }))}
    />
  )
}
