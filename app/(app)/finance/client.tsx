'use client'

// ----------------------------------------------------------------
// Finance Client Component
//
// Page reads as four bands:
//
//   1. Header
//   2. Top summary — 3 disciplined metric cards (Revenue / Expenses /
//      Net activity), with Net activity emphasized
//   3. Operational drivers — Scheduled labor / Inventory spend /
//      External money. All three are clickable and open drawers.
//      External money is the bank-connection entry point in the
//      not-connected state.
//   4. Lower row — Recent activity (left) + Log expense (right),
//      visually balanced.
//
// All Finance logic + states preserved from prior passes:
//   - laborState (4 honest variants)
//   - bankState (3 variants)
//   - source-of-truth chip
//   - empty-state nudges
// ----------------------------------------------------------------

import { useEffect, useState, useActionState, useMemo } from 'react'
import { createExpense } from '@/app/actions/finance'
import { connectSandboxItem, createSandboxRentTransaction } from '@/app/actions/bank'
import { EXPENSE_CATEGORIES } from '@/lib/finance/constants'
import { ConnectBankButton } from '@/components/bank/connect-bank-button'

interface RecentExpense {
  id: string
  category: string
  amount: number
  expenseDate: string
  vendorName: string | null
  notes: string | null
  isInventoryRelated: boolean
  source: string
  locationId: string
  locationName: string | null
}

interface BankAccountSummary {
  id: string
  provider: string
  accountName: string
  accountMask: string | null
  institutionName: string | null
  lastSyncedAt: string | null
}

type LaborState = 'no_employees' | 'no_shifts' | 'missing_rates' | 'ok'
type BankState = 'not_connected' | 'connected_unsynced' | 'connected_synced'

interface LaborByArea { area: 'foh' | 'boh' | 'unassigned'; hours: number; cost: number; shiftCount: number }
interface LaborByRole { role: string; hours: number; cost: number; shiftCount: number; missingRate: boolean }
interface LaborByEmployee { name: string; hours: number; cost: number; shiftCount: number; hourlyRate: number | null }

interface Props {
  locations: { id: string; name: string }[]
  defaultLocationId: string | null
  plaidConfigured: boolean
  plaidSandbox: boolean
  isDev: boolean
  cards: {
    expenseTotal7d: number
    expenseCount7d: number
    revenue7d: number
    inventorySpend7d: number
    laborEstimate: number
    laborRatedShiftCount: number
    laborUnratedShiftCount: number
    totalShiftCount: number
    ratedEmployeeCount: number
    laborState: LaborState
  }
  laborBreakdown: {
    byArea: LaborByArea[]
    byRole: LaborByRole[]
    byEmployee: LaborByEmployee[]
  }
  inventoryBreakdown: {
    byCategory: { label: string; amount: number; count: number }[]
    byVendor: { label: string; amount: number; count: number }[]
  }
  bank: {
    accounts: BankAccountSummary[]
    externalSpend7d: number
    recognizedExternalSpend7d: number
    bankInventoryConfirmed7d: number
    externalSpendCount7d: number
    unresolvedCount7d: number
    externalByCategory: { label: string; rawLabel: string; amount: number; count: number }[]
    recentUnresolved: {
      id: string; description: string | null; merchantName: string | null
      amount: number; postedAt: string
    }[]
    inflow7d: number
    outflow7d: number
    txnCount7d: number
    state: BankState
  }
  recentExpenses: RecentExpense[]
}

type DrawerKind = 'labor' | 'inventory' | 'external' | null

