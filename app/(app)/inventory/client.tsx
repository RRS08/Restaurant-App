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
  createRestockOrder,
  quickAddToOrder,
  markRestockReceived,
  cancelRestockOrder,
  updateRestockQuantity,
  placeAllDrafts,
} from '@/app/actions/inventory'

interface Item {
  id: string; name: string; unitOfMeasure: string; threshold: number
  estimated: number | null; lastCount: number | null; status: 'no_count' | 'out' | 'low' | 'ok'
  recipeLinks: number; hasDependencies: boolean
}

interface Transaction {
  id: string
  inventoryItemId: string
  itemName: string
  type: string
  qty: number
  note: string | null
  date: string
}

// Active restock orders only — received/canceled are terminal and
// don't surface in the drawer's working list.
interface RestockOrder {
  id: string
  inventoryItemId: string
  quantity: number
  vendor: string | null
  expectedCost: number | null
  notes: string | null
  status: 'draft' | 'ordered'
  orderedAt: string | null
  createdAt: string
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

// Drawer state — exactly one drawer open at a time. Discriminated
// union so adding a new drawer is a single new branch in the
// render block at the bottom of InventoryClient.
type DrawerState =
  | { mode: 'item'; itemId: string }
  | { mode: 'create-item' }
  | { mode: 'cart' }
  | { mode: 'orders' }
  | null

export default function InventoryClient({ items, transactions, restockOrders }: {
  items: Item[]
  transactions: Transaction[]
  restockOrders: RestockOrder[]
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<DrawerState>(null)
  const selectedId = drawer?.mode === 'item' ? drawer.itemId : null

  // Auto-close the create-item drawer once revalidation delivers
  // the new row.
  const itemCountRef = useRef(items.length)
  useEffect(() => {
    if (drawer?.mode === 'create-item' && items.length > itemCountRef.current) {
      setDrawer(null)
    }
    itemCountRef.current = items.length
  }, [items.length, drawer])

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

  // If the selected item disappears (archived/deleted), close the drawer.
  useEffect(() => {
    if (selectedId && !items.find((i) => i.id === selectedId)) setDrawer(null)
  }, [items, selectedId])

  // ---- Restock-order indexing ----
  // The order-builder rail and the per-row "Add" affordance both
  // need fast lookups. Build them once per render so neither path
  // does linear filtering inside the hot list.
  const itemsById = useMemo(() => {
    const m = new Map<string, Item>()
    for (const it of items) m.set(it.id, it)
    return m
  }, [items])

  const ordersByItem = useMemo(() => {
    const m = new Map<string, RestockOrder[]>()
    for (const o of restockOrders) {
      const list = m.get(o.inventoryItemId) ?? []
      list.push(o)
      m.set(o.inventoryItemId, list)
    }
    return m
  }, [restockOrders])

  const draftOrders = useMemo(
    () => restockOrders.filter((o) => o.status === 'draft'),
    [restockOrders]
  )
  const orderedOrders = useMemo(
    () => restockOrders.filter((o) => o.status === 'ordered'),
    [restockOrders]
  )

  return (
    <div className="max-w-[1400px]">

      {/* ---- HEADER — same shape as Finance / Staffing: strong   */}
      {/*    title + one-line subtitle, mobile-only inline action. */}
      <div className="mb-7 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">Inventory</h1>
          <p className="mt-1.5 text-sm text-gray-500">Track stock health for ingredients and operational supplies.</p>
        </div>
        {/* Mobile-only fallback — desktop uses the right-rail inline flow */}
        <Link href="/inventory/new-item"
          className="lg:hidden flex-shrink-0 inline-flex items-center rounded-lg border border-gray-200/80 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors">
          + New item
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] p-12 text-center">
          <p className="text-sm font-semibold text-gray-700">No inventory items yet</p>
          <p className="mx-auto mt-1.5 max-w-sm text-xs text-gray-500 leading-relaxed">
            Add ingredients and products to start tracking stock health and movements.
          </p>
          <button
            type="button"
            onClick={() => setDrawer({ mode: 'create-item' })}
            className="mt-5 inline-flex items-center rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white hover:bg-gray-800 transition-colors"
          >
            + Track new item
          </button>
        </div>
      ) : (
        <>
          {/* ---- QUERY / ACTION STRIP ----
              One horizontal strip: wide search on the left, three
              page-level actions on the right (+ Item / Orders /
              Cart). Cart carries a live badge of draft line count.
              All three open drawers — there's no permanent rail
              anymore; the page stays focused on the list. */}
          <div className="mb-5 flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[280px]">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
              </svg>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search items by name…"
                className="h-10 w-full rounded-lg border border-gray-200/80 bg-white pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 shadow-[0_1px_2px_rgba(0,0,0,0.03)] focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
              />
            </div>

            <button
              type="button"
              onClick={() => setDrawer({ mode: 'create-item' })}
              className="inline-flex items-center gap-1.5 h-10 rounded-lg border border-gray-200/80 bg-white px-3.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Item
            </button>

            <button
              type="button"
              onClick={() => setDrawer({ mode: 'orders' })}
              className="inline-flex items-center gap-1.5 h-10 rounded-lg border border-gray-200/80 bg-white px-3.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Orders
              {orderedOrders.length > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold px-1">
                  {orderedOrders.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setDrawer({ mode: 'cart' })}
              className="inline-flex items-center gap-1.5 h-10 rounded-lg border border-gray-200/80 bg-white px-3.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
              Cart
              {draftOrders.length > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold px-1">
                  {draftOrders.length}
                </span>
              )}
            </button>
          </div>

          {/* ---- ITEM LIST ----
              Full-width central surface. Card header band carries
              the section eyebrow + title on the left and the
              filter chips on the right — visually aligned under
              the page-level + Item / Orders / Cart actions above.
              No column headers; each row is self-contained. */}
          <section className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
            <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">Stock</p>
                <h2 className="text-base font-semibold tracking-tight text-gray-900 mt-1">Replenishment discovery</h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <SummaryChip tone="red"    label="Out"      value={counts.out}      active={filter === 'out'}      onClick={() => setFilter(filter === 'out' ? 'all' : 'out')} />
                <SummaryChip tone="amber"  label="Low"      value={counts.low}      active={filter === 'low'}      onClick={() => setFilter(filter === 'low' ? 'all' : 'low')} />
                <SummaryChip tone="gray"   label="No count" value={counts.no_count} active={filter === 'no_count'} onClick={() => setFilter(filter === 'no_count' ? 'all' : 'no_count')} />
                <SummaryChip tone="blue"   label="All"      value={counts.total}    active={filter === 'all'}      onClick={() => setFilter('all')} />
                {(filter !== 'all' || query.length > 0) && (
                  <button
                    type="button"
                    onClick={() => { setFilter('all'); setQuery('') }}
                    className="ml-1 text-xs font-medium text-gray-500 hover:text-gray-700"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100">
                {pageItems.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-14 text-center text-xs text-gray-400">
                      No items match this filter.
                    </td>
                  </tr>
                ) : pageItems.map((item) => {
                  const itemOrders = ordersByItem.get(item.id) ?? []
                  const draftLine = itemOrders.find((o) => o.status === 'draft') ?? null
                  return (
                    <ItemRow
                      key={item.id}
                      item={item}
                      draftLine={draftLine}
                      selected={item.id === selectedId}
                      onOpen={() => setDrawer({ mode: 'item', itemId: item.id })}
                    />
                  )
                })}
              </tbody>
            </table>

            {filteredItems.length > PAGE_SIZE && (
              <div className="border-t border-gray-100 px-6 py-3 flex items-center justify-between">
                <p className="text-[11px] text-gray-500">
                  Showing <span className="font-semibold text-gray-700">{pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredItems.length)}</span> of <span className="font-semibold text-gray-700">{filteredItems.length}</span> items
                </p>
                <div className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage === 1}
                    className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    ←
                  </button>
                  <span className="text-[11px] text-gray-500 px-2 tabular-nums">
                    {safePage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}
                    className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    →
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {/* ---- DRAWERS ----
          One drawer kind active at a time. Drawer state union at
          the top of the component keeps this list exhaustive. */}
      {drawer?.mode === 'item' && selectedItem && (
        <ItemWorkspaceDrawer
          item={selectedItem}
          transactions={transactions}
          restockOrders={ordersByItem.get(selectedItem.id) ?? []}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer?.mode === 'create-item' && (
        <CreateItemDrawer onClose={() => setDrawer(null)} />
      )}
      {drawer?.mode === 'cart' && (
        <CartDrawer
          drafts={draftOrders}
          itemsById={itemsById}
          onClose={() => setDrawer(null)}
          onInspectItem={(itemId) => setDrawer({ mode: 'item', itemId })}
        />
      )}
      {drawer?.mode === 'orders' && (
        <OrdersDrawer
          ordered={orderedOrders}
          itemsById={itemsById}
          transactions={transactions}
          onClose={() => setDrawer(null)}
          onInspectItem={(itemId) => setDrawer({ mode: 'item', itemId })}
        />
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
// DrawerShell — shared chrome used by every page-level drawer here
// (Cart / Orders / Create-item). Same shape as Staffing's drawers
// so the inventory drawers feel like the same product family.
// ----------------------------------------------------------------
function DrawerShell({ eyebrow, title, subtitle, onClose, children }: {
  eyebrow?: string
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
}) {
  // Close on Escape — same convention every other drawer in the
  // app uses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <aside
        className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white border-l border-gray-200 shadow-xl z-50 flex flex-col"
        aria-label={title}
      >
        <header className="flex-shrink-0 border-b border-gray-100 px-6 py-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {eyebrow && (
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">
                {eyebrow}
              </p>
            )}
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-gray-900 leading-tight">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-1 text-xs text-gray-500 leading-relaxed">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex-shrink-0 text-gray-400 hover:text-gray-600 p-1 -mt-0.5"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>
        {children}
      </aside>
    </>
  )
}

// ----------------------------------------------------------------
// CartDrawer — the shopping cart. Lists draft restock_orders for
// the whole restaurant. Place order at the bottom flips them all
// to 'ordered' (placeAllDrafts).
// ----------------------------------------------------------------
function CartDrawer({ drafts, itemsById, onClose, onInspectItem }: {
  drafts: RestockOrder[]
  itemsById: Map<string, Item>
  onClose: () => void
  onInspectItem: (itemId: string) => void
}) {
  const draftCost = drafts.reduce((s, o) => s + (o.expectedCost ?? 0), 0)
  return (
    <DrawerShell
      eyebrow="Replenishment"
      title="Cart"
      subtitle="Items staged for your next replenishment order."
      onClose={onClose}
    >
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {drafts.length === 0 ? (
          <div className="text-center py-10">
            <div className="mx-auto w-10 h-10 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center mb-3">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-gray-900">Your cart is empty</p>
            <p className="mx-auto mt-1.5 max-w-[280px] text-xs text-gray-500 leading-relaxed">
              Add items from the inventory list to start building your next replenishment order. Stock only updates once you mark an order received.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {drafts.map((order) => (
              <CartLineItem
                key={order.id}
                order={order}
                item={itemsById.get(order.inventoryItemId)}
                editable
                onInspect={() => onInspectItem(order.inventoryItemId)}
              />
            ))}
          </ul>
        )}
      </div>

      {drafts.length > 0 && (
        <div className="flex-shrink-0 border-t border-gray-100 px-6 py-4 bg-white">
          <div className="flex items-center justify-between text-xs text-gray-600 mb-3">
            <span>
              {drafts.length} {drafts.length === 1 ? 'item' : 'items'}
            </span>
            {draftCost > 0 && (
              <span className="tabular-nums font-medium text-gray-900">
                ~${draftCost.toFixed(2)} <span className="text-gray-400 font-normal">expected total</span>
              </span>
            )}
          </div>
          <PlaceOrderButton draftCount={drafts.length} />
        </div>
      )}
    </DrawerShell>
  )
}

// ----------------------------------------------------------------
// OrdersDrawer — placed orders awaiting receipt + recent inventory
// movement. Receipt is the commit that bumps stock; activity
// surfaces past receipts and other movements at a glance.
// ----------------------------------------------------------------
function OrdersDrawer({ ordered, itemsById, transactions, onClose, onInspectItem }: {
  ordered: RestockOrder[]
  itemsById: Map<string, Item>
  transactions: Transaction[]
  onClose: () => void
  onInspectItem: (itemId: string) => void
}) {
  return (
    <DrawerShell
      eyebrow="Replenishment"
      title="Orders"
      subtitle="Placed orders awaiting receipt and recent movement."
      onClose={onClose}
    >
      <div className="flex-1 overflow-y-auto">
        {/* AWAITING RECEIPT */}
        <div className="px-6 py-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">Awaiting receipt</p>
            {ordered.length > 0 && (
              <span className="text-[10px] text-gray-400">{ordered.length} {ordered.length === 1 ? 'line' : 'lines'}</span>
            )}
          </div>
          {ordered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/60 px-4 py-6 text-center">
              <p className="text-xs font-medium text-gray-700">No placed orders</p>
              <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                When you place a draft order from the cart, items waiting for receipt will appear here.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {ordered.map((order) => (
                <CartLineItem
                  key={order.id}
                  order={order}
                  item={itemsById.get(order.inventoryItemId)}
                  showReceiveAction
                  onInspect={() => onInspectItem(order.inventoryItemId)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* RECENT ACTIVITY — global movement feed kept accessible
            here instead of a permanent rail card. */}
        {transactions.length > 0 && (
          <div className="px-6 pb-6">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-3">Recent activity</p>
            <ActivityFeed transactions={transactions} />
          </div>
        )}
      </div>
    </DrawerShell>
  )
}

// ----------------------------------------------------------------
// CreateItemDrawer — drawer-wrapped version of the previous inline
// CreateItemCard. The form behavior is unchanged; the chrome
// matches the rest of the page-level drawers.
// ----------------------------------------------------------------
function CreateItemDrawer({ onClose }: { onClose: () => void }) {
  const [state, action, pending] = useActionState(createInventoryItem, null)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus() }, [])

  return (
    <DrawerShell
      eyebrow="Track"
      title="New item"
      subtitle="Recipe ingredient, operational supply — anything you want to monitor."
      onClose={onClose}
    >
      <form action={action} className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
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
              placeholder="Mozzarella, Olive oil, Napkins, Takeout boxes…"
              className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
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
              className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
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
              className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
            />
          </div>

          {state?.error && (
            <p className="text-[11px] text-red-600">{state.error}</p>
          )}
        </div>

        <div className="flex-shrink-0 border-t border-gray-100 px-6 py-4 bg-white flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-10 rounded-lg border border-gray-200 px-4 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="flex-1 h-10 rounded-lg bg-gray-900 px-4 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
          >
            {pending ? 'Creating…' : 'Create item'}
          </button>
        </div>
      </form>
    </DrawerShell>
  )
}

// ----------------------------------------------------------------
// CartLineItem — single line in the OrderBuilderCard.
//
// editable=true (draft mode):
//   - inline qty editor (saves via updateRestockQuantity)
//   - remove × button (cancels the draft via cancelRestockOrder)
//
// showReceiveAction=true (ordered mode):
//   - "Mark received" button (markRestockReceived → stock bump)
//   - cancel × is also available as a quiet escape hatch
//
// The line title links into the drawer for full inspection / edit
// of vendor, cost, notes — keeping this row compact.
// ----------------------------------------------------------------
function CartLineItem({ order, item, editable, showReceiveAction, onInspect }: {
  order: RestockOrder
  item: Item | undefined
  editable?: boolean
  showReceiveAction?: boolean
  onInspect: () => void
}) {
  const [qtyState, qtyAction, qtyPending] = useActionState(updateRestockQuantity, null)
  const [recvState, recvAction, recvPending] = useActionState(markRestockReceived, null)
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelRestockOrder, null)

  const unit = item?.unitOfMeasure ?? ''
  const error = qtyState?.error ?? recvState?.error ?? cancelState?.error

  return (
    <li className="rounded-lg border border-gray-200 bg-white px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onInspect}
          className="text-left min-w-0 flex-1 group/title"
        >
          <p className="text-xs font-semibold text-gray-900 truncate group-hover/title:text-blue-700 transition-colors">
            {item?.name ?? '—'}
          </p>
          <p className="text-[10px] text-gray-400 truncate mt-0.5">
            {[order.vendor, order.expectedCost !== null ? `~$${order.expectedCost.toFixed(2)}` : null]
              .filter(Boolean).join(' · ') || (item?.recipeLinks ? `Used in ${item.recipeLinks} recipe${item.recipeLinks > 1 ? 's' : ''}` : 'Standalone')}
          </p>
        </button>

        <form action={cancelAction} className="flex-shrink-0">
          <input type="hidden" name="order_id" value={order.id} />
          <button
            type="submit"
            disabled={cancelPending}
            aria-label="Remove from order"
            className="text-gray-300 hover:text-red-600 transition-colors p-0.5 disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </form>
      </div>

      {/* Editable mode: inline qty editor that auto-saves on blur/
          submit. Read-only mode in ordered: just a quantity readout
          plus the receive button. */}
      <div className="mt-2 flex items-center gap-2">
        {editable ? (
          <form action={qtyAction} className="flex items-center gap-1.5">
            <input type="hidden" name="order_id" value={order.id} />
            <input
              name="quantity"
              type="number"
              min="0.01"
              step="0.01"
              defaultValue={order.quantity}
              disabled={qtyPending}
              className="h-7 w-20 rounded-md border border-gray-200 bg-white px-2 text-xs font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition disabled:opacity-60"
            />
            <span className="text-[10px] text-gray-400">{unit}</span>
            <button
              type="submit"
              disabled={qtyPending}
              className="text-[10px] font-semibold text-gray-500 hover:text-gray-900 disabled:opacity-50"
            >
              {qtyPending ? 'Saving…' : 'Update'}
            </button>
          </form>
        ) : (
          <p className="text-xs font-mono font-semibold text-gray-900 tabular-nums flex-1">
            {order.quantity.toFixed(order.quantity % 1 === 0 ? 0 : 2)} <span className="text-[10px] text-gray-400 font-sans font-normal">{unit}</span>
          </p>
        )}

        {showReceiveAction && (
          <form action={recvAction} className="ml-auto">
            <input type="hidden" name="order_id" value={order.id} />
            <button
              type="submit"
              disabled={recvPending}
              className="rounded-md bg-gray-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
            >
              {recvPending ? 'Receiving…' : 'Mark received'}
            </button>
          </form>
        )}
      </div>

      {error && <p className="mt-1.5 text-[10px] text-red-600">{error}</p>}
    </li>
  )
}

// ----------------------------------------------------------------
// PlaceOrderButton — bulk-flip drafts → ordered. The dark commit
// at the bottom of the cart's draft section.
// ----------------------------------------------------------------
function PlaceOrderButton({ draftCount }: { draftCount: number }) {
  const [state, action, pending] = useActionState(placeAllDrafts, null)
  return (
    <form action={action}>
      <button
        type="submit"
        disabled={pending || draftCount === 0}
        className="w-full rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {pending ? 'Placing…' : `Place order · ${draftCount} ${draftCount === 1 ? 'item' : 'items'}`}
      </button>
      {state?.error && <p className="mt-1.5 text-[10px] text-red-600">{state.error}</p>}
    </form>
  )
}

// ----------------------------------------------------------------
// Default restock quantity for a quick-add. Uses the threshold as
// the floor — managers can refine in the drawer if they want a
// bigger or smaller order. Conservative starting point that always
// produces a plausible draft, even when stock isn't tracked yet.
// ----------------------------------------------------------------
function defaultRestockQty(item: Item): number {
  const t = item.threshold || 1
  return Math.max(t, 1)
}

// ----------------------------------------------------------------
// ItemRow — replenishment-discovery row. Reads left-to-right:
//
//   [stripe] Item name                       Est. stock  • Status  [cart]
//            type · Threshold N unit
//
// Left:   thin status-colored stripe (red/amber/green/gray) for
//         at-a-glance scanning. Item name on top; supporting meta
//         line carries type context + the threshold target.
// Right:  one tight cluster — current stock value (the strongest
//         scanning anchor on the right) → status text → cart
//         action. Reads as "where we are now → next move."
//
// Selected: bg + stripe both shift blue so the row open in the
// drawer is unmistakable without becoming loud.
// ----------------------------------------------------------------
function ItemRow({ item, draftLine, selected, onOpen }: {
  item: Item
  draftLine: RestockOrder | null
  selected: boolean
  onOpen: () => void
}) {
  const stockColor =
    item.estimated === null ? 'text-gray-300'
      : item.estimated <= 0 ? 'text-red-600'
        : item.status === 'low' ? 'text-amber-700'
          : 'text-gray-900'
  const typeLabel = item.recipeLinks > 0
    ? `Used in ${item.recipeLinks} recipe${item.recipeLinks > 1 ? 's' : ''}`
    : 'Standalone item'

  // Left-edge stripe — status semantics by default, swaps to blue
  // when the row is selected so "this is the row I'm inspecting"
  // reads even faster than the status itself.
  const stripeClass = selected
    ? 'bg-blue-500'
    : item.status === 'out'      ? 'bg-red-500'
      : item.status === 'low'    ? 'bg-amber-500'
        : item.status === 'ok'   ? 'bg-green-500'
          : 'bg-gray-300'

  // Inline status — colored dot + label, no pill chrome.
  const statusTextClass =
    item.status === 'out'      ? 'text-red-600'
      : item.status === 'low'  ? 'text-amber-600'
        : item.status === 'ok' ? 'text-green-700'
          : 'text-gray-500'
  const statusDotClass =
    item.status === 'out'      ? 'bg-red-500'
      : item.status === 'low'  ? 'bg-amber-500'
        : item.status === 'ok' ? 'bg-green-500'
          : 'bg-gray-400'
  const statusLabel = STATUS[item.status].label

  return (
    <tr
      onClick={onOpen}
      className={`group cursor-pointer transition-all ${
        selected
          // Selected: stronger blue tint + 2px blue inset ring at
          // 30% alpha gives clear "this row is open in the drawer"
          // recognition without going loud.
          ? 'bg-blue-50 shadow-[inset_0_0_0_2px_rgba(59,130,246,0.30)]'
          // Hover: full gray-50 (was /80) + a soft 1px gray inset
          // line so the row reads as a discrete inspectable object
          // when the cursor lands on it. Subtle but present.
          : 'hover:bg-gray-50 hover:shadow-[inset_0_0_0_1px_rgba(15,23,42,0.04)]'
      }`}
    >
      {/* Item — left-edge stripe + name + meta line. py-4 (bumped
          from py-3.5) gives each row a touch more vertical
          presence so the list reads as objects, not lines. */}
      <td className="relative px-6 py-4">
        <span
          className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripeClass}`}
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate group-hover:text-blue-700 transition-colors">
            {item.name}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500 truncate">
            <span>{typeLabel}</span>
            <span className="text-gray-300 mx-1.5">·</span>
            <span>
              Threshold{' '}
              <span className="font-mono tabular-nums text-gray-600">
                {item.threshold.toFixed(2)}
              </span>{' '}
              {item.unitOfMeasure}
            </span>
          </p>
        </div>
      </td>

      {/* Right cluster — Est. stock anchors the scan, then status,
          then the cart action. Tight padding (pl-2 pr-1.5 / px-1.5 /
          pl-1.5 pr-4) collapses the gaps between them so they read
          as one decision zone rather than three independent
          columns. */}
      <td className="pl-2 pr-1.5 py-4 text-right whitespace-nowrap">
        {item.estimated !== null ? (
          <span className="inline-flex items-baseline gap-1 font-mono">
            <span className={`text-base font-bold tabular-nums ${stockColor}`}>
              {item.estimated.toFixed(2)}
            </span>
            <span className="text-[10px] font-medium text-gray-400">{item.unitOfMeasure}</span>
          </span>
        ) : (
          <span className="text-gray-300 text-xs">—</span>
        )}
      </td>

      <td className="px-1.5 py-4 whitespace-nowrap">
        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${statusTextClass}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${statusDotClass}`} />
          {statusLabel}
        </span>
      </td>

      {/* Cart icon — final action in the right cluster. The button
          picks up emphasis from the row hover via group-hover, so
          the action affordance brightens together with the row —
          one signal, two surfaces. */}
      <td className="pl-1.5 pr-4 py-4 text-right" onClick={(e) => e.stopPropagation()}>
        {draftLine ? (
          <button
            type="button"
            onClick={onOpen}
            title={`In cart · ${draftLine.quantity} ${item.unitOfMeasure} — click to edit`}
            aria-label="In cart"
            className="relative inline-flex items-center justify-center w-8 h-8 rounded-md bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 group-hover:border-blue-300 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[14px] h-[14px] rounded-full bg-blue-600 text-white text-[9px] font-bold px-0.5 leading-none">
              {Math.floor(draftLine.quantity)}
            </span>
          </button>
        ) : (
          <form action={quickAddToOrder} className="inline-block">
            <input type="hidden" name="inventory_item_id" value={item.id} />
            <input type="hidden" name="quantity" value={defaultRestockQty(item)} />
            <button
              type="submit"
              title="Add to cart"
              aria-label="Add to cart"
              className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-gray-900 hover:border-gray-300 group-hover:border-gray-300 group-hover:text-gray-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            </button>
          </form>
        )}
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

  const visibleCount = Math.min(ACTIVITY_LIMIT, transactions.length)
  return (
    <section className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">Activity</p>
          <h2 className="text-base font-semibold tracking-tight text-gray-900 mt-1">Recent movements</h2>
        </div>
        <span className="flex-shrink-0 text-[10px] text-gray-400">Last {visibleCount}</span>
      </div>
      <ul className="divide-y divide-gray-50">
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
            <li key={tx.id} className="flex items-center gap-3 px-5 py-2.5">
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
// ItemMovementRow — single row in the per-item Movement list
// inside the selected-item rail. Compact rendering: type glyph +
// label + signed qty + date. Item name is intentionally omitted
// because the row already lives inside that item's workspace.
// ----------------------------------------------------------------
function ItemMovementRow({ tx, unit }: { tx: Transaction; unit: string }) {
  // Same style map ActivityFeed uses, kept here so the per-item
  // list stays consistent with the global feed below it.
  const styleFor: Record<string, { bg: string; text: string; glyph: string; label: string; showSign: boolean }> = {
    purchase:      { bg: 'bg-green-50',   text: 'text-green-700',   glyph: '+', label: 'Purchase',      showSign: true  },
    waste:         { bg: 'bg-red-50',     text: 'text-red-700',     glyph: '−', label: 'Waste',         showSign: true  },
    usage:         { bg: 'bg-blue-50',    text: 'text-blue-700',    glyph: '−', label: 'Usage',         showSign: true  },
    count:         { bg: 'bg-gray-100',   text: 'text-gray-600',    glyph: '◉', label: 'Count',         showSign: false },
    initial_count: { bg: 'bg-emerald-50', text: 'text-emerald-700', glyph: '✦', label: 'Initial count', showSign: false },
  }
  const style = styleFor[tx.type] ?? { bg: 'bg-gray-100', text: 'text-gray-600', glyph: '·', label: tx.type, showSign: false }
  const isInitial = tx.type === 'initial_count'
  const qtyClass = !style.showSign
    ? (isInitial ? 'text-emerald-700' : 'text-gray-600')
    : tx.qty > 0 ? 'text-green-700'
      : tx.qty < 0 ? 'text-red-600'
        : 'text-gray-600'
  const qtyPrefix = style.showSign && tx.qty > 0 ? '+' : ''

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${style.bg} ${style.text}`}>
        {style.glyph}
      </span>
      <p className="text-[11px] text-gray-700 truncate flex-1 min-w-0">
        <span className={isInitial ? 'text-emerald-700 font-semibold' : 'text-gray-700 font-medium'}>{style.label}</span>
        {tx.note && <span className="text-gray-400"> · {tx.note}</span>}
      </p>
      <span className={`text-[11px] font-mono font-semibold tabular-nums ${qtyClass}`}>
        {qtyPrefix}{tx.qty.toFixed(2)}
        <span className="text-[9px] text-gray-400 font-normal ml-0.5">{unit}</span>
      </span>
      <span className="text-[10px] text-gray-400 w-10 text-right tabular-nums">
        {new Date(tx.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
      </span>
    </li>
  )
}

// ----------------------------------------------------------------
// CreateRestockForm — inline form to create a draft restock order.
//
// Lives inside the Replenishment section; collapses on success via
// the same pending → done detection used by Staffing's drawers.
// Required: quantity. Optional: vendor, expected_cost, notes.
// ----------------------------------------------------------------
function CreateRestockForm({ item, onClose }: { item: Item; onClose: () => void }) {
  const [state, action, pending] = useActionState(createRestockOrder, null)

  // Auto-collapse on a successful create — same convention every
  // staffing/finance drawer uses.
  const wasPendingRef = useRef(false)
  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      const errored = !!state && 'error' in state && !!state.error
      if (!errored) onClose()
    }
    wasPendingRef.current = pending
  }, [pending, state, onClose])

  return (
    <form action={action} className="rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-2.5">
      <input type="hidden" name="inventory_item_id" value={item.id} />

      {/* Quantity is the only required field. Unit is rendered as a
          suffix to match how the count form below shows units. */}
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1">Quantity</label>
        <div className="relative">
          <input
            name="quantity"
            type="number"
            min="0.01"
            step="0.01"
            required
            autoFocus
            placeholder="0.00"
            className="h-9 w-full rounded-md border border-gray-200 bg-white pl-3 pr-12 text-sm font-mono tabular-nums placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">{item.unitOfMeasure}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1">Vendor <span className="text-gray-400 font-normal normal-case tracking-normal">· optional</span></label>
          <input
            name="vendor"
            type="text"
            placeholder="US Foods"
            className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1">Expected $ <span className="text-gray-400 font-normal normal-case tracking-normal">· optional</span></label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">$</span>
            <input
              name="expected_cost"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              className="h-9 w-full rounded-md border border-gray-200 bg-white pl-6 pr-3 text-sm font-mono tabular-nums placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
            />
          </div>
        </div>
      </div>

      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1">Notes <span className="text-gray-400 font-normal normal-case tracking-normal">· optional</span></label>
        <input
          name="notes"
          type="text"
          placeholder="e.g. Confirm delivery date with vendor"
          className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
        />
      </div>

      {state?.error && (
        <p className="text-[11px] text-red-600">{state.error}</p>
      )}

      <p className="text-[10px] text-gray-400 leading-relaxed">
        Creating an order does not change stock. Stock updates when the order is marked received.
      </p>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="flex-1 rounded-md bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
        >
          {pending ? 'Creating…' : 'Create draft'}
        </button>
      </div>
    </form>
  )
}

// ----------------------------------------------------------------
// RestockOrderRow — single line inside the drawer's Replenishment
// section. Two flavors:
//
//   draft   → status pill, qty + vendor/cost detail, Cancel.
//             Placement (draft → ordered) happens in the rail
//             cart's bulk Place order action — not here.
//   ordered → status pill, readonly summary, "Mark received"
//             (the dark commit that bumps stock), Cancel.
// ----------------------------------------------------------------
function RestockOrderRow({ order, unit }: { order: RestockOrder; unit: string }) {
  const [receivedState, receivedAction, receivedPending] = useActionState(markRestockReceived, null)
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelRestockOrder, null)

  const isDraft = order.status === 'draft'
  const statusLabel = isDraft ? 'Draft' : 'Ordered'
  const statusClass = isDraft
    ? 'bg-gray-100 text-gray-700'
    : 'bg-blue-50 text-blue-700'
  const statusDot = isDraft ? 'bg-gray-400' : 'bg-blue-500'

  const error = receivedState?.error ?? cancelState?.error

  return (
    <li className="rounded-lg border border-gray-200 bg-white px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${statusClass}`}>
          <span className={`w-1 h-1 rounded-full ${statusDot}`} />
          {statusLabel}
        </span>
        <p className="text-xs font-mono font-semibold text-gray-900 tabular-nums">
          {order.quantity.toFixed(2)} <span className="text-[10px] text-gray-400 font-sans font-normal">{unit}</span>
        </p>
      </div>

      <p className="text-[11px] text-gray-500 leading-relaxed">
        {[
          order.vendor,
          order.expectedCost !== null ? `~$${order.expectedCost.toFixed(2)}` : null,
          order.notes,
        ].filter(Boolean).join(' · ') || 'No vendor or cost recorded'}
      </p>

      <div className="mt-2.5 flex items-center gap-2">
        {isDraft ? (
          <p className="flex-1 text-[10px] text-gray-400">
            Place from the order builder when ready.
          </p>
        ) : (
          <form action={receivedAction} className="flex-1">
            <input type="hidden" name="order_id" value={order.id} />
            <button
              type="submit"
              disabled={receivedPending}
              className="w-full rounded-md bg-gray-900 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
            >
              {receivedPending ? 'Receiving…' : 'Mark received'}
            </button>
          </form>
        )}

        <form action={cancelAction}>
          <input type="hidden" name="order_id" value={order.id} />
          <button
            type="submit"
            disabled={cancelPending}
            className="text-[11px] font-medium text-red-600 hover:text-red-700 disabled:opacity-60 px-1"
          >
            {cancelPending ? '…' : 'Cancel'}
          </button>
        </form>
      </div>

      {error && (
        <p className="mt-1.5 text-[11px] text-red-600">{error}</p>
      )}
    </li>
  )
}

// ----------------------------------------------------------------
// ItemDestructiveSection — drawer footer block for Archive / Delete.
// Replaces the old row-level kebab menu so the list stays focused
// on stock + ordering. Same conventions as Staffing's destructive
// confirms: text-only at rest, expand-into-confirm on click.
// ----------------------------------------------------------------
function ItemDestructiveSection({ item }: { item: Item }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletePending, setDeletePending] = useState(false)

  const handleDelete = async () => {
    setDeletePending(true)
    setDeleteError(null)
    const fd = new FormData()
    fd.set('item_id', item.id)
    const result = await deleteInventoryItem(fd)
    if (result?.error) {
      setDeleteError(result.error)
      setDeletePending(false)
    }
    // On success the page revalidates and the drawer closes via the
    // selectedId-not-found effect upstream — no local cleanup needed.
  }

  return (
    <div className="pt-4 mt-2 border-t border-gray-100">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-2">Manage</p>

      <div className="flex items-center gap-3">
        <form action={archiveInventoryItem}>
          <input type="hidden" name="item_id" value={item.id} />
          <button
            type="submit"
            className="text-[11px] font-medium text-gray-600 hover:text-gray-900"
          >
            Archive item
          </button>
        </form>

        <span className="text-gray-200">·</span>

        {item.hasDependencies ? (
          <span
            className="text-[11px] text-gray-300"
            title="Has linked recipes, counts, or transactions. Archive instead."
          >
            Delete unavailable
          </span>
        ) : !confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="text-[11px] font-medium text-red-600 hover:text-red-700"
          >
            Delete item
          </button>
        ) : (
          <span className="text-[11px] text-gray-400">Confirm below</span>
        )}
      </div>

      {confirmDelete && !item.hasDependencies && (
        <div className="mt-2.5 rounded-lg border border-red-200 bg-red-50/60 p-3">
          <p className="text-xs font-semibold text-red-900">Delete {item.name}?</p>
          <p className="mt-0.5 text-[11px] text-red-700/90 leading-relaxed">
            This is permanent. Use Archive if you might restore it later.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={handleDelete}
              disabled={deletePending}
              className="h-9 rounded-md border border-red-300 bg-white px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60 transition-colors"
            >
              {deletePending ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button
              type="button"
              onClick={() => { setConfirmDelete(false); setDeleteError(null) }}
              className="text-[11px] text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
          {deleteError && <p className="mt-1.5 text-[11px] text-red-700">{deleteError}</p>}
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// ItemWorkspaceDrawer — item-specific working surface, opened from
// the inventory list row click on any viewport.
//
// Drawer pattern is the sibling of Staffing's edit/add drawers
// (DrawerShell-style chrome) so the two pillars read as the same
// product family. Sectioned body keeps the workflow legible:
//
//   1. Header — name + status + type pills (both pills are
//      first-class so standalone items don't read as second-class)
//   2. Stock — current estimate + threshold
//   3. Update count — primary inventory action
//   4. Movement — last few transactions for THIS item, item-scoped
//
// Future replenishment / restock sections slot in cleanly between
// Update count and Movement (or below) without redesigning the
// drawer.
//
// `transactions` is the page-level activity feed; the drawer
// filters it down to just this item via `inventoryItemId`.
// ----------------------------------------------------------------
function ItemWorkspaceDrawer({ item, transactions, restockOrders, onClose }: {
  item: Item
  transactions: Transaction[]
  restockOrders: RestockOrder[]
  onClose: () => void
}) {
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

  // Item type — equally first-class for both variants. Recipe-linked
  // items get the count surfaced; standalone items are simply
  // labeled as such, never as "missing" metadata.
  const isRecipeLinked = item.recipeLinks > 0
  const typeLabel = isRecipeLinked
    ? `Recipe-linked · ${item.recipeLinks}`
    : 'Standalone'
  const typeTitle = isRecipeLinked
    ? `Used in ${item.recipeLinks} recipe${item.recipeLinks > 1 ? 's' : ''}`
    : 'Standalone item — not linked to any recipe'

  // Item-scoped movement — last 5 transactions for THIS item.
  // Pulled from the page-level activity feed so the rail doesn't
  // need its own fetch.
  const itemMovement = transactions
    .filter((tx) => tx.inventoryItemId === item.id)
    .slice(0, 5)

  // Below-threshold gap drives the Stock overview card's headline.
  const belowThresholdBy =
    item.estimated !== null && item.estimated < item.threshold
      ? item.threshold - item.estimated
      : null

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <aside
        className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white border-l border-gray-200 shadow-xl z-50 flex flex-col"
        aria-label={`${item.name} workspace`}
      >
        {/* Sticky header — same family as Staffing's drawers. The
            type/recipe pill carries first-class context for both
            recipe-linked ingredients and standalone supplies. */}
        <header className="flex-shrink-0 border-b border-gray-100 px-6 py-5 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">Inventory item</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-gray-900 leading-tight truncate">{item.name}</h2>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${st.color}`}>
                <span className={`w-1 h-1 rounded-full ${st.dot}`} />
                {st.label}
              </span>
              <span
                className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600"
                title={typeTitle}
              >
                {typeLabel}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex-shrink-0 text-gray-400 hover:text-gray-600 p-1 -mt-0.5"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* ---- 3-STAT GRID — current stock, threshold, unit.
                 Mirrors the mockup's stat band; these are the
                 numbers a manager checks first. Threshold is
                 click-to-edit via ThresholdStat. */}
          <div className="grid grid-cols-3 gap-2.5">
            <div className="rounded-lg bg-gray-50 border border-gray-100 p-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">Current stock</p>
              <div className="mt-1 flex items-baseline gap-1">
                <span className={`text-base font-semibold font-mono tabular-nums ${
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
            <div className="rounded-lg bg-gray-50 border border-gray-100 p-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">Unit</p>
              <p className="mt-1 text-base font-semibold text-gray-900 truncate">{item.unitOfMeasure}</p>
            </div>
          </div>

          {/* ---- STOCK OVERVIEW — narrative on stock health,
                 last count, counting method. Replaces a generic
                 "Stock" eyebrow with a card the mockup calls out
                 explicitly. */}
          <div className="rounded-xl border border-gray-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
            <p className="text-xs font-semibold text-gray-900 mb-2.5">Stock overview</p>
            <div className="grid grid-cols-2 gap-3 text-[11px]">
              <div>
                {belowThresholdBy !== null ? (
                  <>
                    <p className="text-[10px] uppercase tracking-wide text-gray-400">Below threshold by</p>
                    <p className="text-base font-bold font-mono tabular-nums text-red-600 mt-0.5">
                      {belowThresholdBy.toFixed(2)} {item.unitOfMeasure}
                    </p>
                    <p className="text-[10px] text-gray-500 leading-relaxed mt-1">
                      Reorder soon to avoid stockouts.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[10px] uppercase tracking-wide text-gray-400">Health</p>
                    <p className="text-sm font-semibold text-gray-900 mt-0.5">
                      {item.status === 'no_count' ? 'No count yet' : 'Above threshold'}
                    </p>
                    <p className="text-[10px] text-gray-500 leading-relaxed mt-1">
                      {item.status === 'no_count'
                        ? 'Record a first count to start tracking.'
                        : 'Stock is comfortably above the reorder line.'}
                    </p>
                  </>
                )}
              </div>
              <div className="space-y-2.5">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-gray-400">Last count</p>
                  <p className="text-xs font-medium text-gray-900 mt-0.5">
                    {hasCount
                      ? `${item.lastCount!.toFixed(2)} ${item.unitOfMeasure}`
                      : 'No count recorded'}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-gray-400">Counting method</p>
                  <p className="text-xs font-medium text-gray-900 mt-0.5">Manual</p>
                </div>
              </div>
            </div>
          </div>

          {/* ---- RECENT ACTIVITY — item-scoped movement. */}
          <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
            <div className="border-b border-gray-100 px-4 py-3 flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-900">Recent activity</p>
              <span className="text-[10px] text-gray-400">
                {itemMovement.length === 0 ? 'No movement' : `Last ${itemMovement.length}`}
              </span>
            </div>
            {itemMovement.length === 0 ? (
              <p className="px-4 py-5 text-center text-[11px] text-gray-400">
                Counts and transactions for this item will surface here.
              </p>
            ) : (
              <ul className="divide-y divide-gray-50">
                {itemMovement.map((tx) => (
                  <ItemMovementRow key={tx.id} tx={tx} unit={item.unitOfMeasure} />
                ))}
              </ul>
            )}
          </div>

          {/* ---- REPLENISH — Add to cart with quantity stepper +
                 active order lines + detail form. The mockup's
                 shopping-cart-oriented section. */}
          <ReplenishSection
            item={item}
            orders={restockOrders}
          />

          {/* ---- UPDATE COUNT — kept available but compact; the
                 mockup deemphasizes counting in favor of replenish,
                 so this lives near the bottom rather than at the
                 top of the drawer. */}
          <details className="group rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
            <summary className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors list-none">
              <div>
                <p className="text-xs font-semibold text-gray-900">{countCtaLabel}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {hasCount ? 'Adjust the quantity on hand' : 'Record the first physical count'}
                </p>
              </div>
              <svg className="w-4 h-4 text-gray-400 group-open:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <form action={countAction} className="border-t border-gray-100 px-4 py-3 space-y-2">
              <input type="hidden" name="inventory_item_id" value={item.id} />
              <div className="relative">
                <input
                  name="quantity_on_hand"
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 pr-14 text-sm font-mono font-semibold tabular-nums placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-medium text-gray-400">{item.unitOfMeasure}</span>
              </div>
              <button
                type="submit"
                disabled={countPending}
                className="w-full h-10 rounded-lg bg-gray-900 px-4 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
              >
                {countPending ? 'Saving…' : 'Save count'}
              </button>
              {countState?.error && (
                <p className="text-[11px] text-red-600">{countState.error}</p>
              )}
            </form>
          </details>

          {/* ---- DESTRUCTIVE SECTION — archive + delete moved
                 here from the row's old kebab menu. */}
          <ItemDestructiveSection item={item} />
        </div>
      </aside>
    </>
  )
}

// ----------------------------------------------------------------
// ReplenishSection — replaces the prior ReplenishmentSection with
// a shopping-cart-style "Add to cart" surface as the primary
// interaction. Active drafts/ordered for THIS item are shown above
// the stepper; the stepper drives quickAddToOrder for quantity-only
// adds, and a "Add details" toggle reveals the full CreateRestockForm
// when the manager wants vendor / cost / notes.
// ----------------------------------------------------------------
function ReplenishSection({ item, orders }: { item: Item; orders: RestockOrder[] }) {
  const [qty, setQty] = useState<number>(defaultRestockQty(item))
  const [showDetails, setShowDetails] = useState(false)
  const drafts = orders.filter((o) => o.status === 'draft')
  const ordered = orders.filter((o) => o.status === 'ordered')

  const projectedAfterAdd =
    item.estimated !== null ? item.estimated + qty : qty

  // Step controls: increment by 1 for whole-unit items, 0.5 for
  // fractional. We don't track fractional preference per item, so
  // use 1 by default and let manual entry handle decimals.
  const step = 1
  const dec = () => setQty((n) => Math.max(step, Math.round((n - step) * 100) / 100))
  const inc = () => setQty((n) => Math.round((n + step) * 100) / 100)

  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="border-b border-gray-100 px-4 py-3 flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-900">Replenish</p>
        {(drafts.length > 0 || ordered.length > 0) && (
          <span className="text-[10px] text-gray-400">
            {drafts.length > 0 && `${drafts.length} draft${drafts.length === 1 ? '' : 's'}`}
            {drafts.length > 0 && ordered.length > 0 && ' · '}
            {ordered.length > 0 && `${ordered.length} placed`}
          </span>
        )}
      </div>

      <div className="px-4 py-4 space-y-3">
        {/* Active orders for THIS item — drafts first, then ordered.
            Each line carries its own actions (cancel, mark received). */}
        {drafts.length > 0 && (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wide text-gray-400 mb-1.5">In your cart</p>
            <ul className="space-y-2">
              {drafts.map((order) => (
                <RestockOrderRow key={order.id} order={order} unit={item.unitOfMeasure} />
              ))}
            </ul>
          </div>
        )}

        {ordered.length > 0 && (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wide text-gray-400 mb-1.5">Awaiting receipt</p>
            <ul className="space-y-2">
              {ordered.map((order) => (
                <RestockOrderRow key={order.id} order={order} unit={item.unitOfMeasure} />
              ))}
            </ul>
          </div>
        )}

        {/* Add-to-cart stepper + primary commit. */}
        <div className={drafts.length > 0 || ordered.length > 0 ? 'pt-3 border-t border-gray-100' : ''}>
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-400 mb-2">Add to cart</p>

          {/* Stepper row: - [qty input] + [unit readout] */}
          <div className="flex items-center gap-2">
            <div className="inline-flex items-stretch rounded-lg border border-gray-200 bg-white overflow-hidden flex-1 max-w-[200px]">
              <button
                type="button"
                onClick={dec}
                className="px-3 text-gray-500 hover:bg-gray-50 transition-colors"
                aria-label="Decrease quantity"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
                </svg>
              </button>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={qty}
                onChange={(e) => {
                  const n = parseFloat(e.target.value)
                  if (Number.isFinite(n) && n > 0) setQty(n)
                }}
                className="flex-1 min-w-0 text-center text-sm font-mono font-semibold tabular-nums border-x border-gray-200 focus:outline-none focus:bg-blue-50/40"
                aria-label="Quantity"
              />
              <button
                type="button"
                onClick={inc}
                className="px-3 text-gray-500 hover:bg-gray-50 transition-colors"
                aria-label="Increase quantity"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              </button>
            </div>
            <span className="text-xs text-gray-500">{item.unitOfMeasure}</span>
          </div>

          {/* Projection line — keeps the manager honest about what
              this add will do to stock once received. */}
          <p className="mt-2 text-[11px] text-gray-500">
            Est. after receipt:{' '}
            <span className="font-mono tabular-nums font-medium text-gray-900">
              {projectedAfterAdd.toFixed(2)} {item.unitOfMeasure}
            </span>
          </p>

          {/* Add to cart — primary commit. quickAddToOrder takes
              just qty + item id so this stays a one-click add. */}
          <form action={quickAddToOrder} className="mt-3">
            <input type="hidden" name="inventory_item_id" value={item.id} />
            <input type="hidden" name="quantity" value={qty} />
            <button
              type="submit"
              disabled={qty <= 0}
              className="w-full h-10 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
              Add to cart
            </button>
          </form>

          {/* Detail form — vendor + expected cost + notes. Same
              CreateRestockForm we had before, just gated behind a
              text-link toggle so the simple add stays simple. */}
          {!showDetails ? (
            <button
              type="button"
              onClick={() => setShowDetails(true)}
              className="mt-2.5 w-full text-center text-[11px] font-medium text-gray-500 hover:text-gray-700"
            >
              + Add details (vendor, expected cost, notes)
            </button>
          ) : (
            <div className="mt-3">
              <CreateRestockForm
                item={item}
                onClose={() => setShowDetails(false)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
