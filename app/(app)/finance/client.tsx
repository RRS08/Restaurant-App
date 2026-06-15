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
//      Operating. All three are clickable and open drawers.
//      Operating is the bank-connection entry point in the
//      not-connected state.
//
//      "Operating" = business expenses outside Labor and Inventory:
//      rent, utilities, marketing, subscriptions, insurance, repairs,
//      bank fees, professional services, loan payments. A separate
//      Bank Review verification workflow is planned for a later pass
//      — it is intentionally NOT built here.
//   4. Lower row — Recent activity (left) + Log expense (right),
//      visually balanced.
//
// All Finance logic + states preserved from prior passes:
//   - laborState (4 honest variants)
//   - bankState (3 variants)
//   - source-of-truth chip
//   - empty-state nudges
// ----------------------------------------------------------------

import { useEffect, useState, useActionState, useMemo, useTransition } from 'react'
import { useSearchParams } from 'next/navigation'
import { createExpense } from '@/app/actions/finance'
import {
  connectSandboxItem,
  createSandboxRentTransaction,
  settleBankTransaction,
  ignoreBankTransaction,
  markBankTransactionNotAMatch,
  reopenBankTransaction,
  settleBankTransactionGroup,
  ignoreBankTransactionGroup,
  markBankTransactionGroupNotAMatch,
} from '@/app/actions/bank'
import { EXPENSE_CATEGORIES } from '@/lib/finance/constants'
import { ConnectBankButton } from '@/components/bank/connect-bank-button'
import {
  suggestSettlementKind,
  looksPersonal,
  groupBankTransactions,
  type SuggestedKind,
  type BankReviewGroup,
} from '@/lib/finance/matching'

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
    review: {
      rows: BankReviewRow[]
      counts: {
        unreviewed: number
        unreviewedInflow: number
        unreviewedOutflow: number
        settled: number
        ignored: number
        notAMatch: number
      }
    }
  }
  recentExpenses: RecentExpense[]
}

export interface BankReviewRow {
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

type DrawerKind =
  | 'revenue'
  | 'spend'
  | 'net'
  | 'labor'
  | 'inventory'
  | 'operating'
  | 'bank_review'
  | 'log_expense'
  | null

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

  // Dashboard's "Add manual expense" quick action navigates to
  // /finance?log=1 (or ?log=expense) — opening the Log Expense
  // drawer automatically the moment the page mounts. Manual entry
  // is no longer a dominant card on the page; it lives in a drawer
  // reachable from here or from Dashboard.
  const searchParams = useSearchParams()
  useEffect(() => {
    const logParam = searchParams?.get('log')
    if (logParam === '1' || logParam === 'expense') {
      setDrawer('log_expense')
    }
  }, [searchParams])

  // When createExpense returns success (state=null after submit
  // settles), close the Log Expense drawer so the user lands back
  // on the page with the new row visible in Recent activity. We
  // can't distinguish "first mount null" from "success null", so
  // we only close after the action has been called at least once
  // by gating on `pending`.
  const [hasSubmittedLog, setHasSubmittedLog] = useState(false)
  useEffect(() => {
    if (pending) setHasSubmittedLog(true)
  }, [pending])
  useEffect(() => {
    if (!pending && hasSubmittedLog && !state?.error && drawer === 'log_expense') {
      setDrawer(null)
      setHasSubmittedLog(false)
    }
  }, [pending, hasSubmittedLog, state, drawer])

  // ----------------------------------------------------------------
  // Spend model (observer phase).
  //
  // The four signals on the page (Labor / Inventory / Operating /
  // Net) are sub-parts of one Spend total, not separate buckets:
  //
  //   Labor     = scheduled hours × rate (projection only — bank
  //               payroll detection is deferred to the action phase).
  //   Inventory = max(manual logs, bank food/drink-PFC outflows).
  //               max() de-dups: a bank row that confirms a manual
  //               log doesn't add on top of it.
  //   Operating = business expenses outside Labor and Inventory —
  //               rent, utilities, marketing, subscriptions,
  //               insurance, repairs, bank fees, professional
  //               services, loan payments. Headline value is
  //               max(manual non-inventory expenses, bank non-
  //               inventory PFC outflows).
  //   Spend     = Labor + Inventory + Operating.
  //   Net       = Revenue − Spend.
  //
  // Unresolved bank outflows (no PFC) stay surfaced in the Operating
  // drawer for triage but are NOT in Net — we don't claim spend on
  // rows we can't classify. A separate Bank Review verification
  // workflow is planned for later; do not conflate it with the
  // Operating expense category.
  //
  // Internal naming note: the server↔client prop shape still uses
  // the legacy `externalSpend7d` / `recognizedExternalSpend7d` /
  // `externalByCategory` / `externalSpendCount7d` field names on
  // `bank`. These are the wire format owned by page.tsx; renaming
  // them is out of scope for this naming pass. Only the user-facing
  // labels and the client-local variable name change here.
  // ----------------------------------------------------------------
  const laborSpend = cards.laborEstimate
  const manualNonInventorySpend = Math.max(0, cards.expenseTotal7d - cards.inventorySpend7d)
  const inventorySpend = Math.max(cards.inventorySpend7d, bank.bankInventoryConfirmed7d)
  const operatingSpend = Math.max(manualNonInventorySpend, bank.recognizedExternalSpend7d)
  const totalSpend7d = laborSpend + inventorySpend + operatingSpend
  const netActivity = cards.revenue7d - totalSpend7d
  const netPositive = netActivity >= 0
  const hasAnyActivity = cards.revenue7d > 0 || totalSpend7d > 0