export default function FinanceClient({
  locations: _locations,
  defaultLocationId,
  plaidConfigured,
  plaidSandbox,
  isDev,
  cards,
  laborBreakdown,
  inventoryBreakdown,
  bank,
  recentExpenses,
}: Props) {
  const [state, action, pending] = useActionState(createExpense, null)
  const [locationId] = useState(defaultLocationId ?? '')
  const [drawer, setDrawer] = useState<DrawerKind>(null)
  const [activityPage, setActivityPage] = useState(0)
  const ACTIVITY_PAGE_SIZE = 6

  // ----------------------------------------------------------------
  // Spend model (observer phase).
  //
  // The four signals on the page (Labor / Inventory / External /
  // Net) are sub-parts of one Spend total, not separate buckets:
  //
  //   Labor     = scheduled hours × rate (projection only — bank
  //               payroll detection is deferred to the action phase).
  //   Inventory = max(manual logs, bank food/drink-PFC outflows).
  //               max() de-dups: a bank row that confirms a manual
  //               log doesn't add on top of it.
  //   External  = max(manual non-inventory expenses, bank non-
  //               inventory PFC outflows). Captures rent, utilities,
  //               fees, transfers — the system-blind layer.
  //   Spend     = Labor + Inventory + External.
  //   Net       = Revenue − Spend.
  //
  // Unresolved bank outflows (no PFC) stay surfaced in the External
  // drawer for triage but are NOT in Net — we don't claim spend on
  // rows we can't classify.
  // ----------------------------------------------------------------
  const laborSpend = cards.laborEstimate
  const manualNonInventorySpend = Math.max(0, cards.expenseTotal7d - cards.inventorySpend7d)
  const inventorySpend = Math.max(cards.inventorySpend7d, bank.bankInventoryConfirmed7d)
  const externalSpend = Math.max(manualNonInventorySpend, bank.recognizedExternalSpend7d)
  const totalSpend7d = laborSpend + inventorySpend + externalSpend
  const netActivity = cards.revenue7d - totalSpend7d
  const netPositive = netActivity >= 0
  const hasAnyActivity = cards.revenue7d > 0 || totalSpend7d > 0

  // Convenience for driver cards — share-of-spend for each bucket,
  // rendered as a small "· N% of spend" suffix so the cards read as
  // sub-parts of one total instead of four parallel expense buckets.
  const pctOfSpend = (n: number) =>
    totalSpend7d > 0 ? Math.round((n / totalSpend7d) * 100) : 0

  // Recent activity is now a single unfiltered log — the Inventory
  // / Other filter pills were removed in this pass to keep the card
  // a clean recent-activity view.
  const activityPageCount = Math.max(1, Math.ceil(recentExpenses.length / ACTIVITY_PAGE_SIZE))
  const safeActivityPage = Math.min(activityPage, activityPageCount - 1)
  const pagedExpenses = recentExpenses.slice(
    safeActivityPage * ACTIVITY_PAGE_SIZE,
    safeActivityPage * ACTIVITY_PAGE_SIZE + ACTIVITY_PAGE_SIZE
  )

  const recentInventoryExpenses = useMemo(
    () => recentExpenses.filter((e) => e.isInventoryRelated).slice(0, 8),
    [recentExpenses]
  )

  return (
    <div className="max-w-[1400px]">

      {/* ================================================================ */}
      {/* 1. HEADER                                                        */}
      {/* ================================================================ */}
      <div className="mb-7 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">Finance</h1>
          <p className="mt-1.5 text-sm text-gray-500">
            Money in, money out, and where pressure is building.
          </p>
        </div>
        <DataSourceChip state={bank.state} />
      </div>

      {/* ================================================================ */}
      {/* 2. TOP SUMMARY — single unified card with internal dividers      */}
      {/* ================================================================ */}
      <section className="mb-7">
        <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="grid grid-cols-1 sm:grid-cols-3">
            <SummaryCell
              label="Revenue"
              dotClass="bg-green-500"
              value={fmt(cards.revenue7d)}
              hint="From recorded sales"
              empty={cards.revenue7d === 0}
            />
            <SummaryCell
              label="Spend"
              dotClass="bg-red-400"
              value={fmt(totalSpend7d)}
              hint="Labor · inventory · external"
              empty={totalSpend7d === 0}
            />
            <NetActivityCell
              value={netActivity}
              hasAnyActivity={hasAnyActivity}
              netPositive={netPositive}
              revenue={cards.revenue7d}
              spend={totalSpend7d}
              recognizedExternalSpend={bank.recognizedExternalSpend7d}
            />
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* 3. OPERATIONAL DRIVERS — three clickable cards                   */}
      {/* ================================================================ */}
      <section className="mb-7">
        <div className="mb-4 flex items-center gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-900">
            What&apos;s driving spend
          </p>
          <span className="flex-1 h-px bg-gray-200/70" />
        </div>
        <div className="grid gap-4 lg:grid-cols-3 sm:grid-cols-2">
          <LaborDriverCard
            cards={cards}
            laborSpend={laborSpend}
            sharePct={pctOfSpend(laborSpend)}
            onOpen={() => setDrawer('labor')}
          />
          <InventoryDriverCard
            value={inventorySpend}
            sharePct={pctOfSpend(inventorySpend)}
            hasManual={cards.inventorySpend7d > 0}
            hasBankConfirm={bank.bankInventoryConfirmed7d > 0}
            onOpen={() => setDrawer('inventory')}
          />
          <ExternalMoneyCard
            bank={bank}
            externalSpend={externalSpend}
            sharePct={pctOfSpend(externalSpend)}
            plaidConfigured={plaidConfigured}
            onOpen={() => setDrawer('external')}
          />
        </div>
      </section>

      {/* ================================================================ */}
      {/* 4. LOWER ROW — Recent activity + Log expense, balanced           */}
      {/* ================================================================ */}
      <section>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] items-start">

          {/* LEFT: Recent activity */}
          <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col min-h-[500px]">
            {/* Header */}
            <div className="border-b border-gray-100 px-6 py-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">Activity</p>
              <h2 className="text-base font-semibold tracking-tight text-gray-900 mt-1">Recent activity</h2>
            </div>

            {/* Body — fixed-height activity log, paginated 6 per page so the
                card never stretches and rows always slot in cleanly. */}
            <div className="flex-1 flex flex-col">
              {recentExpenses.length === 0 ? (
                <EmptyWorkspacePrompt
                  title="No expenses recorded yet"
                  body="Use the Log an expense form on the right to record your first expense. Recent activity will appear here."
                />
              ) : (
                <>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-left">
                        <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em]">Date</th>
                        <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em]">Category</th>
                        <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em]">Vendor</th>
                        <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em] text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {pagedExpenses.map((exp) => (
                        <tr key={exp.id} className="hover:bg-gray-50/70 transition-colors">
                          <td className="px-6 py-3.5 text-gray-700 whitespace-nowrap text-[13px]">
                            {new Date(exp.expenseDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </td>
                          <td className={`px-6 py-3.5 truncate max-w-[180px] text-[13px] font-medium ${categoryColorClass(exp.category)}`}>
                            {exp.category}
                          </td>
                          <td className="px-6 py-3.5 text-gray-700 truncate max-w-[220px] text-[13px]">
                            {exp.vendorName || '—'}
                          </td>
                          <td className="px-6 py-3.5 text-gray-900 font-mono tabular-nums font-medium text-right text-[13px]">${exp.amount.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Pager — pinned at the bottom so the card height is stable
                      regardless of how full the current page is. */}
                  <div className="mt-auto border-t border-gray-100 px-6 py-3 flex items-center justify-between">
                    <p className="text-[11px] text-gray-500">
                      {recentExpenses.length === 0
                        ? '0 entries'
                        : `${safeActivityPage * ACTIVITY_PAGE_SIZE + 1}–${Math.min(
                            (safeActivityPage + 1) * ACTIVITY_PAGE_SIZE,
                            recentExpenses.length
                          )} of ${recentExpenses.length}`}
                    </p>
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setActivityPage((p) => Math.max(0, p - 1))}
                        disabled={safeActivityPage === 0}
                        className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        ← Prev
                      </button>
                      <span className="text-[11px] text-gray-400 px-1.5">
                        {safeActivityPage + 1} / {activityPageCount}
                      </span>
                      <button
                        type="button"
                        onClick={() => setActivityPage((p) => Math.min(activityPageCount - 1, p + 1))}
                        disabled={safeActivityPage >= activityPageCount - 1}
                        className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        Next →
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* RIGHT: Log expense */}
          <QuickExpenseCard
            action={action}
            pending={pending}
            error={state?.error}
            locationId={locationId}
          />
        </div>
      </section>

      {/* ================================================================ */}
      {/* DRAWERS                                                          */}
      {/* ================================================================ */}
      <Drawer
        open={drawer === 'labor'}
        onClose={() => setDrawer(null)}
        title="Scheduled labor"
        subtitle="This week · estimated from schedule + hourly rates"
      >
        <LaborDrawerContent cards={cards} breakdown={laborBreakdown} />
      </Drawer>

      <Drawer
        open={drawer === 'inventory'}
        onClose={() => setDrawer(null)}
        title="Inventory spend"
        subtitle="Last 7 days · expenses flagged as inventory-related"
      >
        <InventoryDrawerContent
          total={cards.inventorySpend7d}
          breakdown={inventoryBreakdown}
          recentItems={recentInventoryExpenses}
        />
      </Drawer>

      <Drawer
        open={drawer === 'external'}
        onClose={() => setDrawer(null)}
        title="External money"
        subtitle={
          bank.state === 'not_connected'
            ? 'No bank connected yet'
            : 'Last 7 days · captured from connected bank'
        }
      >
        <ExternalDrawerContent
          bank={bank}
          plaidConfigured={plaidConfigured}
          plaidSandbox={plaidSandbox}
          isDev={isDev}
        />
      </Drawer>
    </div>
  )
}

// ================================================================
// Top summary
// ================================================================

// Inside-the-unified-card cell. Numbers are black; only the
// identity dot carries color.
function SummaryCell({ label, dotClass, value, hint, empty }: {
  label: string; dotClass: string; value: string; hint: string; empty: boolean
}) {
  return (
    <div className="p-6">
      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${dotClass}`} />
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">{label}</p>
        </div>
        <p className="text-[10px] text-gray-400">Last 7 days</p>
      </div>
      <p className={`mt-5 text-[30px] leading-none font-semibold tracking-tight tabular-nums ${empty ? 'text-gray-300' : 'text-gray-900'}`}>
        {value}
      </p>
      <p className="mt-3 text-xs text-gray-500">{hint}</p>
    </div>
  )
}

// Net activity cell — only metric whose value is colored.
// Green when positive, red when negative.
//
// `spend` here is the full deduction: internal logged expenses +
// recognized external spend (bank outflows Plaid categorized).
// Unresolved bank activity is intentionally excluded — it's not
// recognized yet, so claiming it as "spend" would mislead.
function NetActivityCell({ value, hasAnyActivity, netPositive, revenue, spend, recognizedExternalSpend }: {
  value: number; hasAnyActivity: boolean; netPositive: boolean
  revenue: number; spend: number; recognizedExternalSpend: number
}) {
  const valueColor = !hasAnyActivity ? 'text-gray-300' : (netPositive ? 'text-green-700' : 'text-red-600')
  const dotClass = !hasAnyActivity ? 'bg-gray-300' : (netPositive ? 'bg-green-500' : 'bg-red-500')
  const hasRecognizedExternal = recognizedExternalSpend > 0
  const hint = (() => {
    if (revenue > 0 && spend > 0) {
      const pct = Math.round((spend / revenue) * 100)
      const base = spend > revenue
        ? `Spending exceeds revenue · ${pct}% ratio`
        : `Spending is ${pct}% of revenue`
      return hasRecognizedExternal ? `${base} · incl. external` : base
    }
    if (revenue > 0) return 'No spend recorded yet'
    if (spend > 0) return 'No sales recorded yet'
    return 'Log an expense or connect a bank to begin'
  })()

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${dotClass}`} />
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">Net activity</p>
        </div>
        {hasAnyActivity && (
          <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
            netPositive ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}>
            {netPositive ? 'Positive' : 'Negative'}
          </span>
        )}
      </div>
      <p className="text-[10px] text-gray-400 mt-1 ml-4">Last 7 days</p>
      <p className={`mt-3 text-[36px] leading-none font-semibold tracking-tight tabular-nums ${valueColor}`}>
        {hasAnyActivity ? `${netPositive ? '' : '−'}${fmt(Math.abs(value))}` : '$0.00'}
      </p>
      <p className="mt-3 text-xs text-gray-500">{hint}</p>
    </div>
  )
}

