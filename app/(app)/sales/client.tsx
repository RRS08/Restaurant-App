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

// 6 rows per page. Fixed page size so the ledger card holds a
// stable visual height (see `min-h` on the card shell below); rows
// swap inside the surface and the surface itself never resizes.
const PAGE_SIZE = 6

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

  // Sales-focused metrics for the orientation strip. Scope is the
  // current filter, not the whole restaurant, so the strip reads as
  // "what does this slice look like" — ledger truth, not analytics
  // interpretation. Average ticket = sales total ÷ completed order
  // count; if no completed orders, it reads $0.00.
  const completedOrders = visible.filter((o) => o.status === 'completed')
  const voidedOrders = visible.filter((o) => o.status === 'voided')
  const salesTotal = completedOrders.reduce((s, o) => s + o.total, 0)
  const orderCount = completedOrders.length
  const voidCount = voidedOrders.length
  const avgTicket = orderCount > 0 ? salesTotal / orderCount : 0

  const subtitle = operatingMode === 'external_pos'
    ? 'Imported orders from your connected POS.'
    : operatingMode === 'native_pos'
      ? 'Native sales from the in-app POS.'
      : 'Recent orders for review.'

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
        {/* ----- Sales snapshot strip -----
            Four sales-focused cells: Sales total / Orders / Average
            ticket / Voids. Reads as a quick commercial summary, not
            as table metadata. Average ticket = sales total ÷ orders
            (completed only). Voids cell tints amber when non-zero
            so the eye lands there first without an extra alert. */}
        <div className="mb-5 rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
            <LedgerStat
              label="Sales total"
              value={fmtMoney(salesTotal)}
              hint="completed in view"
            />
            <LedgerStat
              label="Orders"
              value={`${orderCount}`}
              hint={orderCount === 1 ? 'completed order' : 'completed orders'}
            />
            <LedgerStat
              label="Average ticket"
              value={fmtMoney(avgTicket)}
              hint={orderCount === 0 ? 'no completed orders' : 'per completed order'}
            />
            <LedgerStat
              label="Voids"
              value={`${voidCount}`}
              hint={voidCount === 0 ? 'none' : 'in current view'}
              tone={voidCount > 0 ? 'warn' : 'neutral'}
            />
          </div>
        </div>

        {/* ----- Workflow header / filter bar -----
            Filter chips on their own row. The header-side range
            readout that used to live here was consolidated into
            the footer pager so navigation context lives in one
            place. */}
        <div className="mb-3 flex flex-wrap items-center gap-3">
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
              {/* Card-list order feed. The table chrome (thead /
                  tbody / tr / td) was replaced with a stacked ul of
                  vertical-card rows so each order reads as one scan
                  surface: date at top, item summary primary, meta
                  small, and Source · Payment · Status + total on the
                  bottom row. Less admin-table, more modern ledger. */}
              <ul className="divide-y divide-gray-100">
                {pagedOrders.map((o) => (
                  <OrderRow
                    key={o.id}
                    order={o}
                    selected={openId === o.id}
                    onOpen={() => setOpenId(o.id)}
                  />
                ))}
              </ul>

              {/* Pager pinned at bottom for stable card height.
                  Compact "Showing N–M of T · ← X / Y →" footer that
                  matches the rest of the product family (Inventory,
                  Finance, Restock Orders). */}
              <div className="mt-auto border-t border-gray-100 px-6 py-2.5 flex items-center justify-between">
                <p className="text-[10px] text-gray-500 tabular-nums">
                  Showing{' '}
                  <span className="font-semibold text-gray-700">
                    {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, visible.length)}
                  </span>{' '}
                  of <span className="font-semibold text-gray-700">{visible.length}</span>
                </p>
                <div className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    aria-label="Previous orders"
                    className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    ←
                  </button>
                  <span className="text-[10px] text-gray-500 px-1.5 tabular-nums">
                    {safePage + 1} / {pageCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                    disabled={safePage >= pageCount - 1}
                    aria-label="Next orders"
                    className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    →
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
// OrderRow — vertical card-list row.
//
// Visual hierarchy:
//   • Top-left: date · time (quiet)
//   • Item summary (primary — semibold)
//   • Meta: N items · location (smaller)
//   • Bottom: Source · Payment · Status (inline, colored text) + Total ($)
//
// The row is a clickable surface; the selected state matches the
// prior shadow-inset blue accent so deep-link / drawer selection
// still reads identically. Voided rows strike-through the item
// summary + total and mute the colored chips to gray.
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
    <li
      onClick={onOpen}
      aria-selected={selected}
      className={`group cursor-pointer transition-colors ${
        selected
          ? 'bg-blue-50/70 shadow-[inset_3px_0_0_rgba(59,130,246,0.6)]'
          : 'hover:bg-gray-50/70'
      }`}
    >
      <div className="px-6 py-3.5">
        {/* Top — date / time */}
        <p className="text-[11px] text-gray-500 tabular-nums">
          {date.day} <span className="text-gray-300">·</span> {date.time}
        </p>
        {/* Item summary — primary identity */}
        <p className={`mt-0.5 text-sm font-semibold truncate ${
          isVoided ? 'text-gray-400 line-through' : 'text-gray-900'
        }`}>
          {fmtItemPreview(order.lineItems)}
        </p>
        {/* Meta — count + location */}
        <p className="mt-0.5 text-[11px] text-gray-400 tabular-nums">
          {itemCount} {itemCount === 1 ? 'item' : 'items'}
          {order.locationName ? <> · {order.locationName}</> : null}
        </p>
        {/* Bottom — Source · Payment · Status, total on the right */}
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-medium min-w-0">
            <span className={isVoided ? 'text-gray-400' : SOURCE_TEXT[order.source]}>
              {SOURCE_LABEL[order.source]}
            </span>
            <span className="text-gray-300">·</span>
            <span className={`capitalize ${isVoided ? 'text-gray-400' : PAYMENT_TEXT[order.paymentType]}`}>
              {order.paymentType}
            </span>
            <span className="text-gray-300">·</span>
            <span className={`inline-flex items-center gap-1 ${
              isVoided ? 'text-red-700' : 'text-green-700'
            }`}>
              <span className={`w-1 h-1 rounded-full ${status.dot}`} />
              {status.label}
            </span>
            {order.paymentStatus === 'unpaid' && !isVoided && (
              <>
                <span className="text-gray-300">·</span>
                <span className="text-amber-700">Unpaid</span>
              </>
            )}
          </div>
          <p className={`text-base font-mono tabular-nums whitespace-nowrap flex-shrink-0 ${
            isVoided ? 'text-gray-400 line-through' : 'text-gray-900 font-bold'
          }`}>
            {fmtMoney(order.total)}
          </p>
        </div>
      </div>
    </li>
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
// OrderDrawer — physical-ticket workflow.
//
// Reframed from a generic inspection drawer into something that
// reads like a printed sale ticket with controlled correction
// tools. Top-down:
//
//   1. Header — order #, status pill, "Status · Source · Payment"
//      meta line, full date.
//   2. Voided ribbon (when voided) — same as before.
//   3. Body sections (scrollable):
//        a. Sale total hero — large dollar amount.
//        b. Ticket — receipt-style line items.
//        c. Payment — method · status · amount.
//        d. Source — recorded-via location.
//        e. Adjustments — placeholder with item-level deferral note.
//        f. Note (optional) — when the order carries a note string.
//   4. Footer — Correction tools, compact: a single Void order row
//      with short copy and a small action button on the right.
//
// Item-level void is DEFERRED. It requires schema columns on
// order_items (voided_at / void_reason) + a new server action with
// per-line inventory reversal — too risky for a UI redesign pass.
// The Adjustments section calls out that future capability so the
// manager doesn't expect it from this build.
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
  // Manager-friendly source phrasing: "In-app POS · Location" /
  // "External POS · Location" / "Manual entry · Location".
  const sourceTitle =
    order.source === 'native_pos' ? 'In-app POS'
      : order.source === 'external_pos' ? 'External POS'
        : 'Manual entry'
  const sourceLine = order.locationName
    ? `${sourceTitle} · ${order.locationName}`
    : sourceTitle
  const paymentTypeLabel = order.paymentType.charAt(0).toUpperCase() + order.paymentType.slice(1)
  const paymentStatusLabel =
    isVoided ? 'Voided'
      : order.paymentStatus === 'paid' ? 'Paid'
        : 'Unpaid'
  const paymentStatusTone =
    paymentStatusLabel === 'Voided' ? 'text-red-700'
      : paymentStatusLabel === 'Paid' ? 'text-green-700'
        : 'text-amber-700'

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-gray-900/30 backdrop-blur-[1px] z-40"
      />
      <aside className="fixed top-0 right-0 z-50 h-full w-full sm:max-w-md md:max-w-lg lg:max-w-md bg-white shadow-2xl border-l border-gray-200 flex flex-col">

        {/* HEADER — Order # + status pill, then a "Status · Source ·
            Payment" meta line so the cashier reads the order's
            shape at a glance. Date sits below as quiet context. */}
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
            <p className="mt-1 text-xs text-gray-600">
              {status.label}
              <span className="text-gray-300 mx-1">·</span>
              {SOURCE_LABEL[order.source]}
              <span className="text-gray-300 mx-1">·</span>
              <span className="capitalize">{order.paymentType}</span>
            </p>
            <p className="mt-0.5 text-[11px] text-gray-500 tabular-nums">
              {fmtFullDate(order.createdAt)} <span className="text-gray-300">·</span> {fmtRelative(order.createdAt)}
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

        {/* Voided audit stamp — full-bleed ribbon between the fixed
            header and the scrolling body. */}
        {isVoided && (
          <div className="border-b border-red-200/60 bg-red-50/40 px-6 py-2.5 flex items-center gap-2 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            <p className="text-[11px] text-red-700">
              Voided · the original record stays in the ledger for audit history.
            </p>
          </div>
        )}

        {/* BODY — Sale total hero → Ticket → Payment → Source →
            Adjustments → optional Note. */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* a. Sale total — hero. Large mono dollar amount + item /
              line count, framed by a calm bordered card so it reads
              as the receipt's headline number. */}
          <div className="rounded-xl border border-gray-200/80 bg-gray-50/40 px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Sale total
            </p>
            <p className={`mt-1 text-[28px] leading-none font-mono tabular-nums font-bold ${
              isVoided ? 'text-gray-400 line-through' : 'text-gray-900'
            }`}>
              {fmtMoney(order.total)}
            </p>
            <p className="mt-2 text-[11px] text-gray-500 tabular-nums">
              {itemCount} {itemCount === 1 ? 'item' : 'items'}
              <span className="text-gray-300"> · </span>
              {order.lineItems.length} {order.lineItems.length === 1 ? 'line' : 'lines'}
            </p>
          </div>

          {/* b. Ticket — receipt-style line list. Each line:
                  {name}
                  {qty} × {unit price}                        {line total}
              The eyebrow is bumped to gray-700 (the only stronger
              eyebrow in this drawer) so Ticket reads as the body's
              primary content. */}
          <div>
            <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-widest text-gray-700">
              Ticket
            </p>
            <ul className="rounded-xl border border-gray-200/80 bg-white divide-y divide-gray-100">
              {order.lineItems.map((li) => (
                <li
                  key={li.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className={`text-[13px] font-semibold truncate ${
                      isVoided ? 'text-gray-400 line-through' : 'text-gray-900'
                    }`}>
                      {li.name}
                    </p>
                    <p className="mt-0.5 text-[11px] text-gray-500 tabular-nums">
                      {li.quantity} × {fmtMoney(li.unitPrice)}
                    </p>
                  </div>
                  <p className={`text-sm font-bold font-mono tabular-nums whitespace-nowrap ${
                    isVoided ? 'text-gray-400 line-through' : 'text-gray-900'
                  }`}>
                    {fmtMoney(li.totalPrice)}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          {/* c. Payment — method · status · amount on one line. */}
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Payment
            </p>
            <div className="rounded-lg border border-gray-200/80 bg-white px-4 py-3 flex items-baseline justify-between gap-3">
              <p className="text-[13px] min-w-0 flex flex-wrap items-baseline gap-x-1.5">
                <span className={`font-medium ${isVoided ? 'text-gray-400' : PAYMENT_TEXT[order.paymentType]}`}>
                  {paymentTypeLabel}
                </span>
                <span className="text-gray-300">·</span>
                <span className={`font-medium ${paymentStatusTone}`}>
                  {paymentStatusLabel}
                </span>
              </p>
              <p className={`text-sm font-mono tabular-nums font-semibold whitespace-nowrap ${
                isVoided ? 'text-gray-400 line-through' : 'text-gray-900'
              }`}>
                {fmtMoney(order.total)}
              </p>
            </div>
          </div>

          {/* d. Source — manager-friendly "In-app POS · Location" /
              "External POS · Location" / "Manual entry · Location". */}
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Source
            </p>
            <div className="rounded-lg border border-gray-200/80 bg-white px-4 py-3">
              <p className="text-[13px] text-gray-900">{sourceLine}</p>
            </div>
          </div>

          {/* e. Adjustments — placeholder. Item-level corrections
              require schema + action work (see code comment above)
              and are deferred. When no adjustments exist on the
              order, the section communicates that calmly without
              faking a corrections feed. */}
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Adjustments
            </p>
            <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/40 px-4 py-3 text-center">
              <p className="text-[12px] text-gray-600">No adjustments yet.</p>
              <p className="mt-1 text-[10px] text-gray-400 leading-relaxed">
                Item-level voids, refunds, and comp tools are coming in a future update.
              </p>
            </div>
          </div>

          {/* f. Note — only when the order carries one. */}
          {order.note && (
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                Note
              </p>
              <div className="rounded-lg border border-gray-200 bg-gray-50/40 px-4 py-3">
                <p className="text-[12px] text-gray-700 leading-relaxed">{order.note}</p>
              </div>
            </div>
          )}
        </div>

        {/* FOOTER — Correction tools. Compact: a single row with
            short copy on the left and a small Void order button on
            the right. Less dominant than the Ticket above, but
            clearly the drawer's destructive resolution. */}
        <div className="border-t border-gray-100 bg-white px-6 py-3.5 flex-shrink-0">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            Correction tools
          </p>
          {canVoid ? (
            <div className="rounded-lg border border-gray-200/80 bg-gray-50/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-gray-900">Void order</p>
                  <p className="mt-1 text-[11px] text-gray-500 leading-snug">
                    Use when the full sale was rung in error or refunded outside the system. The original ticket stays in the ledger.
                  </p>
                </div>
                <form action={action} className="flex-shrink-0">
                  <input type="hidden" name="order_id" value={order.id} />
                  <button
                    type="submit"
                    disabled={pending}
                    className="rounded-md border border-red-200 bg-white text-red-700 hover:bg-red-50 hover:border-red-300 px-3 py-1.5 text-[11px] font-semibold disabled:opacity-60 transition-colors whitespace-nowrap"
                  >
                    {pending ? 'Voiding…' : 'Void order'}
                  </button>
                </form>
              </div>
              {state?.error && (
                <p className="mt-2 text-[11px] text-red-600">{state.error}</p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200/80 bg-gray-50/40 p-3">
              <p className="text-[12px] font-semibold text-gray-700">Already voided</p>
              <p className="mt-1 text-[11px] text-gray-500 leading-snug">
                The record stays in the ledger for audit history.
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