  // ----------------------------------------------------------------
  // Bank Review groups — bucket unreviewed transactions by likely
  // pattern (Costco, Rent & utilities, etc.) so the Bank Review
  // surface presents one decision per group instead of one per row.
  // The group-first model is the V2 user model; per-row settle/
  // ignore are kept as fallbacks for the drilldown view.
  // ----------------------------------------------------------------
  const reviewGroups = useMemo<BankReviewGroup[]>(() => {
    const unreviewed = bank.review.rows
      .filter((r) => r.reviewState === 'unreviewed')
      .map((r) => ({
        id: r.id,
        direction: r.direction,
        amount: r.amount,
        rawCategory: r.rawCategory,
        merchantName: r.merchantName,
        description: r.description,
        postedAt: r.postedAt,
      }))
    return groupBankTransactions(unreviewed)
  }, [bank.review.rows])

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
              hint="Sales recorded · card and cash settlement handled separately"
              empty={cards.revenue7d === 0}
              truth="Recorded"
              onOpen={() => setDrawer('revenue')}
            />
            <SummaryCell
              label="Spend"
              dotClass="bg-red-400"
              value={fmt(totalSpend7d)}
              hint="Labor · inventory · operating · verification via Bank Review"
              empty={totalSpend7d === 0}
              truth="Tracked"
              onOpen={() => setDrawer('spend')}
            />
            <NetActivityCell
              value={netActivity}
              hasAnyActivity={hasAnyActivity}
              netPositive={netPositive}
              revenue={cards.revenue7d}
              spend={totalSpend7d}
              recognizedOperatingSpend={bank.recognizedExternalSpend7d}
              onOpen={() => setDrawer('net')}
            />
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* 3. OPERATIONAL DRIVERS — three clickable cards                   */}
      {/* ================================================================ */}
      <section className="mb-7">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">
            What&apos;s driving spend
          </h2>
          <span className="text-[11px] text-gray-400">Last 7 days</span>
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
          <OperatingCard
            bank={bank}
            operatingSpend={operatingSpend}
            sharePct={pctOfSpend(operatingSpend)}
            plaidConfigured={plaidConfigured}
            onOpen={() => setDrawer('operating')}
          />
        </div>
      </section>

      {/* ================================================================ */}
      {/* 4. LOWER ROW — Recent activity + Bank Review summary             */}
      {/* The right-rail used to be "Log expense" (the dominant manual     */}
      {/* entry card). It now carries the Bank Review summary — a more    */}
      {/* model-aligned right rail. Manual expense entry still exists     */}
      {/* but lives in a drawer reached via the small "+ Log manual       */}
      {/* expense" link on the Recent activity header, or via Dashboard's */}
      {/* "Add manual expense" quick action which deep-links here with    */}
      {/* ?log=1.                                                          */}
      {/* ================================================================ */}
      <section>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] items-start">

          {/* LEFT: Recent activity */}
          <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col min-h-[500px]">
            {/* Header — secondary "+ Log manual expense" affordance on
                the right keeps the manual capability accessible without
                making it dominant. */}
            <div className="border-b border-gray-100 px-6 py-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-gray-900">Recent activity</h2>
                <p className="mt-0.5 text-[11px] text-gray-500">Latest expenses logged or imported.</p>
              </div>
              <button
                type="button"
                onClick={() => setDrawer('log_expense')}
                className="flex-shrink-0 text-[11px] font-medium text-blue-700 hover:text-blue-900 hover:underline transition-colors"
              >
                + Log manual expense
              </button>
            </div>

            {/* Body — fixed-height activity log, paginated 6 per page so the
                card never stretches and rows always slot in cleanly. */}
            <div className="flex-1 flex flex-col">
              {recentExpenses.length === 0 ? (
                <EmptyWorkspacePrompt
                  title="No activity yet"
                  body="Log an expense or receive a restock order — entries land here."
                />
              ) : (
                <>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-left">
                        <th className="px-6 py-2.5 text-[11px] font-medium text-gray-500">Date</th>
                        <th className="px-6 py-2.5 text-[11px] font-medium text-gray-500">Category</th>
                        <th className="px-6 py-2.5 text-[11px] font-medium text-gray-500">Vendor</th>
                        <th className="px-6 py-2.5 text-[11px] font-medium text-gray-500 text-right">Amount</th>
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

                  {/* Pager — pinned at the bottom so the card height stays
                      stable regardless of how full the current page is.
                      Compact arrow style, matching the Inventory family. */}
                  <div className="mt-auto border-t border-gray-100 px-6 py-2.5 flex items-center justify-between">
                    <p className="text-[10px] text-gray-500 font-mono tabular-nums">
                      {recentExpenses.length === 0
                        ? '0 entries'
                        : (
                          <>
                            Showing{' '}
                            <span className="font-semibold text-gray-700">
                              {safeActivityPage * ACTIVITY_PAGE_SIZE + 1}–
                              {Math.min(
                                (safeActivityPage + 1) * ACTIVITY_PAGE_SIZE,
                                recentExpenses.length,
                              )}
                            </span>{' '}
                            of <span className="font-semibold text-gray-700">{recentExpenses.length}</span>
                          </>
                        )}
                    </p>
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setActivityPage((p) => Math.max(0, p - 1))}
                        disabled={safeActivityPage === 0}
                        aria-label="Previous activity page"
                        className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        ←
                      </button>
                      <span className="text-[10px] text-gray-500 px-1.5 font-mono tabular-nums">
                        {safeActivityPage + 1} / {activityPageCount}
                      </span>
                      <button
                        type="button"
                        onClick={() => setActivityPage((p) => Math.min(activityPageCount - 1, p + 1))}
                        disabled={safeActivityPage >= activityPageCount - 1}
                        aria-label="Next activity page"
                        className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        →
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* RIGHT: Money Review summary — exception-first triage card */}
          <BankReviewSummaryCard
            counts={bank.review.counts}
            groupCount={reviewGroups.length}
            attentionCount={
              reviewGroups.filter((g) => g.triage !== 'auto').length
            }
            autoCount={
              reviewGroups.filter((g) => g.triage === 'auto').length
            }
            bankState={bank.state}
            onOpen={() => setDrawer('bank_review')}
          />
        </div>
      </section>

      {/* ================================================================ */}
      {/* DRAWERS                                                          */}
      {/* ================================================================ */}
      <Drawer
        open={drawer === 'revenue'}
        onClose={() => setDrawer(null)}
        title="Revenue"
        subtitle="How recorded sales become settled money"
      >
        <RevenueDrawerContent
          revenue7d={cards.revenue7d}
          reviewRows={bank.review.rows}
          bankState={bank.state}
        />
      </Drawer>

      <Drawer
        open={drawer === 'spend'}
        onClose={() => setDrawer(null)}
        title="Spend"
        subtitle="What is included, and how true is it"
      >
        <SpendDrawerContent
          laborSpend={laborSpend}
          inventorySpend={inventorySpend}
          operatingSpend={operatingSpend}
          totalSpend7d={totalSpend7d}
          reviewCounts={bank.review.counts}
          bankState={bank.state}
        />
      </Drawer>

      <Drawer
        open={drawer === 'net'}
        onClose={() => setDrawer(null)}
        title="Net activity"
        subtitle="Why operating net and bank net differ"
      >
        <NetActivityDrawerContent
          revenue={cards.revenue7d}
          spend={totalSpend7d}
          bankInflow={bank.inflow7d}
          bankOutflow={bank.outflow7d}
          laborSpend={laborSpend}
          inventorySpend={inventorySpend}
          reviewCounts={bank.review.counts}
          bankState={bank.state}
        />
      </Drawer>

      <Drawer
        open={drawer === 'labor'}
        onClose={() => setDrawer(null)}
        title="Scheduled labor"
        subtitle="This week · projected from schedule × hourly rate"
      >
        <LaborDrawerContent cards={cards} breakdown={laborBreakdown} />
      </Drawer>

      <Drawer
        open={drawer === 'inventory'}
        onClose={() => setDrawer(null)}
        title="Inventory spend"
        subtitle="Last 7 days · inventory purchases"
      >
        <InventoryDrawerContent
          total={cards.inventorySpend7d}
          breakdown={inventoryBreakdown}
          recentItems={recentInventoryExpenses}
        />
      </Drawer>

      <Drawer
        open={drawer === 'operating'}
        onClose={() => setDrawer(null)}
        title="Operating"
        subtitle={
          bank.state === 'not_connected'
            ? 'Business expenses outside labor and inventory'
            : 'Last 7 days · business expenses outside labor and inventory'
        }
      >
        <OperatingDrawerContent
          bank={bank}
          plaidConfigured={plaidConfigured}
          plaidSandbox={plaidSandbox}
          isDev={isDev}
        />
      </Drawer>

      {/* Bank Review drawer — settlement workflow. Renders the same
          reviewRows feed produced by the server in three queues
          (Suggested / Incoming / Outgoing) plus collapsible tails
          for Settled / Review later / Ignored. Action buttons call
          settleBankTransaction / ignoreBankTransaction / etc. */}
      <Drawer
        open={drawer === 'bank_review'}
        onClose={() => setDrawer(null)}
        title="Money Review"
        subtitle={
          bank.state === 'not_connected'
            ? 'Connect a bank to start verifying cash reality'
            : (() => {
                const attention = reviewGroups.filter((g) => g.triage !== 'auto').length
                return `${attention} need${attention === 1 ? 's' : ''} attention · ${reviewGroups.filter((g) => g.triage === 'auto').length} auto-classified`
              })()
        }
      >
        <BankReviewDrawerContent
          groups={reviewGroups}
          rows={bank.review.rows}
          counts={bank.review.counts}
          bankState={bank.state}
          plaidConfigured={plaidConfigured}
        />
      </Drawer>

      {/* Log Expense drawer — manual entry moved out of the main
          page layout into a focused drawer. Reachable from the
          "+ Log manual expense" link on Recent activity, or via
          Dashboard quick action which deep-links here with ?log=1. */}
      <Drawer
        open={drawer === 'log_expense'}
        onClose={() => setDrawer(null)}
        title="Log manual expense"
        subtitle="Cash, owner-paid, or one-off expenses"
      >
        <LogExpenseDrawerContent
          action={action}
          pending={pending}
          error={state?.error}
          locationId={locationId}
        />
      </Drawer>
    </div>
  )
}

// ================================================================
// Top summary
// ================================================================

// ----------------------------------------------------------------
// Truth labels.
//
// Finance mixes several kinds of money truth — system records,
// schedule-derived estimates, bank-detected activity — and the UI
// should not present them as equally final. Each surfaced number
// carries one of the labels below so the manager always sees what
// kind of fact they're looking at.
//
//   Recorded     — the system says it happened (sales, manual
//                  expenses, received restock orders).
//   Estimated    — the system expects it (e.g. schedule × rate).
//   Tracked      — bank-detected, not yet reviewed.
//   Needs review — bank activity that needs human classification.
//   Verified     — cleared / matched against a settlement. Reserved
//                  for a later pass; the current data layer can't
//                  produce verified spend honestly yet.
//
// "Operating view" is not a truth state — it's a perspective
// disclosure used by Net activity ("this is the in-app calculation,
// a bank-settled view will arrive via Bank Review"). It uses the
// same chip styling so the family reads as one piece.
// ----------------------------------------------------------------
type TruthLabel = 'Recorded' | 'Estimated' | 'Verified' | 'Tracked' | 'Needs review'