// ================================================================
// Driver cards (middle row)
// ================================================================

function LaborDriverCard({ cards, laborSpend, sharePct, onOpen }: {
  cards: {
    laborEstimate: number
    laborRatedShiftCount: number
    laborUnratedShiftCount: number
    totalShiftCount: number
    laborState: LaborState
  }
  laborSpend: number
  sharePct: number
  onOpen: () => void
}) {
  const accent = 'bg-purple-500'
  // Labor stays "projected" in the observer phase. Tag is appended
  // to the hint so the manager knows this isn't a confirmed payroll
  // outflow yet — once clock-in/out lands, the tag and the
  // schedule-derived value both swap to actual paid hours.
  const projectedTag = ' · projected'
  const shareTag = sharePct > 0 ? ` · ${sharePct}% of spend` : ''

  switch (cards.laborState) {
    case 'ok': {
      const baseHint =
        cards.laborUnratedShiftCount > 0
          ? `${cards.laborRatedShiftCount} of ${cards.totalShiftCount} shifts costed`
          : `${cards.laborRatedShiftCount} shift${cards.laborRatedShiftCount !== 1 ? 's' : ''} costed`
      return (
        <ClickableDriverCard
          accent={accent}
          label="Scheduled labor"
          period="This week"
          value={fmt(laborSpend)}
          valueMuted={false}
          hint={`${baseHint}${shareTag}${projectedTag}`}
          onOpen={onOpen}
        />
      )
    }
    case 'no_shifts':
      return (
        <ClickableDriverCard
          accent={accent}
          label="Scheduled labor"
          period="This week"
          value="$0.00"
          valueMuted={true}
          hint="No shifts scheduled"
          onOpen={onOpen}
        />
      )
    case 'no_employees':
      return (
        <ClickableUnavailableCard
          accent={accent}
          label="Scheduled labor"
          period="This week"
          reason="Add hourly rates to staff"
          onOpen={onOpen}
        />
      )
    case 'missing_rates':
      return (
        <ClickableUnavailableCard
          accent={accent}
          label="Scheduled labor"
          period="This week"
          reason={`${cards.totalShiftCount} shift${cards.totalShiftCount !== 1 ? 's' : ''} · employees missing rates`}
          onOpen={onOpen}
        />
      )
  }
}

function InventoryDriverCard({ value, sharePct, hasManual, hasBankConfirm, onOpen }: {
  value: number
  sharePct: number
  hasManual: boolean
  hasBankConfirm: boolean
  onOpen: () => void
}) {
  // Hint surfaces the source mix when both manual logs and bank
  // confirmations contribute. Keeps the card honest about whether
  // the number is projected, confirmed, or both.
  const baseHint = (() => {
    if (!hasManual && !hasBankConfirm) return 'Mark expenses as inventory-related'
    if (hasManual && hasBankConfirm)   return 'Logged · bank-confirmed'
    if (hasBankConfirm)                return 'Bank-confirmed'
    return 'Inventory-related expenses'
  })()
  const shareTag = sharePct > 0 ? ` · ${sharePct}% of spend` : ''
  return (
    <ClickableDriverCard
      accent="bg-amber-500"
      label="Inventory spend"
      period="Last 7 days"
      value={fmt(value)}
      valueMuted={value === 0}
      hint={`${baseHint}${shareTag}`}
      onOpen={onOpen}
    />
  )
}

