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
    const invState = readiness.inventory
    if (invState === 'not_started' || invState === 'setup_in_progress' || invState === 'ready') {
      readinessNotes.push({
        text: 'Inventory tracking isn\'t active yet — stock counts shown are setup data only.',
        href: '/settings',
      })
    } else if (invState === 'active_with_limitations') {
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

    if (readiness.finance === 'active_with_limitations') {
      readinessNotes.push({
        text: 'Finance is running on internal data only — bank sync not connected.',
        href: '/finance',
      })
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
      {/* ================================================================ */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{greeting}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {hasIssues
              ? `${alerts.length} thing${alerts.length > 1 ? 's' : ''} need${alerts.length === 1 ? 's' : ''} your attention`
              : 'Everything looks good right now'}
          </p>
        </div>
        <NotificationBell alerts={alerts} />
      </div>

      {/* ---- READINESS NOTES (honest, non-redesign cues) ---- */}
      {readinessNotes.length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-100 bg-amber-50/70 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-700 mb-2">Heads up</p>
          <ul className="space-y-1.5">
            {readinessNotes.map((note, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-amber-900">
                <span className="mt-1 w-1 h-1 rounded-full bg-amber-500 flex-shrink-0" />
                <span className="flex-1">{note.text}</span>
                <Link href={note.href} className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 whitespace-nowrap">
                  Review →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ================================================================ */}
      {/* 2. TOP ROW — 4 pillar cards                                      */}
      {/* ================================================================ */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 mb-8">
        <Link href="/sales" className="bg-white rounded-xl border border-gray-200 p-4 hover:border-blue-200 hover:shadow-sm transition-colors">
          <p className="text-xs font-semibold text-blue-600 uppercase tracking-widest">Sales</p>
          <p className="text-xl font-bold text-gray-900 mt-1.5">
            ${sales.salesToday.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">{sales.ordersToday} order{sales.ordersToday !== 1 ? 's' : ''} today</p>
        </Link>

        <Link href="/staffing" className={`rounded-xl border p-4 hover:shadow-sm transition-colors ${
          staffing.shiftsToday === 0 || staffing.employeeCount === 0
            ? 'bg-amber-50 border-amber-200 hover:border-amber-300'
            : 'bg-white border-gray-200 hover:border-amber-200'
        }`}>
          <p className="text-xs font-semibold text-amber-600 uppercase tracking-widest">Staff</p>
          <p className={`text-xl font-bold mt-1.5 ${
            staffing.shiftsToday === 0 || staffing.employeeCount === 0 ? 'text-amber-700' : 'text-gray-900'
          }`}>{staffing.shiftsToday} shift{staffing.shiftsToday !== 1 ? 's' : ''} today</p>
          <p className="text-xs text-gray-500 mt-0.5">{staffing.employeeCount} active employees</p>
        </Link>

        <Link href="/inventory" className={`rounded-xl border p-4 hover:shadow-sm transition-colors ${
          inventory.outOfStockCount > 0 ? 'bg-red-50 border-red-200 hover:border-red-300'
            : stockAlerts > 0 || inventory.noCountCount > 0 ? 'bg-amber-50 border-amber-200 hover:border-amber-300'
              : 'bg-white border-gray-200 hover:border-gray-300'
        }`}>
          <p className={`text-xs font-semibold uppercase tracking-widest ${
            inventory.outOfStockCount > 0 ? 'text-red-600' : stockAlerts > 0 || inventory.noCountCount > 0 ? 'text-amber-600' : 'text-gray-400'
          }`}>Inventory</p>
          <p className={`text-xl font-bold mt-1.5 ${
            inventory.outOfStockCount > 0 ? 'text-red-700' : stockAlerts > 0 ? 'text-amber-700' : 'text-gray-900'
          }`}>{stockAlerts > 0 ? `${stockAlerts} alert${stockAlerts !== 1 ? 's' : ''}` : 'All clear'}</p>
          <p className="text-xs text-gray-500 mt-0.5">{inventory.totalItems} items tracked</p>
        </Link>

        <Link href="/finance" className="bg-white rounded-xl border border-gray-200 p-4 hover:border-emerald-200 hover:shadow-sm transition-colors">
          <p className="text-xs font-semibold text-emerald-600 uppercase tracking-widest">Finance</p>
          <p className="text-xl font-bold text-gray-900 mt-1.5">
            ${finance.expenseTotal30d.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">{finance.expenseCount30d} expenses · 30d</p>
        </Link>
      </div>

      {/* ================================================================ */}
      {/* 3. MIDDLE — graphs + right support                               */}
      {/* ================================================================ */}
      <div className="grid gap-6 grid-cols-1 xl:grid-cols-12 mb-6">
        <div className="xl:col-span-9 grid gap-6 grid-cols-1 md:grid-cols-2">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-xs font-semibold text-blue-600 uppercase tracking-widest mb-4">Sales — last 7 days</h2>
            <SimpleLineChart data={salesByDay} color="#3b82f6" height={300} />
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-xs font-semibold text-amber-600 uppercase tracking-widest mb-4">Shifts — this week</h2>
            <SimpleBarChart data={shiftsByDay} color="#f97316" height={300} />
          </div>
        </div>

        {/* Right support — Inventory Watchlist (top, larger) + Next Up (bottom, smaller) */}
        <div className="xl:col-span-3 flex flex-col gap-3">

          {/* Inventory watchlist — shows actual problem items */}
          <div className="bg-white rounded-lg border border-gray-200 px-3.5 py-3 flex-1">
            <h2 className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Inventory watchlist</h2>
            {watchlist.length === 0 ? (
              <p className="text-xs text-gray-400 py-1">All items OK</p>
            ) : (
              <div className="space-y-1.5">
                {watchlist.map((item, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-xs text-gray-700 truncate mr-2">{item.name}</span>
                    <span className={`text-[10px] font-semibold flex-shrink-0 px-1.5 py-0.5 rounded ${
                      item.status === 'Out' ? 'bg-red-50 text-red-600'
                        : item.status === 'Low' ? 'bg-amber-50 text-amber-600'
                          : 'bg-gray-100 text-gray-500'
                    }`}>{item.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Next up — compact */}
          <div className="bg-white rounded-lg border border-gray-200 px-3.5 py-3">
            <h2 className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Next up</h2>
            {nextShift ? (
              <div>
                <p className="text-xs font-medium text-gray-900">{nextShift.employeeName} · {nextShift.role}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {new Date(nextShift.startTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  {' · '}
                  {new Date(nextShift.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  {' – '}
                  {new Date(nextShift.endTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </p>
              </div>
            ) : (
              <p className="text-xs text-gray-400">No upcoming shifts</p>
            )}
          </div>

        </div>
      </div>

      {/* ================================================================ */}
      {/* 4. BOTTOM — editable checklist + action needed + quick actions    */}
      {/* ================================================================ */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-3">

        {/* Editable checklist */}
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3.5">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Opening checklist</h2>
            <span className="text-[10px] text-gray-400">{checked.size}/{items.length}</span>
          </div>
          <div>
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
                      checked.has(i) ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
                    }`}>
                      {checked.has(i) && (
                        <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                    <span className={`text-xs ${checked.has(i) ? 'text-gray-400 line-through' : 'text-gray-700'}`}>{item}</span>
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
          </div>
          <div className="flex gap-1.5 mt-2">
            <input
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addItem() }}
              placeholder="Add item…"
              className="flex-1 text-xs px-2 py-1.5 rounded border border-gray-200 placeholder:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            />
            <button type="button" onClick={addItem} disabled={!newItem.trim()}
              className="text-[10px] font-medium text-blue-600 hover:text-blue-500 disabled:text-gray-300 px-1.5">Add</button>
          </div>
        </div>

        {/* Action needed — compact operational guidance */}
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3.5">
          <h2 className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2.5">Action needed</h2>
          {actionItems.length === 0 ? (
            <p className="text-xs text-gray-400 py-1">Nothing urgent right now</p>
          ) : (
            <div className="space-y-1">
              {actionItems.slice(0, 5).map((action, i) => (
                <Link key={i} href={action.href}
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-xs text-gray-700 hover:bg-gray-50 hover:text-gray-900 transition-colors">
                  <span className="w-1 h-1 rounded-full bg-amber-400 flex-shrink-0" />
                  {action.text}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Quick actions — exactly 4 */}
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3.5">
          <h2 className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2.5">Quick actions</h2>
          <div className="space-y-1">
            {[
              { label: 'Open POS', href: '/pos' },
              { label: 'Record inventory count', href: '/inventory/new-count' },
              { label: 'Log inventory transaction', href: '/inventory/new-transaction' },
              { label: 'Schedule shift', href: '/staffing' },
            ].map((action) => (
              <Link key={action.href} href={action.href}
                className="flex items-center justify-between px-3 py-2 rounded text-xs font-medium
                           text-gray-700 bg-gray-50 hover:bg-gray-100 hover:text-gray-900 transition-colors">
                {action.label}
                <span className="text-gray-400 text-[10px]">→</span>
              </Link>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}
