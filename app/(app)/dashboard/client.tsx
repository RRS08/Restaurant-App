'use client'

// ----------------------------------------------------------------
// Dashboard Client — Today's Operations.
//
// The daily command center for the restaurant operating system.
// Three bands:
//
//   1. Daily Status Strip — four compact operating cards
//      (Sales Today / Staff Coverage / Inventory Risk / Money Pulse).
//      Each one answers a single question for today.
//
//   2. Main Operating Area — left: Today's Rhythm (compact sales +
//      shifts charts); right: Needs Attention (the page's dominant
//      operational surface — a unified attention queue that absorbs
//      what used to be readiness banner + inventory watchlist +
//      action-needed list).
//
//   3. Supporting Readiness / Recent Movement — three calm cards:
//      Opening Readiness (system-state checks, replaces the old
//      user-editable checklist), Next Up (next shift), Recent
//      Movement (latest sale / inventory move / expense).
//
// Boundaries enforced by copy and what's surfaced:
//   - never interprets patterns       → Analytics' job
//   - never explains money            → Finance's job
//   - never reviews the ledger        → Sales' job
//   - never schedules                 → Staffing's job
//   - never manages stock workflow    → Inventory's job
//
// Dashboard only reports operating state and routes attention.
// ----------------------------------------------------------------

import { useMemo, useState } from 'react'
import Link from 'next/link'
import SimpleLineChart from '@/components/line-chart'
import type { PillarKey, PillarState } from '@/lib/readiness'

interface Props {
  firstName: string | null
  /** Server-rendered freshness stamp, e.g. "1:14 PM". Truthful: this
   *  is the request time the server produced the view at. */
  renderedAt: string
  readiness: Record<PillarKey, PillarState> | null
  bankConnectedUnsynced?: boolean
  inventoryWriteLive?: boolean
  inventory: {
    outOfStockCount: number
    lowStockCount: number
    noCountCount: number
    totalItems: number
  }
  staffing: {
    employeeCount: number
    shiftsToday: number
    shiftsThisWeek: number
  }
  sales: {
    ordersToday: number
    salesToday: number
    ordersLast7Days: number
    totalLast7Days: number
  }
  finance: {
    expenseCount30d: number
    expenseTotal30d: number
  }
  /** Current Mon–Sun week, one entry per day. Same day-by-day axis
   *  the interactive ShiftStrip uses, so chart and strip stay in
   *  lockstep. `orders` and `date` power the selected-day summary. */
  salesByDay: { label: string; value: number; orders: number; date: string }[]
  shiftsByDay: { label: string; value: number; employees: number; date: string }[]
  /** Flat current-week shift list — used by the selected-day summary
   *  to surface the first scheduled shift on the chosen day without
   *  a second round-trip. */
  weekShiftDetails: {
    id: string
    employeeName: string
    role: string
    startTime: string
    endTime: string
  }[]
  watchlist: { name: string; status: 'Out' | 'Low' | 'No count' }[]
  upcomingShifts: {
    id: string
    employeeName: string
    role: string
    startTime: string
    endTime: string
  }[]
  latestSale: { amount: number; datetime: string } | null
  latestExpense: { amount: number; date: string } | null
  latestInventoryMovement: {
    itemName: string
    quantityChange: number
    datetime: string
  } | null
}

// ================================================================
// Domain types for view-model
// ================================================================

type Severity = 'critical' | 'warn' | 'info'
type PillarTag = 'Inventory' | 'Staffing' | 'Sales' | 'Finance' | 'Setup'

interface AttentionItem {
  id: string
  severity: Severity
  pillar: PillarTag
  headline: string
  sub?: string
  href: string
}

interface ReadinessCheck {
  id: string
  label: string
  status: 'ready' | 'limited' | 'pending'
  sub?: string
}

// ================================================================
// Formatting helpers
// ================================================================

const MONEY = (n: number, withCents = false): string =>
  `$${n.toLocaleString('en-US', {
    minimumFractionDigits: withCents ? 2 : 0,
    maximumFractionDigits: withCents ? 2 : 0,
  })}`

function fmtRelative(iso: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime()
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  const diffWk = Math.round(diffDay / 7)
  return `${diffWk}w ago`
}

function fmtDateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ================================================================
// View-model builders
// ================================================================

