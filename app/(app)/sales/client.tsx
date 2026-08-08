'use client'

// ----------------------------------------------------------------
// Sales Client — 2026-07-27 design pass
//
// Day-scoped ledger with a per-sale detail drawer. Everything
// functional is preserved from the previous build:
//   • URL-driven date navigation (?date=YYYY-MM-DD)
//   • voidOrder server action via useActionState
//   • Timezone-aware date rendering
//   • Full i18n (makeT(lang) — every string)
//   • Swipe gesture on the header band
//
// The visual layer follows the Claude Design pass: date as the
// heading (tap → month picker portal), big mono total under it,
// pill filter row, soft-card rows with method-tinted icon tiles,
// wide drawer with an amount+status hero, items, summary rows,
// method-adaptive payment section, two-step void confirm.
//
// Fields the design mocks but we don't have yet are omitted
// (staff / auth code / cash tendered / Print receipt wiring)
// rather than stubbed. If a per-order staff column lands later
// we can drop a "Rung by" row back into the drawer with zero
// other churn.
// ----------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, useActionState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { voidOrder } from '@/app/actions/sales'
import { makeT, type Lang } from '@/lib/i18n'

type T = (en: string, es?: string) => string

// ================================================================
// Domain types — unchanged. page.tsx feeds these verbatim.
// ================================================================

type Source = 'manual' | 'native_pos' | 'external_pos' | 'web'
type PaymentType = 'cash' | 'card' | 'other'
type PaymentStatus = 'paid' | 'unpaid'
type OrderStatus = 'completed' | 'voided'
type OperatingMode = 'native_pos' | 'external_pos' | null

interface LineItem {
  id: string
  name: string
  variantLabel: string | null
  quantity: number
  unitPrice: number
  totalPrice: number
}

interface WebOrderDetail {
  /** Buyer contact captured on /checkout step 1. */
  contact: {
    name?: string | null
    email?: string | null
    phone?: string | null
    first_name?: string | null
    last_name?: string | null
    opted_in_marketing?: boolean | null
  } | null
  /** Structured shipping address when buyer picked a
   *  requires_address delivery option; null for pickup orders. */
  shipping: {
    line1?: string | null
    line2?: string | null
    city?: string | null
    state?: string | null
    postal?: string | null
    country?: string | null
  } | null
  /** Frozen cart snapshot + delivery choice + notes at time of
   *  order. Line items live here (not in order_items — web orders
   *  never touch menu_items). */
  cart: {
    items?: Array<{ slug: string; qty: number; name: string; price: number; unit?: string | null; line_total: number }>
    subtotal?: number
    delivery?: { key?: string; label?: string; price?: number }
    notes?: string | null
    billing_same?: boolean
  } | null
  /** Provider name (e.g. 'godaddy') and transaction reference from
   *  the payment adapter. Reference is the Poynt transaction UUID
   *  to look up on their POS for refunds. */
  paymentProvider: string | null
  paymentReference: string | null
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
  subtotal:      number | null
  discountTotal: number | null
  taxTotal:      number | null
  cardBrand:     string | null
  cardLast4:     string | null
  customerName:  string | null
  channelSource: string | null
  locationName: string | null
  lineItems: LineItem[]
  /** Populated only for source='web' orders; null otherwise. */
  webDetail: WebOrderDetail | null
}

// ================================================================
// Palette — mirrors the staffing calendar / role drawer / employee
// drawer so all app surfaces read as one design system.
// ================================================================

const INK = '#18181B'
const PAPER = '#FAF9F6'
const LINE = '#E7E6E2'
const LINE_SOFT = '#F0EFEB'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const SURFACE = '#FAFAF9'
const BAND = '#F0EFEB'
const DANGER = '#B91C1C'
const MONO = "'Geist Mono', ui-monospace, monospace"

// One hue per payment method. tile: soft bg for the icon tile;
// ink: stroke / label color; dot: the tiny 5px dot on the meta chip.
const METHOD_TONES: Record<PaymentType, { tile: string; ink: string; dot: string }> = {
  card:  { tile: '#EEF2FF', ink: '#4F46E5', dot: '#6366F1' },
  cash:  { tile: '#ECFDF5', ink: '#047857', dot: '#10B981' },
  other: { tile: '#F4F4F5', ink: '#52525B', dot: '#71717A' },
}

// ================================================================
// Formatting helpers — kept from the prior build so downstream
// values (rows, drawer, filter counts) all agree.
// ================================================================

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtRowTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
}

function fmtFullDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