// External money card — third middle-row card. Headline value is
// the de-duped External bucket from the Spend model: max(manual
// non-inventory expenses, bank non-inventory PFC outflows). The
// drawer still breaks out bank-specific detail (categories,
// unresolved rows, accounts) for managers who want to dig in.
function ExternalMoneyCard({ bank, externalSpend, sharePct, plaidConfigured, onOpen }: {
  bank: {
    externalSpend7d: number
    externalSpendCount7d: number
    unresolvedCount7d: number
    state: BankState
  }
  externalSpend: number
  sharePct: number
  plaidConfigured: boolean
  onOpen: () => void
}) {
  if (bank.state === 'not_connected') {
    return (
      <div className="rounded-xl border border-gray-200/80 bg-gradient-to-br from-white to-teal-50/30 p-6 flex flex-col shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-teal-500" />
            <p className="text-xs font-semibold text-gray-900">External money</p>
          </div>
          <span className="text-[10px] text-gray-400">Optional</span>
        </div>
        <p className="text-[26px] leading-none font-semibold tracking-tight text-gray-300 tabular-nums">—</p>
        <p className="mt-3 text-xs text-gray-500 leading-relaxed mb-4">
          Connect a bank to surface outside-the-system spending — rent, utilities, subscriptions,
          and unresolved activity Finance can&apos;t see otherwise.
        </p>
        <div className="mt-auto" onClick={(e) => e.stopPropagation()}>
          <ConnectBankButton configured={plaidConfigured} />
        </div>
      </div>
    )
  }

  // Identity dot is always teal — that signals "External money".
  // The state pill (Live / Awaiting sync) shows operational state
  // separately so the two readings don't fight each other.
  const identityDot = 'bg-teal-500'
  const stateLabel = bank.state === 'connected_synced' ? 'Live' : 'Awaiting sync'
  const stateLabelTone = bank.state === 'connected_synced' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
  const stateDot = bank.state === 'connected_synced' ? 'bg-green-500' : 'bg-amber-500'

  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left group rounded-xl border border-gray-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:border-gray-300 hover:shadow-[0_8px_20px_-8px_rgba(15,23,42,0.12),0_2px_4px_rgba(15,23,42,0.04)] transition-all"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${identityDot}`} />
          <p className="text-xs font-semibold text-gray-900">External money</p>
        </div>
        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${stateLabelTone}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${stateDot}`} />
          {stateLabel}
        </span>
      </div>
      {bank.state === 'connected_unsynced' ? (
        <>
          <p className="text-[26px] leading-none font-semibold tracking-tight text-gray-400 tabular-nums">—</p>
          <div className="mt-3 flex items-end justify-between gap-2">
            <p className="text-xs text-gray-500 leading-relaxed">Bank linked · awaiting first sync</p>
            <span className="text-[10px] font-medium text-gray-400 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all flex-shrink-0">
              View →
            </span>
          </div>
        </>
      ) : (
        <>
          <p className="text-[10px] uppercase tracking-[0.14em] text-gray-400 font-medium mb-1">External spend · 7 days</p>
          <p className={`text-[26px] leading-none font-semibold tracking-tight tabular-nums ${externalSpend === 0 ? 'text-gray-400' : 'text-gray-900'}`}>
            {fmt(externalSpend)}
          </p>
          <div className="mt-3 flex items-end justify-between gap-2">
            <p className="text-xs text-gray-500 leading-relaxed">
              {(() => {
                const sharePart = sharePct > 0 ? ` · ${sharePct}% of spend` : ''
                if (bank.externalSpendCount7d === 0 && externalSpend === 0) {
                  return 'No external spend detected'
                }
                const txnPart = bank.externalSpendCount7d === 0
                  ? null
                  : bank.unresolvedCount7d > 0
                    ? `${bank.externalSpendCount7d} bank txn${bank.externalSpendCount7d !== 1 ? 's' : ''} · ${bank.unresolvedCount7d} unresolved`
                    : `${bank.externalSpendCount7d} bank txn${bank.externalSpendCount7d !== 1 ? 's' : ''} · all categorized`
                return txnPart ? `${txnPart}${sharePart}` : `Manual entries${sharePart}`
              })()}
            </p>
            <span className="text-[10px] font-medium text-gray-400 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all flex-shrink-0">
              View →
            </span>
          </div>
        </>
      )}
    </button>
  )
}

function ClickableDriverCard({
  accent, label, period, value, valueMuted, hint, onOpen,
}: {
  accent: string; label: string; period: string; value: string
  valueMuted: boolean; hint: string; onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left group rounded-xl border border-gray-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:border-gray-300 hover:shadow-[0_8px_20px_-8px_rgba(15,23,42,0.12),0_2px_4px_rgba(15,23,42,0.04)] transition-all"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${accent}`} />
          <p className="text-xs font-semibold text-gray-900">{label}</p>
        </div>
        <span className="text-[10px] text-gray-400">{period}</span>
      </div>
      <p className={`text-[26px] leading-none font-semibold tracking-tight tabular-nums ${valueMuted ? 'text-gray-400' : 'text-gray-900'}`}>
        {value}
      </p>
      <div className="mt-3 flex items-end justify-between gap-2">
        <p className="text-xs text-gray-500 leading-relaxed">{hint}</p>
        <span className="text-[10px] font-medium text-gray-400 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all flex-shrink-0">
          View →
        </span>
      </div>
    </button>
  )
}

function ClickableUnavailableCard({
  accent, label, period, reason, onOpen,
}: {
  accent: string; label: string; period: string; reason: string; onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left group rounded-xl border border-gray-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:border-gray-300 hover:shadow-[0_8px_20px_-8px_rgba(15,23,42,0.12),0_2px_4px_rgba(15,23,42,0.04)] transition-all"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${accent} opacity-50`} />
          <p className="text-xs font-semibold text-gray-900">{label}</p>
        </div>
        <span className="text-[10px] text-gray-400">{period}</span>
      </div>
      <p className="text-[26px] leading-none font-semibold tracking-tight text-gray-300 tabular-nums">—</p>
      <div className="mt-3 flex items-end justify-between gap-2">
        <p className="text-xs text-gray-500 leading-relaxed">{reason}</p>
        <span className="text-[10px] font-medium text-gray-400 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all flex-shrink-0">
          View →
        </span>
      </div>
    </button>
  )
}

// ================================================================
// Drawer — right-side slide-over
// ================================================================

