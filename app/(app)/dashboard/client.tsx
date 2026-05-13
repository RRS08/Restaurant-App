'use client'

// ----------------------------------------------------------------
// Dashboard V10 — Manager's Operational Home Screen
//
// Layout:
//   1. Header (greeting + bell)
//   2. Top row: 4 pillar snapshot cards
//   3. Middle: 2 graphs + right support (Inventory Watchlist + Next Up)
//   4. Bottom: Editable checklist + Action Needed + Quick Actions
// ----------------------------------------------------------------

import { useState } from 'react'
import Link from 'next/link'
import SimpleBarChart from '@/components/bar-chart'
import SimpleLineChart from '@/components/line-chart'
import NotificationBell, { type AlertItem } from '@/components/notification-bell'
import type { PillarKey, PillarState } from '@/lib/readiness'

interface Props {
  greeting: string
  readiness: Record<PillarKey, PillarState> | null
  /** True when at least one bank is `active=true` but no row has
   *  ever synced. Lets us show "waiting for first bank sync"
   *  separately from "no bank connected yet". */
  bankConnectedUnsynced?: boolean
  /** Mirrors the inventory write gate — `signals.inventory.activatedAt`
   *  is non-null. Intentionally distinct from `readiness.inventory`,
   *  which dev bypass can flip to 'active' without real writes
   *  happening. */
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
  salesByDay: { label: string; value: number }[]
  shiftsByDay: { label: string; value: number }[]
  watchlist: { name: string; status: 'Out' | 'Low' | 'No count' }[]
  recentOrders: {
    id: string
    totalAmount: number
    createdAt: string
    locationName: string | null
  }[]
  upcomingShifts: {
    id: string
    employeeName: string
    role: string
    startTime: string
    endTime: string
  }[]
  alerts: AlertItem[]
}

const DEFAULT_ITEMS = [
  'Review stock alerts',
  'Confirm today\'s staffing',
  'Check next incoming shift',
  'Record critical inventory counts',
  'Review recent sales activity',
]

