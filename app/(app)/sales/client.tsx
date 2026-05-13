'use client'

// ----------------------------------------------------------------
// Sales Client
//
// Sales is the canonical ledger / review / correction workspace for
// completed orders. The UI is intentionally SHARED across both
// branches (native_pos + external_pos) — only the data origin and
// a thin layer of copy differ. Everything structural — page
// hierarchy, filter strip, row design, drawer — is identical so the
// pillar reads as one workspace.
//
// Two bands:
//   1. Header — eyebrow + h1 + mode-aware subtitle + source chip
//   2. Activity — filter strip + paged orders table + drawer
//
// The drawer is the inspection workspace: identity, context chips,
// line items, totals, audit-minded footer, and the correction action.
// ----------------------------------------------------------------

import { useState, useMemo, useActionState, useEffect } from 'react'
import { voidOrder } from '@/app/actions/sales'

// ================================================================
// Domain types
// ================================================================

type Source = 'manual' | 'native_pos' | 'external_pos'
type PaymentType = 'cash' | 'card' | 'other'
type PaymentStatus = 'paid' | 'unpaid'
type OrderStatus = 'completed' | 'voided'
type OperatingMode = 'native_pos' | 'external_pos' | null

interface LineItem {
  id: string
  name: string
  quantity: number
  unitPrice: number
  totalPrice: number
}

interface Order {
  id: string
  total: number
  createdAt: string
  source: Source
  paymentType: PaymentType
  paymentStatus: PaymentStatus
  status: OrderStatus
  note: string | null
  locationName: string | null
  lineItems: LineItem[]
}

// ================================================================
// Source / status vocab — same per-branch, just a label
// ================================================================

const SOURCE_LABEL: Record<Source, string> = {
  manual: 'Manual',
  native_pos: 'POS',
  external_pos: 'External',
}

// Soft text tints for the source column. Restraint over chrome:
// colored text instead of pill chips so the row reads scannably,
// matching Finance's category-tint pattern.
const SOURCE_TEXT: Record<Source, string> = {
  manual: 'text-gray-700',
  native_pos: 'text-blue-700',
  external_pos: 'text-indigo-700',
}

// Drawer chip styles still use pills — appropriate at that scale.
const SOURCE_CHIP: Record<Source, string> = {
  manual: 'bg-gray-100 text-gray-700',
  native_pos: 'bg-blue-50 text-blue-700',
  external_pos: 'bg-indigo-50 text-indigo-700',
}

// Payment-type row tints. Same restrained colored-text pattern the
// Source column uses, but the palette is deliberately disjoint from
// both Source (gray / blue / indigo) and Status (green / red) so
// Payment reads as its own scan axis:
//   • Card  → purple — distinct from Source's blue/indigo
//   • Cash  → orange — distinct from Status's green AND from the
//                       amber Unpaid badge that can sit next to it
//   • Other → neutral gray
const PAYMENT_TEXT: Record<PaymentType, string> = {
  card: 'text-purple-700',
  cash: 'text-orange-700',
  other: 'text-gray-700',
}