function buildAttention(props: Props): AttentionItem[] {
  const out: AttentionItem[] = []
  const {
    inventory,
    staffing,
    sales,
    readiness,
    inventoryWriteLive,
    bankConnectedUnsynced,
  } = props

  // ---- Setup-level (readiness honesty) ----
  if (readiness) {
    if (!inventoryWriteLive) {
      out.push({
        id: 'setup-inventory-not-live',
        severity: 'info',
        pillar: 'Setup',
        headline: 'Inventory tracking not active yet',
        sub: 'Stock counts shown are setup data — depletion is not flowing.',
        href: '/settings',
      })
    } else if (readiness.inventory === 'active_with_limitations') {
      out.push({
        id: 'setup-inventory-partial',
        severity: 'info',
        pillar: 'Setup',
        headline: 'Inventory active with limitations',
        sub: 'Some menu items are still unmapped to recipes.',
        href: '/settings',
      })
    }

    if (readiness.sales === 'setup_in_progress' || readiness.sales === 'not_started') {
      out.push({
        id: 'setup-sales-pending',
        severity: 'warn',
        pillar: 'Setup',
        headline: 'Sales not flowing yet',
        sub: 'Pick an operating mode to start ringing up orders.',
        href: '/settings',
      })
    }

    if (readiness.finance === 'active_with_limitations') {
      if (bankConnectedUnsynced) {
        out.push({
          id: 'setup-bank-unsynced',
          severity: 'info',
          pillar: 'Finance',
          headline: 'Bank connected, awaiting first sync',
          sub: 'Finance will reconcile once transactions arrive.',
          href: '/finance',
        })
      } else {
        out.push({
          id: 'setup-bank-internal-only',
          severity: 'info',
          pillar: 'Finance',
          headline: 'Finance on internal data only',
          sub: 'No bank sync connected — money pulse is approximate.',
          href: '/finance',
        })
      }
    }
  }

  // ---- Inventory ----
  if (inventory.outOfStockCount > 0) {
    out.push({
      id: 'inv-out-of-stock',
      severity: 'critical',
      pillar: 'Inventory',
      headline: `Restock ${inventory.outOfStockCount} item${inventory.outOfStockCount === 1 ? '' : 's'}`,
      sub: 'Currently estimated at zero or below.',
      href: '/inventory',
    })
  }
  if (inventory.lowStockCount > 0) {
    out.push({
      id: 'inv-low-stock',
      severity: 'warn',
      pillar: 'Inventory',
      headline: `Review ${inventory.lowStockCount} low-stock item${inventory.lowStockCount === 1 ? '' : 's'}`,
      sub: 'Below the low-stock threshold.',
      href: '/inventory',
    })
  }
  if (inventory.noCountCount > 0) {
    out.push({
      id: 'inv-no-count',
      severity: 'info',
      pillar: 'Inventory',
      headline: `Count ${inventory.noCountCount} uncounted item${inventory.noCountCount === 1 ? '' : 's'}`,
      sub: 'No baseline count recorded yet.',
      href: '/inventory/new-count',
    })
  }

  // ---- Staffing ----
  if (staffing.employeeCount === 0) {
    out.push({
      id: 'staff-no-employees',
      severity: 'warn',
      pillar: 'Staffing',
      headline: 'No active employees',
      sub: 'Add your team to begin scheduling.',
      href: '/staffing',
    })
  } else if (staffing.shiftsToday === 0) {
    out.push({
      id: 'staff-no-shifts',
      severity: 'warn',
      pillar: 'Staffing',
      headline: 'No shifts scheduled today',
      sub: 'Today\'s coverage is currently empty.',
      href: '/staffing',
    })
  }

  // ---- Sales ----
  if (
    sales.ordersToday === 0 &&
    readiness?.sales === 'active'
  ) {
    out.push({
      id: 'sales-no-today',
      severity: 'info',
      pillar: 'Sales',
      headline: 'No sales recorded today',
      sub: 'Open POS or check the import feed.',
      href: '/pos',
    })
  }

  // Sort: critical → warn → info; stable within group.
  const order: Record<Severity, number> = { critical: 0, warn: 1, info: 2 }
  return out.sort((a, b) => order[a.severity] - order[b.severity])
}