function TruthChip({ label }: { label: TruthLabel }) {
  const toneMap: Record<TruthLabel, string> = {
    'Recorded':     'bg-gray-100 text-gray-600',
    'Estimated':    'bg-amber-50 text-amber-700',
    'Verified':     'bg-green-50 text-green-700',
    'Tracked':      'bg-blue-50 text-blue-700',
    'Needs review': 'bg-amber-50 text-amber-800',
  }
  return (
    <span
      className={`inline-flex text-[9px] font-semibold uppercase tracking-[0.12em] px-1.5 py-0.5 rounded ${toneMap[label]}`}
    >
      {label}
    </span>
  )
}

// Inside-the-unified-card cell. Numbers are black; only the
// identity dot carries color. `truth` adds the small uppercase
// truth label next to the cell title so each top-level number
// declares what kind of fact it is. `onOpen` makes the cell
// clickable — each top card opens a drawer that explains the
// number in detail (Prompt 4: "Every Finance drawer has a job").
function SummaryCell({ label, dotClass, value, hint, empty, truth, onOpen }: {
  label: string; dotClass: string; value: string; hint: string; empty: boolean
  truth: TruthLabel
  onOpen?: () => void
}) {
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full ${dotClass} flex-shrink-0`} />
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">{label}</p>
          <TruthChip label={truth} />
        </div>
        <p className="text-[10px] text-gray-400 whitespace-nowrap flex-shrink-0">Last 7 days</p>
      </div>
      <p className={`mt-5 text-[30px] leading-none font-semibold tracking-tight font-mono tabular-nums ${empty ? 'text-gray-300' : 'text-gray-900'}`}>
        {value}
      </p>
      <p className="mt-3 text-xs text-gray-500">{hint}</p>
    </>
  )
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="text-left p-6 group hover:bg-gray-50/60 transition-colors w-full"
      >
        {body}
      </button>
    )
  }
  return <div className="p-6">{body}</div>
}

// Net activity cell — only metric whose value is colored.
// Green when positive, red when negative.
//
// `spend` here is the full deduction: internal logged expenses +
// recognized operating spend (bank outflows Plaid categorized).
// Unresolved bank activity is intentionally excluded — it's not
// recognized yet, so claiming it as "spend" would mislead.
//
// We label this the "operating view": it is the in-app calculation
// of revenue minus the spend signals Finance is currently aware of.
// A separate bank-settled view (bank inflows − bank outflows) is
// computable but intentionally not shown side-by-side here, because
// bank inflows include card-settlement deposits that represent
// already-counted sales — putting both nets next to each other
// without a verification engine would double-count and mislead.
// The Bank Review workflow planned for a later pass is what will
// reconcile the two views honestly.
function NetActivityCell({ value, hasAnyActivity, netPositive, revenue, spend, recognizedOperatingSpend, onOpen }: {
  value: number; hasAnyActivity: boolean; netPositive: boolean
  revenue: number; spend: number; recognizedOperatingSpend: number
  onOpen?: () => void
}) {
  const valueColor = !hasAnyActivity ? 'text-gray-300' : (netPositive ? 'text-green-700' : 'text-red-600')
  const dotClass = !hasAnyActivity ? 'bg-gray-300' : (netPositive ? 'bg-green-500' : 'bg-red-500')
  const hasRecognizedOperating = recognizedOperatingSpend > 0
  const hint = (() => {
    if (revenue > 0 && spend > 0) {
      const pct = Math.round((spend / revenue) * 100)
      const base = spend > revenue
        ? `Spending exceeds revenue · ${pct}% ratio`
        : `Spending is ${pct}% of revenue`
      return hasRecognizedOperating ? `${base} · incl. operating` : base
    }
    if (revenue > 0) return 'No spend recorded yet'
    if (spend > 0) return 'No sales recorded yet'
    return 'Log an expense or connect a bank to begin'
  })()

  const body = (
    <>
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
      <div className="mt-3 flex items-baseline gap-2 flex-wrap">
        <p className={`text-[36px] leading-none font-semibold tracking-tight font-mono tabular-nums ${valueColor}`}>
          {hasAnyActivity ? `${netPositive ? '' : '−'}${fmt(Math.abs(value))}` : '$0.00'}
        </p>
        <span className="text-[11px] font-medium text-gray-500 lowercase">operating view</span>
      </div>
      <p className="mt-3 text-xs text-gray-500">{hint}</p>
      <p className="mt-1 text-[10px] text-gray-400 leading-relaxed">
        Bank-settled view coming via Bank Review.
      </p>
    </>
  )
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="text-left p-6 group hover:bg-gray-50/60 transition-colors w-full"
      >
        {body}
      </button>
    )
  }
  return <div className="p-6">{body}</div>
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
  // Labor is an Estimate — scheduled hours × rate. Once clock-in/out
  // and payroll detection land, this card moves from Estimated to
  // Verified (paid hours from bank-confirmed payroll outflow).
  // Until then the truth chip and the supporting copy both say
  // estimated so the value can't be misread as a settled payroll
  // figure.
  const shareTag = sharePct > 0 ? ` · ${sharePct}% of spend` : ''

  switch (cards.laborState) {
    case 'ok': {
      const baseHint =
        cards.laborUnratedShiftCount > 0
          ? `From scheduled shifts · ${cards.laborRatedShiftCount} of ${cards.totalShiftCount} costed`
          : `From scheduled shifts · ${cards.laborRatedShiftCount} costed`
      return (
        <ClickableDriverCard
          accent={accent}
          label="Scheduled labor"
          period="This week"
          value={fmt(laborSpend)}
          valueMuted={false}
          hint={`${baseHint}${shareTag}`}
          truth="Estimated"
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
          truth="Estimated"
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
  // Inventory is Recorded — received restock orders + manually
  // logged inventory expenses. Bank PFC overlap exists but is NOT
  // a true line-level match against specific received orders, so
  // we don't claim verification yet. Subtext leads with the
  // settlement gap so the truth chip and the supporting copy align.
  const baseHint = (() => {
    if (!hasManual && !hasBankConfirm) return 'Mark expenses as inventory-related'
    if (hasManual && hasBankConfirm)   return 'Awaiting bank settlement · bank context available'
    if (hasBankConfirm)                return 'Awaiting bank settlement · bank context available'
    return 'Awaiting bank settlement'
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
      truth="Recorded"
      onOpen={onOpen}
    />
  )
}

// Operating card — third middle-row card. Represents business
// expenses outside Labor and Inventory (rent, utilities, marketing,
// subscriptions, insurance, repairs, bank fees, professional
// services, loan payments). Headline value is the de-duped
// Operating bucket from the Spend model: max(manual non-inventory
// expenses, bank non-inventory PFC outflows). The drawer breaks
// out bank-specific detail (categories, unresolved rows, accounts)
// for managers who want to dig in.
//
// Bank Review is a separate verification workflow, planned later —
// do not conflate it with the Operating expense category.
function OperatingCard({ bank, operatingSpend, sharePct, plaidConfigured, onOpen }: {
  bank: {
    externalSpend7d: number
    externalSpendCount7d: number
    unresolvedCount7d: number
    state: BankState
  }
  operatingSpend: number
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
            <p className="text-xs font-semibold text-gray-900">Operating</p>
          </div>
          <span className="text-[10px] text-gray-400">Optional</span>
        </div>
        <p className="text-[26px] leading-none font-semibold tracking-tight text-gray-300 font-mono tabular-nums">—</p>
        <p className="mt-3 text-xs text-gray-500 leading-relaxed mb-4">
          Connect a bank to surface operating expenses paid through your account — rent, utilities, marketing, subscriptions, fees.
        </p>
        <div className="mt-auto" onClick={(e) => e.stopPropagation()}>
          <ConnectBankButton configured={plaidConfigured} />
        </div>
      </div>
    )
  }

  // Identity dot is always teal — that signals "Operating".
  // The state pill (Live / Awaiting sync) shows operational state
  // separately so the two readings don't fight each other.
  const identityDot = 'bg-teal-500'
  const stateLabel = bank.state === 'connected_synced' ? 'Live' : 'Awaiting sync'
  const stateLabelTone = bank.state === 'connected_synced' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
  const stateDot = bank.state === 'connected_synced' ? 'bg-green-500' : 'bg-amber-500'

  // Truth label for the synced view:
  //   - Unresolved bank rows present → "Needs review" (amber). Bank
  //     activity sits uncategorized; manager attention is needed.
  //   - Otherwise → "Tracked" (blue). Bank rows are categorized
  //     but not yet verified against system records. A future
  //     Bank Review workflow promotes these to Verified.
  // No chip in the awaiting-sync state — there's no value to label.
  const operatingTruth: TruthLabel = bank.unresolvedCount7d > 0 ? 'Needs review' : 'Tracked'

  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left group rounded-xl border border-gray-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:border-gray-300 hover:shadow-[0_8px_20px_-8px_rgba(15,23,42,0.12),0_2px_4px_rgba(15,23,42,0.04)] transition-all"
    >
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full ${identityDot} flex-shrink-0`} />
          <p className="text-xs font-semibold text-gray-900">Operating</p>
          {bank.state === 'connected_synced' && <TruthChip label={operatingTruth} />}
        </div>
        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${stateLabelTone}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${stateDot}`} />
          {stateLabel}
        </span>
      </div>
      {bank.state === 'connected_unsynced' ? (
        <>
          <p className="text-[26px] leading-none font-semibold tracking-tight text-gray-400 font-mono tabular-nums">—</p>
          <div className="mt-3 flex items-end justify-between gap-2">
            <p className="text-xs text-gray-500 leading-relaxed">Bank linked · awaiting first sync</p>
            <span className="text-[10px] font-medium text-gray-400 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all flex-shrink-0">
              View →
            </span>
          </div>
        </>
      ) : (
        <>
          <p className="text-[10px] uppercase tracking-[0.14em] text-gray-400 font-medium mb-1">Operating spend · 7 days</p>
          <p className={`text-[26px] leading-none font-semibold tracking-tight font-mono tabular-nums ${operatingSpend === 0 ? 'text-gray-400' : 'text-gray-900'}`}>
            {fmt(operatingSpend)}
          </p>
          <div className="mt-3 flex items-end justify-between gap-2">
            <p className="text-xs text-gray-500 leading-relaxed">
              {(() => {
                const sharePart = sharePct > 0 ? ` · ${sharePct}% of spend` : ''
                const reviewPart = bank.unresolvedCount7d > 0 ? ' · bank review needed' : ''
                if (bank.externalSpendCount7d === 0 && operatingSpend === 0) {
                  return 'No operating spend detected'
                }
                const txnPart = bank.externalSpendCount7d === 0
                  ? null
                  : bank.unresolvedCount7d > 0
                    ? `${bank.externalSpendCount7d} bank txn${bank.externalSpendCount7d !== 1 ? 's' : ''} · ${bank.unresolvedCount7d} unresolved`
                    : `${bank.externalSpendCount7d} bank txn${bank.externalSpendCount7d !== 1 ? 's' : ''} · all categorized`
                return txnPart ? `${txnPart}${sharePart}${reviewPart}` : `Manual entries${sharePart}`
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
  accent, label, period, value, valueMuted, hint, truth, onOpen,
}: {
  accent: string; label: string; period: string; value: string
  valueMuted: boolean; hint: string; truth?: TruthLabel; onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left group rounded-xl border border-gray-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:border-gray-300 hover:shadow-[0_8px_20px_-8px_rgba(15,23,42,0.12),0_2px_4px_rgba(15,23,42,0.04)] transition-all"
    >
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full ${accent} flex-shrink-0`} />
          <p className="text-xs font-semibold text-gray-900">{label}</p>
          {truth && <TruthChip label={truth} />}
        </div>
        <span className="text-[10px] text-gray-400 flex-shrink-0">{period}</span>
      </div>
      <p className={`text-[26px] leading-none font-semibold tracking-tight font-mono tabular-nums ${valueMuted ? 'text-gray-400' : 'text-gray-900'}`}>
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
  accent, label, period, reason, truth, onOpen,
}: {
  accent: string; label: string; period: string; reason: string
  truth?: TruthLabel; onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left group rounded-xl border border-gray-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:border-gray-300 hover:shadow-[0_8px_20px_-8px_rgba(15,23,42,0.12),0_2px_4px_rgba(15,23,42,0.04)] transition-all"
    >
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full ${accent} opacity-50 flex-shrink-0`} />
          <p className="text-xs font-semibold text-gray-900">{label}</p>
          {truth && <TruthChip label={truth} />}
        </div>
        <span className="text-[10px] text-gray-400 flex-shrink-0">{period}</span>
      </div>
      <p className="text-[26px] leading-none font-semibold tracking-tight text-gray-300 font-mono tabular-nums">—</p>
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
        className={`fixed top-0 right-0 z-50 h-full w-full sm:max-w-md md:max-w-lg lg:max-w-md bg-white shadow-2xl border-l border-gray-200 flex flex-col transform transition-transform duration-200 ${
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
      <div className="grid grid-cols-3 rounded-xl border border-gray-200/80 divide-x divide-gray-100 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
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
          Receive a restock order or log an inventory-related expense. Entries appear here grouped by vendor.
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
      <div className="grid grid-cols-3 rounded-xl border border-gray-200/80 divide-x divide-gray-100 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
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
// Operating drawer — explanation/connect when not linked,
// summary + accounts + caveat when linked.
//
// Operating = business expenses outside Labor and Inventory (rent,
// utilities, marketing, subscriptions, insurance, repairs, bank
// fees, professional services, loan payments). Bank Review (a
// later verification workflow) is intentionally NOT built here.
// ----------------------------------------------------------------
function OperatingDrawerContent({ bank, plaidConfigured, plaidSandbox, isDev }: {
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
        <div className="rounded-xl border border-gray-200/80 bg-gray-50/60 p-5">
          <p className="text-sm font-semibold text-gray-900">What Operating covers</p>
          <p className="mt-1.5 text-[12px] text-gray-500 leading-relaxed">
            Operating expenses are business costs outside labor and inventory. Connect a bank to surface them automatically.
          </p>
          <ul className="mt-3 space-y-2.5 text-[12px] text-gray-600 leading-relaxed">
            <PreviewBullet>Rent, utilities, marketing, and subscriptions.</PreviewBullet>
            <PreviewBullet>Insurance, repairs, bank fees, professional services, and loan payments.</PreviewBullet>
            <PreviewBullet>Unresolved activity — transfers and uncategorized outflows shown separately.</PreviewBullet>
          </ul>
        </div>

        <div className="rounded-xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <p className="text-[11px] font-semibold text-gray-900">Connect a bank</p>
          <p className="mt-1 text-xs text-gray-500 leading-relaxed mb-4">
            Credentials stay server-side and owner-only. Disconnect anytime.
          </p>
          <ConnectBankButton configured={plaidConfigured} />
        </div>

        <div className="rounded-lg border border-gray-200/80 bg-gray-50/60 px-3 py-2.5">
          <p className="text-[11px] text-gray-600 leading-relaxed">
            Finance interprets bank activity as operating-spend context — never as revenue. Sales stay your source of truth.
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
      {/* Stats strip — operating spend, not inflow/outflow */}
      <div className="grid grid-cols-3 rounded-xl border border-gray-200/80 divide-x divide-gray-100 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <DrawerStat
          label="Operating spend"
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
          text={`${topCategory.label} is ${topCategoryShare}% of operating spend.`}
        />
      ) : unresolvedShare >= 30 && bank.unresolvedCount7d > 0 ? (
        <InsightLine
          accent="amber"
          text={`${unresolvedShare}% of bank-detected operating spend is uncategorized — likely worth a look.`}
        />
      ) : null}

      {/* Operating expenses — categorized outflows */}
      <DrawerSection title="Operating expenses">
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
            All recent bank activity is categorized.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-gray-500 leading-relaxed mb-2.5">
              Outflows the system can&apos;t confidently match yet.
            </p>
            <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200/80 bg-white overflow-hidden">
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
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200/80 bg-white overflow-hidden">
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

      {/* Honesty caveat — operating spend pulled from bank context */}
      <div className="rounded-lg border border-gray-200/80 bg-gray-50/60 px-3 py-2.5">
        <p className="text-[11px] text-gray-600 leading-relaxed">
          <strong>Bank-detected, not authoritative.</strong> Operating expenses pulled from bank activity reflect what&apos;s posted to your account — not your system record. Sales still come from inside the app.
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
      <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">{label}</p>
      <p className={`mt-1 text-base font-bold font-mono tabular-nums truncate ${valueClass}`}>{value}</p>
    </div>
  )
}

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-3 text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">{title}</p>
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