const STATUS_META: Record<OrderStatus, { label: string; chip: string; dot: string }> = {
  completed: { label: 'Completed', chip: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
  voided:    { label: 'Voided',    chip: 'bg-red-50 text-red-700',    dot: 'bg-red-500' },
}

// ================================================================
// Filter model
// ================================================================

type Filter = 'all' | Source

// Filter chips are operating-mode aware so the strip doesn't
// advertise sources that won't show up. The set is light (UI only) —
// "All" still surfaces every order, regardless of source, on either
// branch.
function filtersForMode(mode: OperatingMode): Filter[] {
  if (mode === 'external_pos') return ['all', 'external_pos', 'manual']
  if (mode === 'native_pos') return ['all', 'native_pos', 'manual']
  return ['all', 'native_pos', 'external_pos', 'manual']
}

// ================================================================
// Formatting helpers
// ================================================================

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtRowDate(iso: string): { day: string; time: string } {
  const d = new Date(iso)
  return {
    day: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
  }
}

function fmtFullDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function fmtRelative(iso: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime()
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`
  const diffWk = Math.round(diffDay / 7)
  return `${diffWk} week${diffWk === 1 ? '' : 's'} ago`
}

// First two item names, joined by · with an N more suffix.
function fmtItemPreview(items: LineItem[]): string {
  if (items.length === 0) return '—'
  const visible = items.slice(0, 2).map((i) => i.name).join(' · ')
  const extra = items.length - 2
  return extra > 0 ? `${visible} · +${extra} more` : visible
}

// Short, read-only order id (last 6 of a uuid). Lets the drawer
// surface a consistent identifier without ever exposing the raw uuid.
function shortId(id: string): string {
  const cleaned = id.replace(/-/g, '')
  return cleaned.slice(-6).toUpperCase()
}

// ================================================================
// Sales client
// ================================================================

// 10 rows per page: a fixed page size lets the ledger card hold a
// stable visual height (see `min-h` on the card shell below). Rows
// swap inside the surface; the surface itself never resizes.
const PAGE_SIZE = 10

export default function SalesClient({
  orders,
  operatingMode = null,
}: {
  orders: Order[]
  operatingMode?: OperatingMode
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  // Filter ordering is mode-aware so the most-relevant source appears
  // second (right after All), matching the pillar's actual data origin.
  const availableFilters = filtersForMode(operatingMode)

  const visible = useMemo(() => {
    if (filter === 'all') return orders
    return orders.filter((o) => o.source === filter)
  }, [orders, filter])

  // Reset pagination if the filter narrows past the current page.
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pagedOrders = visible.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  useEffect(() => {
    if (page >= pageCount) setPage(0)
  }, [page, pageCount])

  // Close the drawer if the open order disappears after revalidation.
  useEffect(() => {
    if (openId && !orders.find((o) => o.id === openId)) setOpenId(null)
  }, [orders, openId])

  const selected = openId ? orders.find((o) => o.id === openId) ?? null : null

  // Scope-of-list counters and the dollar total for the current
  // filter. Used by the orientation strip above the ledger. These
  // are intentionally bounded to the current view (not the page,
  // not the restaurant) so the strip reads as "what am I looking
  // at?" — ledger truth, not analytics interpretation.
  const completedInView = visible.filter((o) => o.status === 'completed').length
  const voidedInView = visible.filter((o) => o.status === 'voided').length
  const netTotal = visible
    .filter((o) => o.status === 'completed')
    .reduce((s, o) => s + o.total, 0)

  const subtitle = operatingMode === 'external_pos'
    ? 'Review imported orders from your connected POS and correct mistaken sales.'
    : operatingMode === 'native_pos'
      ? 'Review native sales rung up at the in-app POS and correct mistakes.'
      : 'Review recent orders and correct mistaken sales.'

  return (
    <div className="max-w-[1200px]">

      {/* ================================================================ */}
      {/* 1. HEADER                                                        */}
      {/* ================================================================ */}
      <div className="mb-7 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">Sales</h1>
          <p className="mt-1.5 text-sm text-gray-500">{subtitle}</p>
        </div>
        <SourceChip operatingMode={operatingMode} />
      </div>

      {/* ================================================================ */}
      {/* 2. ACTIVITY                                                      */}
      {/* ================================================================ */}
      <section>
        {/* ----- Orientation summary strip -----
            Four ledger-scope cells: count in view, completed,
            voided, and the dollar net of completed sales in the
            current filter. Scope-of-list only — does not interpret,
            does not trend, does not compare. Voided cell tints red
            when there's anything to look at so the eye lands there
            first without adding a separate alert. */}
        <div className="mb-5 rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
            <LedgerStat
              label="In view"
              value={`${visible.length}`}
              hint={`${visible.length === 1 ? 'order' : 'orders'} on this filter`}
            />
            <LedgerStat
              label="Completed"
              value={`${completedInView}`}
              hint={completedInView === 0 ? 'none yet' : 'in current view'}
            />
            <LedgerStat
              label="Voided"
              value={`${voidedInView}`}
              hint={voidedInView === 0 ? 'none' : 'in current view'}
              tone={voidedInView > 0 ? 'warn' : 'neutral'}
            />
            <LedgerStat
              label="Net total"
              value={fmtMoney(netTotal)}
              hint="completed sales"
            />
          </div>
        </div>

        {/* ----- Workflow header / filter bar -----
            Filter chips on the left as the natural starting control
            cluster, active-scope counter on the right. The cluster
            speaks for itself — no "View" label needed. */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex items-center gap-1 rounded-lg border border-gray-200/80 bg-white p-1 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
              {availableFilters.map((f) => {
                const active = filter === f
                const count = f === 'all' ? orders.length : orders.filter((o) => o.source === f).length
                const label =
                  f === 'all' ? 'All' :
                  f === 'manual' ? 'Manual' :
                  f === 'native_pos' ? 'POS' : 'External'
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => { setFilter(f); setPage(0) }}
                    className={`text-[12px] font-medium px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 ${
                      active
                        ? 'bg-gray-900 text-white shadow-sm'
                        : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    {label}
                    <span className={`text-[10px] tabular-nums ${active ? 'text-white/70' : 'text-gray-400'}`}>
                      {count}
                    </span>
                  </button>
                )
              })}
          </div>
          {visible.length > 0 && (
            <p className="text-[11px] text-gray-500 tabular-nums">
              Showing{' '}
              <span className="font-semibold text-gray-700">
                {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, visible.length)}
              </span>{' '}
              of {visible.length}
            </p>
          )}
        </div>

        {/* Orders card.
            Fixed-height ledger surface. The min-h is sized to fit a
            full page of 10 rows + thead + pager, so the card keeps a
            stable visual frame regardless of how many rows are on
            the current page. When a page is short, the existing
            `mt-auto` on the pager pins it to the bottom and the empty
            space sits as quiet whitespace inside the same stable
            surface — no filler rows, no shrinking. */}
        <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col min-h-[680px]">
          {visible.length === 0 ? (
            <EmptyLedger orders={orders.length} filter={filter} />
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left">
                    <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em]">When</th>
                    <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em]">Items</th>
                    <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em]">Source</th>
                    <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em]">Payment</th>
                    <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em]">Status</th>
                    <th className="px-6 py-3 text-[10px] font-semibold text-gray-500 uppercase tracking-[0.14em] text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {pagedOrders.map((o) => (
                    <OrderRow
                      key={o.id}
                      order={o}
                      selected={openId === o.id}
                      onOpen={() => setOpenId(o.id)}
                    />
                  ))}
                </tbody>
              </table>

              {/* Pager pinned at bottom for stable card height.
                  Range readout lives in the workflow header above,
                  so the footer just shows page position + nav. */}
              <div className="mt-auto border-t border-gray-100 px-6 py-3 flex items-center justify-between">
                <p className="text-[11px] text-gray-400 tabular-nums">
                  Page {safePage + 1} of {pageCount}
                </p>
                <div className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    ← Prev
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                    disabled={safePage >= pageCount - 1}
                    className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next →
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {selected && <OrderDrawer order={selected} onClose={() => setOpenId(null)} />}
    </div>
  )
}