function Drawer({ open, onClose, title, subtitle, children }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string; children: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 bg-gray-900/30 backdrop-blur-[1px] z-40 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden={!open}
      />
      <aside
        className={`fixed top-0 right-0 z-50 h-full w-full sm:max-w-md bg-white shadow-2xl border-l border-gray-200 flex flex-col transform transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        aria-hidden={!open}
      >
        <div className="border-b border-gray-100 px-6 py-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {children}
        </div>
      </aside>
    </>
  )
}

// ----------------------------------------------------------------
// Labor drawer — interpretive: stats strip + breakdowns + caveat
// ----------------------------------------------------------------
function LaborDrawerContent({ cards, breakdown }: {
  cards: { laborEstimate: number; laborState: LaborState; totalShiftCount: number; laborRatedShiftCount: number; laborUnratedShiftCount: number }
  breakdown: { byArea: LaborByArea[]; byRole: LaborByRole[]; byEmployee: LaborByEmployee[] }
}) {
  const totalHours = breakdown.byEmployee.reduce((s, e) => s + e.hours, 0)
  const employeeCount = breakdown.byEmployee.length
  const showByArea = breakdown.byArea.some((a) => a.area === 'foh' || a.area === 'boh')

  // Insight: which area / role drives the most labor cost?
  const topArea = breakdown.byArea[0]
  const topAreaShare = cards.laborEstimate > 0 && topArea
    ? Math.round((topArea.cost / cards.laborEstimate) * 100)
    : 0

  return (
    <div className="space-y-6">
      {/* 3-stat strip — interpretive top line */}
      <div className="grid grid-cols-3 rounded-xl border border-gray-200 divide-x divide-gray-100 bg-white">
        <DrawerStat label="Cost" value={fmt(cards.laborEstimate)} muted={cards.laborEstimate === 0} />
        <DrawerStat label="Hours" value={fmtHours(totalHours)} muted={totalHours === 0} />
        <DrawerStat label="Employees" value={`${employeeCount}`} muted={employeeCount === 0} />
      </div>

      {/* Honesty caveat */}
      <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5">
        <p className="text-[11px] text-amber-800 leading-relaxed">
          <strong>Estimated, not paid.</strong> Computed from this week&apos;s schedule × hourly rate.
          {cards.laborUnratedShiftCount > 0 && ` ${cards.laborUnratedShiftCount} shift${cards.laborUnratedShiftCount !== 1 ? 's' : ''} excluded — employees missing hourly rates.`}
        </p>
      </div>

      {/* Insight when there's data */}
      {showByArea && topArea && topAreaShare >= 50 && (
        <InsightLine
          accent="purple"
          text={`${areaLabel(topArea.area)} is ${topAreaShare}% of scheduled labor cost this week.`}
        />
      )}

      {/* By house */}
      {showByArea && (
        <DrawerSection title="By house">
          <div className="space-y-2">
            {breakdown.byArea.map((row) => (
              <BreakdownRow
                key={row.area}
                primary={areaLabel(row.area)}
                secondary={`${row.shiftCount} shift${row.shiftCount !== 1 ? 's' : ''} · ${fmtHours(row.hours)}`}
                value={fmt(row.cost)}
              />
            ))}
          </div>
        </DrawerSection>
      )}

      {/* By role */}
      <DrawerSection title="By role">
        {breakdown.byRole.length === 0 ? (
          <p className="text-xs text-gray-400 italic">No roles scheduled this week.</p>
        ) : (
          <div className="space-y-2">
            {breakdown.byRole.map((row) => (
              <BreakdownRow
                key={row.role}
                primary={row.role}
                secondary={`${row.shiftCount} shift${row.shiftCount !== 1 ? 's' : ''} · ${fmtHours(row.hours)}${row.missingRate ? ' · some rates missing' : ''}`}
                value={fmt(row.cost)}
                muted={row.cost === 0}
              />
            ))}
          </div>
        )}
      </DrawerSection>

      {/* By employee */}
      <DrawerSection title="By employee">
        {breakdown.byEmployee.length === 0 ? (
          <p className="text-xs text-gray-400 italic">No employees on the schedule this week.</p>
        ) : (
          <div className="space-y-2">
            {breakdown.byEmployee.map((row) => (
              <BreakdownRow
                key={row.name}
                primary={row.name}
                secondary={
                  row.hourlyRate
                    ? `${fmtHours(row.hours)} · $${row.hourlyRate.toFixed(2)}/hr · ${row.shiftCount} shift${row.shiftCount !== 1 ? 's' : ''}`
                    : `${fmtHours(row.hours)} · no rate · ${row.shiftCount} shift${row.shiftCount !== 1 ? 's' : ''}`
                }
                value={row.hourlyRate ? fmt(row.cost) : 'Unrated'}
                muted={!row.hourlyRate}
              />
            ))}
          </div>
        )}
      </DrawerSection>
    </div>
  )
}

function areaLabel(area: 'foh' | 'boh' | 'unassigned'): string {
  switch (area) {
    case 'foh': return 'Front of House'
    case 'boh': return 'Back of House'
    case 'unassigned': return 'Unassigned'
  }
}

function fmtHours(h: number): string {
  return `${h.toFixed(h % 1 === 0 ? 0 : 1)}h`
}

// ----------------------------------------------------------------
// Inventory drawer — interpretive: stats strip + concentration +
// vendor-first + category-second + recent (supporting only)
// ----------------------------------------------------------------
function InventoryDrawerContent({ total, breakdown, recentItems }: {
  total: number
  breakdown: { byCategory: { label: string; amount: number; count: number }[]; byVendor: { label: string; amount: number; count: number }[] }
  recentItems: RecentExpense[]
}) {
  const entryCount = breakdown.byCategory.reduce((s, c) => s + c.count, 0)
  // Vendor count excludes the "—" placeholder bucket
  const vendorCount = breakdown.byVendor.filter((v) => v.label !== '—').length
  const noData = total === 0 && recentItems.length === 0

  if (noData) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-6 text-center">
        <p className="text-sm font-semibold text-gray-700">No inventory spend yet</p>
        <p className="mx-auto mt-1.5 max-w-xs text-xs text-gray-500 leading-relaxed">
          Mark expenses as inventory-related when logging them — food, beverage, or supplies. They&apos;ll
          appear here grouped by vendor and category.
        </p>
      </div>
    )
  }

  // Concentration insight: top vendor share
  const topVendor = breakdown.byVendor.find((v) => v.label !== '—')
  const topVendorShare = total > 0 && topVendor ? Math.round((topVendor.amount / total) * 100) : 0
  const topCategory = breakdown.byCategory[0]
  const topCategoryShare = total > 0 && topCategory ? Math.round((topCategory.amount / total) * 100) : 0

  return (
    <div className="space-y-6">
      {/* Stats strip */}
      <div className="grid grid-cols-3 rounded-xl border border-gray-200 divide-x divide-gray-100 bg-white">
        <DrawerStat label="Spend" value={fmt(total)} muted={total === 0} />
        <DrawerStat label="Entries" value={`${entryCount}`} muted={entryCount === 0} />
        <DrawerStat label="Vendors" value={`${vendorCount}`} muted={vendorCount === 0} />
      </div>

      {/* Concentration insight */}
      {topVendor && topVendorShare >= 40 && (
        <InsightLine
          accent="amber"
          text={`${topVendor.label} is ${topVendorShare}% of inventory spend.`}
        />
      )}
      {!topVendor && topCategory && topCategoryShare >= 50 && (
        <InsightLine
          accent="amber"
          text={`${topCategory.label} is ${topCategoryShare}% of inventory spend.`}
        />
      )}

      {/* By vendor — primary */}
      <DrawerSection title="By vendor">
        {breakdown.byVendor.length === 0 ? (
          <p className="text-xs text-gray-400 italic">No vendor data.</p>
        ) : (
          <div className="space-y-2">
            {breakdown.byVendor.map((row) => (
              <BreakdownRow
                key={row.label}
                primary={row.label === '—' ? 'Unspecified vendor' : row.label}
                secondary={`${row.count} ${row.count === 1 ? 'expense' : 'expenses'}`}
                value={fmt(row.amount)}
                muted={row.label === '—'}
              />
            ))}
          </div>
        )}
      </DrawerSection>

      {/* By category — secondary */}
      <DrawerSection title="By category">
        {breakdown.byCategory.length === 0 ? (
          <p className="text-xs text-gray-400 italic">No category data.</p>
        ) : (
          <div className="space-y-2">
            {breakdown.byCategory.map((row) => (
              <BreakdownRow
                key={row.label}
                primary={row.label}
                secondary={`${row.count} ${row.count === 1 ? 'expense' : 'expenses'}`}
                value={fmt(row.amount)}
              />
            ))}
          </div>
        )}
      </DrawerSection>

      {/* Recent — supporting */}
      {recentItems.length > 0 && (
        <DrawerSection title="Recent entries">
          <ul className="divide-y divide-gray-100">
            {recentItems.map((item) => (
              <li key={item.id} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-gray-900 truncate">
                    {item.vendorName || item.category}
                  </p>
                  <p className="text-[11px] text-gray-500 truncate mt-0.5">
                    {new Date(item.expenseDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    {' · '}{item.category}
                  </p>
                </div>
                <p className="text-xs font-semibold text-gray-900 font-mono tabular-nums flex-shrink-0">
                  {fmt(item.amount)}
                </p>
              </li>
            ))}
          </ul>
        </DrawerSection>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// External money drawer — explanation/connect when not linked,
// summary + accounts + caveat when linked.
// ----------------------------------------------------------------
function ExternalDrawerContent({ bank, plaidConfigured, plaidSandbox, isDev }: {
  bank: {
    accounts: BankAccountSummary[]
    externalSpend7d: number
    recognizedExternalSpend7d: number
    bankInventoryConfirmed7d: number
    externalSpendCount7d: number
    unresolvedCount7d: number
    externalByCategory: { label: string; rawLabel: string; amount: number; count: number }[]
    recentUnresolved: {
      id: string; description: string | null; merchantName: string | null
      amount: number; postedAt: string
    }[]
    inflow7d: number
    outflow7d: number
    txnCount7d: number
    state: BankState
  }
  plaidConfigured: boolean
  plaidSandbox: boolean
  isDev: boolean
}) {
  if (bank.state === 'not_connected') {
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-5">
          <p className="text-sm font-semibold text-gray-900">What a bank connection adds</p>
          <p className="mt-1.5 text-[12px] text-gray-500 leading-relaxed">
            Revenue stays system-defined — sales come from inside the app. Bank sync is for
            outside-the-system spending.
          </p>
          <ul className="mt-3 space-y-2.5 text-[12px] text-gray-600 leading-relaxed">
            <PreviewBullet>Surface rent, utilities, subscriptions, and other business expenses paid through the bank.</PreviewBullet>
            <PreviewBullet>Catch unresolved activity Finance can&apos;t see otherwise — transfers, fees, uncategorized outflows.</PreviewBullet>
            <PreviewBullet>Capture rows for future matching against your recorded expenses.</PreviewBullet>
          </ul>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Connect</p>
          <p className="text-xs text-gray-600 leading-relaxed mb-4">
            Bank credentials stay server-side and owner-only. You can disconnect anytime.
          </p>
          <ConnectBankButton configured={plaidConfigured} />
        </div>

        <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2.5">
          <p className="text-[11px] text-gray-600 leading-relaxed">
            <strong>What you won&apos;t see here.</strong> A raw bank-feed view, or current account
            balance as a headline. Finance is the interpretation layer — bank inflow is never
            presented as revenue.
          </p>
        </div>
      </div>
    )
  }

  const lastSync = bank.accounts.reduce<string | null>((latest, a) => {
    if (!a.lastSyncedAt) return latest
    if (!latest || new Date(a.lastSyncedAt) > new Date(latest)) return a.lastSyncedAt
    return latest
  }, null)

  // Concentration insights — only fire when there's enough signal.
  const topCategory = bank.externalByCategory[0]
  const topCategoryShare = bank.externalSpend7d > 0 && topCategory
    ? Math.round((topCategory.amount / bank.externalSpend7d) * 100)
    : 0
  const unresolvedShare = bank.externalSpendCount7d > 0
    ? Math.round((bank.unresolvedCount7d / bank.externalSpendCount7d) * 100)
    : 0

  return (
    <div className="space-y-6">
      {/* Stats strip — outside-the-system spend, not inflow/outflow */}
      <div className="grid grid-cols-3 rounded-xl border border-gray-200 divide-x divide-gray-100 bg-white">
        <DrawerStat
          label="External spend"
          value={fmt(bank.externalSpend7d)}
          muted={bank.externalSpend7d === 0}
        />
        <DrawerStat
          label="Transactions"
          value={`${bank.externalSpendCount7d}`}
          muted={bank.externalSpendCount7d === 0}
        />
        <DrawerStat
          label="Unresolved"
          value={`${bank.unresolvedCount7d}`}
          muted={bank.unresolvedCount7d === 0}
        />
      </div>

      {/* Single insight line, prioritized:
          - awaiting sync state takes precedence
          - then a high concentration warning
          - then a high unresolved share warning */}
      {bank.state === 'connected_unsynced' ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5">
          <p className="text-[11px] text-amber-800 leading-relaxed">
            <strong>Awaiting first sync.</strong> Bank linked but no transactions have arrived yet.
          </p>
        </div>
      ) : topCategory && topCategoryShare >= 40 ? (
        <InsightLine
          accent="teal"
          text={`${topCategory.label} is ${topCategoryShare}% of external spend.`}
        />
      ) : unresolvedShare >= 30 && bank.unresolvedCount7d > 0 ? (
        <InsightLine
          accent="amber"
          text={`${unresolvedShare}% of bank-detected spend is uncategorized — likely worth a look.`}
        />
      ) : null}

      {/* Likely external expenses — categorized outflows */}
      <DrawerSection title="Likely external expenses">
        {bank.externalByCategory.length === 0 ? (
          <p className="text-xs text-gray-400 italic">No categorized outflows yet.</p>
        ) : (
          <div className="space-y-2">
            {bank.externalByCategory.map((row) => (
              <BreakdownRow
                key={row.rawLabel}
                primary={row.label}
                secondary={`${row.count} ${row.count === 1 ? 'transaction' : 'transactions'}`}
                value={fmt(row.amount)}
              />
            ))}
          </div>
        )}
      </DrawerSection>

      {/* Unresolved activity — outflows the bank could not classify */}
      <DrawerSection title="Unresolved activity">
        {bank.recentUnresolved.length === 0 ? (
          <p className="text-xs text-gray-500 italic">
            All recent bank-detected spend is categorized.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-gray-500 leading-relaxed mb-2.5">
              Bank-detected outflows the system cannot confidently match yet.
            </p>
            <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white overflow-hidden">
              {bank.recentUnresolved.map((row) => (
                <li key={row.id} className="px-4 py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-900 truncate">
                      {row.merchantName || row.description || 'Untitled outflow'}
                    </p>
                    <p className="text-[11px] text-gray-500 truncate mt-0.5">
                      {new Date(row.postedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {' · '}No category
                    </p>
                  </div>
                  <p className="text-xs font-semibold text-gray-900 font-mono tabular-nums flex-shrink-0">
                    {fmt(row.amount)}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </DrawerSection>

      {/* Connected accounts — supporting context */}
      <DrawerSection title="Connected accounts">
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white overflow-hidden">
          {bank.accounts.map((a) => (
            <li key={a.id} className="px-4 py-3">
              <p className="text-xs font-semibold text-gray-900 truncate">
                {a.institutionName ?? a.provider} · {a.accountName}
                {a.accountMask && <span className="text-gray-400 font-normal ml-1">••{a.accountMask}</span>}
              </p>
              <p className="text-[11px] text-gray-500 mt-0.5">
                {a.lastSyncedAt
                  ? `Last synced ${new Date(a.lastSyncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                  : 'Not synced yet'}
              </p>
            </li>
          ))}
        </ul>
        {lastSync && (
          <p className="mt-2 text-[10px] text-gray-400">
            Most recent sync · {new Date(lastSync).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </p>
        )}
      </DrawerSection>

      {/* Honesty caveat — reframed to the new External money meaning */}
      <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2.5">
        <p className="text-[11px] text-gray-600 leading-relaxed">
          <strong>External, not authoritative.</strong> Bank-detected spend is the bank&apos;s view,
          not the system&apos;s record. Revenue still comes from sales recorded inside the app.
          Categorization depth depends on what the bank reports.
        </p>
      </div>

      {/* Dev-only sandbox affordances — hidden outside sandbox env
          since /sandbox/* endpoints reject in production.
          Connect first (deterministic dynamic-transactions Item),
          then create rent. */}
      {isDev && plaidSandbox && (
        <div className="space-y-3">
          <SandboxConnectTrigger />
          <SandboxRentTrigger />
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// Dev-only: deterministic Plaid Sandbox connect.
//
// Plaid Link's interactive sandbox flow is unreliable for the
// `user_transactions_dynamic` test profile — even when the user
// types the right username, the resulting Item often does not
// behave as a dynamic-transactions Item, so /sandbox/transactions/
// create silently no-ops. This button bypasses Link entirely by
// calling /sandbox/public_token/create with override_username =
// user_transactions_dynamic, which guarantees an Item that
// /sandbox/transactions/create will actually persist rows on.
//
// Only visible when isDev && plaidSandbox; the server action also
// rejects in production as defense in depth.
// ----------------------------------------------------------------
function SandboxConnectTrigger() {
  const [state, action, pending] = useActionState(connectSandboxItem, null)
  return (
    <div className="rounded-xl border border-dashed border-blue-300 bg-blue-50/40 p-4">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">Dev</span>
        <p className="text-[11px] font-semibold text-blue-900">Deterministic sandbox connect</p>
      </div>
      <p className="text-[11px] text-blue-800/80 leading-relaxed mb-3">
        Skips Plaid Link and creates a guaranteed{' '}
        <code className="text-[10px] bg-white/60 px-1 rounded">user_transactions_dynamic</code>{' '}
        Item via <code className="text-[10px] bg-white/60 px-1 rounded">/sandbox/public_token/create</code>.
        Use this before testing rent injection — interactive Link is unreliable for the
        dynamic-transactions flow.
      </p>
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-blue-800 hover:bg-blue-100 disabled:opacity-60 transition-colors"
        >
          {pending ? 'Connecting…' : 'Connect sandbox dynamic Item'}
        </button>
      </form>
      {state && 'error' in state && (
        <pre className="mt-2 text-[11px] text-red-700 whitespace-pre-wrap font-sans">{state.error}</pre>
      )}
      {state && 'ok' in state && (
        <pre className="mt-2 text-[11px] text-emerald-700 whitespace-pre-wrap font-sans">{state.message}</pre>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// Dev-only: triggers Plaid /sandbox/transactions/create + sync.
// Only visible to DEV_EMAILS allowlist users so the affordance
// never appears in normal operator UI.
// ----------------------------------------------------------------
function SandboxRentTrigger() {
  const [state, action, pending] = useActionState(createSandboxRentTransaction, null)
  return (
    <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50/40 p-4">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">Dev</span>
        <p className="text-[11px] font-semibold text-amber-900">Sandbox tools</p>
      </div>
      <p className="text-[11px] text-amber-800/80 leading-relaxed mb-3">
        Inject a fake $1,500 rent expense into the connected sandbox account and re-sync.
        Requires the Item to be a <code className="text-[10px] bg-white/60 px-1 rounded">user_transactions_dynamic</code> sandbox user.
      </p>
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60 transition-colors"
        >
          {pending ? 'Creating…' : 'Add sandbox rent expense'}
        </button>
      </form>
      {state && 'error' in state && (
        <pre className="mt-2 text-[11px] text-red-700 whitespace-pre-wrap font-sans">{state.error}</pre>
      )}
      {state && 'ok' in state && (
        <pre className="mt-2 text-[11px] text-emerald-700 whitespace-pre-wrap font-sans">{state.message}</pre>
      )}
    </div>
  )
}

function PreviewBullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-1.5 w-1 h-1 rounded-full bg-blue-500 flex-shrink-0" />
      <span>{children}</span>
    </li>
  )
}

// ================================================================
// Drawer primitives
// ================================================================

function DrawerStat({ label, value, tone, muted }: {
  label: string; value: string; tone?: 'positive' | 'negative'; muted?: boolean
}) {
  const valueClass =
    muted ? 'text-gray-300'
      : tone === 'positive' ? 'text-green-700'
        : tone === 'negative' ? 'text-red-600'
          : 'text-gray-900'
  return (
    <div className="px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{label}</p>
      <p className={`mt-1 text-base font-bold tabular-nums truncate ${valueClass}`}>{value}</p>
    </div>
  )
}

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-gray-500">{title}</p>
      {children}
    </div>
  )
}

function BreakdownRow({ primary, secondary, value, muted = false }: {
  primary: string; secondary: string; value: string; muted?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 bg-white px-3 py-2.5 hover:border-gray-200 transition-colors">
      <div className="min-w-0">
        <p className="text-xs font-medium text-gray-900 truncate">{primary}</p>
        <p className="text-[11px] text-gray-500 truncate mt-0.5">{secondary}</p>
      </div>
      <p className={`text-sm font-semibold font-mono tabular-nums flex-shrink-0 ${muted ? 'text-gray-400' : 'text-gray-900'}`}>
        {value}
      </p>
    </div>
  )
}

function InsightLine({ text, accent }: { text: string; accent: 'amber' | 'purple' | 'teal' }) {
  const tones: Record<typeof accent, string> = {
    amber: 'border-amber-200 bg-amber-50/60 text-amber-800',
    purple: 'border-purple-200 bg-purple-50/60 text-purple-800',
    teal: 'border-teal-200 bg-teal-50/60 text-teal-800',
  }
  return (
    <div className={`rounded-lg border ${tones[accent]} px-3 py-2.5`}>
      <p className="text-[11px] leading-relaxed">
        <span className="font-semibold">Notice:</span> {text}
      </p>
    </div>
  )
}

// ================================================================
// QuickExpenseCard
//
// The lower-row right card. Visual goals: cleaner field rhythm,
// consistent input heights, lighter labels, calmer button. The
// form's behavior is unchanged — every name= attribute, validation
// rule, default value, and id is preserved so createExpense reads
// the form exactly as before.
// ================================================================
function QuickExpenseCard({
  action, pending, error, locationId,
}: {
  action: (fd: FormData) => void
  pending: boolean
  error?: string
  locationId: string
}) {
  return (
    <aside className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col min-h-[500px]">
      <div className="border-b border-gray-100 px-6 py-5">
        <h2 className="text-base font-semibold tracking-tight text-gray-900">Log an expense</h2>
        <p className="mt-1 text-xs text-gray-500">Manual entry — adds to recorded spend.</p>
      </div>

      <form action={action} className="p-6 flex-1 flex flex-col gap-5">
        <input type="hidden" name="location_id" value={locationId} />

        <FormField label="Category" htmlFor="qa-category">
          <select
            id="qa-category"
            name="category"
            required
            defaultValue=""
            className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900
                       focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
          >
            <option value="" disabled>Select a category…</option>
            {EXPENSE_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </FormField>

        <FormField label="Amount" htmlFor="qa-amount">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
            <input
              id="qa-amount"
              name="amount"
              type="number"
              required
              min="0.01"
              step="0.01"
              placeholder="0.00"
              className="h-10 w-full rounded-lg border border-gray-200 bg-white pl-7 pr-3 text-sm font-mono tabular-nums placeholder:text-gray-300
                         focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
            />
          </div>
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Date" htmlFor="qa-date">
            <input
              id="qa-date"
              name="expense_date"
              type="date"
              required
              defaultValue={new Date().toISOString().split('T')[0]}
              className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900
                         focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
            />
          </FormField>
          <FormField label="Vendor" htmlFor="qa-vendor" optional>
            <input
              id="qa-vendor"
              name="vendor_name"
              type="text"
              placeholder="US Foods"
              className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400
                         focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
            />
          </FormField>
        </div>

        <label
          htmlFor="qa-inventory"
          className="flex items-center gap-2.5 cursor-pointer select-none"
        >
          <input
            id="qa-inventory"
            name="is_inventory_related"
            type="checkbox"
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500/40"
          />
          <span className="text-xs text-gray-700">
            Inventory-related
            <span className="text-gray-400 ml-1">— food, beverage, supplies</span>
          </span>
        </label>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}

        {/* Submit pinned to the bottom of the form so the card height
            stays consistent with the Recent activity card next to it. */}
        <div className="mt-auto">
          <button
            type="submit"
            disabled={pending}
            className="h-10 w-full rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {pending ? 'Saving…' : 'Record expense'}
          </button>
        </div>
      </form>
    </aside>
  )
}

function FormField({ label, htmlFor, children, optional = false }: {
  label: string; htmlFor: string; children: React.ReactNode; optional?: boolean
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-gray-700">
        {label}
        {optional && <span className="text-gray-400 font-normal">· optional</span>}
      </label>
      {children}
    </div>
  )
}

// ================================================================
// Header chip + workspace empty
// ================================================================
function DataSourceChip({ state }: { state: BankState }) {
  const variants: Record<BankState, { label: string; tone: string; dot: string }> = {
    not_connected: {
      label: 'System data only',
      tone: 'text-gray-600',
      dot: 'bg-gray-400',
    },
    connected_unsynced: {
      label: 'Bank linked · awaiting sync',
      tone: 'text-amber-700',
      dot: 'bg-amber-500',
    },
    connected_synced: {
      label: 'Live with bank context',
      tone: 'text-green-700',
      dot: 'bg-green-500',
    },
  }
  const v = variants[state]
  return (
    <div className="hidden sm:inline-flex items-center gap-2 self-start text-[11px] font-medium px-3 py-1.5 rounded-full border border-gray-200/80 bg-white/80 backdrop-blur-sm shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <span className={`w-1.5 h-1.5 rounded-full ${v.dot}`} />
      <span className={v.tone}>{v.label}</span>
    </div>
  )
}

function EmptyWorkspacePrompt({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="text-sm font-semibold text-gray-700">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-xs text-gray-500 leading-relaxed">{body}</p>
    </div>
  )
}

function fmt(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Soft text tints for the Recent activity Category column. Same
// hue mapping the old chip used, rendered as plain colored text so
// the row stays scannable without reintroducing pill chrome. The
// 700 tones land readable on white but stay quieter than the
// previous 800-tone chips.
function categoryColorClass(category: string): string {
  const map: Record<string, string> = {
    'Inventory Purchase': 'text-amber-700',
    'Beverage Purchase':  'text-teal-700',
    'Labor':              'text-purple-700',
    'Rent':               'text-rose-700',
    'Utilities':          'text-blue-700',
    'Maintenance':        'text-slate-700',
    'Marketing':          'text-purple-700',
    'Supplies':           'text-emerald-700',
    'Miscellaneous':      'text-gray-600',
  }
  return map[category] ?? 'text-gray-700'
}