// ================================================================
// TOP-CARD DRAWERS (Prompt 4: each drawer answers a question)
//
// The three drawers below back the clickable top summary cells.
// They are deliberately compact — each one answers one question:
//
//   Revenue   → "How do recorded sales become settled money?"
//   Spend     → "What is in spend, and how true is it?"
//   Net       → "Why are operating net and bank net different?"
//
// They do NOT duplicate the Sales or Bank Review surfaces — they
// frame what the top number means and link out for detail.
// ================================================================

function RevenueDrawerContent({
  revenue7d,
  reviewRows,
  bankState,
}: {
  revenue7d: number
  reviewRows: BankReviewRow[]
  bankState: BankState
}) {
  // Settled-as-revenue bank inflows give us the "verified deposits"
  // number. The rest of recorded sales are still pending settlement.
  const settledRevenueRows = reviewRows.filter(
    (r) => r.reviewState === 'settled' && r.settledKind === 'revenue',
  )
  const settledRevenueTotal = settledRevenueRows.reduce((s, r) => s + r.amount, 0)
  const settledRevenueCount = settledRevenueRows.length

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 rounded-xl border border-gray-200/80 divide-x divide-gray-100 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <DrawerStat label="Recorded sales" value={fmt(revenue7d)} muted={revenue7d === 0} />
        <DrawerStat
          label="Verified deposits"
          value={bankState === 'not_connected' ? '—' : fmt(settledRevenueTotal)}
          muted={settledRevenueTotal === 0}
        />
      </div>

      <DrawerSection title="How the number is built">
        <ul className="space-y-2.5 text-[12px] text-gray-600 leading-relaxed">
          <PreviewBullet>
            <strong>Recorded sales.</strong> Every order rung up in the system. This is the
            headline number on the card.
          </PreviewBullet>
          <PreviewBullet>
            <strong>Card and cash settlement happen separately.</strong> Card sales become
            bank deposits when the processor batches them out — usually 1–2 business
            days later. Cash sales become deposits when someone walks them to the bank.
          </PreviewBullet>
          <PreviewBullet>
            <strong>Verified deposits</strong> are bank inflows you&apos;ve confirmed in Bank
            Review as &quot;Settle as revenue.&quot; They count {settledRevenueCount}
            {settledRevenueCount === 1 ? ' row' : ' rows'} this window.
          </PreviewBullet>
        </ul>
      </DrawerSection>

      <div className="rounded-lg border border-gray-200/80 bg-gray-50/60 px-3 py-2.5">
        <p className="text-[11px] text-gray-600 leading-relaxed">
          <strong>Recorded ≠ settled.</strong> Recorded sales are the system&apos;s record
          of what was rung up. They become settled cash when the bank deposit
          clears — and you confirm the match in Bank Review.
        </p>
      </div>
    </div>
  )
}

