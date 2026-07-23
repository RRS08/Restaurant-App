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

import { useState, useActionState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { voidOrder } from '@/app/actions/sales'
import { makeT, type Lang } from '@/lib/i18n'

type T = (en: string, es?: string) => string

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
  /** Variant / modifier subline for POS sources that expose it
   *  (Poynt: "1oz-Loose", "45g - Organic"). Null for manual +
   *  native + legacy. Rendered on its own line beneath the name. */
  variantLabel: string | null
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
  // Receipt-shaped enrichment — nullable because manual + legacy
  // rows don't carry it. When present, the drawer renders a
  // Subtotal / Discount / Tax breakdown block and payment card
  // details.
  subtotal:      number | null
  discountTotal: number | null
  taxTotal:      number | null
  cardBrand:     string | null
  cardLast4:     string | null
  customerName:  string | null
  channelSource: string | null
  locationName: string | null
  lineItems: LineItem[]
}

// ================================================================
// Source / status vocab — same per-branch, just a label
// ================================================================

function sourceLabel(t: T): Record<Source, string> {
  return {
    manual: t('Manual', 'Manual'),
    native_pos: t('POS', 'POS'),
    external_pos: t('External', 'Externo'),
  }
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

function statusMeta(t: T): Record<OrderStatus, { label: string; chip: string; dot: string }> {
  return {
    completed: { label: t('Completed', 'Completada'), chip: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
    voided:    { label: t('Voided', 'Anulada'),       chip: 'bg-red-50 text-red-700',    dot: 'bg-red-500' },
  }
}

// ================================================================
// Formatting helpers
// ================================================================

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtRowDate(iso: string, locale: string = 'en-US'): { day: string; time: string } {
  const d = new Date(iso)
  return {
    day: d.toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }),
  }
}