function buildReadinessChecks(props: Props): ReadinessCheck[] {
  const { readiness, inventoryWriteLive, inventory, staffing, sales, bankConnectedUnsynced } = props
  const stockAlertCount = inventory.outOfStockCount + inventory.lowStockCount

  return [
    {
      id: 'pos',
      label: 'POS ready',
      status: readiness?.sales === 'active' ? 'ready' : 'pending',
      sub:
        readiness?.sales === 'active'
          ? 'Operating mode set; orders can flow.'
          : 'Pick an operating mode in Settings.',
    },
    {
      id: 'staffing',
      label: 'Today\'s staffing confirmed',
      status:
        staffing.employeeCount > 0 && staffing.shiftsToday > 0
          ? 'ready'
          : 'pending',
      sub:
        staffing.shiftsToday > 0
          ? `${staffing.shiftsToday} shift${staffing.shiftsToday === 1 ? '' : 's'} on today.`
          : 'No shifts scheduled for today.',
    },
    {
      id: 'inventory',
      label: 'Stock alerts reviewed',
      status: !inventoryWriteLive
        ? 'pending'
        : stockAlertCount === 0
          ? 'ready'
          : 'limited',
      sub: !inventoryWriteLive
        ? 'Tracking not active yet — counts are setup data.'
        : stockAlertCount === 0
          ? 'All items in good standing.'
          : `${stockAlertCount} alert${stockAlertCount === 1 ? '' : 's'} pending review.`,
    },
    {
      id: 'finance',
      label: 'Finance status known',
      status:
        readiness?.finance === 'active'
          ? 'ready'
          : readiness?.finance === 'active_with_limitations'
            ? 'limited'
            : 'pending',
      sub:
        readiness?.finance === 'active'
          ? 'Bank synced.'
          : bankConnectedUnsynced
            ? 'Bank connected, awaiting first sync.'
            : readiness?.finance === 'active_with_limitations'
              ? 'Internal expense tracking only.'
              : 'Not configured yet.',
    },
    {
      id: 'sales-activity',
      label: 'Recent sales activity reviewed',
      status: sales.ordersLast7Days > 0 ? 'ready' : 'limited',
      sub:
        sales.ordersLast7Days > 0
          ? `${sales.ordersLast7Days} order${sales.ordersLast7Days === 1 ? '' : 's'} in the last 7 days.`
          : 'No sales in the last 7 days.',
    },
  ]
}

// ================================================================
// Main client
// ================================================================

