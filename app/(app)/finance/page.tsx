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
import { getLang } from '@/lib/i18n-server'
import { makeT, type Lang } from '@/lib/i18n'
import FinanceClient from './client'

// Plaid Personal Finance Category primaries → short human labels.
// Keeps the Operating UI readable without pretending the
// classification is more than what Plaid actually returns.
function friendlyOperatingCategory(raw: string, lang: Lang): string {
  const t = makeT(lang)
  const map: Record<string, string> = {
    RENT_AND_UTILITIES: t('Rent & utilities', 'Renta y servicios'),
    GENERAL_SERVICES: t('Services & subscriptions', 'Servicios y suscripciones'),
    FOOD_AND_DRINK: t('Food & drink', 'Comida y bebida'),
    GENERAL_MERCHANDISE: t('Supplies & merchandise', 'Suministros y mercancía'),
    TRANSPORTATION: t('Transportation', 'Transporte'),
    TRAVEL: t('Travel', 'Viajes'),
    ENTERTAINMENT: t('Marketing & entertainment', 'Marketing y entretenimiento'),
    BANK_FEES: t('Bank fees', 'Cuotas bancarias'),
    LOAN_PAYMENTS: t('Loan payments', 'Pagos de préstamos'),
    TRANSFER_OUT: t('Transfers out', 'Transferencias salientes'),
    HOME_IMPROVEMENT: t('Maintenance', 'Mantenimiento'),
    MEDICAL: t('Medical', 'Médico'),
    PERSONAL_CARE: t('Personal care', 'Cuidado personal'),
    GOVERNMENT_AND_NON_PROFIT: t('Government & other', 'Gobierno y otros'),
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
  const lang = await getLang()

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
    // the Operating card + drawer (outside-labor/inventory spend
    // focus) plus the Bank Review settlement workflow added in V3:
    // per-row amount, direction, raw category, merchant, description,
    // and the four review columns (review_state, settled_kind,
    // settled_expense_id, settled_at). Bank row IDs DO reach the UI
    // now — Bank Review needs them to drive settle/ignore actions.
    supabase
      .from('bank_transactions')
      .select('id, amount, direction, raw_category, merchant_name, description, posted_at, review_state, settled_kind, settled_expense_id, settled_at')
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
  // OBSERVER-PHASE MODEL — see also the Finance design doc.
  //
  // The four spend signals (Labor / Inventory / External / Net)
  // are sub-parts of one Spend total, not separate buckets. To
  // avoid double-counting between in-system projections and bank
  // reality, classify each bank outflow into one of:
  //
  //   inventory  → confirms the Inventory bucket (food/drink and
  //                general-merchandise PFCs). NOT added to External.
  //   external   → captures the system-blind layer (rent, utilities,
  //                fees, transfers, subscriptions, etc.).
  //   unresolved → no PFC yet; surfaced in the External drawer for
  //                manager triage but excluded from Net.
  //
  // Each bucket is then reconciled at the metric level via
  // max(in-system projection, bank-confirmed) in the client so a
  // bank row that confirms a logged expense doesn't add on top of
  // it. Rough first-pass classifier — accepts some misclassification
  // by design; gets retired once the app initiates payments itself.
  let bankInflow7d = 0
  let bankOutflow7d = 0
  let bankTxnCount7d = 0
  let externalSpendCount7d = 0
  let unresolvedCount7d = 0
  let bankInventoryConfirmed7d = 0

  const externalByCategoryMap = new Map<string, { amount: number; count: number }>()
  type UnresolvedRow = {
    id: string; description: string | null; merchantName: string | null
    amount: number; postedAt: string
  }
  const unresolvedRows: UnresolvedRow[] = []

  // ---- Bank Review V1 review-queue accumulators ----
  // Bank transactions carry a review_state column added in the
  // Bank Review V1 migration. We surface rows by state so the
  // Bank Review card + drawer can render review queues without
  // a second round-trip. Settled rows feed the "Settled" tail of
  // the drawer; ignored rows are excluded from every Finance
  // total below so personal/owner-transfer activity stops
  // polluting the business numbers.
  type ReviewRow = {
    id: string
    direction: 'inflow' | 'outflow'
    amount: number
    rawCategory: string | null
    merchantName: string | null
    description: string | null
    postedAt: string
    reviewState: 'unreviewed' | 'settled' | 'ignored' | 'not_a_match'
    settledKind: 'revenue' | 'inventory' | 'labor' | 'operating' | null
  }
  const reviewRows: ReviewRow[] = []
  let unreviewedCount = 0
  let unreviewedInflowCount = 0
  let unreviewedOutflowCount = 0
  let settledCount = 0
  let ignoredCount = 0
  let notAMatchCount = 0

  // PFC → bucket. Conservative mapping: only food/drink and general-
  // merchandise route to Inventory; everything else categorized goes
  // to External. Labor/payroll detection is intentionally deferred —
  // Plaid PFC alone can't reliably tell payroll from generic ACH/
  // transfer outflows, and that's the layer the action-phase will
  // own anyway.
  const inventoryPfcs = new Set(['FOOD_AND_DRINK', 'GENERAL_MERCHANDISE'])
  const classifyBankPfc = (rawCategory: string | null): 'inventory' | 'external' | 'unresolved' => {
    if (!rawCategory) return 'unresolved'
    if (inventoryPfcs.has(rawCategory)) return 'inventory'
    return 'external'
  }

  for (const tx of periodBankTxns ?? []) {
    const amt = Number(tx.amount)
    const rawCat = (tx.raw_category as string | null)?.trim() || null
    const reviewState = ((tx.review_state as string | null) ?? 'unreviewed') as ReviewRow['reviewState']
    const settledKind = ((tx.settled_kind as string | null) ?? null) as ReviewRow['settledKind']

    // Populate the review feed for every row (regardless of state).
    // The Bank Review drawer filters at render time.
    reviewRows.push({
      id: tx.id as string,
      direction: tx.direction as 'inflow' | 'outflow',
      amount: round2(amt),
      rawCategory: rawCat,
      merchantName: (tx.merchant_name as string | null) ?? null,
      description: (tx.description as string | null) ?? null,
      postedAt: tx.posted_at as string,
      reviewState,
      settledKind,
    })
    if (reviewState === 'settled') settledCount++
    else if (reviewState === 'ignored') ignoredCount++
    else if (reviewState === 'not_a_match') notAMatchCount++
    else {
      unreviewedCount++
      if (tx.direction === 'inflow') unreviewedInflowCount++
      else unreviewedOutflowCount++
    }

    // Ignored rows are excluded from every Finance total — they
    // are personal / owner-transfer / not-a-business-event by
    // explicit manager decision. They still appear in the Bank
    // Review drawer's ignored tail for reversibility.
    if (reviewState === 'ignored') continue

    bankTxnCount7d++
    if (tx.direction === 'inflow') {
      bankInflow7d += amt
      continue
    }

    // Outflow path — counts toward external/operating spend.
    bankOutflow7d += amt
    externalSpendCount7d++

    const klass = classifyBankPfc(rawCat)

    if (klass === 'unresolved') {
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

    if (klass === 'inventory') {
      // Inventory PFC rows confirm the Inventory bucket — they're
      // the bank's echo of food/supply purchases the manager either
      // already logged or hasn't logged yet. Tracked separately so
      // they don't show up under External in the drawer.
      bankInventoryConfirmed7d += amt
      continue
    }

    // 'external' — categorized as non-inventory non-labor.
    // rawCat is non-null here because klass === 'external' implies it.
    const bucket = externalByCategoryMap.get(rawCat!) ?? { amount: 0, count: 0 }
    bucket.amount += amt
    bucket.count += 1
    externalByCategoryMap.set(rawCat!, bucket)
  }

  const externalByCategory = Array.from(externalByCategoryMap.entries())
    .map(([rawLabel, v]) => ({
      label: friendlyOperatingCategory(rawLabel, lang),
      rawLabel,
      amount: round2(v.amount),
      count: v.count,
    }))
    .sort((a, b) => b.amount - a.amount)

  // Recognized external spend = bank-categorized outflows that
  // are NOT inventory-PFC. Inventory-PFC rows are filtered out
  // above so they only flow into the Inventory bucket (not double-
  // counted). This is the bank-confirmed half of the External
  // bucket; the client max()es it against manual non-inventory
  // expenses to land on the displayed External value.
  const recognizedExternalSpend7d = externalByCategory.reduce((s, c) => s + c.amount, 0)

  // Most recent unresolved outflows. Cap so the drawer stays bounded.
  const recentUnresolved = unresolvedRows
    .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
    .slice(0, 8)

  // Sort review rows newest first. Drawer renders by section
  // (suggested / incoming / outgoing / settled / ignored) and reuses
  // this single feed — no extra round-trip needed.
  reviewRows.sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())

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
      lang={lang}
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
        bankInventoryConfirmed7d: round2(bankInventoryConfirmed7d),
        externalSpendCount7d,
        unresolvedCount7d,
        inflow7d: Math.round(bankInflow7d * 100) / 100,
        outflow7d: Math.round(bankOutflow7d * 100) / 100,
        txnCount7d: bankTxnCount7d,
        externalByCategory,
        recentUnresolved,
        state: bankState,
        review: {
          rows: reviewRows,
          counts: {
            unreviewed: unreviewedCount,
            unreviewedInflow: unreviewedInflowCount,
            unreviewedOutflow: unreviewedOutflowCount,
            settled: settledCount,
            ignored: ignoredCount,
            notAMatch: notAMatchCount,
          },
        },
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