function SpendDrawerContent({
  laborSpend,
  inventorySpend,
  operatingSpend,
  totalSpend7d,
  reviewCounts,
  bankState,
}: {
  laborSpend: number
  inventorySpend: number
  operatingSpend: number
  totalSpend7d: number
  reviewCounts: Props['bank']['review']['counts']
  bankState: BankState
}) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 rounded-xl border border-gray-200/80 divide-x divide-gray-100 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <DrawerStat label="Tracked spend" value={fmt(totalSpend7d)} muted={totalSpend7d === 0} />
        <DrawerStat
          label="Needs review"
          value={bankState === 'not_connected' ? '—' : `${reviewCounts.unreviewed}`}
          muted={reviewCounts.unreviewed === 0}
        />
      </div>

      <DrawerSection title="Breakdown">
        <div className="space-y-2">
          <BreakdownRow
            primary="Labor"
            secondary="Estimated · scheduled hours × rate"
            value={fmt(laborSpend)}
            muted={laborSpend === 0}
          />
          <BreakdownRow
            primary="Inventory"
            secondary="Recorded · awaiting bank settlement"
            value={fmt(inventorySpend)}
            muted={inventorySpend === 0}
          />
          <BreakdownRow
            primary="Operating"
            secondary={
              reviewCounts.unreviewed > 0
                ? 'Tracked · bank review needed'
                : 'Tracked · bank context categorized'
            }
            value={fmt(operatingSpend)}
            muted={operatingSpend === 0}
          />
        </div>
      </DrawerSection>

      <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5">
        <p className="text-[11px] text-amber-800 leading-relaxed">
          <strong>Tracked, not verified.</strong> The spend number combines an estimate
          (Labor), recorded expenses (Inventory), and bank-categorized rows
          (Operating). Unreviewed bank activity does <em>not</em> count as verified
          business spend — settle it in Bank Review to lock it in.
        </p>
      </div>
    </div>
  )
}

function NetActivityDrawerContent({
  revenue,
  spend,
  bankInflow,
  bankOutflow,
  laborSpend,
  inventorySpend,
  reviewCounts,
  bankState,
}: {
  revenue: number
  spend: number
  bankInflow: number
  bankOutflow: number
  laborSpend: number
  inventorySpend: number
  reviewCounts: Props['bank']['review']['counts']
  bankState: BankState
}) {
  const operatingNet = revenue - spend
  const bankNet = bankInflow - bankOutflow
  const difference = operatingNet - bankNet
  const bankConnected = bankState !== 'not_connected'

  const opTone = operatingNet >= 0 ? 'text-green-700' : 'text-red-600'
  const bankTone = bankNet >= 0 ? 'text-green-700' : 'text-red-600'

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 rounded-xl border border-gray-200/80 divide-x divide-gray-100 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <div className="px-4 py-3">
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">Operating view</p>
          <p className={`mt-1 text-base font-bold font-mono tabular-nums ${opTone}`}>
            {operatingNet >= 0 ? '' : '−'}{fmt(Math.abs(operatingNet))}
          </p>
          <p className="text-[10px] text-gray-500 mt-0.5">Revenue − tracked spend</p>
        </div>
        <div className="px-4 py-3">
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">Bank view</p>
          <p className={`mt-1 text-base font-bold font-mono tabular-nums ${bankConnected ? bankTone : 'text-gray-300'}`}>
            {bankConnected ? `${bankNet >= 0 ? '' : '−'}${fmt(Math.abs(bankNet))}` : '—'}
          </p>
          <p className="text-[10px] text-gray-500 mt-0.5">Bank inflows − outflows</p>
        </div>
      </div>

      {bankConnected && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/40 px-3 py-2.5">
          <p className="text-[11px] text-blue-900 leading-relaxed">
            <strong>Difference: {difference >= 0 ? '' : '−'}{fmt(Math.abs(difference))}.</strong>{' '}
            Operating and bank views look at the same week from two angles. They
            rarely match exactly — settlement timing, estimates, and unreviewed
            rows create the gap.
          </p>
        </div>
      )}

      <DrawerSection title="What drives the difference">
        <ul className="space-y-2.5 text-[12px] text-gray-600 leading-relaxed">
          <PreviewBullet>
            <strong>Pending payouts.</strong> Recorded sales not yet deposited by the
            card processor. Show up in revenue, not yet in bank inflows.
          </PreviewBullet>
          <PreviewBullet>
            <strong>Estimated labor.</strong> Scheduled hours × rate is {fmt(laborSpend)} this
            week, but payroll has its own cadence. Not in bank outflows yet.
          </PreviewBullet>
          <PreviewBullet>
            <strong>Inventory awaiting settlement.</strong> Recorded restock orders sit at{' '}
            {fmt(inventorySpend)}. Bank-confirmed deductions are not line-matched yet.
          </PreviewBullet>
          <PreviewBullet>
            <strong>Unreviewed bank activity.</strong> {reviewCounts.unreviewed}{' '}
            {reviewCounts.unreviewed === 1 ? 'row' : 'rows'} pending review — count toward
            bank net but not toward verified spend.
          </PreviewBullet>
          <PreviewBullet>
            <strong>Register cash.</strong> Cash drawer counts and walked-deposit timing
            are out of scope for V1 — they show up later in the bank view.
          </PreviewBullet>
        </ul>
      </DrawerSection>
    </div>
  )
}