export default function DashboardClient(props: Props) {
  const {
    firstName,
    renderedAt,
    inventory,
    staffing,
    sales,
    finance,
    salesByDay,
    shiftsByDay,
    weekShiftDetails,
    upcomingShifts,
    latestSale,
    latestExpense,
    latestInventoryMovement,
    readiness,
    bankConnectedUnsynced,
    inventoryWriteLive,
  } = props

  // ----------------------------------------------------------------
  // Today's Rhythm — selected-day state
  //
  // Default: today's Mon..Sun index (0=Mon, 6=Sun). If for any
  // reason today isn't in the displayed week, fall back to the
  // latest day with any data (sales or shifts), otherwise day 0.
  // ----------------------------------------------------------------
  const todayIdx = useMemo(() => {
    const jsDay = new Date().getDay() // 0=Sun..6=Sat
    return jsDay === 0 ? 6 : jsDay - 1
  }, [])

  const defaultSelectedIdx = useMemo(() => {
    // Today is the natural default.
    if (todayIdx >= 0 && todayIdx < 7) return todayIdx
    // Fallback: latest day in the week that has any activity.
    for (let i = 6; i >= 0; i--) {
      if ((salesByDay[i]?.value ?? 0) > 0 || (shiftsByDay[i]?.value ?? 0) > 0) {
        return i
      }
    }
    return 0
  }, [todayIdx, salesByDay, shiftsByDay])

  const [selectedDayIdx, setSelectedDayIdx] = useState<number>(defaultSelectedIdx)

  // Resolved values for the selected day. Each useMemo only
  // recomputes when its inputs change, so flipping days is cheap.
  const selectedSales = salesByDay[selectedDayIdx] ?? null
  const selectedShifts = shiftsByDay[selectedDayIdx] ?? null
  const selectedDate = selectedShifts?.date ?? selectedSales?.date ?? null

  // First scheduled shift on the selected day. Earliest start time
  // wins — this is the "next" for today/future and the "first" for
  // a past day, framed with a single neutral eyebrow.
  const selectedFirstShift = useMemo(() => {
    if (!selectedDate) return null
    const target = new Date(selectedDate)
    const onDay = weekShiftDetails.filter((s) => {
      const d = new Date(s.startTime)
      return (
        d.getFullYear() === target.getFullYear() &&
        d.getMonth() === target.getMonth() &&
        d.getDate() === target.getDate()
      )
    })
    if (onDay.length === 0) return null
    return [...onDay].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    )[0]
  }, [selectedDate, weekShiftDetails])

  const stockAlerts = inventory.outOfStockCount + inventory.lowStockCount
  const attention = buildAttention(props)
  const readinessChecks = buildReadinessChecks(props)
  const nextShift = upcomingShifts[0] ?? null

  // Daily Status Strip — each card answers one question for today.
  const salesState: 'ready' | 'quiet' =
    sales.ordersToday > 0 ? 'ready' : 'quiet'

  const staffState: 'ready' | 'warn' =
    staffing.shiftsToday > 0 && staffing.employeeCount > 0 ? 'ready' : 'warn'
  const staffStatus =
    staffing.employeeCount === 0
      ? 'No team yet'
      : staffing.shiftsToday === 0
        ? 'No shifts today'
        : 'Ready'

  const inventoryState: 'critical' | 'warn' | 'ready' =
    inventory.outOfStockCount > 0
      ? 'critical'
      : stockAlerts > 0 || inventory.noCountCount > 0
        ? 'warn'
        : 'ready'
  const inventoryStatus =
    inventory.outOfStockCount > 0
      ? 'Needs attention'
      : stockAlerts > 0
        ? 'Watch items'
        : !inventoryWriteLive
          ? 'Setup only'
          : 'Stable'

  const financeState: 'ready' | 'limited' | 'pending' =
    readiness?.finance === 'active'
      ? 'ready'
      : readiness?.finance === 'active_with_limitations'
        ? 'limited'
        : 'pending'
  const financeStatus =
    financeState === 'ready'
      ? 'Bank synced'
      : bankConnectedUnsynced
        ? 'Awaiting sync'
        : financeState === 'limited'
          ? 'Internal only'
          : 'Needs setup'

  return (
    // Constrained content width — same family standard as Staffing,
    // Analytics, Inventory, Finance, and POS. Preserves intentional
    // right-side whitespace on wide screens so Dashboard reads as a
    // focused operating workspace, not a wall-to-wall admin grid.
    <div className="max-w-[1400px]">
      {/* ============================================================ */}
      {/* HEADER — page identity is "Today's Operations", greeting is a  */}
      {/* small eyebrow so personalization stays but doesn't lead.       */}
      {/* The standalone notification bell was removed — the Needs       */}
      {/* Attention queue below is the single operational triage         */}
      {/* surface, so a separate bell would just compete with it.        */}
      {/* ============================================================ */}
      <div className="mb-5 pb-4 border-b border-gray-100 flex items-end justify-between gap-4 flex-wrap">
        <div>
          {firstName && (
            <p className="text-[11px] text-gray-500 mb-1">
              Welcome back, {firstName}
            </p>
          )}
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">
            Today&apos;s Operations
          </h1>
          <p className="mt-1.5 text-sm text-gray-500">
            A quick read on sales, stock, staffing, and finance.
          </p>
        </div>
        {/* Truthful render-time stamp. Not live — accurate as of the
            request that produced this view. */}
        <p className="text-[11px] text-gray-500 tabular-nums">
          Updated {renderedAt}
        </p>
      </div>

      {/* ============================================================ */}
      {/* 1. DAILY STATUS STRIP                                          */}
      {/* Four compact operating cards. Each answers "is this OK today?" */}
      {/* with one number + a short status word. Color is restrained:    */}
      {/* small status dot + soft left-edge accent on non-normal states. */}
      {/* ============================================================ */}
      {/* Sub-copy is deliberately operational ("X completed orders
          today" / "No coverage scheduled today" / "Y items need
          review" / "Z expenses · last 30d"). The eye should land on
          the main number, then read the supporting line, then check
          the status pill — each layer answers "is today okay?" at
          a different fidelity. */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 mb-5">
        <DailyStatusCard
          href="/sales"
          label="Sales Today"
          value={MONEY(sales.salesToday)}
          sub={
            sales.ordersToday === 0
              ? 'No completed orders yet today'
              : `${sales.ordersToday} completed order${sales.ordersToday === 1 ? '' : 's'} today`
          }
          status={sales.ordersToday === 0 ? 'No sales yet' : 'Active'}
          tone={salesState === 'ready' ? 'normal' : 'neutral'}
        />
        <DailyStatusCard
          href="/staffing"
          label="Staff Coverage"
          value={`${staffing.shiftsToday} shift${staffing.shiftsToday === 1 ? '' : 's'}`}
          sub={
            staffing.employeeCount === 0
              ? 'Add your team to begin scheduling'
              : staffing.shiftsToday === 0
                ? 'No coverage scheduled today'
                : `${staffing.employeeCount} active employee${staffing.employeeCount === 1 ? '' : 's'} on the team`
          }
          status={staffStatus}
          tone={staffState === 'ready' ? 'normal' : 'warn'}
        />
        <DailyStatusCard
          href="/inventory"
          label="Inventory Risk"
          value={
            inventory.outOfStockCount > 0
              ? `${inventory.outOfStockCount} out`
              : stockAlerts > 0
                ? `${stockAlerts} alert${stockAlerts === 1 ? '' : 's'}`
                : 'All clear'
          }
          sub={(() => {
            const needReview =
              inventory.outOfStockCount + inventory.lowStockCount + inventory.noCountCount
            if (needReview === 0) return `${inventory.totalItems} tracked · all in good standing`
            return `${inventory.totalItems} tracked · ${needReview} need${needReview === 1 ? 's' : ''} review`
          })()}
          status={inventoryStatus}
          tone={
            inventoryState === 'critical'
              ? 'critical'
              : inventoryState === 'warn'
                ? 'warn'
                : 'normal'
          }
        />
        <DailyStatusCard
          href="/finance"
          label="Money Pulse"
          value={MONEY(finance.expenseTotal30d)}
          sub={`${finance.expenseCount30d} expense${finance.expenseCount30d === 1 ? '' : 's'} tracked · last 30d`}
          status={financeStatus}
          tone={
            financeState === 'ready'
              ? 'normal'
              : financeState === 'limited'
                ? 'neutral'
                : 'warn'
          }
        />
      </div>

      {/* ============================================================ */}
      {/* 2. MAIN OPERATING AREA                                         */}
      {/* Left: Today's Rhythm — sales chart + shift coverage strip.     */}
      {/* Right: Needs Attention — the dominant operational surface.    */}
      {/* The right column intentionally outweighs the left in product  */}
      {/* role even though the left is wider visually: charts orient,   */}
      {/* attention routes.                                              */}
      {/* ============================================================ */}
      <div className="grid gap-4 grid-cols-1 xl:grid-cols-5 mb-5">

        {/* LEFT — Today's Rhythm (col-span-3).
            Compact: sales line at 110px (was 160), shift coverage
            is now a 7-tile horizontal strip (was a bar chart) so
            empty days don't carry chart chrome. Today's tile is
            highlighted dark to anchor the eye to "now". */}
        <div className="xl:col-span-3 rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col">
          <div className="border-b border-gray-100 px-5 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Today&apos;s rhythm
            </p>
            <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
              Sales movement and scheduled coverage this week.
            </p>
          </div>
          <div className="px-5 pt-3 pb-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">
              Sales · this week
            </p>
            <SimpleLineChart data={salesByDay} color="#3b82f6" height={110} />
          </div>
          <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/40">
            <div className="flex items-baseline justify-between mb-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                Shifts · this week
              </p>
              <p className="text-[10px] tabular-nums text-gray-500">
                <span className="font-semibold text-gray-700">
                  {shiftsByDay.reduce((s, d) => s + d.value, 0)}
                </span>{' '}
                total
              </p>
            </div>
            <ShiftStrip
              days={shiftsByDay}
              selectedIdx={selectedDayIdx}
              todayIdx={todayIdx}
              onSelect={setSelectedDayIdx}
            />
          </div>

          {/* Selected-day summary — appears inside the same Today's
              Rhythm card so the interaction stays contained. Three
              compact columns: Sales / Coverage / Next. Empty states
              are honest ("No sales recorded" / "No shifts scheduled"
              / "No upcoming shift") so the card never invents data. */}
          <SelectedDaySummary
            sales={selectedSales}
            shifts={selectedShifts}
            firstShift={selectedFirstShift}
            dateIso={selectedDate}
          />
        </div>

        {/* RIGHT — Needs Attention (col-span-2). The dominant
            operational triage surface. Header carries a sub-line +
            a count pill that's the same visual class as the daily
            status strip's pills, so this surface anchors as the
            page's triage anchor rather than a generic side list. */}
        <div className="xl:col-span-2 rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col">
          <div className="border-b border-gray-100 px-5 py-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-700">
                Needs attention
              </p>
              <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                What to look at next.
              </p>
            </div>
            {attention.length > 0 && (
              <span
                className={`inline-flex items-center gap-1.5 text-[10px] font-bold tabular-nums px-2 py-0.5 rounded-full flex-shrink-0 ${
                  attention.some((a) => a.severity === 'critical')
                    ? 'bg-red-50 text-red-700'
                    : attention.some((a) => a.severity === 'warn')
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-gray-100 text-gray-700'
                }`}
              >
                {attention.length}
              </span>
            )}
          </div>
          {attention.length === 0 ? (
            <div className="flex-1 px-5 py-10 text-center">
              <p className="text-xs font-semibold text-gray-700">Nothing urgent right now.</p>
              <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed max-w-xs mx-auto">
                Today&apos;s operating state looks healthy. Open a pillar to keep working.
              </p>
            </div>
          ) : (
            <ul className="flex-1 divide-y divide-gray-100">
              {attention.slice(0, 8).map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="flex items-start gap-3 px-5 py-3.5 hover:bg-gray-50 transition-colors group"
                  >
                    <span
                      className={`mt-1.5 h-2 w-2 rounded-full flex-shrink-0 ${
                        item.severity === 'critical'
                          ? 'bg-red-500'
                          : item.severity === 'warn'
                            ? 'bg-amber-500'
                            : 'bg-blue-400'
                      }`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                        {item.pillar}
                      </p>
                      <p className="mt-0.5 text-[13px] font-semibold text-gray-900 leading-snug">
                        {item.headline}
                      </p>
                      {item.sub && (
                        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                          {item.sub}
                        </p>
                      )}
                    </div>
                    {/* Explicit action affordance — a small text
                        link rather than a lone arrow. Blue is the
                        family accent for action; sentence-case +
                        medium weight keeps the row calm. */}
                    <span className="text-[11px] font-medium text-blue-700 group-hover:text-blue-800 group-hover:translate-x-0.5 transition-all flex-shrink-0 mt-0.5 whitespace-nowrap">
                      Review →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

      </div>

      {/* ============================================================ */}
      {/* 3. SUPPORTING READINESS / RECENT MOVEMENT                      */}
      {/* Three calm support cards.                                      */}
      {/* ============================================================ */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-3">

        {/* Daily readiness — system-driven, not a to-do list. Broader
            than "opening" since the dashboard plays a daily role
            beyond morning workflows. */}
        <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Daily readiness
            </p>
            <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
              Readiness checks for today&apos;s operation.
            </p>
          </div>
          <ul className="divide-y divide-gray-100">
            {readinessChecks.map((check) => (
              <li key={check.id} className="px-4 py-2.5 flex items-start gap-2.5">
                <ReadinessDot status={check.status} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-gray-800 leading-snug">
                    {check.label}
                  </p>
                  {check.sub && (
                    <p className="mt-0.5 text-[10px] text-gray-500 leading-relaxed">
                      {check.sub}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Next up — next scheduled operational event */}
        <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Next up
            </p>
            <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
              The next scheduled shift.
            </p>
          </div>
          <div className="px-4 py-4">
            {nextShift ? (
              <>
                <p className="text-sm font-semibold text-gray-900 truncate">
                  {nextShift.employeeName}
                </p>
                <p className="mt-0.5 text-[11px] text-gray-500">{nextShift.role}</p>
                <p className="mt-2 text-[11px] text-gray-600 tabular-nums leading-relaxed">
                  {new Date(nextShift.startTime).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                  {' · '}
                  {new Date(nextShift.startTime).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                  {' – '}
                  {new Date(nextShift.endTime).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </p>
              </>
            ) : (
              <p className="text-xs text-gray-400">No upcoming shifts.</p>
            )}
          </div>
        </div>

        {/* Recent movement — proof the system is alive */}
        <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Recent movement
            </p>
            <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
              Latest activity across the system.
            </p>
          </div>
          <ul className="divide-y divide-gray-100">
            <MovementRow
              label="Latest sale"
              value={latestSale ? MONEY(latestSale.amount, true) : null}
              when={latestSale?.datetime ?? null}
              relative
            />
            <MovementRow
              label="Inventory move"
              value={
                latestInventoryMovement
                  ? `${latestInventoryMovement.itemName} · ${latestInventoryMovement.quantityChange > 0 ? '+' : ''}${latestInventoryMovement.quantityChange}`
                  : null
              }
              when={latestInventoryMovement?.datetime ?? null}
              relative
            />
            <MovementRow
              label="Latest expense"
              value={latestExpense ? MONEY(latestExpense.amount, true) : null}
              when={latestExpense?.date ?? null}
              relative={false}
            />
          </ul>
        </div>

      </div>

      {/* ============================================================ */}
      {/* 4. QUICK ACTIONS — secondary strip below the supporting row. */}
      {/* Manual expense entry used to live as a dominant card on the */}
      {/* Finance page; it now lives in a Finance drawer reachable    */}
      {/* either from there or from this Dashboard quick action.      */}
      {/* ?log=1 deep-links into the Log Expense drawer on load.      */}
      {/* ============================================================ */}
      <div className="mt-4">
        <Link
          href="/finance?log=1"
          className="block rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:border-gray-300 hover:shadow-[0_4px_12px_-4px_rgba(15,23,42,0.08)] transition-all p-4 group"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                Quick action
              </p>
              <p className="mt-1 text-sm font-semibold text-gray-900">Add manual expense</p>
              <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">
                Record a cash purchase, owner-paid expense, or one-off correction.
              </p>
            </div>
            <span className="text-[11px] font-medium text-blue-700 group-hover:text-blue-800 group-hover:translate-x-0.5 transition-all flex-shrink-0 whitespace-nowrap">
              Open form →
            </span>
          </div>
        </Link>
      </div>
    </div>
  )
}

// ================================================================
// DailyStatusCard — top-row operating tile. Unified white chrome,
// pillar identity through the label, state via small status pill +
// soft left-edge accent. Never tints the whole card.
// ================================================================
function DailyStatusCard({
  href,
  label,
  value,
  sub,
  status,
  tone,
}: {
  href: string
  label: string
  value: string
  sub: string
  status: string
  tone: 'normal' | 'neutral' | 'warn' | 'critical'
}) {
  const accent =
    tone === 'critical'
      ? 'border-l-2 border-l-red-300'
      : tone === 'warn'
        ? 'border-l-2 border-l-amber-300'
        : ''
  const pillBg =
    tone === 'critical'
      ? 'bg-red-50 text-red-700'
      : tone === 'warn'
        ? 'bg-amber-50 text-amber-700'
        : tone === 'neutral'
          ? 'bg-gray-100 text-gray-600'
          : 'bg-emerald-50 text-emerald-700'
  const dot =
    tone === 'critical'
      ? 'bg-red-500'
      : tone === 'warn'
        ? 'bg-amber-500'
        : tone === 'neutral'
          ? 'bg-gray-400'
          : 'bg-emerald-500'
  const valueTone =
    tone === 'critical'
      ? 'text-red-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : 'text-gray-900'
  return (
    <Link
      href={href}
      className={`rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] p-4 hover:border-gray-300 hover:shadow-md transition-all block ${accent}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
          {label}
        </p>
        <span
          className={`inline-flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${pillBg}`}
        >
          <span className={`h-1 w-1 rounded-full ${dot}`} aria-hidden="true" />
          {status}
        </span>
      </div>
      <p className={`mt-2 text-xl font-bold tabular-nums leading-tight ${valueTone}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-gray-500 truncate">{sub}</p>
    </Link>
  )
}

// ================================================================
// ShiftStrip — interactive 7-tile week strip. Each tile is a button
// that selects that day for the inline summary below.
//
// Visual states:
//   • selected    → dark navy fill (bg-gray-900) — legitimate now
//                   that the tiles are actual interactive controls,
//                   matching the family's primary-control language.
//   • unselected  → white surface, thin gray-100 border, hover state
//                   that picks up a slightly darker border + bg-gray-50.
//   • today (when not selected) gets a small blue dot above the label
//                   so the manager can still spot "now" at a glance.
//
// Zero-shift days show "—" instead of "0" to stay calm.
// ================================================================
function ShiftStrip({
  days,
  selectedIdx,
  todayIdx,
  onSelect,
}: {
  days: { label: string; value: number }[]
  selectedIdx: number
  todayIdx: number
  onSelect: (idx: number) => void
}) {
  return (
    <div className="grid grid-cols-7 gap-1" role="tablist" aria-label="Select weekday">
      {days.map((d, i) => {
        const isSelected = i === selectedIdx
        const isToday = i === todayIdx
        const empty = d.value === 0
        return (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={isSelected}
            onClick={() => onSelect(i)}
            className={`rounded-md px-1.5 py-1.5 text-center transition-colors relative ${
              isSelected
                ? 'bg-gray-900 border border-gray-900 shadow-sm'
                : 'bg-white border border-gray-100 hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            {/* Small blue dot marks "today" when today is not the
                currently selected day — keeps "now" findable even
                while the manager is browsing other days. */}
            {isToday && !isSelected && (
              <span
                className="absolute top-1 right-1 h-1 w-1 rounded-full bg-blue-500"
                aria-hidden="true"
              />
            )}
            <p
              className={`text-[9px] font-semibold uppercase tracking-widest ${
                isSelected ? 'text-white/70' : 'text-gray-400'
              }`}
            >
              {d.label}
            </p>
            <p
              className={`mt-0.5 text-[12px] font-bold tabular-nums ${
                isSelected
                  ? 'text-white'
                  : empty
                    ? 'text-gray-300'
                    : 'text-gray-700'
              }`}
            >
              {empty ? '—' : d.value}
            </p>
          </button>
        )
      })}
    </div>
  )
}

// ================================================================
// SelectedDaySummary — compact band that sits at the bottom of the
// Today's Rhythm card and explains the selected day. Strictly bound
// to the Dashboard's product role: sales totals, scheduled coverage,
// and the first shift of the day. No category breakdowns, no payment
// mix, no diagnostic language. Empty states are honest.
// ================================================================
function SelectedDaySummary({
  sales,
  shifts,
  firstShift,
  dateIso,
}: {
  sales: { value: number; orders: number } | null
  shifts: { value: number; employees: number } | null
  firstShift: {
    employeeName: string
    role: string
    startTime: string
    endTime: string
  } | null
  dateIso: string | null
}) {
  if (!dateIso) return null
  const dateObj = new Date(dateIso)
  const fullDate = dateObj.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })

  const hasSales = sales !== null && sales.value > 0
  const hasShifts = shifts !== null && shifts.value > 0
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })

  return (
    <div className="px-5 py-4 border-t border-gray-100">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
          Selected day
        </p>
        <p className="text-[12px] font-semibold text-gray-900 tabular-nums">
          {fullDate}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Sales for the selected day */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            Sales
          </p>
          {hasSales ? (
            <>
              <p className="mt-1 text-base font-bold tabular-nums text-gray-900">
                ${sales!.value.toLocaleString('en-US', {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 0,
                })}
              </p>
              <p className="mt-0.5 text-[11px] text-gray-500 tabular-nums">
                {sales!.orders} completed order{sales!.orders === 1 ? '' : 's'}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-gray-400">No sales recorded</p>
          )}
        </div>

        {/* Scheduled coverage */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            Coverage
          </p>
          {hasShifts ? (
            <>
              <p className="mt-1 text-base font-bold tabular-nums text-gray-900">
                {shifts!.value} shift{shifts!.value === 1 ? '' : 's'}
              </p>
              <p className="mt-0.5 text-[11px] text-gray-500 tabular-nums">
                {shifts!.employees} scheduled employee
                {shifts!.employees === 1 ? '' : 's'}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-gray-400">No shifts scheduled</p>
          )}
        </div>

        {/* First scheduled shift of the day */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            Next
          </p>
          {firstShift ? (
            <>
              <p className="mt-1 text-[13px] font-semibold text-gray-900 truncate">
                {firstShift.employeeName}
              </p>
              <p className="mt-0.5 text-[11px] text-gray-500 tabular-nums">
                {fmtTime(firstShift.startTime)} – {fmtTime(firstShift.endTime)}
                {firstShift.role && (
                  <span className="text-gray-400"> · {firstShift.role}</span>
                )}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-gray-400">No upcoming shift</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ================================================================
// ReadinessDot — three-state status indicator for Opening Readiness.
// Calm — a small filled dot, ringed when limited, hollow when pending.
// ================================================================
function ReadinessDot({ status }: { status: 'ready' | 'limited' | 'pending' }) {
  const cls =
    status === 'ready'
      ? 'bg-emerald-500'
      : status === 'limited'
        ? 'bg-amber-400'
        : 'bg-gray-300'
  return (
    <span
      className={`mt-1.5 h-1.5 w-1.5 rounded-full flex-shrink-0 ${cls}`}
      aria-hidden="true"
    />
  )
}

// ================================================================
// MovementRow — one row in Recent Movement. Standardized 3-line
// vertical anatomy: source label (uppercase eyebrow) → main activity
// (semibold value) → time/context (muted). Renders an em dash when
// the corresponding stream has no data yet so the card stays calm
// rather than empty.
// ================================================================
function MovementRow({
  label,
  value,
  when,
  relative,
}: {
  label: string
  value: string | null
  when: string | null
  relative: boolean
}) {
  return (
    <li className="px-4 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
        {label}
      </p>
      <p
        className={`mt-0.5 text-sm tabular-nums truncate ${
          value ? 'font-semibold text-gray-900' : 'text-gray-400'
        }`}
      >
        {value ?? '—'}
      </p>
      {when && (
        <p className="mt-0.5 text-[11px] text-gray-500">
          {relative ? fmtRelative(when) : fmtDateOnly(when)}
        </p>
      )}
    </li>
  )
}
