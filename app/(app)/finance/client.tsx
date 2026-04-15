'use client'

// ----------------------------------------------------------------
// Finance Client Component  —  Operational redesign
//
// The Finance page is a financial control surface, not a report.
// This redesign groups the page around real financial workflow:
//
//   1. Money overview    — revenue, expenses, net activity with a
//                          single proportional bar that visualizes
//                          financial pressure at a glance.
//
//   2. Operational cost  — labor estimate + inventory spend as a
//      context             quiet supporting strip.
//
//   3. Spending workspace — tabbed container (By category / Recent
//                           activity) so spending interpretation and
//                           recent financial activity live in one
//                           mental surface, not stacked below each
//                           other as orphaned tables.
//
//   4. Right rail         — quick expense entry (always inline, part
//                           of the workflow) + connected accounts
//                           as supporting context below it.
//
// The backbone, server actions, and data shape are unchanged.
// ----------------------------------------------------------------

import { useState, useActionState, useMemo } from 'react'
import { createExpense } from '@/app/actions/finance'
import { EXPENSE_CATEGORIES } from '@/lib/finance/constants'
import SimpleBarChart from '@/components/bar-chart'

interface RecentExpense {
  id: string
  category: string
  amount: number
  expenseDate: string
  vendorName: string | null
  notes: string | null
  isInventoryRelated: boolean
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

interface Props {
  locations: { id: string; name: string }[]
  defaultLocationId: string | null
  cards: {
    expenseTotal30d: number
    expenseCount30d: number
    revenue30d: number
    inventorySpend30d: number
    laborEstimate: number
    laborShiftCount: number
  }
  bank: {
    accounts: BankAccountSummary[]
    inflow30d: number
    outflow30d: number
    txnCount30d: number
  }
  categoryBreakdown: { label: string; value: number }[]
  recentExpenses: RecentExpense[]
}

type WorkspaceTab = 'category' | 'activity'
type ActivityFilter = 'all' | 'inventory' | 'non_inventory'

export default function FinanceClient({
  locations: _locations,
  defaultLocationId,
  cards,
  bank,
  categoryBreakdown,
  recentExpenses,
}: Props) {
  const [tab, setTab] = useState<WorkspaceTab>('category')
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all')
  const [state, action, pending] = useActionState(createExpense, null)
  const [locationId] = useState(defaultLocationId ?? '')

  const netActivity = cards.revenue30d - cards.expenseTotal30d
  const netPositive = netActivity >= 0

  // Proportional pressure — expenses as a share of revenue. Clamp
  // at 100% when expenses exceed revenue and show the overflow copy
  // below the bar so the visual stays readable either way.
  const pressurePct = cards.revenue30d > 0
    ? Math.min(100, Math.round((cards.expenseTotal30d / cards.revenue30d) * 100))
    : cards.expenseTotal30d > 0 ? 100 : 0
  const expensesExceedRevenue = cards.expenseTotal30d > cards.revenue30d

  // Top spending category — surfaced as copy, not a new chart.
  const topCategory = categoryBreakdown[0] ?? null
  const categoryTotal = categoryBreakdown.reduce((s, c) => s + c.value, 0)
  const topCategoryShare = topCategory && categoryTotal > 0
    ? Math.round((topCategory.value / categoryTotal) * 100)
    : 0

  const filteredExpenses = useMemo(() => {
    if (activityFilter === 'all') return recentExpenses
    if (activityFilter === 'inventory') return recentExpenses.filter((e) => e.isInventoryRelated)
    return recentExpenses.filter((e) => !e.isInventoryRelated)
  }, [recentExpenses, activityFilter])

  return (
    <div className="max-w-[1400px]">

      {/* ---- HEADER ---- */}
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Finance</h1>
        <p className="mt-1 text-sm text-gray-500">
          Understand money coming in, money going out, and where spending pressure is building.
        </p>
      </div>

      {/* ---- MONEY OVERVIEW HERO ---- */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6 mb-4">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
            Money · last 30 days
          </p>
          <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
            netPositive ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${netPositive ? 'bg-green-500' : 'bg-red-500'}`} />
            {netPositive ? 'Positive' : 'Negative'}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-6 mb-5">
          <HeroFigure label="Revenue"  value={fmt(cards.revenue30d)} />
          <HeroFigure label="Expenses" value={fmt(cards.expenseTotal30d)} />
          <HeroFigure
            label="Net activity"
            value={`${netPositive ? '' : '−'}${fmt(Math.abs(netActivity))}`}
            tone={netPositive ? 'positive' : 'negative'}
          />
        </div>

        {/* Pressure bar — one visual, not a chart. Shows expenses as  */}
        {/* a proportion of revenue so the reader sees margin pressure */}
        {/* without needing to do math.                                */}
        <div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full ${expensesExceedRevenue ? 'bg-red-500' : 'bg-red-400/80'}`}
              style={{ width: `${pressurePct}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
            <span>
              {cards.revenue30d > 0 ? (
                <>Expenses are <span className="font-semibold text-gray-700">{pressurePct}%</span> of revenue</>
              ) : (
                <>No revenue recorded in the last 30 days</>
              )}
            </span>
            <span className="text-[10px] text-gray-400">
              {expensesExceedRevenue ? 'Spending exceeds revenue' : 'Margin remaining'}
            </span>
          </div>
        </div>
      </div>

      {/* ---- OPERATIONAL COST CONTEXT (quiet strip) ---- */}
      <div className="rounded-xl border border-gray-200 bg-white mb-8 grid sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
        <BridgeCell
          label="Scheduled labor · week"
          value={fmt(cards.laborEstimate)}
          hint={`${cards.laborShiftCount} shift${cards.laborShiftCount !== 1 ? 's' : ''} with hourly rates · estimate only`}
        />
        <BridgeCell
          label="Inventory spend · 30d"
          value={fmt(cards.inventorySpend30d)}
          hint="Expenses marked as inventory-related"
        />
      </div>

      {/* ================ TWO-COLUMN WORKSPACE ================ */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">

        {/* -------- LEFT: Spending workspace -------- */}
        <div className="min-w-0 space-y-8">

          {/* Tabbed spending workspace */}
          <section>
            <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              {/* Tab bar */}
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
                <div className="flex items-center gap-1">
                  <WorkspaceTabButton
                    label="By category"
                    active={tab === 'category'}
                    onClick={() => setTab('category')}
                  />
                  <WorkspaceTabButton
                    label="Recent activity"
                    active={tab === 'activity'}
                    onClick={() => setTab('activity')}
                  />
                </div>
                {tab === 'activity' && recentExpenses.length > 0 && (
                  <div className="flex items-center gap-1">
                    {(['all', 'inventory', 'non_inventory'] as ActivityFilter[]).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setActivityFilter(f)}
                        className={`text-[10px] font-semibold px-2 py-1 rounded transition-colors ${
                          activityFilter === f
                            ? 'bg-gray-900 text-white'
                            : 'text-gray-500 hover:bg-gray-100'
                        }`}
                      >
                        {f === 'all' ? 'All' : f === 'inventory' ? 'Inventory' : 'Other'}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Panels */}
              {tab === 'category' ? (
                <div className="p-5">
                  {categoryBreakdown.length === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-12">No category data yet.</p>
                  ) : (
                    <>
                      {topCategory && (
                        <div className="mb-4 flex items-baseline justify-between">
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Top category</p>
                            <p className="mt-0.5 text-sm font-semibold text-gray-900">
                              {topCategory.label}{' '}
                              <span className="text-gray-400 font-normal">· {topCategoryShare}% of spend</span>
                            </p>
                          </div>
                          <p className="text-lg font-bold font-mono tabular-nums text-gray-900">
                            {fmt(topCategory.value)}
                          </p>
                        </div>
                      )}
                      <SimpleBarChart data={categoryBreakdown} color="#8b5cf6" />
                    </>
                  )}
                </div>
              ) : (
                <div>
                  {filteredExpenses.length === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-12">
                      {recentExpenses.length === 0
                        ? 'No expenses recorded yet.'
                        : 'No expenses match this filter.'}
                    </p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100 text-left bg-gray-50/60">
                          <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Date</th>
                          <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Category</th>
                          <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Vendor</th>
                          <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {filteredExpenses.map((exp) => (
                          <tr key={exp.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-5 py-3 text-gray-900 whitespace-nowrap">
                              {new Date(exp.expenseDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            </td>
                            <td className="px-5 py-3">
                              <span className="inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full bg-purple-50 text-purple-700">
                                {exp.category}
                              </span>
                              {exp.isInventoryRelated && (
                                <span className="ml-1.5 inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700">
                                  Inventory
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-3 text-gray-500 truncate max-w-[220px]">{exp.vendorName || '—'}</td>
                            <td className="px-5 py-3 text-gray-900 font-mono tabular-nums text-right">${exp.amount.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* -------- RIGHT RAIL -------- */}
        <aside className="mt-8 lg:mt-0">
          <div className="sticky top-4 space-y-4">

            {/* Quick expense entry — inline, part of the workflow */}
            <QuickExpenseCard
              action={action}
              pending={pending}
              error={state?.error}
              locationId={locationId}
            />

            {/* Connected accounts — supporting only */}
            <ConnectedAccountsCard bank={bank} />
          </div>
        </aside>
      </div>
    </div>
  )
}

// ================================================================
// Helpers
// ================================================================

function HeroFigure({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'negative' }) {
  const valueTone =
    tone === 'positive' ? 'text-green-700'
      : tone === 'negative' ? 'text-red-600'
        : 'text-gray-900'
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums truncate ${valueTone}`}>{value}</p>
    </div>
  )
}

function BridgeCell({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="px-5 py-4">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{label}</p>
      <p className="mt-0.5 text-base font-bold text-gray-900 tabular-nums">{value}</p>
      <p className="mt-0.5 text-[10px] text-gray-400 leading-relaxed">{hint}</p>
    </div>
  )
}

function WorkspaceTabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
        active ? 'bg-gray-900 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {label}
    </button>
  )
}