// ================================================================
// SourceChip — page-level data-origin pill (Finance pattern)
// ================================================================
function SourceChip({ operatingMode }: { operatingMode: OperatingMode }) {
  const variants: Record<NonNullable<OperatingMode> | 'unset', { label: string; tone: string; dot: string }> = {
    native_pos: {
      label: 'Native POS ledger',
      tone: 'text-blue-700',
      dot: 'bg-blue-500',
    },
    external_pos: {
      label: 'External POS ledger',
      tone: 'text-indigo-700',
      dot: 'bg-indigo-500',
    },
    unset: {
      label: 'Operating mode not set',
      tone: 'text-gray-600',
      dot: 'bg-gray-400',
    },
  }
  const v = variants[operatingMode ?? 'unset']
  return (
    <div className="hidden sm:inline-flex items-center gap-2 self-start text-[11px] font-medium px-3 py-1.5 rounded-full border border-gray-200/80 bg-white/80 backdrop-blur-sm shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <span className={`w-1.5 h-1.5 rounded-full ${v.dot}`} />
      <span className={v.tone}>{v.label}</span>
    </div>
  )
}

// ================================================================
// OrderRow — list-row scan
// ================================================================
function OrderRow({
  order,
  selected,
  onOpen,
}: {
  order: Order
  selected: boolean
  onOpen: () => void
}) {
  const date = fmtRowDate(order.createdAt)
  const isVoided = order.status === 'voided'
  const status = STATUS_META[order.status]
  const itemCount = order.lineItems.reduce((s, l) => s + l.quantity, 0)

  return (
    <tr
      onClick={onOpen}
      aria-selected={selected}
      className={`group cursor-pointer transition-colors ${
        selected
          ? 'bg-blue-50/70 shadow-[inset_3px_0_0_rgba(59,130,246,0.6)]'
          : 'hover:bg-gray-50/70'
      }`}
    >
      {/* When — day on top, time muted underneath */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className={`text-[13px] font-semibold tabular-nums ${isVoided ? 'text-gray-400' : 'text-gray-800'}`}>
          {date.day}
        </div>
        <div className="mt-0.5 text-[11px] text-gray-400 tabular-nums">{date.time}</div>
      </td>
      {/* Items — primary title bumped to semibold, supporting meta
          stays restrained so the row reads as a clear scannable
          identity line + a quieter second line. */}
      <td className="px-6 py-4 max-w-[280px]">
        <p className={`text-sm font-semibold truncate ${
          isVoided ? 'text-gray-400 line-through' : 'text-gray-900'
        }`}>
          {fmtItemPreview(order.lineItems)}
        </p>
        <p className="mt-0.5 text-[11px] text-gray-400 tabular-nums">
          {itemCount} {itemCount === 1 ? 'unit' : 'units'}
          {order.locationName ? <> · {order.locationName}</> : null}
        </p>
      </td>
      {/* Source — colored text, restraint over chrome */}
      <td className={`px-6 py-4 text-[13px] font-medium ${
        isVoided ? 'text-gray-400' : SOURCE_TEXT[order.source]
      }`}>
        {SOURCE_LABEL[order.source]}
      </td>
      {/* Payment — colored text per type (Card blue, Cash green,
          Other neutral) so the column reads at a glance. Same
          family pattern as Source: tone over chrome, no pill in
          the row. */}
      <td className="px-6 py-4 text-[13px]">
        <div className="flex items-center gap-2">
          <span className={`capitalize font-medium ${
            isVoided ? 'text-gray-400' : PAYMENT_TEXT[order.paymentType]
          }`}>
            {order.paymentType}
          </span>
          {order.paymentStatus === 'unpaid' && !isVoided && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
              Unpaid
            </span>
          )}
        </div>
      </td>
      {/* Status — chip pattern, same in row and drawer */}
      <td className="px-6 py-4">
        <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${status.chip}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
      </td>
      {/* Total — right-aligned mono for column alignment */}
      <td className={`px-6 py-4 font-mono tabular-nums text-right text-sm ${
        isVoided ? 'text-gray-400 line-through' : 'text-gray-900 font-semibold'
      }`}>
        {fmtMoney(order.total)}
      </td>
    </tr>
  )
}