// ================================================================
// BANK REVIEW V1 — summary card + drawer + settlement actions
//
// The summary card replaces the old "Log expense" right-rail. It
// reads the review counts the server computed and offers a single
// CTA to open the full drawer. The drawer is where actual settle/
// ignore/not-a-match decisions happen, organized into Suggested
// matches (likely_match confidence), Incoming, and Outgoing queues
// for unreviewed rows, plus collapsible tails for the already-
// reviewed rows so the manager can undo.
// ================================================================
function BankReviewSummaryCard({
  counts,
  groupCount,
  attentionCount,
  autoCount,
  bankState,
  onOpen,
}: {
  counts: Props['bank']['review']['counts']
  groupCount: number
  attentionCount: number
  autoCount: number
  bankState: BankState
  onOpen: () => void
}) {
  if (bankState === 'not_connected') {
    return (
      <aside className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] p-6 flex flex-col min-h-[500px]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-gray-300" />
            <p className="text-xs font-semibold text-gray-900">Money Review</p>
          </div>
          <span className="text-[10px] text-gray-400">Not connected</span>
        </div>
        <p className="text-[26px] leading-none font-semibold tracking-tight text-gray-300 font-mono tabular-nums">—</p>
        <p className="mt-3 text-xs text-gray-500 leading-relaxed">
          Connect a bank to start verifying cash reality. Money Review surfaces
          deposits to confirm and exceptions — not every transaction.
        </p>
        <div className="mt-auto">
          <p className="text-[11px] text-gray-400">Exception triage · activates after bank sync</p>
        </div>
      </aside>
    )
  }

  const noWork = attentionCount === 0
  const dotTone =
    attentionCount >= 5
      ? 'bg-amber-500'
      : attentionCount > 0
        ? 'bg-blue-500'
        : 'bg-green-500'
  const statusChip =
    noWork
      ? { label: 'Caught up', tone: 'bg-green-50 text-green-700' }
      : { label: 'Needs attention', tone: 'bg-amber-50 text-amber-700' }

  return (
    <aside className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] p-6 flex flex-col min-h-[500px]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${dotTone}`} />
          <p className="text-xs font-semibold text-gray-900">Money Review</p>
        </div>
        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusChip.tone}`}>
          {statusChip.label}
        </span>
      </div>

      {/* Hero — TRUE attention required (deposits to confirm,
          exceptions, suggested personal). Auto-classified activity
          stays out of this number so the manager sees the real
          workload, not "236 things to review." */}
      <p className={`text-[34px] leading-none font-semibold tracking-tight font-mono tabular-nums ${noWork ? 'text-gray-300' : 'text-gray-900'}`}>
        {attentionCount}
      </p>
      <p className="mt-2 text-xs text-gray-500">
        {noWork
          ? 'All money movement is classified.'
          : `need${attentionCount === 1 ? 's' : ''} attention`}
      </p>
      <p className="mt-1 text-[11px] text-gray-500 font-mono tabular-nums">
        {autoCount} auto-classified
        <span className="text-gray-300 px-1">·</span>
        {counts.unreviewed} transaction{counts.unreviewed === 1 ? '' : 's'} scanned
      </p>

      {!noWork && (
        <div className="mt-5 space-y-2 text-[11px] text-gray-500">
          <div className="flex items-center justify-between">
            <span>Deposits to confirm</span>
            <span className="font-semibold font-mono tabular-nums text-gray-700">{counts.unreviewedInflow}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Outgoing exceptions</span>
            <span className="font-semibold font-mono tabular-nums text-gray-700">{counts.unreviewedOutflow}</span>
          </div>
        </div>
      )}

      <div className="mt-5 pt-4 border-t border-gray-100 space-y-1 text-[10px] text-gray-400">
        <div className="flex items-center justify-between">
          <span>Confirmed</span>
          <span className="font-medium font-mono tabular-nums">{counts.settled}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Marked personal</span>
          <span className="font-medium font-mono tabular-nums">{counts.ignored}</span>
        </div>
        {counts.notAMatch > 0 && (
          <div className="flex items-center justify-between">
            <span>Review later</span>
            <span className="font-medium font-mono tabular-nums">{counts.notAMatch}</span>
          </div>
        )}
        {groupCount > 0 && (
          <div className="flex items-center justify-between pt-1 mt-1 border-t border-gray-100">
            <span>Total groups</span>
            <span className="font-medium font-mono tabular-nums">{groupCount}</span>
          </div>
        )}
      </div>

      <div className="mt-auto pt-5">
        <button
          type="button"
          onClick={onOpen}
          className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
        >
          {noWork ? 'Open Money Review' : 'Review now →'}
        </button>
      </div>
    </aside>
  )
}