// ----------------------------------------------------------------
// QuickExpenseCard — always-visible inline form in the right rail.
// Simplified to the five fields that matter for fast entry.
// ----------------------------------------------------------------
function QuickExpenseCard({
  action, pending, error, locationId,
}: {
  action: (fd: FormData) => void
  pending: boolean
  error?: string
  locationId: string
}) {
  return (
    <aside className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-gray-100 px-5 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Record</p>
        <h2 className="text-base font-bold text-gray-900 mt-0.5">Log an expense</h2>
      </div>

      <form action={action} className="p-5 space-y-3">
        <input type="hidden" name="location_id" value={locationId} />

        <div>
          <label htmlFor="qa-category" className="block text-[11px] font-semibold text-gray-600 mb-1">
            Category
          </label>
          <select
            id="qa-category"
            name="category"
            required
            defaultValue=""
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
          >
            <option value="" disabled>Select…</option>
            {EXPENSE_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="qa-amount" className="block text-[11px] font-semibold text-gray-600 mb-1">
            Amount
          </label>
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
              className="w-full rounded-lg border border-gray-200 bg-white pl-7 pr-3 py-2 text-sm font-mono placeholder:text-gray-400
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="qa-date" className="block text-[11px] font-semibold text-gray-600 mb-1">
              Date
            </label>
            <input
              id="qa-date"
              name="expense_date"
              type="date"
              required
              defaultValue={new Date().toISOString().split('T')[0]}
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
            />
          </div>
          <div>
            <label htmlFor="qa-vendor" className="block text-[11px] font-semibold text-gray-600 mb-1">
              Vendor <span className="text-gray-400 font-normal">(opt.)</span>
            </label>
            <input
              id="qa-vendor"
              name="vendor_name"
              type="text"
              placeholder="e.g. US Foods"
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs placeholder:text-gray-400
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            id="qa-inventory"
            name="is_inventory_related"
            type="checkbox"
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-[11px] text-gray-600">
            Inventory-related (food, bev, supplies)
          </span>
        </label>

        {error && <p className="text-[11px] text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 shadow-sm disabled:opacity-60 transition-colors"
        >
          {pending ? 'Saving…' : 'Record expense'}
        </button>
      </form>
    </aside>
  )
}

// ----------------------------------------------------------------
// ConnectedAccountsCard — supporting context only.
// ----------------------------------------------------------------
function ConnectedAccountsCard({ bank }: {
  bank: {
    accounts: BankAccountSummary[]
    inflow30d: number
    outflow30d: number
    txnCount30d: number
  }
}) {
  if (bank.accounts.length === 0) {
    return (
      <aside className="rounded-xl border border-dashed border-gray-200 bg-white p-5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">External</p>
        <h2 className="text-sm font-semibold text-gray-900 mt-0.5">No bank connected</h2>
        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
          Bank sync is coming soon. Once linked, inflows and outflows will appear here as supporting
          context — not a raw transaction feed.
        </p>
      </aside>
    )
  }

  return (
    <aside className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-gray-100 px-5 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">External</p>
        <h2 className="text-base font-bold text-gray-900 mt-0.5">Connected accounts</h2>
      </div>
      <ul className="divide-y divide-gray-50">
        {bank.accounts.map((a) => (
          <li key={a.id} className="px-5 py-3">
            <p className="text-xs font-semibold text-gray-900 truncate">
              {a.institutionName ?? a.provider} · {a.accountName}
              {a.accountMask && <span className="text-gray-400 font-normal ml-1">••{a.accountMask}</span>}
            </p>
            <p className="text-[10px] text-gray-400 mt-0.5">
              {a.lastSyncedAt
                ? `Last synced ${new Date(a.lastSyncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                : 'Not synced yet'}
            </p>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-3 border-t border-gray-100 divide-x divide-gray-100">
        <MiniFigure label="Inflow" value={fmt(bank.inflow30d)} tone="positive" />
        <MiniFigure label="Outflow" value={fmt(bank.outflow30d)} tone="negative" />
        <MiniFigure label="Activity" value={`${bank.txnCount30d}`} />
      </div>
      <p className="px-5 py-2 text-[10px] text-gray-400 leading-relaxed border-t border-gray-100">
        Activity is captured for future matching. Only totals are shown here.
      </p>
    </aside>
  )
}

function MiniFigure({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'negative' }) {
  const valueTone =
    tone === 'positive' ? 'text-green-700'
      : tone === 'negative' ? 'text-red-600'
        : 'text-gray-900'
  return (
    <div className="px-3 py-2.5">
      <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400">{label}</p>
      <p className={`mt-0.5 text-xs font-bold tabular-nums ${valueTone}`}>{value}</p>
    </div>
  )
}

function fmt(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
