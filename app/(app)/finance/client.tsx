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
    inflow7d: number
    outflow7d: number
    txnCount7d: number
    state: BankState
  }
  recentExpenses: RecentExpense[]
}

type ActivityFilter = 'all' | 'inventory' | 'non_inventory'
type DrawerKind = 'labor' | 'inventory' | 'external' | null

export default function FinanceClient({
  locations: _locations,
  defaultLocationId,
  plaidConfigured,
  cards,
  laborBreakdown,
  inventoryBreakdown,
  bank,
  recentExpenses,
}: Props) {
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all')
  const [state, action, pending] = useActionState(createExpense, null)
  const [locationId] = useState(defaultLocationId ?? '')
  const [drawer, setDrawer] = useState<DrawerKind>(null)

  const netActivity = cards.revenue7d - cards.expenseTotal7d
  const netPositive = netActivity >= 0
  const hasAnyActivity = cards.revenue7d > 0 || cards.expenseTotal7d > 0

  const filteredExpenses = useMemo(() => {
    if (activityFilter === 'all') return recentExpenses
    if (activityFilter === 'inventory') return recentExpenses.filter((e) => e.isInventoryRelated)
    return recentExpenses.filter((e) => !e.isInventoryRelated)
  }, [recentExpenses, activityFilter])

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
              label="Expenses"
              dotClass="bg-red-400"
              value={fmt(cards.expenseTotal7d)}
              hint={`${cards.expenseCount7d} ${cards.expenseCount7d === 1 ? 'entry' : 'entries'}`}
              empty={cards.expenseTotal7d === 0}
            />
            <NetActivityCell
              value={netActivity}
              hasAnyActivity={hasAnyActivity}
              netPositive={netPositive}
              revenue={cards.revenue7d}
              expenses={cards.expenseTotal7d}
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
          <LaborDriverCard cards={cards} onOpen={() => setDrawer('labor')} />
          <InventoryDriverCard
            value={cards.inventorySpend7d}
            hint={
              cards.inventorySpend7d > 0
                ? 'Inventory-related expenses'
                : 'Mark expenses as inventory-related'
            }
            onOpen={() => setDrawer('inventory')}
          />
          <ExternalMoneyCard
            bank={bank}
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
            <div className="border-b border-gray-100 px-6 py-5 flex items-center justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">Activity</p>
                <h2 className="text-base font-semibold tracking-tight text-gray-900 mt-1">Recent activity</h2>
              </div>
              {recentExpenses.length > 0 && (
                <div className="inline-flex items-center gap-0.5 rounded-lg border border-gray-200 bg-gray-50/80 p-0.5">
                  {(['all', 'inventory', 'non_inventory'] as ActivityFilter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setActivityFilter(f)}
                      className={`text-[11px] font-semibold px-2.5 py-1 rounded-md transition-colors ${
                        activityFilter === f
                          ? 'bg-white text-gray-900 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {f === 'all' ? 'All' : f === 'inventory' ? 'Inventory' : 'Other'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto">
              {filteredExpenses.length === 0 ? (
                recentExpenses.length === 0 ? (
                  <EmptyWorkspacePrompt
                    title="No expenses recorded yet"
                    body="Use the Log an expense form on the right to record your first expense. Recent activity will appear here."
                  />
                ) : (
                  <p className="text-xs text-gray-400 text-center py-12">No expenses match this filter.</p>
                )
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white/95 backdrop-blur">
                    <tr className="border-b border-gray-100 text-left">
                      <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em]">Date</th>
                      <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em]">Category</th>
                      <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em]">Vendor</th>
                      <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em] text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {filteredExpenses.map((exp) => (
                      <tr key={exp.id} className="hover:bg-gray-50/70 transition-colors">
                        <td className="px-6 py-3.5 text-gray-700 whitespace-nowrap text-[13px]">
                          {new Date(exp.expenseDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </td>
                        <td className="px-6 py-3.5">
                          <span className={`inline-flex text-[11px] font-medium px-2 py-0.5 rounded-md ${categoryChipClass(exp.category)}`}>
                            {exp.category}
                          </span>
                          {exp.isInventoryRelated && (
                            <span className="ml-1.5 inline-flex text-[11px] font-medium px-2 py-0.5 rounded-md bg-amber-50 text-amber-800">
                              Inventory
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-3.5 text-gray-500 truncate max-w-[220px] text-[13px]">{exp.vendorName || '—'}</td>
                        <td className="px-6 py-3.5 text-gray-900 font-mono tabular-nums font-medium text-right text-[13px]">${exp.amount.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
        <ExternalDrawerContent bank={bank} plaidConfigured={plaidConfigured} />
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
function NetActivityCell({ value, hasAnyActivity, netPositive, revenue, expenses }: {
  value: number; hasAnyActivity: boolean; netPositive: boolean
  revenue: number; expenses: number
}) {
  const valueColor = !hasAnyActivity ? 'text-gray-300' : (netPositive ? 'text-green-700' : 'text-red-600')
  const dotClass = !hasAnyActivity ? 'bg-gray-300' : (netPositive ? 'bg-green-500' : 'bg-red-500')
  const hint = (() => {
    if (revenue > 0 && expenses > 0) {
      const pct = Math.round((expenses / revenue) * 100)
      return expenses > revenue
        ? `Spending exceeds revenue · ${pct}% ratio`
        : `Expenses are ${pct}% of revenue`
    }
    if (revenue > 0) return 'No expenses recorded yet'
    if (expenses > 0) return 'No sales recorded yet'
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

function LaborDriverCard({ cards, onOpen }: {
  cards: {
    laborEstimate: number
    laborRatedShiftCount: number
    laborUnratedShiftCount: number
    totalShiftCount: number
    laborState: LaborState
  }
  onOpen: () => void
}) {
  const accent = 'bg-purple-500'

  switch (cards.laborState) {
    case 'ok': {
      const hint =
        cards.laborUnratedShiftCount > 0
          ? `${cards.laborRatedShiftCount} of ${cards.totalShiftCount} shifts costed`
          : `${cards.laborRatedShiftCount} shift${cards.laborRatedShiftCount !== 1 ? 's' : ''} costed`
      return (
        <ClickableDriverCard
          accent={accent}
          label="Scheduled labor"
          period="This week"
          value={fmt(cards.laborEstimate)}
          valueMuted={false}
          hint={hint}
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

function InventoryDriverCard({ value, hint, onOpen }: {
  value: number; hint: string; onOpen: () => void
}) {
  return (
    <ClickableDriverCard
      accent="bg-amber-500"
      label="Inventory spend"
      period="Last 7 days"
      value={fmt(value)}
      valueMuted={value === 0}
      hint={hint}
      onOpen={onOpen}
    />
  )
}

// External money card — third middle-row card. Owns the bank
// connection entry point in the not-connected state.
function ExternalMoneyCard({ bank, plaidConfigured, onOpen }: {
  bank: { inflow7d: number; outflow7d: number; txnCount7d: number; state: BankState }
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
          Connect a bank to bring real money-movement context into Finance.
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
          <div className="flex items-baseline gap-3">
            <span className="text-[22px] leading-none font-semibold tracking-tight tabular-nums text-gray-900">+{fmt(bank.inflow7d)}</span>
            <span className="text-[22px] leading-none font-semibold tracking-tight tabular-nums text-gray-900">−{fmt(bank.outflow7d)}</span>
          </div>
          <div className="mt-3 flex items-end justify-between gap-2">
            <p className="text-xs text-gray-500 leading-relaxed">{bank.txnCount7d} transaction{bank.txnCount7d !== 1 ? 's' : ''} · last 7 days</p>
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
function ExternalDrawerContent({ bank, plaidConfigured }: {
  bank: {
    accounts: BankAccountSummary[]
    inflow7d: number
    outflow7d: number
    txnCount7d: number
    state: BankState
  }
  plaidConfigured: boolean
}) {
  if (bank.state === 'not_connected') {
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-5">
          <p className="text-sm font-semibold text-gray-900">Why connect a bank?</p>
          <ul className="mt-3 space-y-2.5 text-[12px] text-gray-600 leading-relaxed">
            <PreviewBullet>See real money movement alongside your sales and recorded expenses.</PreviewBullet>
            <PreviewBullet>Spot inflow/outflow patterns Finance can&apos;t infer from internal data alone.</PreviewBullet>
            <PreviewBullet>Capture activity for future matching — Finance stays a workspace, not a feed.</PreviewBullet>
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
            <strong>What you won&apos;t see here.</strong> A raw bank-feed view. Finance only surfaces
            aggregates and is for interpretation, not transaction-by-transaction inspection.
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

  const net = bank.inflow7d - bank.outflow7d
  const netPositive = net >= 0

  return (
    <div className="space-y-6">
      {/* Stats strip */}
      <div className="grid grid-cols-3 rounded-xl border border-gray-200 divide-x divide-gray-100 bg-white">
        <DrawerStat label="Inflow" value={fmt(bank.inflow7d)} tone="positive" />
        <DrawerStat label="Outflow" value={fmt(bank.outflow7d)} tone="negative" />
        <DrawerStat label="Activity" value={`${bank.txnCount7d}`} muted={bank.txnCount7d === 0} />
      </div>

      {/* Net direction insight */}
      {bank.txnCount7d > 0 && (
        <InsightLine
          accent={netPositive ? 'teal' : 'amber'}
          text={
            netPositive
              ? `Net ${fmt(Math.abs(net))} into the account this period.`
              : `Net ${fmt(Math.abs(net))} out of the account this period.`
          }
        />
      )}

      {bank.state === 'connected_unsynced' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5">
          <p className="text-[11px] text-amber-800 leading-relaxed">
            <strong>Awaiting first sync.</strong> Bank linked but no transactions have arrived yet.
            Trigger a sync from Settings to bring activity in.
          </p>
        </div>
      )}

      {/* Accounts */}
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

      {/* Honesty caveat */}
      <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2.5">
        <p className="text-[11px] text-gray-600 leading-relaxed">
          <strong>Aggregates only.</strong> Activity is captured for future matching against orders
          and expenses. Finance is the interpretation layer — not a raw bank-feed page.
        </p>
      </div>
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
// QuickExpenseCard — refined inline form (lower-row right card)
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
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-blue-500" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">Action</p>
        </div>
        <h2 className="text-base font-semibold tracking-tight text-gray-900 mt-1">Log an expense</h2>
      </div>

      <form action={action} className="p-6 space-y-4 flex-1 flex flex-col">
        <input type="hidden" name="location_id" value={locationId} />

        <FormField label="Category" htmlFor="qa-category">
          <select
            id="qa-category"
            name="category"
            required
            defaultValue=""
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
          >
            <option value="" disabled>Select a category…</option>
            {EXPENSE_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </FormField>

        <FormField label="Amount" htmlFor="qa-amount">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 font-medium">$</span>
            <input
              id="qa-amount"
              name="amount"
              type="number"
              required
              min="0.01"
              step="0.01"
              placeholder="0.00"
              className="w-full rounded-lg border border-gray-200 bg-white pl-7 pr-3 py-2 text-sm font-mono tabular-nums placeholder:text-gray-300
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
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
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
            />
          </FormField>
          <FormField label="Vendor" htmlFor="qa-vendor" optional>
            <input
              id="qa-vendor"
              name="vendor_name"
              type="text"
              placeholder="e.g. US Foods"
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs placeholder:text-gray-400
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
            />
          </FormField>
        </div>

        <label className="flex items-center gap-2 cursor-pointer rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2 hover:bg-gray-50 transition-colors">
          <input
            id="qa-inventory"
            name="is_inventory_related"
            type="checkbox"
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-[11px] text-gray-700 leading-tight">
            Inventory-related <span className="text-gray-400 font-normal">· food, beverage, supplies</span>
          </span>
        </label>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
            <p className="text-[11px] text-red-700">{error}</p>
          </div>
        )}

        {/* Submit pinned to bottom of form so the card height feels intentional */}
        <div className="mt-auto pt-2">
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 shadow-[0_1px_2px_rgba(0,0,0,0.08)] disabled:opacity-60 transition-colors"
          >
            {pending ? 'Saving…' : 'Record expense'}
          </button>
          <p className="mt-2.5 text-[11px] text-gray-400 text-center">
            Manual entry · adds to spending pressure
          </p>
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
      <label htmlFor={htmlFor} className="block text-[11px] font-semibold text-gray-600 mb-2 tracking-wide">
        {label}
        {optional && <span className="text-gray-400 font-normal ml-1">(optional)</span>}
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

// Restrained per-category chip palette for the activity table.
// Soft 50-tone backgrounds with 700-tone text — readable but never
// loud. Unknown categories fall back to neutral gray.
function categoryChipClass(category: string): string {
  const map: Record<string, string> = {
    'Inventory Purchase': 'bg-amber-50 text-amber-800',
    'Beverage Purchase': 'bg-teal-50 text-teal-700',
    'Labor': 'bg-purple-50 text-purple-700',
    'Rent': 'bg-rose-50 text-rose-700',
    'Utilities': 'bg-blue-50 text-blue-700',
    'Maintenance': 'bg-slate-100 text-slate-700',
    'Marketing': 'bg-purple-50 text-purple-700',
    'Supplies': 'bg-emerald-50 text-emerald-700',
    'Miscellaneous': 'bg-gray-100 text-gray-700',
  }
  return map[category] ?? 'bg-gray-100 text-gray-700'
}