// ================================================================
// EmptyLedger — calm, branch-aware empty state
// ================================================================
function EmptyLedger({ orders, filter }: { orders: number; filter: Filter }) {
  const isFilterEmpty = orders > 0 && filter !== 'all'
  return (
    <div className="px-6 py-20 text-center">
      <p className="text-sm font-semibold text-gray-700">
        {isFilterEmpty ? 'Nothing matches this filter' : 'No orders in the ledger yet'}
      </p>
      <p className="mx-auto mt-2 max-w-sm text-xs text-gray-500 leading-relaxed">
        {isFilterEmpty
          ? 'Switch back to All to see every order, or pick a different source.'
          : 'Completed sales appear here for review and correction. The first order will land in this list automatically.'}
      </p>
    </div>
  )
}

// ================================================================
// OrderDrawer — inspection workspace
//
// Family-aligned with the Finance / Staffing / Inventory drawers:
//
//   • Aside is `flex flex-col` so the header band is fixed-height
//     and only the body scrolls — same shell every drawer in the app
//     uses.
//   • Header is the family's calm `text-base font-bold` title +
//     subtitle line + labeled "Close" button. No giant total in the
//     header — the receipt-y dollar hero made the drawer feel like
//     a transaction snapshot instead of a managed object.
//   • Body opens with a 3-cell stats strip (`Total / Items / Lines`)
//     in the family's bordered/divided shell — same anatomy as the
//     Labor and Inventory-spend stat strips. The dollar amount is
//     still prominent, but as one cell of a structured object summary
//     rather than the drawer's hero.
//   • Sections use the family's quiet `mb-3 text-[10px] uppercase
//     tracking-widest text-gray-500` eyebrow with no divider line —
//     drawer-level rhythm is calmer than the page-level band rhythm.
//   • Items is the body's central section: slightly stronger eyebrow
//     tone (text-gray-700) and a compact line-list with the family's
//     primary/secondary/value row pattern.
//   • Correction is a real action-resolution zone: a full-bleed
//     `border-t` separates it from the inspection content, then a
//     calm tinted card houses the explanation + the destructive
//     action.
// ================================================================
function OrderDrawer({ order, onClose }: { order: Order; onClose: () => void }) {
  const [state, action, pending] = useActionState(voidOrder, null)
  const canVoid = order.status === 'completed'
  const status = STATUS_META[order.status]
  const isVoided = order.status === 'voided'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const itemCount = order.lineItems.reduce((s, l) => s + l.quantity, 0)
  const recordedVia =
    order.source === 'native_pos' ? 'In-app POS'
      : order.source === 'external_pos' ? 'External POS import'
        : 'Manual entry'

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-gray-900/30 backdrop-blur-[1px] z-40"
      />
      <aside className="fixed top-0 right-0 z-50 h-full w-full sm:max-w-md bg-white shadow-2xl border-l border-gray-200 flex flex-col">

        {/* ============================================================ */}
        {/* HEADER — family pattern: title + subtitle + Close            */}
        {/* The total moves out of the header into the stats strip below */}
        {/* so the drawer no longer reads as "big-dollar receipt first,  */}
        {/* everything else second." Identity is the lead: the order id  */}
        {/* + status pill, then the time it happened in the subtitle.    */}
        {/* ============================================================ */}
        <div className="border-b border-gray-100 px-6 py-5 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-gray-900 tabular-nums">
                Order #{shortId(order.id)}
              </h2>
              <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${status.chip}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
                {status.label}
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              <span className="text-gray-700">{fmtFullDate(order.createdAt)}</span>
              <span className="text-gray-400"> · {fmtRelative(order.createdAt)}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
          >
            Close
          </button>
        </div>

        {/* Voided audit stamp — full-bleed strip directly under the
            header so the corrected status reads before the body
            content. Sits between the fixed header and the scrollable
            body so it never collides with content on scroll. */}
        {isVoided && (
          <div className="border-b border-red-200/60 bg-red-50/40 px-6 py-2.5 flex items-center gap-2 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            <p className="text-[11px] text-red-700">
              Voided · the original record stays in the ledger for auditability.
            </p>
          </div>
        )}

        {/* ============================================================ */}
        {/* BODY — scrollable, family rhythm                             */}
        {/* ============================================================ */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">

          {/* Stats strip — family pattern (Total / Items / Lines).
              Total carries `prominent` so the dollar amount reads
              as the lead number of the inspection without being
              promoted back into the header. Items and Lines stay
              at the standard cell scale. */}
          <div className="grid grid-cols-3 rounded-xl border border-gray-200 divide-x divide-gray-100 bg-white">
            <DrawerStatCell
              label="Total"
              value={fmtMoney(order.total)}
              prominent
              valueClass={isVoided ? 'text-gray-400 line-through' : 'text-gray-900'}
            />
            <DrawerStatCell
              label="Items"
              value={`${itemCount}`}
              muted={itemCount === 0}
            />
            <DrawerStatCell
              label="Lines"
              value={`${order.lineItems.length}`}
              muted={order.lineItems.length === 0}
            />
          </div>

          {/* Context — source / payment / payment status as a quiet
              chip group. Lives outside the stats strip because these
              are categorical (chip) signals, not numeric (cell). */}
          <div>
            <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Context
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full ${SOURCE_CHIP[order.source]}`}>
                {SOURCE_LABEL[order.source]}
              </span>
              <span className="inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 capitalize">
                {order.paymentType}
              </span>
              <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                order.paymentStatus === 'paid' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
              }`}>
                {order.paymentStatus}
              </span>
            </div>
          </div>

          {/* Provenance — quiet two-up grid */}
          <div>
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Provenance
            </p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <DrawerMeta label="Recorded via" value={recordedVia} />
              <DrawerMeta label="Location" value={order.locationName ?? '—'} />
            </dl>
            {order.note && (
              <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50/40 px-3.5 py-2.5">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                  Note
                </p>
                <p className="text-[12px] text-gray-700 leading-relaxed">{order.note}</p>
              </div>
            )}
          </div>

          {/* Items — drawer's central section.
              Eyebrow tone is bumped from gray-500 to gray-700 (the only
              section to do so) so Items reads as the body's primary
              content without resorting to dividers, badges, or color. */}
          <div>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-700">
                Items
              </p>
              <p className="text-[11px] text-gray-400 tabular-nums">
                {order.lineItems.length} {order.lineItems.length === 1 ? 'line' : 'lines'} · {itemCount} {itemCount === 1 ? 'unit' : 'units'}
              </p>
            </div>
            <ul className="rounded-xl border border-gray-200 bg-white divide-y divide-gray-100">
              {order.lineItems.map((li) => (
                <li
                  key={li.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-gray-900 truncate">
                      {li.name}
                    </p>
                    <p className="mt-0.5 text-[11px] text-gray-500 tabular-nums">
                      {fmtMoney(li.unitPrice)} × {li.quantity}
                    </p>
                  </div>
                  <p className="text-sm font-bold font-mono tabular-nums text-gray-900 flex-shrink-0">
                    {fmtMoney(li.totalPrice)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* ============================================================ */}
        {/* ACTION RESOLUTION ZONE                                       */}
        {/* Full-width footer band, separated from the scrollable body   */}
        {/* by a top border so it reads as the drawer's concluding       */}
        {/* operational moment — not just another bottom card. Pinned    */}
        {/* below the body's flex-1 region so it never scrolls away.     */}
        {/* ============================================================ */}
        <div className="border-t border-gray-200 bg-gray-50/40 px-6 py-5 flex-shrink-0">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            Correction
          </p>
          {canVoid ? (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs font-semibold text-gray-900">Void this order</p>
              <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
                Use this when the order was rung up in error or refunded outside the system.
                Voiding marks the record as corrected and reverses any inventory it depleted.
                The original entry stays in the ledger so the sale, the void event, and any
                reversed stock movement all remain visible for auditing.
              </p>
              <form action={action} className="mt-4">
                <input type="hidden" name="order_id" value={order.id} />
                <button
                  type="submit"
                  disabled={pending}
                  className="w-full rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50 hover:border-red-300 px-4 py-2 text-xs font-semibold disabled:opacity-60 transition-colors"
                >
                  {pending ? 'Voiding…' : 'Void this order'}
                </button>
                {state?.error && (
                  <p className="mt-2 text-[11px] text-red-600">{state.error}</p>
                )}
              </form>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs font-semibold text-gray-700">No further correction available</p>
              <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
                This order has already been voided. The record is preserved as-is so the original
                sale, the void event, and any reversed inventory all stay visible to an auditor.
              </p>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

// ================================================================
// LedgerStat — the ledger-scope summary cell used in the page's
// orientation strip. Same family as the drawer stat cell but with
// a `hint` line underneath the value (the orientation strip is
// horizontal and the cells need to declare scope, not just label).
// `tone="warn"` tints the value red — used by the Voided cell so
// the eye lands on it first when there are voids to inspect.
// ================================================================
function LedgerStat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint: string
  tone?: 'neutral' | 'warn'
}) {
  const valueColor = tone === 'warn' ? 'text-red-700' : 'text-gray-900'
  return (
    <div className="px-5 py-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
        {label}
      </p>
      <p className={`mt-1 text-[17px] font-bold tabular-nums ${valueColor}`}>{value}</p>
      <p className="mt-0.5 text-[10px] text-gray-400">{hint}</p>
    </div>
  )
}

// ================================================================
// Drawer-local primitives
//
// Match the family's stat-cell / meta-pair pattern exactly. The
// stat cell is the Sales analogue of Finance's `DrawerStat` — same
// padding, same uppercase label, same bold value — so the strip
// reads as the same component family across pillars.
// ================================================================
function DrawerStatCell({
  label,
  value,
  muted = false,
  prominent = false,
  valueClass,
}: {
  label: string
  value: string
  muted?: boolean
  prominent?: boolean
  valueClass?: string
}) {
  const tone = valueClass ?? (muted ? 'text-gray-300' : 'text-gray-900')
  return (
    <div className="px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{label}</p>
      <p
        className={`mt-1 font-bold tabular-nums truncate font-mono ${
          prominent ? 'text-lg' : 'text-base'
        } ${tone}`}
      >
        {value}
      </p>
    </div>
  )
}

// Stacked key/value pair used in the Provenance grid. Vertical
// orientation so two pairs sit side by side without competing for
// width — labels stay restrained on top, values get full width below.
function DrawerMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">{label}</dt>
      <dd className="mt-1 text-[12px] text-gray-800 truncate">{value}</dd>
    </div>
  )
}