export default function DashboardClient({
  greeting,
  readiness,
  bankConnectedUnsynced = false,
  inventoryWriteLive = false,
  inventory,
  staffing,
  sales,
  finance,
  salesByDay,
  shiftsByDay,
  watchlist,
  upcomingShifts,
  alerts,
}: Props) {
  const stockAlerts = inventory.outOfStockCount + inventory.lowStockCount
  const hasIssues = alerts.length > 0
  const nextShift = upcomingShifts[0] ?? null

  // Readiness-aware notes — small, honest, non-destructive cues that
  // sit at the top of the page when pillars are partial. Keeps the
  // dashboard from pretending inventory is live when it isn't, etc.
  const readinessNotes: { text: string; href: string }[] = []
  if (readiness) {
    // Inventory note uses the REAL write gate (inventoryWriteLive),
    // not the pillar state — pillar state can be flipped 'active'
    // by dev bypass without actual writes happening, and the note
    // should always reflect whether stock is moving for real.
    if (!inventoryWriteLive) {
      readinessNotes.push({
        text: 'Inventory tracking isn\'t active yet — stock counts shown are setup data only.',
        href: '/settings',
      })
    } else if (readiness.inventory === 'active_with_limitations') {
      readinessNotes.push({
        text: 'Inventory is active with limitations — some menu items are still unmapped.',
        href: '/settings',
      })
    }

    if (readiness.sales === 'setup_in_progress' || readiness.sales === 'not_started') {
      readinessNotes.push({
        text: 'Sales aren\'t flowing yet. Pick an operating mode to start ringing up orders.',
        href: '/settings',
      })
    }

    // Finance note now distinguishes three real states:
    //   • no bank connected        → "running on internal data only"
    //   • connected but unsynced   → "waiting for first bank sync"
    //   • connected and flowing    → no note
    if (readiness.finance === 'active_with_limitations') {
      if (bankConnectedUnsynced) {
        readinessNotes.push({
          text: 'Bank connected, waiting for first sync. Finance will reconcile once transactions arrive.',
          href: '/finance',
        })
      } else {
        readinessNotes.push({
          text: 'Finance is running on internal data only — bank sync not connected.',
          href: '/finance',
        })
      }
    }
  }

  // ---- Editable checklist state ----
  const [items, setItems] = useState<string[]>(DEFAULT_ITEMS)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [newItem, setNewItem] = useState('')

  const toggleCheck = (i: number) => {
    setChecked((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })
  }
  const removeItem = (i: number) => {
    setItems((prev) => prev.filter((_, idx) => idx !== i))
    setChecked((prev) => {
      const n = new Set<number>()
      prev.forEach((v) => { if (v < i) n.add(v); else if (v > i) n.add(v - 1) })
      return n
    })
  }
  const saveEdit = (i: number, text: string) => {
    if (text.trim()) setItems((prev) => prev.map((v, idx) => idx === i ? text.trim() : v))
    setEditingIdx(null)
  }
  const addItem = () => {
    if (newItem.trim()) { setItems((prev) => [...prev, newItem.trim()]); setNewItem('') }
  }

  // ---- Action needed items ----
  const actionItems: { text: string; href: string }[] = []
  if (inventory.outOfStockCount > 0)
    actionItems.push({ text: `Restock ${inventory.outOfStockCount} item${inventory.outOfStockCount > 1 ? 's' : ''}`, href: '/inventory' })
  if (inventory.lowStockCount > 0)
    actionItems.push({ text: `Review ${inventory.lowStockCount} low stock item${inventory.lowStockCount > 1 ? 's' : ''}`, href: '/inventory' })
  if (inventory.noCountCount > 0)
    actionItems.push({ text: `Count ${inventory.noCountCount} uncounted item${inventory.noCountCount > 1 ? 's' : ''}`, href: '/inventory/new-count' })
  if (staffing.shiftsToday === 0 && staffing.employeeCount > 0)
    actionItems.push({ text: 'Schedule shifts for today', href: '/staffing' })
  if (staffing.employeeCount === 0)
    actionItems.push({ text: 'Add your first employee', href: '/staffing' })
  if (sales.ordersToday === 0)
    actionItems.push({ text: 'Open POS to start selling', href: '/pos' })

  return (
    <div>

      {/* ================================================================ */}
      {/* 1. HEADER                                                        */}
      {/* Family pattern: title + subtitle on the left, bell on the right, */}
      {/* anchored by a bottom divider so the rest of the page reads as    */}
      {/* content beneath page chrome.                                     */}
      {/* ================================================================ */}
      <div className="mb-7 pb-5 border-b border-gray-100 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 leading-tight">{greeting}</h1>
          <p className="mt-1.5 text-sm text-gray-500 leading-relaxed">
            {hasIssues
              ? `${alerts.length} thing${alerts.length > 1 ? 's' : ''} need${alerts.length === 1 ? 's' : ''} your attention right now.`
              : 'Everything looks good right now.'}
          </p>
        </div>
        <NotificationBell alerts={alerts} />
      </div>

      {/* ---- READINESS NOTES (honest, non-redesign cues)
              Calmer amber treatment: thin left accent stripe + soft
              background. Family card chrome so it reads as a
              supporting alert surface, not a full alert banner. ---- */}
      {readinessNotes.length > 0 && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white overflow-hidden border-l-2 border-l-amber-300">
          <div className="px-5 py-3 border-b border-gray-100 bg-amber-50/30">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-700">
              Heads up
            </p>
          </div>
          <ul className="divide-y divide-gray-100">
            {readinessNotes.map((note, i) => (
              <li key={i} className="px-5 py-3 flex items-start gap-3 text-xs">
                <span
                  className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
                  aria-hidden="true"
                />
                <span className="flex-1 text-gray-700 leading-relaxed">{note.text}</span>
                <Link
                  href={note.href}
                  className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 whitespace-nowrap flex-shrink-0"
                >
                  Review →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ================================================================ */}
      {/* 2. TOP ROW — 4 pillar summary cards                              */}
      {/*                                                                  */}
      {/* Unified neutral chrome. Pillar identity comes from a small       */}
      {/* colored dot beside the eyebrow (Sales blue, Staff amber,         */}
      {/* Inventory gray, Finance emerald). State is conveyed by a soft    */}
      {/* left-edge border accent + value tone when warranted — never a   */}
      {/* full-card background tint, which kept the page feeling like      */}
      {/* alert tiles instead of product cards.                            */}
      {/* ================================================================ */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 mb-8">
        <PillarCard
          href="/sales"
          label="Sales"
          dot="bg-blue-500"
          value={`$${sales.salesToday.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
          sub={`${sales.ordersToday} order${sales.ordersToday !== 1 ? 's' : ''} today`}
        />

        <PillarCard
          href="/staffing"
          label="Staff"
          dot="bg-amber-500"
          value={`${staffing.shiftsToday} shift${staffing.shiftsToday !== 1 ? 's' : ''} today`}
          sub={`${staffing.employeeCount} active employee${staffing.employeeCount === 1 ? '' : 's'}`}
          state={
            staffing.shiftsToday === 0 || staffing.employeeCount === 0 ? 'warn' : 'normal'
          }
        />

        <PillarCard
          href="/inventory"
          label="Inventory"
          dot="bg-gray-400"
          value={stockAlerts > 0 ? `${stockAlerts} alert${stockAlerts !== 1 ? 's' : ''}` : 'All clear'}
          sub={`${inventory.totalItems} items tracked`}
          state={
            inventory.outOfStockCount > 0
              ? 'critical'
              : stockAlerts > 0 || inventory.noCountCount > 0
                ? 'warn'
                : 'normal'
          }
        />

        <PillarCard
          href="/finance"
          label="Finance"
          dot="bg-emerald-500"
          value={`$${finance.expenseTotal30d.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
          sub={`${finance.expenseCount30d} expense${finance.expenseCount30d === 1 ? '' : 's'} · 30d`}
        />
      </div>

      {/* ================================================================ */}
      {/* 3. MIDDLE — graphs + right support                               */}
      {/* Family chrome on the chart cards (header band + body), neutral   */}
      {/* eyebrows, calmer chart heights matching Analytics' rhythm.       */}
      {/* ================================================================ */}
      <div className="grid gap-4 grid-cols-1 xl:grid-cols-12 mb-6">
        <div className="xl:col-span-9 grid gap-4 grid-cols-1 md:grid-cols-2">
          <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
            <div className="border-b border-gray-100 px-5 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                Sales rhythm
              </p>
              <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                Daily revenue over the last 7 days.
              </p>
            </div>
            <div className="px-5 py-4">
              <SimpleLineChart data={salesByDay} color="#3b82f6" height={200} />
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
            <div className="border-b border-gray-100 px-5 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                Shift coverage
              </p>
              <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                Scheduled shifts per day this week.
              </p>
            </div>
            <div className="px-5 py-4">
              <SimpleBarChart data={shiftsByDay} color="#f59e0b" height={200} />
            </div>
          </div>
        </div>

        {/* Right support — Inventory Watchlist + Next Up.
            Same rounded-xl family chrome as the top cards. Each is a
            two-band card (header band with eyebrow, body band with
            content) so the rail rhymes with the chart cards. */}
        <div className="xl:col-span-3 flex flex-col gap-4">

          {/* Inventory watchlist */}
          <div className="rounded-xl border border-gray-200 bg-white overflow-hidden flex-1 flex flex-col">
            <div className="border-b border-gray-100 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                Inventory watchlist
              </p>
            </div>
            {watchlist.length === 0 ? (
              <p className="flex-1 px-4 py-5 text-xs text-gray-400 text-center">
                All items in good standing.
              </p>
            ) : (
              <ul className="flex-1 divide-y divide-gray-100">
                {watchlist.map((item, i) => {
                  const tone =
                    item.status === 'Out'
                      ? { dot: 'bg-red-500', text: 'text-red-700' }
                      : item.status === 'Low'
                        ? { dot: 'bg-amber-500', text: 'text-amber-700' }
                        : { dot: 'bg-gray-400', text: 'text-gray-500' }
                  return (
                    <li key={i} className="px-4 py-2.5 flex items-center gap-2.5">
                      <span
                        className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${tone.dot}`}
                        aria-hidden="true"
                      />
                      <span className="text-xs text-gray-800 truncate flex-1">
                        {item.name}
                      </span>
                      <span className={`text-[10px] font-semibold flex-shrink-0 ${tone.text}`}>
                        {item.status}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {/* Next up */}
          <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
            <div className="border-b border-gray-100 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                Next up
              </p>
            </div>
            <div className="px-4 py-3">
              {nextShift ? (
                <>
                  <p className="text-xs font-semibold text-gray-900 truncate">
                    {nextShift.employeeName} · {nextShift.role}
                  </p>
                  <p className="mt-1 text-[11px] text-gray-500 tabular-nums leading-relaxed">
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

        </div>
      </div>

      {/* ================================================================ */}
      {/* 4. BOTTOM — opening checklist + action needed + quick actions     */}
      {/* All three share the family chrome (rounded-xl, two-band card,    */}
      {/* eyebrow header band + body) so the bottom row reads as a         */}
      {/* coherent triplet rather than three mismatched widget tiles.      */}
      {/* ================================================================ */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-3">

        {/* Editable checklist */}
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden flex flex-col">
          <div className="border-b border-gray-100 px-4 py-3 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Opening checklist
            </p>
            <span className="text-[10px] tabular-nums text-gray-400">
              {checked.size}/{items.length}
            </span>
          </div>
          <div className="px-4 py-3 flex-1">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2 group">
                {editingIdx === i ? (
                  <input
                    autoFocus
                    defaultValue={item}
                    onBlur={(e) => saveEdit(i, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(i, (e.target as HTMLInputElement).value) }}
                    className="flex-1 text-xs px-1.5 py-1.5 rounded border border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                ) : (
                  <button type="button" onClick={() => toggleCheck(i)}
                    className="flex items-center gap-2.5 flex-1 px-1.5 py-1.5 rounded text-left hover:bg-gray-50 transition-colors">
                    <span className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      checked.has(i) ? 'bg-gray-900 border-gray-900' : 'border-gray-300'
                    }`}>
                      {checked.has(i) && (
                        <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                    <span className={`text-xs ${checked.has(i) ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                      {item}
                    </span>
                  </button>
                )}
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <button type="button" onClick={() => setEditingIdx(i)} className="text-gray-300 hover:text-gray-500 p-0.5" title="Edit">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                  <button type="button" onClick={() => removeItem(i)} className="text-gray-300 hover:text-red-400 p-0.5" title="Remove">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
            <div className="flex gap-1.5 mt-2">
              <input
                value={newItem}
                onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addItem() }}
                placeholder="Add item…"
                className="flex-1 text-xs px-2 py-1.5 rounded border border-gray-200 placeholder:text-gray-300 focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
              />
              <button type="button" onClick={addItem} disabled={!newItem.trim()}
                className="text-[10px] font-semibold text-gray-700 hover:text-gray-900 disabled:text-gray-300 px-1.5">
                Add
              </button>
            </div>
          </div>
        </div>

        {/* Action needed */}
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Action needed
            </p>
          </div>
          {actionItems.length === 0 ? (
            <p className="px-4 py-5 text-xs text-gray-400 text-center">
              Nothing urgent right now.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {actionItems.slice(0, 5).map((action, i) => (
                <li key={i}>
                  <Link
                    href={action.href}
                    className="flex items-center gap-2.5 px-4 py-2.5 text-xs text-gray-800 hover:bg-gray-50 transition-colors"
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
                      aria-hidden="true"
                    />
                    <span className="flex-1 truncate">{action.text}</span>
                    <span className="text-gray-400 text-[10px] flex-shrink-0">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Quick actions */}
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Quick actions
            </p>
          </div>
          <ul className="px-4 py-3 space-y-1.5">
            {[
              { label: 'Open POS', href: '/pos' },
              { label: 'Record inventory count', href: '/inventory/new-count' },
              { label: 'Log inventory transaction', href: '/inventory/new-transaction' },
              { label: 'Schedule shift', href: '/staffing' },
            ].map((action) => (
              <li key={action.href}>
                <Link
                  href={action.href}
                  className="flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 hover:text-gray-900 transition-colors"
                >
                  {action.label}
                  <span className="text-gray-400 text-[10px]">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>

      </div>
    </div>
  )
}

// ================================================================
// PillarCard — top-row summary tile. Unified white chrome; pillar
// identity via a small colored dot; state via a thin left-edge
// border accent and value tone. Never tints the whole card.
// ================================================================
function PillarCard({
  href,
  label,
  dot,
  value,
  sub,
  state = 'normal',
}: {
  href: string
  label: string
  dot: string
  value: string
  sub: string
  state?: 'normal' | 'warn' | 'critical'
}) {
  const accent =
    state === 'critical'
      ? 'border-l-2 border-l-red-300'
      : state === 'warn'
        ? 'border-l-2 border-l-amber-300'
        : ''
  const valueTone =
    state === 'critical'
      ? 'text-red-700'
      : state === 'warn'
        ? 'text-amber-700'
        : 'text-gray-900'
  return (
    <Link
      href={href}
      className={`rounded-xl border border-gray-200 bg-white p-4 hover:border-gray-300 hover:shadow-sm transition-colors block ${accent}`}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
          {label}
        </p>
      </div>
      <p className={`mt-2 text-xl font-bold tabular-nums leading-tight ${valueTone}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-gray-500">{sub}</p>
    </Link>
  )
}