// ----------------------------------------------------------------
// BankReviewDrawerContent — priority-based Money Review workspace.
//
// Sections (in order):
//   1. Top stats strip            — need attention / auto-classified / confirmed / personal
//   2. Deposits to confirm        — every inflow group, attention tier
//   3. Exceptions                 — outflow attention groups (unclear / unknown / transfers / large)
//   4. Suggested personal         — personal attention tier
//   5. Auto-classified (collapsed)— outflow attention=auto, expanded on demand
//   6. Review later (rows)        — per-row, collapsible
//   7. Confirmed tail (rows)      — per-row, collapsible
//   8. Personal tail (rows)       — per-row, collapsible
//
// Triage tier is computed by groupBankTransactions() in matching.ts:
//   • inflow → always attention (deposits/income always matter)
//   • outflow + personal → personal
//   • outflow + suggestedKind + confidence + amount in tolerance → auto
//   • outflow + no suggestion / transfers / unknown / large unclear → attention
//
// Auto-classified is shown but NOT counted as required work; the
// hero "X need attention" excludes it. Manager can confirm in bulk
// from the collapsed section if they want extra audit pressure.
// ----------------------------------------------------------------
function BankReviewDrawerContent({
  groups,
  rows,
  counts,
  bankState,
  plaidConfigured,
}: {
  groups: BankReviewGroup[]
  rows: BankReviewRow[]
  counts: Props['bank']['review']['counts']
  bankState: BankState
  plaidConfigured: boolean
}) {
  const [showSettled, setShowSettled] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const [showReviewLater, setShowReviewLater] = useState(false)
  const [showAuto, setShowAuto] = useState(false)

  if (bankState === 'not_connected') {
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-gray-200/80 bg-gray-50/60 p-5">
          <p className="text-sm font-semibold text-gray-900">No bank connected</p>
          <p className="mt-1.5 text-[12px] text-gray-500 leading-relaxed">
            Connect a bank to see incoming deposits and outgoing exceptions.
            Money Review focuses on what needs your attention — not every
            transaction.
          </p>
        </div>
        <div className="rounded-xl border border-gray-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <ConnectBankButton configured={plaidConfigured} />
        </div>
      </div>
    )
  }

  const settled = rows.filter((r) => r.reviewState === 'settled')
  const ignored = rows.filter((r) => r.reviewState === 'ignored')
  const reviewLater = rows.filter((r) => r.reviewState === 'not_a_match')

  // Triage partition — drives section order. Inflow + outflow are
  // separated because their copy + primary actions differ.
  const depositsToConfirm = groups.filter((g) => g.direction === 'inflow' && g.triage === 'attention')
  const exceptions = groups.filter((g) => g.direction === 'outflow' && g.triage === 'attention')
  const suggestedPersonal = groups.filter((g) => g.triage === 'personal')
  const autoClassified = groups.filter((g) => g.triage === 'auto')

  const attentionTotal = depositsToConfirm.length + exceptions.length + suggestedPersonal.length

  return (
    <div className="space-y-6">
      {/* Top stats strip — Need attention is the headline; auto-
          classified counts as visibility, not work. */}
      <div className="grid grid-cols-4 rounded-xl border border-gray-200/80 divide-x divide-gray-100 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <DrawerStat label="Need attention" value={`${attentionTotal}`} muted={attentionTotal === 0} />
        <DrawerStat label="Auto-classified" value={`${autoClassified.length}`} muted={autoClassified.length === 0} />
        <DrawerStat label="Confirmed" value={`${counts.settled}`} muted={counts.settled === 0} />
        <DrawerStat label="Personal" value={`${counts.ignored}`} muted={counts.ignored === 0} />
      </div>

      {/* Opening orientation */}
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Money Review — confirm deposits, resolve exceptions, and verify cash
        reality. Normal recurring activity is auto-classified below.
      </p>

      {/* 1. Deposits to confirm */}
      <DrawerSection title={`Deposits to confirm${depositsToConfirm.length > 0 ? ` · ${depositsToConfirm.length}` : ''}`}>
        {depositsToConfirm.length === 0 ? (
          <p className="text-xs text-gray-400 italic">No incoming deposits waiting on a match.</p>
        ) : (
          <div className="space-y-2">
            {depositsToConfirm.map((group) => (
              <ReviewGroupCard key={group.key} group={group} />
            ))}
          </div>
        )}
      </DrawerSection>

      {/* 2. Exceptions */}
      {exceptions.length > 0 && (
        <DrawerSection title={`Exceptions · ${exceptions.length}`}>
          <p className="mb-2 text-[11px] text-gray-500 leading-relaxed">
            Outflows that didn&apos;t auto-classify — unknown vendors,
            transfers, or amounts large enough to want eyes on.
          </p>
          <div className="space-y-2">
            {exceptions.map((group) => (
              <ReviewGroupCard key={group.key} group={group} />
            ))}
          </div>
        </DrawerSection>
      )}

      {/* 3. Suggested personal */}
      {suggestedPersonal.length > 0 && (
        <DrawerSection title={`Suggested personal · ${suggestedPersonal.length}`}>
          <p className="mb-2 text-[11px] text-gray-500 leading-relaxed">
            Looks like personal spend — mark it so it stops counting against
            business totals.
          </p>
          <div className="space-y-2">
            {suggestedPersonal.map((group) => (
              <ReviewGroupCard key={group.key} group={group} />
            ))}
          </div>
        </DrawerSection>
      )}

      {/* 4. Auto-classified — collapsed by default. Visible for
          audit / override, not required work. */}
      {autoClassified.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowAuto((v) => !v)}
            className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate hover:text-gray-700 transition-colors flex items-center gap-1.5"
          >
            <span>{showAuto ? '▾' : '▸'}</span>
            Auto-classified · {autoClassified.length}
          </button>
          {!showAuto && (
            <p className="mt-1.5 text-[11px] text-gray-400 leading-relaxed">
              Normal recurring activity, already categorized. Open to confirm
              in bulk or override.
            </p>
          )}
          {showAuto && (
            <div className="mt-3 space-y-2">
              {autoClassified.map((group) => (
                <ReviewGroupCard key={group.key} group={group} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 5. Review later (not_a_match) — per-row */}
      {reviewLater.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowReviewLater((v) => !v)}
            className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate hover:text-gray-700 transition-colors flex items-center gap-1.5"
          >
            <span>{showReviewLater ? '▾' : '▸'}</span>
            Review later · {reviewLater.length}
          </button>
          {showReviewLater && (
            <div className="mt-3 space-y-2">
              {reviewLater.map((row) => (
                <ReviewRow key={row.id} row={row} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 6. Confirmed tail */}
      {settled.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowSettled((v) => !v)}
            className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate hover:text-gray-700 transition-colors flex items-center gap-1.5"
          >
            <span>{showSettled ? '▾' : '▸'}</span>
            Confirmed · {settled.length}
          </button>
          {showSettled && (
            <div className="mt-3 space-y-2">
              {settled.map((row) => (
                <ReviewRow key={row.id} row={row} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 7. Personal tail */}
      {ignored.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowIgnored((v) => !v)}
            className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate hover:text-gray-700 transition-colors flex items-center gap-1.5"
          >
            <span>{showIgnored ? '▾' : '▸'}</span>
            Personal · {ignored.length}
          </button>
          {showIgnored && (
            <div className="mt-3 space-y-2">
              {ignored.map((row) => (
                <ReviewRow key={row.id} row={row} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Honesty caveat */}
      <div className="rounded-lg border border-gray-200/80 bg-gray-50/60 px-3 py-2.5">
        <p className="text-[11px] text-gray-600 leading-relaxed">
          <strong>Truth model.</strong> Confirming an outflow records the bank
          amount as the settled value for that category. Operational records
          (inventory orders, scheduled labor, recorded sales) are never
          overwritten — both sides stay visible and auditable. Per-ticket
          expected-vs-settled display requires a follow-up schema pass and is
          intentionally deferred.
        </p>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// ReviewGroupCard — one card per bucketed pattern (Costco, HEB,
// Rent & utilities, etc.). Renders the group's suggested decision
// + one primary action, with secondary controls tucked behind a
// Change-category dropdown, an Ignore action, and a Review details
// drilldown that expands into the underlying transactions.
//
// Primary CTA logic:
//   • personal group               → primary action = Ignore
//   • inflow + revenue suggestion  → "Match to Sales"
//   • outflow + suggestion present → "Settle as {kind}"
//   • no suggestion                → "Review details" (no settle)
//
// Override path: the Change-category dropdown lets the manager
// pick any of the standard kinds (or mark for later) without hunting
// through five equal buttons.
// ----------------------------------------------------------------
function ReviewGroupCard({ group }: { group: BankReviewGroup }) {
  const [isPending, startTransition] = useTransition()
  const [showDetails, setShowDetails] = useState(false)
  const [overrideKind, setOverrideKind] = useState<string>('')

  const sign = group.direction === 'outflow' ? '−' : '+'
  const amountTone = group.direction === 'outflow' ? 'text-red-700' : 'text-green-700'
  const txnIdsCsv = group.txnIds.join(',')

  function callGroupAction(
    action:
      | typeof settleBankTransactionGroup
      | typeof ignoreBankTransactionGroup
      | typeof markBankTransactionGroupNotAMatch,
    kind?: SuggestedKind,
  ) {
    startTransition(async () => {
      const fd = new FormData()
      fd.append('txn_ids', txnIdsCsv)
      if (kind) fd.append('kind', kind)
      await action(null, fd)
    })
  }

  function onPrimaryClick() {
    if (group.personal) return callGroupAction(ignoreBankTransactionGroup)
    if (!group.suggestedKind) return setShowDetails(true)
    return callGroupAction(settleBankTransactionGroup, group.suggestedKind)
  }

  function onOverrideChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value
    setOverrideKind(value)
    if (!value) return
    if (value === 'ignore') {
      callGroupAction(ignoreBankTransactionGroup)
    } else if (value === 'review_later') {
      callGroupAction(markBankTransactionGroupNotAMatch)
    } else if (
      value === 'revenue' || value === 'inventory' || value === 'labor' || value === 'operating'
    ) {
      callGroupAction(settleBankTransactionGroup, value)
    }
    // Reset so a re-pick of the same override fires again next time.
    setOverrideKind('')
  }

  const primaryLabel = (() => {
    if (group.personal) return 'Mark personal'
    if (!group.suggestedKind) return 'Review details'
    if (group.direction === 'inflow' && group.suggestedKind === 'revenue') return 'Match to Sales Deposit'
    return `Confirm as ${prettyKind(group.suggestedKind)}`
  })()

  const suggestedLabel = group.personal
    ? 'Suggested as personal'
    : group.suggestedKind
      ? `Suggested: ${prettyKind(group.suggestedKind)}`
      : 'Suggested: review details'

  return (
    <div className="rounded-lg border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      {/* Header — name, amount */}
      <div className="px-3.5 py-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-gray-900 truncate">{group.label}</p>
          <p className="text-[11px] text-gray-500 mt-0.5 font-mono tabular-nums">
            {group.txnCount} transaction{group.txnCount === 1 ? '' : 's'}
          </p>
          <p className="text-[11px] text-gray-500 mt-1.5">
            <span className="font-medium text-gray-700">{suggestedLabel}</span>
            <span className="text-gray-300 px-1">·</span>
            <span>{group.reason}</span>
          </p>
        </div>
        <p className={`text-sm font-bold font-mono tabular-nums flex-shrink-0 ${amountTone}`}>
          {sign}${group.totalAmount.toFixed(2)}
        </p>
      </div>

      {/* Action row — one primary CTA + Change-category + drilldown */}
      <div className="px-3.5 pb-3 pt-1 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={isPending}
          onClick={onPrimaryClick}
          className="text-[10px] font-semibold uppercase tracking-[0.06em] px-2.5 py-1 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-gray-900 text-white hover:bg-gray-800"
        >
          {primaryLabel}
        </button>

        {/* Change-category dropdown — single override surface
            instead of a row of equal buttons. Empty option keeps
            the suggested decision; picking any concrete kind fires
            the corresponding action immediately. */}
        <label className="text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-600 inline-flex items-center gap-1 border border-gray-200 rounded-md px-2 py-1 hover:bg-gray-50 transition-colors cursor-pointer">
          <span>Change</span>
          <select
            value={overrideKind}
            onChange={onOverrideChange}
            disabled={isPending}
            className="text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-600 bg-transparent border-0 outline-none cursor-pointer disabled:cursor-not-allowed"
          >
            <option value="">…</option>
            {group.direction === 'inflow' ? (
              <option value="revenue">Sales Deposit</option>
            ) : (
              <>
                <option value="inventory">Inventory</option>
                <option value="labor">Labor</option>
                <option value="operating">Operating</option>
              </>
            )}
            <option value="ignore">Mark personal</option>
            <option value="review_later">Review later</option>
          </select>
        </label>

        {/* Mark-personal secondary — suppressed when the primary
            CTA is already Mark personal, so two equivalents never
            appear at once. */}
        {!group.personal && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => callGroupAction(ignoreBankTransactionGroup)}
            className="text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-600 hover:bg-gray-100 border border-gray-200 px-2 py-1 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Mark personal
          </button>
        )}

        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-500 hover:text-gray-700 ml-auto px-2 py-1 rounded-md transition-colors"
        >
          {showDetails ? 'Hide details' : 'Details'}
        </button>
      </div>

      {/* Drilldown — underlying transactions for this group. Each
          row is the same ReviewRow used by the Settled / Ignored
          tails, so the manager has per-row override available
          without leaving the group context. */}
      {showDetails && (
        <div className="border-t border-gray-100 px-3 py-3 bg-gray-50/40">
          <div className="space-y-2">
            {group.txns.map((txn) => {
              const fullRow: BankReviewRow = {
                id: txn.id,
                direction: txn.direction,
                amount: txn.amount,
                rawCategory: txn.rawCategory,
                merchantName: txn.merchantName,
                description: txn.description,
                postedAt: txn.postedAt,
                reviewState: 'unreviewed',
                settledKind: null,
              }
              return <ReviewRow key={txn.id} row={fullRow} />
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function prettyKind(kind: SuggestedKind): string {
  if (kind === 'revenue') return 'Sales'
  if (kind === 'inventory') return 'Inventory'
  if (kind === 'labor') return 'Labor'
  if (kind === 'operating') return 'Operating'
  return ''
}

// ----------------------------------------------------------------
// ReviewRow — a single bank row in the Bank Review drawer.
//
// Renders date, merchant/description, amount with direction tone,
// suggested-kind tag, and action buttons appropriate for the row's
// direction and current state. Actions go through useTransition so
// the route revalidates and the row migrates between queues on
// success without a hard reload.
// ----------------------------------------------------------------
function ReviewRow({ row }: { row: BankReviewRow }) {
  const [isPending, startTransition] = useTransition()
  const isOutflow = row.direction === 'outflow'
  const amountTone = isOutflow ? 'text-red-700' : 'text-green-700'
  const arrow = isOutflow ? '−' : '+'

  const suggested = suggestSettlementKind({
    direction: row.direction,
    amount: row.amount,
    rawCategory: row.rawCategory,
    merchantName: row.merchantName,
    description: row.description,
  })
  const personal = looksPersonal({
    direction: row.direction,
    amount: row.amount,
    rawCategory: row.rawCategory,
    merchantName: row.merchantName,
    description: row.description,
  })

  function call(action: typeof settleBankTransaction, kind?: SuggestedKind) {
    startTransition(async () => {
      const fd = new FormData()
      fd.append('txn_id', row.id)
      if (kind) fd.append('kind', kind)
      await action(null, fd)
    })
  }

  return (
    <div className="rounded-lg border border-gray-200/80 bg-white px-3 py-2.5">
      {/* Top line: merchant / amount */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-gray-900 truncate">
            {row.merchantName || row.description || 'Untitled transaction'}
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5 truncate">
            {new Date(row.postedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            {row.rawCategory && <> · {prettyCategory(row.rawCategory)}</>}
            {suggested && row.reviewState === 'unreviewed' && <> · suggests {suggested}</>}
            {personal && row.reviewState === 'unreviewed' && <> · looks personal</>}
            {row.reviewState === 'settled' && row.settledKind && (
              <> · settled as {row.settledKind}</>
            )}
          </p>
        </div>
        <p className={`text-sm font-bold font-mono tabular-nums flex-shrink-0 ${amountTone}`}>
          {arrow}${row.amount.toFixed(2)}
        </p>
      </div>

      {/* Action row */}
      <div className="mt-2.5 pt-2.5 border-t border-gray-100 flex flex-wrap gap-1.5">
        {row.reviewState === 'unreviewed' && (
          <>
            {isOutflow ? (
              <>
                <ActionButton
                  primary={suggested === 'inventory'}
                  disabled={isPending}
                  onClick={() => call(settleBankTransaction, 'inventory')}
                >
                  Confirm as inventory
                </ActionButton>
                <ActionButton
                  primary={suggested === 'labor'}
                  disabled={isPending}
                  onClick={() => call(settleBankTransaction, 'labor')}
                >
                  Confirm as labor
                </ActionButton>
                <ActionButton
                  primary={suggested === 'operating'}
                  disabled={isPending}
                  onClick={() => call(settleBankTransaction, 'operating')}
                >
                  Confirm as operating
                </ActionButton>
              </>
            ) : (
              <ActionButton
                primary={suggested === 'revenue'}
                disabled={isPending}
                onClick={() => call(settleBankTransaction, 'revenue')}
              >
                Match to Sales Deposit
              </ActionButton>
            )}
            <ActionButton
              primary={false}
              tone="ignore"
              disabled={isPending}
              onClick={() => call(ignoreBankTransaction)}
            >
              Mark personal
            </ActionButton>
            <ActionButton
              primary={false}
              tone="muted"
              disabled={isPending}
              onClick={() => call(markBankTransactionNotAMatch)}
            >
              Review later
            </ActionButton>
          </>
        )}
        {row.reviewState !== 'unreviewed' && (
          <ActionButton
            primary={false}
            tone="muted"
            disabled={isPending}
            onClick={() => call(reopenBankTransaction)}
          >
            Reopen
          </ActionButton>
        )}
      </div>
    </div>
  )
}

function ActionButton({
  children,
  onClick,
  primary,
  disabled,
  tone,
}: {
  children: React.ReactNode
  onClick: () => void
  primary: boolean
  disabled: boolean
  tone?: 'ignore' | 'muted'
}) {
  const base =
    'text-[10px] font-semibold uppercase tracking-[0.06em] px-2 py-1 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
  const palette = primary
    ? 'bg-gray-900 text-white hover:bg-gray-800'
    : tone === 'ignore'
      ? 'bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200'
      : tone === 'muted'
        ? 'text-gray-600 hover:bg-gray-100 border border-gray-200'
        : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${palette}`}>
      {children}
    </button>
  )
}

// Pretty-print a Plaid PFC primary into a short human label for the
// row meta line. Reuses the same mapping spirit as page.tsx's
// friendlyOperatingCategory but kept inline here so the drawer
// doesn't need a server round-trip for the labels.
function prettyCategory(raw: string): string {
  const map: Record<string, string> = {
    INCOME: 'income',
    TRANSFER_IN: 'transfer in',
    TRANSFER_OUT: 'transfer out',
    FOOD_AND_DRINK: 'food & drink',
    GENERAL_MERCHANDISE: 'merchandise',
    RENT_AND_UTILITIES: 'rent & utilities',
    GENERAL_SERVICES: 'services',
    ENTERTAINMENT: 'entertainment',
    BANK_FEES: 'bank fees',
    LOAN_PAYMENTS: 'loan payment',
    TRANSPORTATION: 'transportation',
    TRAVEL: 'travel',
    HOME_IMPROVEMENT: 'maintenance',
    MEDICAL: 'medical',
    PERSONAL_CARE: 'personal care',
    GOVERNMENT_AND_NON_PROFIT: 'government',
  }
  return map[raw] ?? raw.toLowerCase().replace(/_/g, ' ')
}

// ----------------------------------------------------------------
// LogExpenseDrawerContent — manual expense form inside a drawer.
// Same form as the prior right-rail QuickExpenseCard, just wrapped
// in drawer chrome. createExpense action unchanged.
// ----------------------------------------------------------------
function LogExpenseDrawerContent({
  action, pending, error, locationId,
}: {
  action: (fd: FormData) => void
  pending: boolean
  error?: string
  locationId: string
}) {
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="location_id" value={locationId} />

      <FormField label="Category" htmlFor="qa-category">
        <select
          id="qa-category"
          name="category"
          required
          defaultValue=""
          className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
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
            className="h-10 w-full rounded-lg border border-gray-200 bg-white pl-7 pr-3 text-sm font-mono tabular-nums placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
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
            className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
          />
        </FormField>
        <FormField label="Vendor" htmlFor="qa-vendor" optional>
          <input
            id="qa-vendor"
            name="vendor_name"
            type="text"
            placeholder="US Foods"
            className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
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

      <button
        type="submit"
        disabled={pending}
        className="h-10 w-full rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {pending ? 'Saving…' : 'Record expense'}
      </button>
    </form>
  )
}
