'use client'

// ----------------------------------------------------------------
// Inventory Client
//
// Operational workspace:
//   header → modern toolbar → paginated stock table → activity feed
// Clicking a row opens an item detail slide-over with threshold +
// count actions.
// ----------------------------------------------------------------

import { useState, useRef, useEffect, useMemo, useActionState } from 'react'
import Link from 'next/link'
import {
  updateThreshold,
  archiveInventoryItem,
  deleteInventoryItem,
  createInventoryCount,
  createInventoryItem,
} from '@/app/actions/inventory'

interface Item {
  id: string; name: string; unitOfMeasure: string; threshold: number
  estimated: number | null; lastCount: number | null; status: 'no_count' | 'out' | 'low' | 'ok'
  recipeLinks: number; hasDependencies: boolean
}

interface Transaction {
  id: string; itemName: string; type: string; qty: number; note: string | null; date: string
}

const STATUS = {
  no_count: { label: 'No count', color: 'bg-gray-100 text-gray-600', dot: 'bg-gray-400' },
  out:      { label: 'Out',      color: 'bg-red-50 text-red-700',    dot: 'bg-red-500' },
  low:      { label: 'Low',      color: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  ok:       { label: 'OK',       color: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
} as const

const STATUS_ORDER: Record<Item['status'], number> = { out: 0, low: 1, no_count: 2, ok: 3 }
type Filter = 'all' | 'out' | 'low' | 'no_count'

const PAGE_SIZE = 12
const ACTIVITY_LIMIT = 8

export default function InventoryClient({ items, transactions }: { items: Item[]; transactions: Transaction[] }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // Track how many items exist so we can auto-close the create card
  // once revalidation has delivered the new row.
  const itemCountRef = useRef(items.length)
  useEffect(() => {
    if (creating && items.length > itemCountRef.current) setCreating(false)
    itemCountRef.current = items.length
  }, [items.length, creating])

  const counts = useMemo(() => ({
    out: items.filter((i) => i.status === 'out').length,
    low: items.filter((i) => i.status === 'low').length,
    no_count: items.filter((i) => i.status === 'no_count').length,
    total: items.length,
  }), [items])

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items
      .filter((i) => {
        if (q && !i.name.toLowerCase().includes(q)) return false
        if (filter === 'all') return true
        return i.status === filter
      })
      .sort((a, b) => {
        const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
        return d !== 0 ? d : a.name.localeCompare(b.name)
      })
  }, [items, query, filter])

  // Reset to page 1 whenever the filter/search changes the dataset
  useEffect(() => { setPage(1) }, [query, filter])

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * PAGE_SIZE
  const pageItems = filteredItems.slice(pageStart, pageStart + PAGE_SIZE)

  const selectedItem = selectedId ? items.find((i) => i.id === selectedId) ?? null : null

  // Keep the selected item's data fresh when server revalidation returns new items
  useEffect(() => {
    if (selectedId && !items.find((i) => i.id === selectedId)) setSelectedId(null)
  }, [items, selectedId])

  return (
    <div className="max-w-[1400px]">

      {/* ---- HEADER (title + mobile-only new item link) ---- */}
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
          <p className="mt-1 text-sm text-gray-500">Monitor stock health and take action on urgent items.</p>
        </div>
        {/* Mobile-only fallback — desktop uses the right-rail inline flow */}
        <Link href="/inventory/new-item"
          className="lg:hidden flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors">
          + New item
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-lg font-medium text-gray-400">No inventory items yet</p>
          <p className="mt-1 text-sm text-gray-300">Add ingredients and products to start tracking stock.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">

          {/* ================= LEFT / MAIN COLUMN ================= */}
          <div className="min-w-0">

            {/* ---- TOOLBAR: search (grows) + clickable summary chips (right) ---- */}
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm px-3 py-2.5 mb-4 flex flex-col lg:flex-row lg:items-center gap-3">
              <div className="relative lg:flex-1 lg:min-w-0">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
                </svg>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search items…"
                  className="w-full rounded-lg bg-gray-50 border border-transparent pl-9 pr-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:bg-white focus:border-blue-300 focus:ring-2 focus:ring-blue-100 transition"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 lg:ml-auto lg:flex-shrink-0">
                <SummaryChip tone="red"    label="Out"      value={counts.out}      active={filter === 'out'}      onClick={() => setFilter(filter === 'out' ? 'all' : 'out')} />
                <SummaryChip tone="amber"  label="Low"      value={counts.low}      active={filter === 'low'}      onClick={() => setFilter(filter === 'low' ? 'all' : 'low')} />
                <SummaryChip tone="gray"   label="No count" value={counts.no_count} active={filter === 'no_count'} onClick={() => setFilter(filter === 'no_count' ? 'all' : 'no_count')} />
                <SummaryChip tone="blue"   label="Total"    value={counts.total}    active={filter === 'all'}      onClick={() => setFilter('all')} />
              </div>
            </div>

            {/* ---- STOCK TABLE ---- */}
            <section className="mb-4">
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left bg-gray-50/60">
                      <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Item</th>
                      <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide text-right">Est. stock</th>
                      <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide text-right">Threshold</th>
                      <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                      <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide text-right w-12"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {pageItems.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-5 py-10 text-center text-sm text-gray-400">
                          No items match this filter.
                        </td>
                      </tr>
                    ) : pageItems.map((item) => (
                      <ItemRow key={item.id} item={item}
                        selected={item.id === selectedId}
                        onOpen={() => setSelectedId(item.id)} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {filteredItems.length > PAGE_SIZE && (
                <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                  <p>
                    Showing <span className="font-semibold text-gray-700">{pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredItems.length)}</span> of <span className="font-semibold text-gray-700">{filteredItems.length}</span>
                  </p>
                  <div className="inline-flex items-stretch rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={safePage === 1}
                      aria-label="Previous page"
                      className="px-3 py-1.5 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <div className="px-4 py-1.5 border-l border-r border-gray-200 bg-gray-50/60 text-gray-700 tabular-nums flex items-center">
                      <span className="font-semibold text-gray-900">{safePage}</span>
                      <span className="mx-1 text-gray-400">/</span>
                      <span>{totalPages}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage === totalPages}
                      aria-label="Next page"
                      className="px-3 py-1.5 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* Activity feed — on small screens only (desktop has it in the rail) */}
            <div className="lg:hidden">
              {transactions.length > 0 && <ActivityFeed transactions={transactions} />}
            </div>
          </div>

          {/* ================= RIGHT / SUPPORT RAIL (desktop only) ================= */}
          <aside className="hidden lg:block">
            <div className="sticky top-4 space-y-4">
              {creating
                ? <CreateItemCard onCancel={() => setCreating(false)} />
                : selectedItem
                  ? <ItemDetailPanel embedded item={selectedItem} onClose={() => setSelectedId(null)} />
                  : <NewItemRailCard onStartCreate={() => { setSelectedId(null); setCreating(true) }} />}
              {transactions.length > 0 && <ActivityFeed transactions={transactions} />}
            </div>
          </aside>
        </div>
      )}

      {/* ---- MOBILE SLIDE-OVER (only below lg, only when an item is selected) ---- */}
      {selectedItem && (
        <div className="lg:hidden">
          <ItemDetailPanel item={selectedItem} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// SummaryChip — clickable status summary that doubles as a filter.
// Active state is visually obvious via a filled tone + ring.
// ----------------------------------------------------------------
function SummaryChip({ tone, label, value, active, onClick }: {
  tone: 'red' | 'amber' | 'gray' | 'blue'
  label: string
  value: number
  active: boolean
  onClick: () => void
}) {
  const palette = {
    red:   { dot: 'bg-red-500',   activeBg: 'bg-red-50 border-red-300 ring-red-200',       idleText: 'text-red-700',   activeText: 'text-red-800' },
    amber: { dot: 'bg-amber-500', activeBg: 'bg-amber-50 border-amber-300 ring-amber-200', idleText: 'text-amber-700', activeText: 'text-amber-800' },
    gray:  { dot: 'bg-gray-400',  activeBg: 'bg-gray-100 border-gray-300 ring-gray-200',   idleText: 'text-gray-600',  activeText: 'text-gray-800' },
    blue:  { dot: 'bg-blue-500',  activeBg: 'bg-blue-50 border-blue-300 ring-blue-200',    idleText: 'text-gray-600',  activeText: 'text-blue-800' },
  }[tone]

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-all ${
        active
          ? `${palette.activeBg} ring-2 shadow-sm ${palette.activeText}`
          : `bg-white border-gray-200 ${palette.idleText} hover:border-gray-300 hover:bg-gray-50`
      }`}
    >
      <span className={`w-2 h-2 rounded-full ${palette.dot}`} />
      <span>{label}</span>
      <span className={`text-sm font-bold tabular-nums ${active ? palette.activeText : 'text-gray-900'}`}>{value}</span>
    </button>
  )
}

// ----------------------------------------------------------------
// ThresholdStat — compact stat cell for the top summary grid.
// Displays as a small value with an Edit affordance; clicking Edit
// swaps the value in place for an inline input. Save only appears
// when the value is dirty; auto-collapses on success.
// ----------------------------------------------------------------
function ThresholdStat({ value, onChange, onSave, dirty, saving, saved, unit, editing, onEditingChange }: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  dirty: boolean
  saving: boolean
  saved: boolean
  unit: string
  editing: boolean
  onEditingChange: (editing: boolean) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])
  useEffect(() => { if (saved) onEditingChange(false) }, [saved, onEditingChange])

  if (editing) {
    // Extremely minimal inline editor — no card frame, no eyebrow.
    // Reads as a quick settings tweak, visually quiet.
    return (
      <div className="rounded-xl bg-amber-50/60 border border-amber-100 p-3 flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <input
            ref={inputRef}
            type="number"
            min="0"
            step="0.01"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full bg-transparent border-0 border-b border-amber-300 px-0 py-1 pr-8 text-base font-mono font-bold tabular-nums text-amber-900 focus:outline-none focus:border-amber-500"
          />
          <span className="absolute right-1 bottom-1 text-[10px] text-amber-600/70">{unit}</span>
        </div>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          aria-label="Save threshold"
          className="text-amber-700 hover:text-amber-900 disabled:opacity-30 disabled:cursor-not-allowed p-1 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => onEditingChange(false)}
          aria-label="Cancel"
          className="text-gray-400 hover:text-gray-600 p-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    )
  }

  // Display mode — compact stat with Edit pinned bottom-right
  return (
    <div className="relative rounded-xl bg-amber-50/60 border border-amber-100 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-700">Threshold</p>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-xl font-bold font-mono tabular-nums text-amber-900">
          {parseFloat(value || '0').toFixed(2)}
        </span>
        <span className="text-[10px] text-amber-600/70">{unit}</span>
      </div>
      <div className="absolute bottom-1.5 right-2 flex items-center gap-1.5">
        {saved ? (
          <span className="text-[10px] font-semibold text-green-600">Saved ✓</span>
        ) : (
          <button
            type="button"
            onClick={() => onEditingChange(true)}
            className="text-[10px] font-semibold text-amber-700 hover:text-amber-900 uppercase tracking-wide"
          >
            Edit
          </button>
        )}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// NewItemRailCard — calm default empty state. Same rail card
// family as the selected item card. Clicking + New item swaps
// the rail into the inline CreateItemCard flow on the same page.
// ----------------------------------------------------------------
function NewItemRailCard({ onStartCreate }: { onStartCreate: () => void }) {
  return (
    <aside className="rounded-xl border border-gray-200 bg-white shadow-sm p-6 flex flex-col items-center text-center">
      <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </div>
      <h2 className="mt-3 text-sm font-semibold text-gray-900">No item selected</h2>
      <p className="mt-1 text-xs text-gray-500 leading-relaxed max-w-[240px]">
        Pick an item from the list to review it, or create a new one to start tracking.
      </p>
      <button
        type="button"
        onClick={onStartCreate}
        className="mt-5 inline-flex items-center justify-center w-full rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700 shadow-sm transition-colors"
      >
        + New item
      </button>
    </aside>
  )
}

// ----------------------------------------------------------------
// CreateItemCard — inline new-inventory-item form. Reuses the
// existing createInventoryItem server action so validation and
// persistence stay identical to the standalone page.
// ----------------------------------------------------------------
function CreateItemCard({ onCancel }: { onCancel: () => void }) {
  const [state, action, pending] = useActionState(createInventoryItem, null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => { nameRef.current?.focus() }, [])

  return (
    <aside className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-gray-100 px-5 py-3 flex items-start justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">New item</p>
          <h2 className="text-base font-bold text-gray-900 mt-0.5">New inventory item</h2>
        </div>
        <button type="button" onClick={onCancel} aria-label="Cancel"
          className="text-gray-400 hover:text-gray-600 p-1 -mt-1 -mr-1">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <form action={action} className="p-5 space-y-4">
        <div>
          <label htmlFor="ci-name" className="block text-[11px] font-semibold text-gray-600 mb-1">
            Item name
          </label>
          <input
            ref={nameRef}
            id="ci-name"
            name="name"
            type="text"
            required
            placeholder="e.g. Mozzarella, Olive oil, Napkins"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
          />
        </div>

        <div>
          <label htmlFor="ci-unit" className="block text-[11px] font-semibold text-gray-600 mb-1">
            Unit of measure
          </label>
          <select
            id="ci-unit"
            name="unit_of_measure"
            defaultValue="units"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
          >
            <option value="units">Units (each)</option>
            <option value="kg">Kilograms (kg)</option>
            <option value="lbs">Pounds (lbs)</option>
            <option value="liters">Liters</option>
            <option value="gallons">Gallons</option>
            <option value="oz">Ounces (oz)</option>
            <option value="cases">Cases</option>
            <option value="bags">Bags</option>
          </select>
        </div>

        <div>
          <label htmlFor="ci-threshold" className="block text-[11px] font-semibold text-gray-600 mb-1">
            Low stock threshold
          </label>
          <input
            id="ci-threshold"
            name="low_stock_threshold"
            type="number"
            min="0"
            step="0.01"
            defaultValue="5"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
          />
        </div>

        {state?.error && (
          <p className="text-[11px] text-red-600">{state.error}</p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 shadow-sm disabled:opacity-60 transition-colors"
          >
            {pending ? 'Creating…' : 'Create item'}
          </button>
        </div>
      </form>
    </aside>
  )
}

// ----------------------------------------------------------------
// ItemRow — interactive row, clicks open the detail panel
// ----------------------------------------------------------------
function ItemRow({ item, selected, onOpen }: { item: Item; selected: boolean; onOpen: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const st = STATUS[item.status]
  const isUrgent = item.status === 'out' || item.status === 'low'

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    if (menuOpen) document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [menuOpen])

  const handleDelete = async () => {
    setDeleteError(null)
    const fd = new FormData()
    fd.set('item_id', item.id)
    const result = await deleteInventoryItem(fd)
    if (result?.error) setDeleteError(result.error)
    else setMenuOpen(false)
  }

  // Click anywhere on the row opens the detail panel, except
  // inside interactive zones (actions menu).
  const rowClass = [
    'group cursor-pointer transition-colors relative',
    selected ? 'bg-blue-50/60' : isUrgent ? 'hover:bg-red-50/40' : 'hover:bg-gray-50',
  ].join(' ')

  return (
    <tr className={rowClass} onClick={onOpen}>
      {/* Item */}
      <td className="px-5 py-3">
        <div className="flex items-center gap-2">
          {selected
            ? <span className="w-1 h-8 rounded-full bg-blue-500" />
            : isUrgent && <span className={`w-1 h-8 rounded-full ${item.status === 'out' ? 'bg-red-500' : 'bg-amber-500'}`} />}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate group-hover:text-blue-700 transition-colors">
              {item.name}
            </p>
            {item.recipeLinks > 0 && (
              <p className="text-[10px] text-gray-400 mt-0.5">Used in {item.recipeLinks} recipe{item.recipeLinks > 1 ? 's' : ''}</p>
            )}
          </div>
        </div>
      </td>

      {/* Estimated stock */}
      <td className="px-5 py-3 text-right">
        {item.estimated !== null ? (
          <div className="inline-flex items-baseline gap-1 font-mono">
            <span className={`text-base font-bold tabular-nums ${
              item.estimated <= 0 ? 'text-red-600'
                : item.status === 'low' ? 'text-amber-700'
                  : 'text-gray-900'
            }`}>{item.estimated.toFixed(2)}</span>
            <span className="text-[10px] text-gray-400">{item.unitOfMeasure}</span>
          </div>
        ) : (
          <span className="text-gray-300 text-xs">—</span>
        )}
      </td>

      {/* Threshold — read-only in row, editable in panel */}
      <td className="px-5 py-3 text-right">
        <span className="inline-flex items-baseline gap-1 font-mono text-xs text-gray-500">
          <span className="tabular-nums">{item.threshold.toFixed(2)}</span>
          <span className="text-[10px] text-gray-400">{item.unitOfMeasure}</span>
        </span>
      </td>

      {/* Status */}
      <td className="px-5 py-3">
        <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full ${st.color}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
          {st.label}
        </span>
      </td>

      {/* Actions */}
      <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
        <div className="relative inline-block" ref={menuRef}>
          <button type="button" onClick={() => { setMenuOpen(!menuOpen); setDeleteError(null) }}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded hover:bg-gray-100">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v.01M12 12v.01M12 19v.01" />
            </svg>
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-52 bg-white rounded-lg border border-gray-200 shadow-lg z-20 py-1">
              <p className="px-3 py-1 text-[10px] font-semibold text-gray-400 uppercase">Stock</p>
              <Link href="/inventory/new-count" onClick={() => setMenuOpen(false)}
                className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">Record count</Link>
              <Link href="/inventory/new-transaction" onClick={() => setMenuOpen(false)}
                className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">Log transaction</Link>

              <div className="my-1 border-t border-gray-100" />

              <p className="px-3 py-1 text-[10px] font-semibold text-gray-400 uppercase">Lifecycle</p>
              <form action={archiveInventoryItem}>
                <input type="hidden" name="item_id" value={item.id} />
                <button type="submit" onClick={() => setMenuOpen(false)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  Archive item
                </button>
              </form>

              {item.hasDependencies ? (
                <div className="px-3 py-2">
                  <p className="text-xs text-gray-400">Delete unavailable</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">Has linked recipes, counts, or transactions. Use archive instead.</p>
                </div>
              ) : (
                <button type="button" onClick={handleDelete}
                  className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50">
                  Delete item
                </button>
              )}

              {deleteError && <p className="px-3 py-1 text-[10px] text-red-500">{deleteError}</p>}
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

// ----------------------------------------------------------------
// ActivityFeed — compact supporting feed (replaces secondary table)
// ----------------------------------------------------------------
function ActivityFeed({ transactions }: { transactions: Transaction[] }) {
  // `initial_count` and `count` come from inventory_counts (merged
  // server-side). All other types come from inventory_transactions.
  const styleFor: Record<string, { bg: string; text: string; glyph: string; label: string; showSign: boolean }> = {
    purchase:      { bg: 'bg-green-50',  text: 'text-green-700',  glyph: '+', label: 'Purchase',      showSign: true  },
    waste:         { bg: 'bg-red-50',    text: 'text-red-700',    glyph: '−', label: 'Waste',         showSign: true  },
    usage:         { bg: 'bg-blue-50',   text: 'text-blue-700',   glyph: '−', label: 'Usage',         showSign: true  },
    count:         { bg: 'bg-gray-100',  text: 'text-gray-600',   glyph: '◉', label: 'Count',         showSign: false },
    initial_count: { bg: 'bg-emerald-50', text: 'text-emerald-700', glyph: '✦', label: 'Initial count', showSign: false },
  }

  return (
    <section>
      <div className="flex items-end justify-between mb-2">
        <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Activity</h2>
        <p className="text-[10px] text-gray-400">Last {Math.min(ACTIVITY_LIMIT, transactions.length)} movements</p>
      </div>
      <ul className="rounded-xl border border-gray-200 bg-white divide-y divide-gray-50">
        {transactions.slice(0, ACTIVITY_LIMIT).map((tx) => {
          const style = styleFor[tx.type] ?? { bg: 'bg-gray-100', text: 'text-gray-600', glyph: '·', label: tx.type, showSign: false }
          const isInitial = tx.type === 'initial_count'
          const qtyClass = !style.showSign
            ? (isInitial ? 'text-emerald-700' : 'text-gray-600')
            : tx.qty > 0 ? 'text-green-700'
            : tx.qty < 0 ? 'text-red-600'
            : 'text-gray-600'
          const qtyPrefix = style.showSign && tx.qty > 0 ? '+' : ''
          return (
            <li key={tx.id} className="flex items-center gap-3 px-4 py-2">
              <span className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${style.bg} ${style.text}`}>
                {style.glyph}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-700 truncate">
                  <span className="font-medium text-gray-900">{tx.itemName}</span>
                  <span className={`${isInitial ? 'text-emerald-700 font-semibold' : 'text-gray-400'}`}> · {style.label}</span>
                  {tx.note && <span className="text-gray-400"> · {tx.note}</span>}
                </p>
              </div>
              <span className={`text-xs font-mono font-semibold tabular-nums ${qtyClass}`}>
                {qtyPrefix}{tx.qty.toFixed(2)}
              </span>
              <span className="text-[10px] text-gray-400 w-12 text-right tabular-nums">
                {new Date(tx.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ----------------------------------------------------------------
// ItemDetailPanel — right-side detail with threshold + count actions.
//
// Two rendering modes:
//   embedded = true  → inline card in the desktop rail
//   embedded = false → fixed slide-over with backdrop (mobile)
// ----------------------------------------------------------------
function ItemDetailPanel({ item, onClose, embedded = false }: { item: Item; onClose: () => void; embedded?: boolean }) {
  const st = STATUS[item.status]
  const [threshold, setThreshold] = useState(item.threshold.toString())
  const [thresholdSaving, setThresholdSaving] = useState(false)
  const [thresholdSaved, setThresholdSaved] = useState(false)
  const [thresholdEditing, setThresholdEditing] = useState(false)

  // Count form (uses existing createInventoryCount server action)
  const [countState, countAction, countPending] = useActionState(createInventoryCount, null)

  useEffect(() => {
    setThreshold(item.threshold.toString())
    setThresholdSaved(false)
  }, [item.id, item.threshold])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const thresholdDirty = parseFloat(threshold || '0') !== item.threshold

  const saveThreshold = async () => {
    if (!thresholdDirty || thresholdSaving) return
    setThresholdSaving(true)
    const fd = new FormData()
    fd.set('item_id', item.id)
    fd.set('low_stock_threshold', threshold)
    await updateThreshold(fd)
    setThresholdSaving(false)
    setThresholdSaved(true)
    setTimeout(() => setThresholdSaved(false), 1600)
  }

  const hasCount = item.lastCount !== null
  const countCtaLabel = hasCount ? 'Update stock count' : 'Record first count'

  const body = (
    <>
      <div className={`${embedded ? 'border-b border-gray-100 px-5 py-3' : 'sticky top-0 bg-white border-b border-gray-100 px-6 py-4 z-10'} flex items-start justify-between gap-3`}>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Inventory item</p>
          <div className="flex items-center gap-2 mt-0.5">
            <h2 className={`${embedded ? 'text-base' : 'text-lg'} font-bold text-gray-900 truncate`}>{item.name}</h2>
            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 ${st.color}`}>
              <span className={`w-1 h-1 rounded-full ${st.dot}`} />
              {st.label}
            </span>
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 -mt-1 -mr-1 flex-shrink-0">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className={`${embedded ? 'p-5 space-y-5' : 'p-6 space-y-6'}`}>
          {/* ---- TOP SUMMARY: Est. stock + Threshold ---- */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-gray-50 border border-gray-100 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Est. stock</p>
              <div className="mt-1 flex items-baseline gap-1">
                <span className={`text-xl font-bold font-mono tabular-nums ${
                  item.estimated === null ? 'text-gray-300'
                    : item.estimated <= 0 ? 'text-red-600'
                      : item.status === 'low' ? 'text-amber-700'
                        : 'text-gray-900'
                }`}>
                  {item.estimated !== null ? item.estimated.toFixed(2) : '—'}
                </span>
                <span className="text-[10px] text-gray-400">{item.unitOfMeasure}</span>
              </div>
            </div>
            <ThresholdStat
              value={threshold}
              onChange={setThreshold}
              onSave={saveThreshold}
              dirty={thresholdDirty}
              saving={thresholdSaving}
              saved={thresholdSaved}
              unit={item.unitOfMeasure}
              editing={thresholdEditing}
              onEditingChange={setThresholdEditing}
            />
          </div>

          {/* ---- PRIMARY ACTION: Update stock count ---- */}
          <div>
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <h3 className="text-sm font-semibold text-gray-900">{countCtaLabel}</h3>
              {hasCount && (
                <span className="text-[10px] text-gray-400 tabular-nums whitespace-nowrap">
                  Last {item.lastCount!.toFixed(2)} {item.unitOfMeasure}
                </span>
              )}
            </div>
            <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
              {hasCount
                ? 'Enter the quantity you physically have on hand right now.'
                : 'Enter the current quantity on hand to start tracking.'}
            </p>

            <form action={countAction} className="space-y-2">
              <input type="hidden" name="inventory_item_id" value={item.id} />
              <div className="relative">
                <input
                  name="quantity_on_hand"
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-3 pr-14 text-lg font-mono font-bold tabular-nums placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                />
                <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-medium text-gray-400">{item.unitOfMeasure}</span>
              </div>
              <button
                type="submit"
                disabled={countPending}
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 shadow-sm disabled:opacity-60 transition-colors"
              >
                {countPending ? 'Saving…' : 'Save count'}
              </button>
            </form>
            {countState?.error && (
              <p className="text-[11px] text-red-600 mt-2">{countState.error}</p>
            )}
          </div>

          {/* Meta */}
          {item.recipeLinks > 0 && (
            <div className="pt-2 border-t border-gray-100">
              <p className="text-[11px] text-gray-400">Used in {item.recipeLinks} recipe{item.recipeLinks > 1 ? 's' : ''}</p>
            </div>
          )}
        </div>
    </>
  )

  if (embedded) {
    return (
      <aside className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        {body}
      </aside>
    )
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40 animate-[fadeIn_.18s_ease]" onClick={onClose} />
      <style>{`@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
               @keyframes slideIn { from { transform: translateX(100%) } to { transform: translateX(0) } }`}</style>
      <aside className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white border-l border-gray-200 shadow-2xl z-50 overflow-y-auto"
        style={{ animation: 'slideIn .22s cubic-bezier(.2,.7,.2,1)' }}>
        {body}
      </aside>
    </>
  )
}