// Shift the business_date ISO by whole days without falling into DST
// weirdness. Anchor at noon UTC so ±24h can't roll to the wrong day
// at DST edges when the browser interprets midnight as local.
function shiftBusinessDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const noon = Date.UTC(y, m - 1, d, 12, 0, 0)
  const shifted = new Date(noon + deltaDays * 86_400_000)
  const yy = shifted.getUTCFullYear()
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(shifted.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function fmtBusinessDateLong(iso: string, locale: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const asUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  return asUTC.toLocaleDateString(locale, {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

function fmtBusinessDateShort(iso: string, locale: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const asUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  return asUTC.toLocaleDateString(locale, {
    weekday: 'short', timeZone: 'UTC',
  })
}

function shortId(id: string): string {
  const cleaned = id.replace(/-/g, '')
  return cleaned.slice(-6).toUpperCase()
}

// Poynt's terse SCREAM_CASE channel values → human strings.
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

// Source phrasing used in the drawer's Source line. Kept from the
// prior build for continuity.
function sourceLine(order: Order, t: T): string {
  const base =
    order.source === 'native_pos' ? t('Native POS', 'POS nativo')
      : order.source === 'external_pos' ? t('External POS', 'POS externo')
        : order.source === 'web' ? t('Online store', 'Tienda en línea')
          : t('Manual entry', 'Entrada manual')
  return order.locationName ? `${base} · ${order.locationName}` : base
}

function paymentLabel(t: T): Record<PaymentType, string> {
  return {
    cash:  t('Cash', 'Efectivo'),
    card:  t('Card', 'Tarjeta'),
    other: t('Other', 'Otro'),
  }
}

// ================================================================
// Payment icons — outline only, inherit the tile tint via
// currentColor so a single component works for both methods.
// ================================================================

function CardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="1.5" y="4" width="17" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M1.5 8h17" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.5 12.5h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function CashIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden>
      <ellipse cx="10" cy="5.3" rx="6.4" ry="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.6 5.3v4.4c0 1.38 2.87 2.5 6.4 2.5s6.4-1.12 6.4-2.5V5.3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.6 9.7v4.4c0 1.38 2.87 2.5 6.4 2.5s6.4-1.12 6.4-2.5V9.7" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

function OtherIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 6.5v3.5l2.2 1.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

// ================================================================
// SalesClient — top-level page component.
// ================================================================

type FilterKey = 'all' | 'card' | 'cash' | 'web' | 'voided'

export default function SalesClient({
  lang, orders, operatingMode, date, today,
}: {
  lang: Lang
  orders: Order[]
  operatingMode?: OperatingMode
  date: string
  today: string
}) {
  const t = makeT(lang)
  const router = useRouter()
  const locale = lang === 'es' ? 'es-ES' : 'en-US'

  const [openId, setOpenId] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [salesQuery, setSalesQuery] = useState('')
  const [calOpen, setCalOpen] = useState(false)
  const [calMonth, setCalMonth] = useState(() => monthOfIso(date))
  const [swipeX, setSwipeX] = useState<number | null>(null)
  const [swipeDX, setSwipeDX] = useState(0)

  // Bands treatment at all md+ widths (tablet + desktop). No page
  // card, header + filter sticky as one band, hairline dividers
  // between rows, 24px shared side inset. Above ~1336px content
  // caps at max-width so rows don't stretch across dead space on
  // wide monitors — bands still span 100%, only their inner
  // content is capped. Phone (<md) keeps the card treatment.
  const [isBands, setIsBands] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const update = () => setIsBands(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Close the drawer if the open order disappears after revalidation.
  useEffect(() => {
    if (openId && !orders.find((o) => o.id === openId)) setOpenId(null)
  }, [orders, openId])

  const selected = openId ? orders.find((o) => o.id === openId) ?? null : null

  // Day-scoped metrics — page already narrowed to one business_date.
  const completed = useMemo(() => orders.filter((o) => o.status === 'completed'), [orders])
  const salesTotal = useMemo(() => completed.reduce((s, o) => s + o.total, 0), [completed])
  const orderCount = completed.length
  const avgTicket = orderCount > 0 ? salesTotal / orderCount : 0

  // Filter counts — always across the full day so the pill numbers
  // don't shift as the manager clicks filters. Card + Cash are
  // "in-person only" (exclude source='web') so an online card sale
  // doesn't show in both Card AND Online tabs — those three chips
  // partition the day cleanly. Voided is a status axis that overlaps
  // any of the above on purpose (a voided card sale still shows in
  // Voided so it can be audited).
  const counts: Record<FilterKey, number> = {
    all: orders.length,
    card: orders.filter((o) => o.paymentType === 'card' && o.source !== 'web').length,
    cash: orders.filter((o) => o.paymentType === 'cash' && o.source !== 'web').length,
    web: orders.filter((o) => o.source === 'web').length,
    voided: orders.filter((o) => o.status === 'voided').length,
  }

  const shownOrders = useMemo(() => {
    const byFilter =
      filter === 'all' ? orders
        : filter === 'voided' ? orders.filter((o) => o.status === 'voided')
          : filter === 'web' ? orders.filter((o) => o.source === 'web')
            : orders.filter((o) => o.paymentType === filter && o.source !== 'web')
    const q = salesQuery.trim().toLowerCase()
    if (!q) return byFilter
    // Match customer / note / card last4 / short-id / any line item name.
    // Short-id: last 6 chars of the order id (what the row shows).
    return byFilter.filter((o) => {
      if ((o.customerName ?? '').toLowerCase().includes(q)) return true
      if ((o.note ?? '').toLowerCase().includes(q)) return true
      if ((o.cardLast4 ?? '').toLowerCase().includes(q)) return true
      if (o.id.slice(-6).toLowerCase().includes(q)) return true
      return o.lineItems.some((li) => (li.name ?? '').toLowerCase().includes(q))
    })
  }, [orders, filter, salesQuery])

  const isToday = date === today
  const canGoNext = date < today

  const shiftDay = (delta: number) => {
    if (delta > 0 && !canGoNext) return
    router.push(`/sales?date=${shiftBusinessDate(date, delta)}`)
    setCalOpen(false)
    setOpenId(null)
  }

  // ---- Header title button anchor for the picker portal ----
  const titleBtnRef = useRef<HTMLButtonElement | null>(null)
  const [pickerAnchor, setPickerAnchor] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    if (!calOpen) return
    const compute = () => {
      const r = titleBtnRef.current?.getBoundingClientRect()
      if (r) setPickerAnchor({ top: r.bottom + 8, left: r.left })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [calOpen])

  // Relative day chip: Today / Yesterday / N days ago / Sat …
  const relativeChip = ((): { label: string; kind: 'today' | 'past' } => {
    if (isToday) return { label: t('Today', 'Hoy'), kind: 'today' }
    const days = daysBetween(date, today)
    if (days === 1) return { label: t('Yesterday', 'Ayer'), kind: 'past' }
    if (days > 0 && days < 7) return { label: `${days} ${t('days ago', 'días atrás')}`, kind: 'past' }
    return { label: fmtBusinessDateShort(date, locale), kind: 'past' }
  })()

  return (
    <div style={{
      minHeight: '100vh',
      // Tablet: zero padding on every side. AppShell also strips
      // its own p-8 at this breakpoint, so the sales bands run
      // flush against every viewport edge.
      padding: isBands ? 0 : '20px 24px 28px',
      background: '#fff',
      fontFamily: "'Geist', system-ui, sans-serif", color: INK,
    }}>
      <div
        style={{
          position: 'relative',
          border: isBands ? 0 : `1px solid ${LINE}`,
          borderRadius: isBands ? 0 : 12,
          background: '#fff',
        }}
      >

        {/* Sticky band — at tablet, header + filter pin to the top
            of the viewport so the manager can scroll the ledger
            without losing the date, totals, or the active filter.
            At other widths it collapses to a plain wrapper. */}
        <div
          style={{
            position: isBands ? 'sticky' : 'static',
            top: 0, zIndex: 5, background: '#fff',
          }}
        >

        {/* Header — date as the heading, big mono total, stats. */}
        <div
          onPointerDown={(e) => {
            const target = e.target as HTMLElement
            if (target.closest('button, a, input, [role="button"]')) return
            setSwipeX(e.clientX); setSwipeDX(0)
          }}
          onPointerMove={(e) => { if (swipeX !== null) setSwipeDX(e.clientX - swipeX) }}
          onPointerUp={() => {
            if (swipeX === null) return
            if (swipeDX <= -60) shiftDay(1)
            else if (swipeDX >= 60) shiftDay(-1)
            setSwipeX(null); setSwipeDX(0)
          }}
          onPointerLeave={() => { setSwipeX(null); setSwipeDX(0) }}
          style={{
            position: 'relative',
            // md+ keeps the same vertical rhythm as phone — only
            // the SIDE padding grows to 28 so the band aligns
            // with the row inset per the doc's verdict.
            padding: isBands ? '16px 24px 14px' : '16px 16px 14px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 24, flexWrap: 'wrap',
            touchAction: 'pan-y',
            cursor: swipeX === null ? 'default' : 'grabbing',
            transform: `translateX(${swipeDX / 6}px)`,
            background: '#fff',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                ref={titleBtnRef}
                type="button"
                onClick={() => {
                  setCalMonth(monthOfIso(date))
                  setCalOpen((v) => !v)
                }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  border: '1px solid transparent', background: 'transparent',
                  borderRadius: 9, padding: '2px 8px', marginLeft: -8,
                  font: 'inherit', color: INK, cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.035em', whiteSpace: 'nowrap' }}>
                  {fmtBusinessDateLong(date, locale)}
                </span>
                <span style={{ fontSize: 10, color: FAINT }}>▾</span>
              </button>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999,
                padding: '3px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                background: relativeChip.kind === 'today' ? '#F4F4F2' : '#EFF6FF',
                color: relativeChip.kind === 'today' ? MUTED : '#2563EB',
              }}>
                {relativeChip.label}
              </span>
              {operatingMode && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999,
                  padding: '3px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                  background: operatingMode === 'native_pos' ? '#EFF6FF' : '#EEF2FF',
                  color: operatingMode === 'native_pos' ? '#2563EB' : '#4F46E5',
                }}>
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%',
                    background: operatingMode === 'native_pos' ? '#3B82F6' : '#6366F1',
                  }} />
                  {operatingMode === 'native_pos' ? t('Native POS', 'POS nativo') : t('External POS', 'POS externo')}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: MONO, fontSize: 30, fontWeight: 600, letterSpacing: '-0.045em', lineHeight: 1 }}>
                {fmtMoney(salesTotal)}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>USD</span>
              <Dot />
              <Stat value={String(orderCount)} label={orderCount === 1 ? t('sale', 'venta') : t('sales', 'ventas')} />
              <Dot />
              <Stat value={fmtMoney(avgTicket)} label={t('avg ticket', 'ticket promedio')} />
            </div>
          </div>
          {/* Export — solid-ink pill, sized to match inventory's
              "Add item" header CTA (34px, 16px padding, radius 10,
              fontSize 13). Placeholder for now; wire when the
              export flow is designed. */}
          {isBands && (
            <button
              type="button"
              onClick={() => { /* placeholder — export flow not wired yet */ }}
              style={{
                border: 0, background: INK, color: PAPER,
                borderRadius: 10, height: 34, padding: '0 16px',
                font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                flex: '0 0 auto',
              }}
            >
              {t('Export', 'Exportar')}
            </button>
          )}
        </div>

        {/* Filter strip — All / Card / Cash / Voided with counts.
            At md+ the band's bg + borders span 100% (the outer
            div), while the buttons themselves are capped and
            left-anchored (the inner div). Below md the whole
            thing is one div because there's no cap needed. */}
        <div style={{
          borderTop: `1px solid ${LINE}`, borderBottom: `1px solid ${LINE}`,
          background: SURFACE,
        }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: isBands ? '10px 24px' : '10px 16px',
          flexWrap: 'wrap',
        }}>
          {(['all', 'card', 'cash', 'web', 'voided'] as const).map((f) => {
            const on = filter === f
            const label =
              f === 'all' ? t('All', 'Todo')
                : f === 'card' ? t('Card', 'Tarjeta')
                  : f === 'cash' ? t('Cash', 'Efectivo')
                    : f === 'web' ? t('Online', 'En línea')
                      : t('Voided', 'Anuladas')
            // Same treatment as inventory's filter row — a small
            // hue-coded dot so managers can scan the row by color
            // before reading the label. 'All' stays dotless.
            const dot =
              f === 'card' ? METHOD_TONES.card.dot
                : f === 'cash' ? METHOD_TONES.cash.dot
                  : f === 'web' ? '#27306F'
                    : f === 'voided' ? '#DC2626'
                      : null
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  borderRadius: 999, padding: '5px 12px',
                  font: 'inherit', fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${on ? INK : LINE}`,
                  background: on ? INK : '#fff',
                  color: on ? PAPER : '#3F3F46',
                  fontWeight: on ? 600 : 500,
                }}
              >
                {dot && <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: dot }} />}
                {label}
                <span style={{
                  fontFamily: MONO, fontSize: 10,
                  color: on ? 'rgba(250,249,246,0.65)' : FAINT,
                }}>
                  {counts[f]}
                </span>
              </button>
            )
          })}
          {/* Search pill — marginLeft:auto anchors it to the right
              edge of the same row, matching inventory's filter bar
              layout exactly (same padding row, no wrapper div). */}
          <SalesSearchPill
            total={orders.length}
            value={salesQuery}
            onChange={setSalesQuery}
            placeholder={t('Search', 'Buscar')}
            unit={t('sales', 'ventas')}
          />
        </div>
        </div>{/* /filter band outer */}

        </div>{/* /sticky band */}

        {/* Rows — one continuous subject. md+: no wrapper
            padding, rows own their own 24px inset so the list
            runs edge-to-edge and prices land at the viewport
            right edge like a POS ledger. Phone keeps the small
            8px card gutter. */}
        <div style={{
          padding: isBands ? 0 : 8,
          borderBottomLeftRadius: 12, borderBottomRightRadius: 12,
        }}>
          {orders.length === 0 ? (
            <EmptyLedger t={t} isToday={isToday} date={date} locale={locale} />
          ) : shownOrders.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: FAINT, fontSize: 12 }}>
              {t('No sales match this filter.', 'Ninguna venta coincide con este filtro.')}
            </div>
          ) : (
            shownOrders.map((o) => (
              <SaleRow
                key={o.id}
                order={o}
                selected={openId === o.id}
                onOpen={() => setOpenId(o.id)}
                t={t}
                locale={locale}
                isBands={isBands}
              />
            ))
          )}
        </div>
      </div>

      {/* Month picker — portaled to <body> so the calendar card's
          overflow:hidden doesn't clip it. */}
      {calOpen && typeof document !== 'undefined' && pickerAnchor && createPortal(
        <MonthPickerOverlay
          date={date}
          today={today}
          month={calMonth}
          setMonth={setCalMonth}
          onPick={(iso) => {
            router.push(`/sales?date=${iso}`)
            setCalOpen(false)
            setOpenId(null)
          }}
          onClose={() => setCalOpen(false)}
          anchor={pickerAnchor}
          t={t}
          locale={locale}
        />,
        document.body,
      )}

      {selected && (
        <OrderDrawer
          order={selected}
          onClose={() => setOpenId(null)}
          t={t}
          locale={locale}
        />
      )}
    </div>
  )
}

// ================================================================
// SaleRow — soft-card row.
// ================================================================

function SaleRow({
  order, selected, onOpen, t, locale, isBands,
}: {
  order: Order
  selected: boolean
  onOpen: () => void
  t: T
  locale: string
  isBands: boolean
}) {
  const tone = METHOD_TONES[order.paymentType]
  const isVoided = order.status === 'voided'
  const itemCount = order.lineItems.reduce((s, l) => s + l.quantity, 0)
  const title = order.lineItems[0]?.name ?? t('Order', 'Orden')
  const time = fmtRowTime(order.createdAt, locale)
  const methodLabels = paymentLabel(t)

  return (
    <div
      onClick={onOpen}
      aria-selected={selected}
      style={{
        display: 'flex', alignItems: 'center', gap: 13,
        // Tablet: only the SIDE padding grows to 28 (matches the
        // header/filter inset). Vertical rhythm and element sizes
        // stay identical to phone/desktop so rows don't feel
        // sparse in the extra horizontal room.
        padding: isBands ? '11px 24px' : '11px 12px',
        // Rows are strips in a continuous list on tablet. No
        // radius, no per-row border — the tinted method tile IS
        // the row's only "card" per rule 3. A hairline divider
        // separates them; selection uses a soft SURFACE fill.
        borderRadius: isBands ? 0 : 10,
        cursor: 'pointer',
        border: isBands ? 0 : `1px solid ${selected ? LINE : 'transparent'}`,
        borderBottom: isBands ? `1px solid ${LINE_SOFT}` : undefined,
        background: selected ? SURFACE : 'transparent',
        opacity: isVoided ? 0.75 : 1,
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 34, height: 34, borderRadius: 10, flex: '0 0 auto',
        background: tone.tile, color: tone.ink,
      }}>
        {order.paymentType === 'card' ? <CardIcon />
          : order.paymentType === 'cash' ? <CashIcon />
            : <OtherIcon />}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{
          display: 'block', fontSize: 14, fontWeight: 600, letterSpacing: '-0.015em',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          color: isVoided ? MUTED : INK,
          textDecoration: isVoided ? 'line-through' : undefined,
        }}>
          {title}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>{time}</span>
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: LINE }} />
          <span style={{ fontSize: 11, color: FAINT }}>
            {itemCount} {itemCount === 1 ? t('item', 'artículo') : t('items', 'artículos')}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            borderRadius: 999, padding: '1px 8px',
            fontSize: 10, fontWeight: 600,
            background: tone.tile, color: tone.ink,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: tone.dot }} />
            {methodLabels[order.paymentType]}
          </span>
          {isVoided && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', borderRadius: 999,
              padding: '1px 8px', fontSize: 10, fontWeight: 600,
              background: '#FEE2E2', color: '#B91C1C',
            }}>
              {t('Voided', 'Anulada')}
            </span>
          )}
          {order.paymentStatus === 'unpaid' && !isVoided && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', borderRadius: 999,
              padding: '1px 8px', fontSize: 10, fontWeight: 600,
              background: '#FFFBEB', color: '#B45309',
            }}>
              {t('Unpaid', 'No pagada')}
            </span>
          )}
        </span>
      </span>
      <span style={{
        fontFamily: MONO, fontSize: 16, fontWeight: 600, letterSpacing: '-0.03em',
        whiteSpace: 'nowrap',
        color: isVoided ? MUTED : INK,
        textDecoration: isVoided ? 'line-through' : undefined,
      }}>
        {fmtMoney(order.total)}
      </span>
      <span style={{ fontSize: 12, color: '#D6D5D1' }}>›</span>
    </div>
  )
}

// ================================================================
// EmptyLedger — no orders for this day.
// ================================================================

function EmptyLedger({ t, isToday, date, locale }: { t: T; isToday: boolean; date: string; locale: string }) {
  return (
    <div style={{ padding: '44px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#52525B' }}>
        {isToday
          ? t('No sales yet today', 'Sin ventas hoy aún')
          : t('No sales on this day', 'Sin ventas este día')}
      </div>
      <div style={{ fontSize: 12, color: FAINT, marginTop: 3 }}>
        {isToday
          ? t('Completed sales land here as they close.', 'Las ventas completadas aparecen aquí al cerrarse.')
          : t(`Nothing came through on ${fmtBusinessDateLong(date, locale)}.`, `No hubo movimiento el ${fmtBusinessDateLong(date, locale)}.`)}
      </div>
    </div>
  )
}

// ================================================================
// MonthPickerOverlay — portal-rendered floating picker.
// ================================================================

function MonthPickerOverlay({
  date, today, month, setMonth, onPick, onClose, anchor, t, locale,
}: {
  date: string
  today: string
  month: { y: number; m: number }
  setMonth: (m: { y: number; m: number }) => void
  onPick: (iso: string) => void
  onClose: () => void
  anchor: { top: number; left: number }
  t: T
  locale: string
}) {
  const first = new Date(Date.UTC(month.y, month.m, 1, 12))
  // Monday-first grid start.
  const wd = (first.getUTCDay() + 6) % 7
  const gridStartUTC = Date.UTC(month.y, month.m, 1 - wd, 12)
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStartUTC + i * 86_400_000)
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    return {
      iso,
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month.m,
      selected: iso === date,
      isToday: iso === today,
    }
  })
  const monthLabel = new Date(Date.UTC(month.y, month.m, 1, 12)).toLocaleDateString(locale, {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  })
  const weekdayLetters = Array.from({ length: 7 }, (_, i) => {
    // Monday-first sample.
    const sample = new Date(Date.UTC(2024, 0, 1 + i, 12)) // Jan 1 2024 was a Monday
    return sample.toLocaleDateString(locale, { weekday: 'narrow', timeZone: 'UTC' })
  })

  const shift = (delta: number) => {
    const next = new Date(Date.UTC(month.y, month.m + delta, 1, 12))
    setMonth({ y: next.getUTCFullYear(), m: next.getUTCMonth() })
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      <div style={{
        position: 'fixed',
        top: anchor.top,
        left: anchor.left,
        zIndex: 41, width: 300,
        border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff',
        boxShadow: '0 12px 32px rgba(24,24,27,0.14)', padding: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
          <NavBtn dir="‹" onClick={() => shift(-1)} />
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>{monthLabel}</span>
          <NavBtn dir="›" onClick={() => shift(1)} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 0, marginBottom: 6 }}>
          {weekdayLetters.map((l, i) => (
            <span key={i} style={{ textAlign: 'center', fontFamily: MONO, fontSize: 9, letterSpacing: '0.1em', color: FAINT }}>
              {l}
            </span>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: '3px 0' }}>
          {cells.map((c, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onPick(c.iso)}
              disabled={c.iso > today}
              style={{
                position: 'relative', border: 0, borderRadius: 8, height: 30, font: 'inherit',
                fontFamily: MONO, fontSize: 12,
                cursor: c.iso > today ? 'not-allowed' : 'pointer',
                background: c.selected ? BAND : 'transparent',
                color: c.iso > today ? '#E5E5E5'
                  : c.selected ? INK
                    : c.inMonth ? '#3F3F46' : '#D6D5D1',
                fontWeight: c.selected ? 600 : 400,
              }}
            >
              {c.day}
              {c.isToday && (
                <span style={{
                  position: 'absolute', left: '50%', bottom: 4, transform: 'translateX(-50%)',
                  width: 3, height: 3, borderRadius: '50%', background: c.selected ? INK : FAINT,
                }} />
              )}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${LINE}` }}>
          <span style={{ fontSize: 11, color: FAINT }}>
            {t('Pick a date to see its sales', 'Elige una fecha para ver sus ventas')}
          </span>
          <button
            type="button"
            onClick={() => onPick(today)}
            style={{
              border: 0, background: 'transparent', padding: 0,
              font: 'inherit', fontSize: 12, fontWeight: 500, color: '#2563EB', cursor: 'pointer',
            }}
          >
            {t('Today', 'Hoy')}
          </button>
        </div>
      </div>
    </>
  )
}

// ================================================================
// OrderDrawer — per-sale detail sheet.
// ================================================================

function OrderDrawer({ order, onClose, t, locale }: {
  order: Order; onClose: () => void; t: T; locale: string
}) {
  const [state, action, pending] = useActionState(voidOrder, null)
  const [confirming, setConfirming] = useState(false)
  const canVoid = order.status === 'completed'
  const isVoided = order.status === 'voided'
  const tone = METHOD_TONES[order.paymentType]
  const methodLabels = paymentLabel(t)
  const itemCount = order.lineItems.reduce((s, l) => s + l.quantity, 0)

  // Escape closes + body scroll lock while open.
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

  // Sale-summary rows — only render lines with meaningful values.
  type SummaryRow = { label: string; value: string; strong?: boolean }
  const summary: SummaryRow[] = []
  if (order.subtotal != null) summary.push({ label: t('Subtotal', 'Subtotal'), value: fmtMoney(order.subtotal) })
  if (order.discountTotal != null && order.discountTotal > 0) {
    summary.push({ label: t('Discount', 'Descuento'), value: `−${fmtMoney(order.discountTotal)}` })
  }
  if (order.taxTotal != null && order.taxTotal > 0) {
    summary.push({ label: t('Tax', 'Impuesto'), value: fmtMoney(order.taxTotal) })
  }
  summary.push({ label: t('Total', 'Total'), value: fmtMoney(order.total), strong: true })

  const statusChipBg = isVoided ? '#FEE2E2' : order.paymentStatus === 'unpaid' ? '#FFFBEB' : '#D1FAE5'
  const statusChipText = isVoided ? '#B91C1C' : order.paymentStatus === 'unpaid' ? '#B45309' : '#047857'
  const statusChipDot = isVoided ? '#DC2626' : order.paymentStatus === 'unpaid' ? '#D97706' : '#10B981'
  const statusLabel = isVoided ? t('Voided', 'Anulada')
    : order.paymentStatus === 'unpaid' ? t('Unpaid', 'No pagada')
      : t('Paid', 'Pagada')

  const eyebrow: React.CSSProperties = {
    fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em', color: FAINT,
  }
  const metaRow: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, padding: '9px 0', borderBottom: `1px solid ${LINE_SOFT}`,
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 40, display: 'flex', justifyContent: 'flex-end',
      fontFamily: "'Geist', system-ui, sans-serif", color: INK,
    }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(24,24,27,0.28)' }} />

      <div style={{
        position: 'relative', width: 440, maxWidth: '100%', flex: '0 0 440px',
        height: '100vh', background: '#fff',
        borderLeft: `1px solid ${LINE}`, boxShadow: '-24px 0 48px rgba(24,24,27,0.10)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* header */}
        <div style={{
          padding: '20px 24px 16px', borderBottom: `1px solid ${LINE}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ ...eyebrow, color: FAINT }}>
              {t('ORDER', 'ORDEN')} #{shortId(order.id)}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginTop: 6, flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: MONO, fontSize: 28, fontWeight: 600, letterSpacing: '-0.045em', lineHeight: 1,
                textDecoration: isVoided ? 'line-through' : undefined,
                color: isVoided ? MUTED : INK,
              }}>
                {fmtMoney(order.total)}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>USD</span>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999,
                padding: '3px 10px', fontSize: 11, fontWeight: 600,
                background: statusChipBg, color: statusChipText,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: statusChipDot }} />
                {statusLabel}
              </span>
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 7 }}>
              {fmtFullDateTime(order.createdAt, locale)} · {itemCount} {itemCount === 1 ? t('item', 'artículo') : t('items', 'artículos')}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Close', 'Cerrar')}
            style={{
              border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8,
              width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
              font: 'inherit', fontSize: 15, color: MUTED, cursor: 'pointer', flex: '0 0 auto',
            }}
          >
            ×
          </button>
        </div>

        {/* body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 24px 24px', display: 'block' }}>
          {/* items + summary. For web orders order.lineItems is empty
              (checkout leaves order_items blank on purpose — see
              lib/sites/checkout.ts); the actual cart lives on
              site_orders_link.cart.items. Fall back to that shape so
              online orders show what was bought instead of a bare
              "No line items" placeholder. */}
          {(() => {
            const webCart = order.source === 'web' && order.webDetail
              ? ((order.webDetail.cart as { items?: Array<{ slug?: string; name?: string; qty?: number; line_total?: number; unit?: string | null }> } | null)?.items ?? [])
              : []
            const displayItems: Array<{ id: string; name: string; quantity: number; totalPrice: number; variantLabel: string | null }> =
              order.lineItems.length > 0
                ? order.lineItems
                : webCart.map((c, i) => ({
                    id: (c.slug ?? String(i)),
                    name: c.name ?? '—',
                    quantity: typeof c.qty === 'number' ? c.qty : 1,
                    totalPrice: typeof c.line_total === 'number' ? c.line_total : 0,
                    variantLabel: c.unit ?? null,
                  }))
            return (
          <div style={{ marginBottom: 20 }}>
            <div style={{ ...eyebrow, marginBottom: 8 }}>{t('ITEMS', 'ARTÍCULOS')}</div>
            <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
              {displayItems.length === 0 ? (
                <div style={{ padding: '10px 12px', fontSize: 12, color: FAINT }}>
                  {t('No line items on this order.', 'Sin artículos en esta orden.')}
                </div>
              ) : displayItems.map((l, i) => (
                <div
                  key={l.id}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 11,
                    padding: '9px 12px',
                    borderBottom: i === displayItems.length - 1 ? undefined : `1px solid ${LINE_SOFT}`,
                  }}
                >
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: 22, height: 20, borderRadius: 6,
                    background: '#F4F4F2', fontFamily: MONO, fontSize: 10, fontWeight: 600,
                    color: '#52525B', padding: '0 4px',
                  }}>
                    {l.quantity}×
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, letterSpacing: '-0.01em' }}>{l.name}</span>
                    {l.variantLabel && (
                      <span style={{ display: 'block', fontSize: 11, color: FAINT, marginTop: 1 }}>
                        {l.variantLabel}
                      </span>
                    )}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: '#3F3F46' }}>
                    {fmtMoney(l.totalPrice)}
                  </span>
                </div>
              ))}
              {summary.map((r) => (
                <div
                  key={r.label}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: r.strong ? '10px 12px' : '8px 12px',
                    borderTop: `1px solid ${r.strong ? LINE : LINE_SOFT}`,
                    background: SURFACE,
                  }}
                >
                  <span style={r.strong
                    ? { fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }
                    : { fontSize: 12, color: MUTED }}>
                    {r.label}
                  </span>
                  <span style={r.strong
                    ? { fontFamily: MONO, fontSize: 14, fontWeight: 700, letterSpacing: '-0.02em' }
                    : { fontFamily: MONO, fontSize: 12 }}>
                    {r.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
            )
          })()}

          {/* payment — plain list, adapts to the method */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ ...eyebrow, marginBottom: 4 }}>{t('PAYMENT', 'PAGO')}</div>
            <div style={metaRow}>
              <span style={{ fontSize: 12, color: MUTED }}>{t('Method', 'Método')}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: tone.dot }} />
                <span style={{ fontSize: 12 }}>{methodLabels[order.paymentType]}</span>
              </span>
            </div>
            {order.paymentType === 'card' && (order.cardBrand || order.cardLast4) && (
              <div style={metaRow}>
                <span style={{ fontSize: 12, color: MUTED }}>{t('Card', 'Tarjeta')}</span>
                <span style={{ fontFamily: MONO, fontSize: 12 }}>
                  {order.cardBrand ?? '—'}{order.cardLast4 ? ` ··${order.cardLast4}` : ''}
                </span>
              </div>
            )}
            <div style={metaRow}>
              <span style={{ fontSize: 12, color: MUTED }}>{t('Status', 'Estado')}</span>
              <span style={{ fontSize: 12, color: statusChipText, fontWeight: 600 }}>{statusLabel}</span>
            </div>
            <div style={{ ...metaRow, borderBottom: 'none' }}>
              <span style={{ fontSize: 12, color: MUTED }}>{t('Source', 'Fuente')}</span>
              <span style={{ fontSize: 12 }}>{sourceLine(order, t)}</span>
            </div>
          </div>

          {/* channel — only when Poynt sent one */}
          {order.channelSource && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ ...eyebrow, marginBottom: 4 }}>{t('CHANNEL', 'CANAL')}</div>
              <div style={{ ...metaRow, borderBottom: 'none' }}>
                <span style={{ fontSize: 12, color: MUTED }}>{t('Type', 'Tipo')}</span>
                <span style={{ fontSize: 12 }}>{channelLabel(order.channelSource, t)}</span>
              </div>
            </div>
          )}

          {/* online order details — buyer contact + delivery choice +
              shipping (if applicable) + note to shop + Poynt txn ref.
              Rendered only for source='web' orders that have a
              matching site_orders_link row (i.e. the full checkout
              flow completed). */}
          {order.source === 'web' && order.webDetail && (() => {
            const d = order.webDetail
            const c = (d.contact ?? {}) as Record<string, unknown>
            const s = (d.shipping ?? {}) as Record<string, unknown>
            const cart = (d.cart ?? {}) as Record<string, unknown>
            const delivery = (cart.delivery ?? {}) as { key?: string; label?: string; price?: number }
            const notes = typeof cart.notes === 'string' ? cart.notes : null
            const email = typeof c.email === 'string' ? c.email : null
            const phone = typeof c.phone === 'string' ? c.phone : null
            const cardholderName = typeof c.cardholder_name === 'string' ? c.cardholder_name : null
            const billing = (c.billing_address ?? null) as Record<string, unknown> | null
            const addressLine1 = typeof s.line1 === 'string' ? s.line1 : null
            const addressLine2 = typeof s.line2 === 'string' ? s.line2 : null
            const city = typeof s.city === 'string' ? s.city : null
            const state = typeof s.state === 'string' ? s.state : null
            const postal = typeof s.postal === 'string' ? s.postal : null
            const addressStreet = [addressLine1, addressLine2].filter(Boolean).join(', ')
            const addressCity = [city, state, postal].filter(Boolean).join(', ')
            const hasAddress = Boolean(addressStreet || addressCity)
            const billingLine1 = billing && typeof billing.line1 === 'string' ? billing.line1 : null
            const billingLine2 = billing && typeof billing.line2 === 'string' ? billing.line2 : null
            const billingCity = billing && typeof billing.city === 'string' ? billing.city : null
            const billingState = billing && typeof billing.state === 'string' ? billing.state : null
            const billingPostal = billing && typeof billing.postal === 'string' ? billing.postal : null
            const billingStreet = [billingLine1, billingLine2].filter(Boolean).join(', ')
            const billingCityLine = [billingCity, billingState, billingPostal].filter(Boolean).join(', ')
            const hasBilling = Boolean(billingStreet || billingCityLine)
            const deliveryLabel = delivery.label ?? (delivery.key ?? '—')
            const deliveryPrice = typeof delivery.price === 'number' ? delivery.price : null
            return (
              <div style={{ marginBottom: 20 }}>
                <div style={{ ...eyebrow, marginBottom: 4 }}>{t('ONLINE ORDER', 'PEDIDO EN LÍNEA')}</div>
                {email && (
                  <div style={metaRow}>
                    <span style={{ fontSize: 12, color: MUTED }}>{t('Email', 'Correo')}</span>
                    <span style={{ fontSize: 12, wordBreak: 'break-all' }}>{email}</span>
                  </div>
                )}
                {phone && (
                  <div style={metaRow}>
                    <span style={{ fontSize: 12, color: MUTED }}>{t('Phone', 'Teléfono')}</span>
                    <span style={{ fontFamily: MONO, fontSize: 12 }}>{phone}</span>
                  </div>
                )}
                <div style={metaRow}>
                  <span style={{ fontSize: 12, color: MUTED }}>{t('Delivery', 'Entrega')}</span>
                  <span style={{ fontSize: 12, textAlign: 'right' }}>
                    {deliveryLabel}
                    {/* Price suffix only when it's meaningful — a
                        priced ship option ($1.00) or a free ship
                        option (has address → "Free"). Zero-price
                        pickup gets no suffix, since "Pick up in
                        store · Free" reads like "free shipping"
                        when the whole point is there's no shipping. */}
                    {deliveryPrice != null && (hasAddress || deliveryPrice > 0) && (
                      <span style={{ color: MUTED, marginLeft: 6 }}>
                        {deliveryPrice === 0 ? t('· Free', '· Gratis') : `· ${fmtMoney(deliveryPrice)}`}
                      </span>
                    )}
                  </span>
                </div>
                {hasAddress && (
                  <div style={metaRow}>
                    <span style={{ fontSize: 12, color: MUTED }}>{t('Ship to', 'Envío a')}</span>
                    <span style={{ fontSize: 12, textAlign: 'right', lineHeight: 1.45 }}>
                      {addressStreet && <span style={{ display: 'block' }}>{addressStreet}</span>}
                      {addressCity && <span style={{ display: 'block' }}>{addressCity}</span>}
                    </span>
                  </div>
                )}
                {notes && (
                  <div style={metaRow}>
                    <span style={{ fontSize: 12, color: MUTED }}>{t('Note to shop', 'Nota a la tienda')}</span>
                    <span style={{ fontSize: 12, textAlign: 'right', lineHeight: 1.45, maxWidth: 240 }}>{notes}</span>
                  </div>
                )}
                {cardholderName && (
                  <div style={metaRow}>
                    <span style={{ fontSize: 12, color: MUTED }}>{t('Name on card', 'Nombre en tarjeta')}</span>
                    <span style={{ fontSize: 12, textAlign: 'right' }}>{cardholderName}</span>
                  </div>
                )}
                {hasBilling && (
                  <div style={metaRow}>
                    <span style={{ fontSize: 12, color: MUTED }}>{t('Billing', 'Facturación')}</span>
                    <span style={{ fontSize: 12, textAlign: 'right', lineHeight: 1.45 }}>
                      {billingStreet && <span style={{ display: 'block' }}>{billingStreet}</span>}
                      {billingCityLine && <span style={{ display: 'block' }}>{billingCityLine}</span>}
                    </span>
                  </div>
                )}
                {d.paymentReference && (
                  <div style={{ ...metaRow, borderBottom: 'none' }}>
                    <span style={{ fontSize: 12, color: MUTED }}>{t('Poynt ref', 'Ref. Poynt')}</span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: '#3F3F46', wordBreak: 'break-all', textAlign: 'right', maxWidth: 220 }}>
                      {d.paymentReference}
                    </span>
                  </div>
                )}
              </div>
            )
          })()}

          {/* customer — only when captured */}
          {order.customerName && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ ...eyebrow, marginBottom: 4 }}>{t('CUSTOMER', 'CLIENTE')}</div>
              <div style={{ ...metaRow, borderBottom: 'none' }}>
                <span style={{ fontSize: 12, color: MUTED }}>{t('Name', 'Nombre')}</span>
                <span style={{ fontSize: 12 }}>{order.customerName}</span>
              </div>
            </div>
          )}

          {/* note — only when present */}
          {order.note && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ ...eyebrow, marginBottom: 8 }}>{t('NOTE', 'NOTA')}</div>
              <div style={{
                border: `1px solid ${LINE}`, borderRadius: 10, background: SURFACE,
                padding: '10px 12px', fontSize: 12, color: '#3F3F46', lineHeight: 1.5,
              }}>
                {order.note}
              </div>
            </div>
          )}
        </div>

        {/* footer — two-step void confirm */}
        <div style={{
          borderTop: `1px solid ${LINE}`, padding: '14px 24px',
          display: 'flex', alignItems: 'center', gap: 10, background: '#fff',
        }}>
          {!canVoid ? (
            <span style={{ fontSize: 12, color: MUTED }}>
              {t('Already voided — the record stays in the ledger for audit history.', 'Ya anulada — el registro se mantiene en el libro para historial de auditoría.')}
            </span>
          ) : confirming ? (
            <>
              <span style={{ marginRight: 'auto', fontSize: 12, lineHeight: 1.4, color: DANGER, maxWidth: 200 }}>
                {t('Void this sale? The ticket stays in the ledger.', '¿Anular esta venta? El ticket se mantiene en el libro.')}
              </span>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                style={{
                  border: `1px solid ${LINE}`, background: '#fff', borderRadius: 9,
                  padding: '9px 14px', font: 'inherit', fontSize: 13, fontWeight: 500,
                  color: '#3F3F46', cursor: 'pointer',
                }}
              >
                {t('Keep it', 'Conservar')}
              </button>
              <form action={action}>
                <input type="hidden" name="order_id" value={order.id} />
                <button
                  type="submit"
                  disabled={pending}
                  style={{
                    border: 0, background: DANGER, color: '#fff', borderRadius: 9,
                    padding: '10px 16px', font: 'inherit', fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', opacity: pending ? 0.6 : 1,
                  }}
                >
                  {pending ? t('Voiding…', 'Anulando…') : t('Void order', 'Anular orden')}
                </button>
              </form>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                style={{
                  border: `1px solid ${LINE}`, background: '#fff', borderRadius: 9,
                  padding: '9px 14px', font: 'inherit', fontSize: 13, fontWeight: 500,
                  color: DANGER, cursor: 'pointer',
                }}
              >
                {t('Void order', 'Anular orden')}
              </button>
              {/* Print receipt — UI parity with the design; the wiring
                  will land alongside the native-POS receipt work. */}
              <button
                type="button"
                onClick={() => {/* TODO: wire when receipt renderer lands */}}
                style={{
                  marginLeft: 'auto', border: 0, background: INK, color: PAPER, borderRadius: 9,
                  padding: '10px 16px', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {t('Print receipt', 'Imprimir recibo')}
              </button>
            </>
          )}
        </div>
        {state?.error && (
          <div style={{ padding: '0 24px 12px', fontSize: 12, color: DANGER }}>{state.error}</div>
        )}
      </div>
    </div>
  )
}

// ================================================================
// Small primitives — Stat, Dot, NavBtn.
// ================================================================

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600 }}>{value}</span>
      <span style={{ fontSize: 12, color: MUTED }}>{label}</span>
    </span>
  )
}

function Dot() {
  return <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#D6D5D1', alignSelf: 'center' }} />
}

function NavBtn({ dir, onClick }: { dir: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8,
        width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
        font: 'inherit', fontSize: 12, color: '#52525B', cursor: 'pointer',
      }}
    >
      {dir}
    </button>
  )
}

// ================================================================
// Small local helpers.
// ================================================================

function monthOfIso(iso: string): { y: number; m: number } {
  const [y, m] = iso.split('-').map(Number)
  return { y, m: m - 1 }
}

function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number)
  const [yb, mb, db] = b.split('-').map(Number)
  const at = Date.UTC(ya, ma - 1, da, 12)
  const bt = Date.UTC(yb, mb - 1, db, 12)
  return Math.round((bt - at) / 86_400_000)
}

/** Filter-row search pill. Sized and styled to match inventory's
 *  filter-row search exactly — same 34px height, 180px input,
 *  same 22px clear button, same icon size. marginLeft:auto pins
 *  it to the right edge of the same flex row. */
function SalesSearchPill({
  total, value, onChange, placeholder, unit,
}: { total: number; value: string; onChange: (v: string) => void; placeholder: string; unit: string }) {
  const [focused, setFocused] = useState(false)
  return (
    <span
      style={{
        marginLeft: 'auto',
        display: 'flex', alignItems: 'center', gap: 8, borderRadius: 999,
        padding: '0 6px 0 12px', height: 34,
        transition: 'background 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
        background: focused ? '#fff' : '#F4F4F2',
        border: `1px solid ${focused ? INK : 'transparent'}`,
        boxShadow: focused ? '0 0 0 3px rgba(24,24,27,0.06)' : 'none',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={focused ? '#52525B' : FAINT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.35-4.35" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={`${placeholder} ${total} ${unit}`}
        style={{ border: 0, background: 'transparent', fontFamily: 'inherit', fontSize: 13, color: INK, width: 180, padding: 0, outline: 'none' }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, border: 0, borderRadius: '50%', background: LINE, fontFamily: 'inherit', fontSize: 13, lineHeight: 1, color: '#52525B', cursor: 'pointer', flex: '0 0 auto' }}
        >
          ×
        </button>
      )}
    </span>
  )
}