function fmtFullDate(iso: string, locale: string = 'en-US'): string {
  return new Date(iso).toLocaleString(locale, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function fmtRelative(iso: string, t: T, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime()
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return t('just now', 'justo ahora')
  if (diffMin < 60) return `${diffMin} ${t('min ago', 'min atrás')}`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr} ${diffHr === 1 ? t('hour ago', 'hora atrás') : t('hours ago', 'horas atrás')}`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay} ${diffDay === 1 ? t('day ago', 'día atrás') : t('days ago', 'días atrás')}`
  const diffWk = Math.round(diffDay / 7)
  return `${diffWk} ${diffWk === 1 ? t('week ago', 'semana atrás') : t('weeks ago', 'semanas atrás')}`
}

// First two item names, joined by · with an N more suffix.
function fmtItemPreview(items: LineItem[], t: T): string {
  if (items.length === 0) return '—'
  const visible = items.slice(0, 2).map((i) => i.name).join(' · ')
  const extra = items.length - 2
  return extra > 0 ? `${visible} · +${extra} ${t('more', 'más')}` : visible
}

// Short, read-only order id (last 6 of a uuid). Lets the drawer
// surface a consistent identifier without ever exposing the raw uuid.
function shortId(id: string): string {
  const cleaned = id.replace(/-/g, '')
  return cleaned.slice(-6).toUpperCase()
}

// Poynt's `context.source` values are terse SCREAM_CASE. Render
// them as short human strings so the manager doesn't have to
// parse "INSTORE" every time they open the drawer. Unknown values
// fall through unchanged rather than getting hidden — a new
// channel type shouldn't silently disappear from the UI.
function channelLabel(raw: string, t: T): string {
  switch (raw.toUpperCase()) {
    case 'INSTORE': return t('In-store', 'En tienda')
    case 'WEB':     return t('Online', 'En línea')
    case 'MOBILE':  return t('Mobile', 'Móvil')
    case 'CALLIN':  return t('Phone', 'Teléfono')
    case 'MOTO':    return t('Card-not-present', 'Sin tarjeta presente')
    default: return raw
  }
}

// ================================================================
// Day navigator helpers + component
// ================================================================
//
// Dates in the URL are plain YYYY-MM-DD strings (business_date
// in the restaurant's local timezone). Prev/next arithmetic uses
// UTC-noon parsing so shifting by 24 h can't accidentally roll
// into the wrong day at DST edges — a plain new Date('2026-03-08')
// would be interpreted as midnight UTC and offsetting 24 h across
// a DST boundary in the browser's local zone could land on the
// same date. Anchor at noon keeps us safely in the middle of
// the day.

function shiftBusinessDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const noon = Date.UTC(y, m - 1, d, 12, 0, 0)
  const shifted = new Date(noon + deltaDays * 86_400_000)
  const yy = shifted.getUTCFullYear()
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(shifted.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function fmtBusinessDate(iso: string, locale: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const local = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  return local.toLocaleDateString(locale, {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

// Minimum horizontal drag distance (px) to register a swipe. Small
// enough to feel responsive on iPad, large enough that a slow tap
// with slight finger drift doesn't accidentally navigate.
const SWIPE_THRESHOLD_PX = 55

function HeroDayCard({
  date, today, lang, t,
  salesTotal, orderCount, avgTicket, voidCount,
}: {
  date: string; today: string; lang: Lang; t: T
  salesTotal: number; orderCount: number; avgTicket: number; voidCount: number
}) {
  const router = useRouter()
  const locale = lang === 'es' ? 'es-ES' : 'en-US'
  const prevDate = shiftBusinessDate(date, -1)
  const nextDate = shiftBusinessDate(date, +1)
  const isToday = date === today
  const canGoNext = date < today

  const daysDelta = Math.round(
    (Date.UTC(
      ...(today.split('-').map(Number) as [number, number, number]),
    ) - Date.UTC(
      ...(date.split('-').map(Number) as [number, number, number]),
    )) / 86_400_000,
  )
  const relative =
    daysDelta === 0 ? t('Today', 'Hoy')
      : daysDelta === 1 ? t('Yesterday', 'Ayer')
        : daysDelta > 1 ? `${daysDelta} ${t('days ago', 'días atrás')}`
          : null

  // ---- Swipe navigation ----
  // Track the touch start point and, on release, decide whether the
  // gesture was a horizontal swipe worth acting on. Vertical motion
  // above a ratio bails so the page can still scroll normally.
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
  }
  const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    const startX = touchStartX.current
    const startY = touchStartY.current
    touchStartX.current = null
    touchStartY.current = null
    if (startX === null || startY === null) return
    const dx = e.changedTouches[0].clientX - startX
    const dy = e.changedTouches[0].clientY - startY
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return           // too short
    if (Math.abs(dy) > Math.abs(dx) * 0.7) return           // too vertical
    if (dx < 0) {
      // Swipe left → move forward in time. Guard against browsing
      // past today so URL fiddling is the only way to see the future.
      if (canGoNext) router.push(`/sales?date=${nextDate}`)
    } else {
      router.push(`/sales?date=${prevDate}`)
    }
  }

  // ---- Calendar picker via native <input type="date"> ----
  // On iPad this opens the iOS date roulette; on desktop it opens
  // the browser's native date picker. Max is clamped to today so
  // the picker itself disables future dates.
  const onPickDate = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.value
    if (!picked || !/^\d{4}-\d{2}-\d{2}$/.test(picked)) return
    if (picked === date) return
    router.push(`/sales?date=${picked}`)
  }

  return (
    <div
      // touch-pan-y: still allow vertical scrolling; we only steal
      // horizontal gestures. w-fit + inline-block so the card only
      // wraps its content, not the full available width.
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      // Full-width card so it lines up with the orders feed below;
      // content inside stays center-aligned so the big number reads
      // as the anchor even in a wide surface.
      className="w-full rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-8 py-6 select-none touch-pan-y text-center"
    >
      {/* Row 1 — date on top, centered over the big number.
          Tap the date to open the native date picker (input
          layered under the label at opacity 0). Jump-to-today
          link sits outside the label so it isn't part of the
          picker's click target. Day navigation is swipe-only —
          arrows removed per pilot request. */}
      <div className="mb-3 flex items-baseline justify-center gap-2 flex-wrap">
        <label className="relative cursor-pointer group">
          <span className="text-[15px] leading-none font-semibold tracking-tight text-gray-900 group-hover:text-gray-700 transition-colors">
            {fmtBusinessDate(date, locale)}
          </span>
          <input
            type="date"
            value={date}
            max={today}
            onChange={onPickDate}
            aria-label={t('Pick a date', 'Elegir una fecha')}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
        </label>
        {relative && (
          <span className="text-[12px] text-gray-500">
            {relative}
            {!isToday && (
              <>
                <span className="text-gray-300 mx-1.5">·</span>
                <Link href="/sales" className="text-gray-600 hover:text-gray-900 underline underline-offset-2 decoration-gray-300 hover:decoration-gray-500">
                  {t('Jump to today', 'Ir a hoy')}
                </Link>
              </>
            )}
          </span>
        )}
      </div>

      {/* Row 2 — hero sales total. Tabular mono numerals so digits
          have consistent width regardless of the value. */}
      <p className={`text-[44px] sm:text-[52px] leading-none font-mono tabular-nums font-semibold tracking-tight ${
        salesTotal > 0 ? 'text-gray-900' : 'text-gray-300'
      }`}>
        {fmtMoney(salesTotal)}
        <span className="text-[14px] text-gray-400 font-medium ml-2 align-top mt-2 inline-block">USD</span>
      </p>

      {/* Row 3 — quiet inline metrics. Voids segment tints amber
          only when > 0 so a zero-void day reads calmly. */}
      <p className="mt-3 text-[13px] text-gray-500 flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
        <span>
          <span className="font-semibold text-gray-800 tabular-nums">{orderCount}</span>{' '}
          {orderCount === 1 ? t('sale', 'venta') : t('sales', 'ventas')}
        </span>
        <span className="text-gray-300">·</span>
        <span>
          <span className="font-semibold text-gray-800 tabular-nums">{fmtMoney(avgTicket)}</span>{' '}
          {t('avg ticket', 'ticket promedio')}
        </span>
        {voidCount > 0 && (
          <>
            <span className="text-gray-300">·</span>
            <span className="text-amber-700">
              <span className="font-semibold tabular-nums">{voidCount}</span>{' '}
              {voidCount === 1 ? t('voided', 'anulada') : t('voided', 'anuladas')}
            </span>
          </>
        )}
      </p>
    </div>
  )
}

// ================================================================
// Sales client
// ================================================================

export default function SalesClient({
  lang,
  orders,
  operatingMode = null,
  date,
  today,
}: {
  lang: Lang
  orders: Order[]
  operatingMode?: OperatingMode
  /** YYYY-MM-DD of the day currently displayed. Server picked it
   *  from ?date or defaulted to today in the restaurant's TZ. */
  date: string
  /** YYYY-MM-DD of today in the restaurant's timezone. Used by
   *  the DayNav to know when to show a "Jump to today" link and
   *  to gate the next-day arrow (no browsing the future). */
  today: string
}) {
  const t = makeT(lang)
  const [openId, setOpenId] = useState<string | null>(null)

  // Close the drawer if the open order disappears after revalidation.
  useEffect(() => {
    if (openId && !orders.find((o) => o.id === openId)) setOpenId(null)
  }, [orders, openId])

  const selected = openId ? orders.find((o) => o.id === openId) ?? null : null

  // Day-scoped metrics. Query already narrows to one business_date,
  // so these are naturally per-day. Average ticket = sales total ÷
  // completed order count; $0.00 when no completed orders exist yet.
  const completedOrders = orders.filter((o) => o.status === 'completed')
  const voidedOrders = orders.filter((o) => o.status === 'voided')
  const salesTotal = completedOrders.reduce((s, o) => s + o.total, 0)
  const orderCount = completedOrders.length
  const voidCount = voidedOrders.length
  const avgTicket = orderCount > 0 ? salesTotal / orderCount : 0

  return (
    <div className="max-w-[1200px]">
      {/* ================================================================ */}
      {/* HERO CARD — compact bordered card that owns the date nav +      */}
      {/* sales total + inline metrics. Sized to content (not full        */}
      {/* width) and left-aligned in the page. Day navigation is         */}
      {/* swipe-only; tap the date to open a native calendar picker.    */}
      {/* Source chip lives above the card as a quiet page-context      */}
      {/* pill so the card stays focused on the day's numbers.           */}
      {/* ================================================================ */}
      <section className="mb-6">
        <div className="mb-3 flex justify-center">
          <SourceChip operatingMode={operatingMode} t={t} />
        </div>
        <HeroDayCard
          date={date}
          today={today}
          lang={lang}
          t={t}
          salesTotal={salesTotal}
          orderCount={orderCount}
          avgTicket={avgTicket}
          voidCount={voidCount}
        />
      </section>

      {/* ================================================================ */}
      {/* FEED — free-scroll list of the day's orders. Day-scoped so the  */}
      {/* browser scroll is the pager. Empty state sits inside the        */}
      {/* card on light days.                                             */}
      {/* ================================================================ */}
      <section>
        <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
          {orders.length === 0 ? (
            <EmptyLedger t={t} isToday={date === today} />
          ) : (
            <ul className="divide-y divide-gray-100">
              {orders.map((o) => (
                <OrderRow
                  key={o.id}
                  order={o}
                  selected={openId === o.id}
                  onOpen={() => setOpenId(o.id)}
                  t={t}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      {selected && <OrderDrawer order={selected} onClose={() => setOpenId(null)} t={t} />}
    </div>
  )
}

// ================================================================
// SourceChip — page-level data-origin pill (Finance pattern)
// ================================================================
function SourceChip({ operatingMode, t }: { operatingMode: OperatingMode; t: T }) {
  const variants: Record<NonNullable<OperatingMode> | 'unset', { label: string; tone: string; dot: string }> = {
    native_pos: {
      label: t('Native POS ledger', 'Libro POS nativo'),
      tone: 'text-blue-700',
      dot: 'bg-blue-500',
    },
    external_pos: {
      label: t('External POS ledger', 'Libro POS externo'),
      tone: 'text-indigo-700',
      dot: 'bg-indigo-500',
    },
    unset: {
      label: t('Operating mode not set', 'Modo de operación no configurado'),
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
  t,
}: {
  order: Order
  selected: boolean
  onOpen: () => void
  t: T
}) {
  const isEs = t('__lang_probe__', 'es') === 'es'
  const locale = isEs ? 'es-ES' : 'en-US'
  const date = fmtRowDate(order.createdAt, locale)
  const isVoided = order.status === 'voided'
  const STATUS_META = statusMeta(t)
  const SOURCE_LABEL = sourceLabel(t)
  const status = STATUS_META[order.status]
  const itemCount = order.lineItems.reduce((s, l) => s + l.quantity, 0)
  // Localized payment-type and capitalized label for the bottom row.
  const paymentLabel =
    order.paymentType === 'cash' ? t('Cash', 'Efectivo')
      : order.paymentType === 'card' ? t('Card', 'Tarjeta')
        : t('Other', 'Otro')

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
        <p className="text-[11px] text-gray-500 font-mono tabular-nums">
          {date.day} <span className="text-gray-300">·</span> {date.time}
        </p>
        {/* Item summary — primary identity */}
        <p className={`mt-0.5 text-sm font-semibold truncate ${
          isVoided ? 'text-gray-400 line-through' : 'text-gray-900'
        }`}>
          {fmtItemPreview(order.lineItems, t)}
        </p>
        {/* Meta — count + location */}
        <p className="mt-0.5 text-[11px] text-gray-400 font-mono tabular-nums">
          {itemCount} {itemCount === 1 ? t('item', 'artículo') : t('items', 'artículos')}
          {order.locationName ? <> · {order.locationName}</> : null}
        </p>
        {/* Bottom — Source · Payment · Status, total on the right */}
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-medium min-w-0">
            <span className={isVoided ? 'text-gray-400' : SOURCE_TEXT[order.source]}>
              {SOURCE_LABEL[order.source]}
            </span>
            <span className="text-gray-300">·</span>
            <span className={isVoided ? 'text-gray-400' : PAYMENT_TEXT[order.paymentType]}>
              {paymentLabel}
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
                <span className="text-amber-700">{t('Unpaid', 'No pagada')}</span>
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
function EmptyLedger({ t, isToday }: { t: T; isToday: boolean }) {
  return (
    <div className="px-6 py-20 text-center">
      <p className="text-sm font-semibold text-gray-700">
        {isToday
          ? t('No sales yet today', 'Sin ventas hoy aún')
          : t('No sales on this day', 'Sin ventas este día')}
      </p>
      <p className="mx-auto mt-2 max-w-sm text-xs text-gray-500 leading-relaxed">
        {isToday
          ? t('Completed sales land here as they close. The first order will appear automatically.', 'Las ventas completadas aparecen aquí al cerrarse. La primera orden se mostrará automáticamente.')
          : t('Use the day navigator above to move to another date.', 'Usa el navegador de días arriba para ir a otra fecha.')}
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
function OrderDrawer({ order, onClose, t }: { order: Order; onClose: () => void; t: T }) {
  const [state, action, pending] = useActionState(voidOrder, null)
  const canVoid = order.status === 'completed'
  const STATUS_META = statusMeta(t)
  const status = STATUS_META[order.status]
  const isVoided = order.status === 'voided'
  const isEs = t('__lang_probe__', 'es') === 'es'
  const locale = isEs ? 'es-ES' : 'en-US'

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
    order.source === 'native_pos' ? t('In-app POS', 'POS de la app')
      : order.source === 'external_pos' ? t('External POS', 'POS externo')
        : t('Manual entry', 'Entrada manual')
  const sourceLine = order.locationName
    ? `${sourceTitle} · ${order.locationName}`
    : sourceTitle
  const paymentTypeLabel =
    order.paymentType === 'cash' ? t('Cash', 'Efectivo')
      : order.paymentType === 'card' ? t('Card', 'Tarjeta')
        : t('Other', 'Otro')
  // English-keyed status code for tone selection, then translated label.
  const paymentStatusCode: 'voided' | 'paid' | 'unpaid' =
    isVoided ? 'voided'
      : order.paymentStatus === 'paid' ? 'paid'
        : 'unpaid'
  const paymentStatusLabel =
    paymentStatusCode === 'voided' ? t('Voided', 'Anulada')
      : paymentStatusCode === 'paid' ? t('Paid', 'Pagada')
        : t('Unpaid', 'No pagada')
  const paymentStatusTone =
    paymentStatusCode === 'voided' ? 'text-red-700'
      : paymentStatusCode === 'paid' ? 'text-green-700'
        : 'text-amber-700'

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-gray-900/30 backdrop-blur-[1px] z-40"
      />
      <aside className="fixed top-0 right-0 z-50 h-full w-full sm:max-w-md md:max-w-lg lg:max-w-md bg-white shadow-2xl border-l border-gray-200 flex flex-col">

        {/* HEADER — Order identifier on the left, close on the
            right. Date + status pill live inside the payment hero
            card below so the header stays quiet and doesn't
            repeat what's about to follow. */}
        <div className="border-b border-gray-100 px-5 py-3.5 flex items-center justify-between gap-4 flex-shrink-0">
          <h2 className="text-[13px] font-semibold text-gray-900 font-mono tabular-nums">
            {t('Order', 'Orden')} #{shortId(order.id)}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
          >
            {t('Close', 'Cerrar')}
          </button>
        </div>

        {/* Voided audit stamp — full-bleed ribbon between the fixed
            header and the scrolling body. */}
        {isVoided && (
          <div className="border-b border-red-200/60 bg-red-50/40 px-6 py-2.5 flex items-center gap-2 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            <p className="text-[11px] text-red-700">
              {t('Voided · the original record stays in the ledger for audit history.', 'Anulada · el registro original se mantiene en el libro para historial de auditoría.')}
            </p>
          </div>
        )}

        {/* BODY — Reshaped to mirror Poynt's transaction detail:
            a Payment hero card (date · status pill, big total,
            card-details definition list), then Items, then Sale
            breakdown, then Source/Customer/Note. Cards use a
            calmer gray-50 background than plain white so the
            drawer reads as three distinct stacked receipts
            instead of a wall of framed rows. */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-3">

          {/* PAYMENT HERO — date on the left, status pill on the
              right, then the big total, then a definition-list
              of card number + payment method. Matches the top
              card in Poynt's transaction detail. */}
          <section className="rounded-xl border border-gray-200/80 bg-gray-50/60 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-gray-600 font-mono tabular-nums">
                {fmtFullDate(order.createdAt, locale)}
              </p>
              <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${status.chip}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
                {status.label}
              </span>
            </div>
            <p className={`mt-3 text-[32px] leading-none font-mono tabular-nums font-bold ${
              isVoided ? 'text-gray-400 line-through' : 'text-gray-900'
            }`}>
              {fmtMoney(order.total)}
              <span className="text-[13px] text-gray-400 font-medium ml-1.5 align-middle">USD</span>
            </p>

            {/* Definition list — Card Number + Payment Method.
                Only the Card Number row renders when we actually
                have card details; otherwise Payment Method stands
                alone (cash / other). */}
            <dl className="mt-4 space-y-1.5 text-[12px]">
              {order.paymentType === 'card' && (order.cardBrand || order.cardLast4) && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-gray-500">{t('Card Number', 'Número de tarjeta')}</dt>
                  <dd className="font-mono tabular-nums text-gray-900">
                    {order.cardBrand ?? t('Card', 'Tarjeta')}
                    {order.cardLast4 && <> **{order.cardLast4}</>}
                  </dd>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-gray-500">{t('Payment Method', 'Método de pago')}</dt>
                <dd className={`font-medium ${isVoided ? 'text-gray-400' : PAYMENT_TEXT[order.paymentType]}`}>
                  {paymentTypeLabel}
                </dd>
              </div>
              {order.paymentStatus !== 'paid' && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-gray-500">{t('Status', 'Estado')}</dt>
                  <dd className={`font-medium ${paymentStatusTone}`}>{paymentStatusLabel}</dd>
                </div>
              )}
            </dl>
          </section>

          {/* ITEMS — receipt-style line list. Each row:
                [qty pill] {name}                     {price}
                          {variant subline, if any}
              Variant renders on its own line under the name,
              matching the "1oz-Loose" subline in Poynt's UI. */}
          <section className="rounded-xl border border-gray-200/80 bg-white px-5 py-4">
            <p className="mb-3 text-[13px] font-semibold text-gray-900">
              {t('Items', 'Artículos')}
            </p>
            <ul className="space-y-3">
              {order.lineItems.map((li) => (
                <li key={li.id} className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    {/* Compact qty pill — mimics the "2x" chip
                        in the screenshot's item list. */}
                    <span className="mt-0.5 flex-shrink-0 inline-flex items-center justify-center min-w-[28px] h-[22px] px-1.5 rounded-md bg-gray-100 text-gray-700 text-[11px] font-semibold font-mono tabular-nums">
                      {li.quantity}x
                    </span>
                    <div className="min-w-0">
                      <p className={`text-[13px] leading-tight ${
                        isVoided ? 'text-gray-400 line-through' : 'text-gray-900'
                      }`}>
                        {li.name}
                      </p>
                      {li.variantLabel && (
                        <p className="mt-0.5 text-[11px] text-gray-500">
                          {li.variantLabel}
                        </p>
                      )}
                    </div>
                  </div>
                  <p className={`text-[13px] font-mono tabular-nums whitespace-nowrap ${
                    isVoided ? 'text-gray-400 line-through' : 'text-gray-900'
                  }`}>
                    {fmtMoney(li.totalPrice)}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          {/* SALE — Subtotal / Discount / Tax / Total. Only
              rendered when the source gave us at least one of
              the breakdown fields; a bare Total that duplicates
              the hero is worthless. Discount only shows when
              non-zero. */}
          {(order.subtotal !== null || order.taxTotal !== null || (order.discountTotal !== null && order.discountTotal > 0)) && (
            <section className="rounded-xl border border-gray-200/80 bg-white px-5 py-4">
              <p className="mb-3 text-[13px] font-semibold text-gray-900">
                {t('Sale', 'Venta')}
              </p>
              <div className="space-y-1.5 text-[12px]">
                {order.subtotal !== null && (
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-gray-600">{t('Subtotal', 'Subtotal')}</span>
                    <span className={`font-mono tabular-nums ${isVoided ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                      {fmtMoney(order.subtotal)}
                    </span>
                  </div>
                )}
                {order.discountTotal !== null && order.discountTotal > 0 && (
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-gray-600">{t('Discount', 'Descuento')}</span>
                    <span className={`font-mono tabular-nums ${isVoided ? 'text-gray-400 line-through' : 'text-emerald-700'}`}>
                      −{fmtMoney(order.discountTotal)}
                    </span>
                  </div>
                )}
                {order.taxTotal !== null && (
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-gray-600">{t('Tax', 'Impuesto')}</span>
                    <span className={`font-mono tabular-nums ${isVoided ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                      {fmtMoney(order.taxTotal)}
                    </span>
                  </div>
                )}
                <div className="pt-2.5 mt-2 border-t border-gray-100 flex items-baseline justify-between gap-3">
                  <span className="text-[13px] font-semibold text-gray-900">{t('Total', 'Total')}</span>
                  <span className={`text-[14px] font-mono tabular-nums font-bold ${isVoided ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                    {fmtMoney(order.total)}
                    <span className="text-[11px] text-gray-400 font-medium ml-1 align-middle">USD</span>
                  </span>
                </div>
              </div>
            </section>
          )}

          {/* CUSTOMER — only when captured. Standalone card so
              walk-in sales don't render an empty attribution. */}
          {order.customerName && (
            <section className="rounded-xl border border-gray-200/80 bg-white px-5 py-4">
              <p className="mb-2 text-[13px] font-semibold text-gray-900">
                {t('Customer', 'Cliente')}
              </p>
              <p className="text-[13px] text-gray-800">{order.customerName}</p>
            </section>
          )}

          {/* SOURCE — manager-friendly source line + optional
              channel subline (In-store / Online / Mobile). */}
          <section className="rounded-xl border border-gray-200/80 bg-white px-5 py-4">
            <p className="mb-2 text-[13px] font-semibold text-gray-900">
              {t('Source', 'Fuente')}
            </p>
            <p className="text-[13px] text-gray-800">{sourceLine}</p>
            {order.channelSource && (
              <p className="mt-0.5 text-[11px] text-gray-500">
                {channelLabel(order.channelSource, t)}
              </p>
            )}
            <p className="mt-2 text-[11px] text-gray-400 font-mono tabular-nums">
              #{shortId(order.id)} <span className="text-gray-300 mx-1">·</span> {itemCount} {itemCount === 1 ? t('item', 'artículo') : t('items', 'artículos')}
            </p>
          </section>

          {/* NOTE — only when the order carries one. */}
          {order.note && (
            <section className="rounded-xl border border-gray-200/80 bg-white px-5 py-4">
              <p className="mb-2 text-[13px] font-semibold text-gray-900">
                {t('Note', 'Nota')}
              </p>
              <p className="text-[12px] text-gray-700 leading-relaxed">{order.note}</p>
            </section>
          )}
        </div>

        {/* FOOTER — Correction tools. Compact: a single row with
            short copy on the left and a small Void order button on
            the right. Less dominant than the Ticket above, but
            clearly the drawer's destructive resolution. */}
        <div className="border-t border-gray-100 bg-white px-6 py-3.5 flex-shrink-0">
          <p className="mb-2 text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
            {t('Correction tools', 'Herramientas de corrección')}
          </p>
          {canVoid ? (
            <div className="rounded-lg border border-gray-200/80 bg-gray-50/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-gray-900">{t('Void order', 'Anular orden')}</p>
                  <p className="mt-1 text-[11px] text-gray-500 leading-snug">
                    {t('Use when the full sale was rung in error or refunded outside the system. The original ticket stays in the ledger.', 'Úsalo cuando la venta completa se registró por error o se reembolsó fuera del sistema. El ticket original se mantiene en el libro.')}
                  </p>
                </div>
                <form action={action} className="flex-shrink-0">
                  <input type="hidden" name="order_id" value={order.id} />
                  <button
                    type="submit"
                    disabled={pending}
                    className="rounded-md border border-red-200 bg-white text-red-700 hover:bg-red-50 hover:border-red-300 px-3 py-1.5 text-[11px] font-semibold disabled:opacity-60 transition-colors whitespace-nowrap"
                  >
                    {pending ? t('Voiding…', 'Anulando…') : t('Void order', 'Anular orden')}
                  </button>
                </form>
              </div>
              {state?.error && (
                <p className="mt-2 text-[11px] text-red-600">{state.error}</p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200/80 bg-gray-50/40 p-3">
              <p className="text-[12px] font-semibold text-gray-700">{t('Already voided', 'Ya anulada')}</p>
              <p className="mt-1 text-[11px] text-gray-500 leading-snug">
                {t('The record stays in the ledger for audit history.', 'El registro se mantiene en el libro para historial de auditoría.')}
              </p>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}


