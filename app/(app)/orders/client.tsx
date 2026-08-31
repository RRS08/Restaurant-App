'use client'

// ----------------------------------------------------------------
// Orders client — the ledger + drawer for web orders.
//
// Copies the sales page's visual vocabulary (sticky band, hero
// total, filter chips, soft-tile rows, right-side drawer) but is
// scoped to source='web'. The chips read Pickup / Delivery /
// Voided instead of Card / Cash — payment method isn't the
// interesting axis on web orders (always card), the fulfillment
// channel is.
//
// Drawer's primary action is "Mark ready for pickup" for pickup
// orders in the 'new' state. Advancing state fires the buyer's
// ready email via after(); optimistic UI removes the row from the
// New lane the instant it's clicked.
// ----------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { markReady } from '@/app/actions/pickup'
import { voidOrder } from '@/app/actions/sales'
import { makeT, type Lang } from '@/lib/i18n'

export interface OrderRowItem {
  name: string
  qty: number
  variantLabel: string | null
  lineTotal: number
}

export interface OrderShipping {
  line1: string | null
  line2: string | null
  city: string | null
  state: string | null
  postal: string | null
  country: string | null
}

export interface OrderDelivery {
  key: string | null
  label: string | null
  price: number | null
  sublabel: string | null
}

export interface OrderRow {
  id: string
  orderNumber: string
  createdAt: string
  total: number
  subtotal: number | null
  discountTotal: number | null
  taxTotal: number | null
  status: 'completed' | 'voided'
  fulfillmentState: 'new' | 'ready' | 'completed'
  readyAt: string | null
  customerName: string | null
  channel: 'pickup' | 'delivery'
  itemCount: number
  items: OrderRowItem[]
  buyerEmail: string | null
  buyerPhone: string | null
  cardholderName: string | null
  cardBrand: string | null
  cardLast4: string | null
  shipping: OrderShipping
  delivery: OrderDelivery
  note: string | null
  paymentProvider: string | null
  paymentReference: string | null
}

const INK = '#18181B'
const PAPER = '#FAF9F6'
const LINE = '#E7E6E2'
const LINE_SOFT = '#F0EFEB'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const SURFACE = '#FAFAF9'
const BAND = '#F0EFEB'
const MONO = "'Geist Mono', ui-monospace, monospace"

const CHANNEL_TONES = {
  pickup:   { tile: '#FDF1EA', ink: '#C2410C', dot: '#EA580C' },
  delivery: { tile: '#FDF2F8', ink: '#DB2777', dot: '#EC4899' },
} as const

type FilterKey = 'all' | 'pickup' | 'delivery' | 'voided'

export default function OrdersClient({
  lang, orders, date, today,
}: {
  lang: Lang
  orders: OrderRow[]
  /** The business_date the ledger is currently showing (YYYY-MM-DD). */
  date: string
  /** Today in the restaurant's tz — enables the "Today" chip +
   *  disables future-date clicks in the month picker. */
  today: string
}) {
  const t = makeT(lang)
  const router = useRouter()
  const locale = lang === 'es' ? 'es-ES' : 'en-US'
  const [openId, setOpenId] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [calOpen, setCalOpen] = useState(false)
  const [calMonth, setCalMonth] = useState(() => monthOfIso(date))
  const titleBtnRef = useRef<HTMLButtonElement | null>(null)
  const [pickerAnchor, setPickerAnchor] = useState<{ top: number; left: number } | null>(null)

  // Recompute the picker's anchor position on scroll/resize so
  // the overlay stays glued to the title button as the ledger
  // moves under it.
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

  const isToday = date === today

  // Relative day chip: Today / Yesterday / N days ago / Sat …
  const relativeChip = ((): { label: string; kind: 'today' | 'past' } => {
    if (isToday) return { label: t('Today', 'Hoy'), kind: 'today' }
    const days = daysBetween(date, today)
    if (days === 1) return { label: t('Yesterday', 'Ayer'), kind: 'past' }
    if (days > 0 && days < 7) return { label: `${days} ${t('days ago', 'días atrás')}`, kind: 'past' }
    return { label: fmtBusinessDateShort(date, locale), kind: 'past' }
  })()

  // Bands treatment at md+ (tablet + desktop) — same pattern as
  // the Sales page: header + filter sticky as one band, rows run
  // edge-to-edge with hairline dividers, no card treatment. Below
  // md (phone), rows collapse to card-treatment with side padding.
  // Match Sales exactly so both ledgers read as one design system.
  const [isBands, setIsBands] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const update = () => setIsBands(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  const counts: Record<FilterKey, number> = {
    all: orders.length,
    pickup: orders.filter(o => o.status !== 'voided' && o.channel === 'pickup').length,
    delivery: orders.filter(o => o.status !== 'voided' && o.channel === 'delivery').length,
    voided: orders.filter(o => o.status === 'voided').length,
  }

  // How many orders in each channel still need staff attention.
  // Pickup has a real workflow (Mark ready) so the number is
  // actionable; delivery's shipping workflow lands later, so its
  // action count stays 0 until then. Rendered as a small orange
  // dot on the filter chip only when > 0.
  const needsAction: Record<FilterKey, number> = {
    all: 0,
    pickup: orders.filter(o => o.status !== 'voided' && o.channel === 'pickup' && o.fulfillmentState === 'new').length,
    delivery: 0,
    voided: 0,
  }

  const shown = useMemo(() => {
    if (filter === 'all') return orders
    if (filter === 'voided') return orders.filter(o => o.status === 'voided')
    return orders.filter(o => o.status !== 'voided' && o.channel === filter)
  }, [orders, filter])

  const selected = openId ? orders.find(o => o.id === openId) ?? null : null

  const scopedTotal = useMemo(
    () => shown.filter(o => o.status !== 'voided').reduce((s, o) => s + o.total, 0),
    [shown],
  )
  const scopedCount = shown.filter(o => o.status !== 'voided').length

  return (
    <div style={{
      minHeight: '100vh', background: '#fff', color: INK,
      fontFamily: "'Geist', system-ui, sans-serif",
      // Phone gets a small card gutter around the ledger; md+
      // runs edge-to-edge so bands align with the app shell.
      padding: isBands ? 0 : '20px 24px 28px',
    }}>
      {/* Sticky header — mirrors the sales layout: date heading,
          big mono total, count. Filter strip band underneath.
          Sticky only in bands mode so the header pins as the
          ledger scrolls; on phone it flows with the page. */}
      <div style={{
        position: isBands ? 'sticky' : 'static',
        top: 0, zIndex: 5, background: '#fff',
      }}>
        <div style={{ padding: isBands ? '16px 24px 14px' : '16px 16px 14px' }}>
          <div style={{
            fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em',
            color: FAINT, marginBottom: 6,
          }}>
            ORDERS
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              ref={titleBtnRef}
              type="button"
              onClick={() => {
                setCalMonth(monthOfIso(date))
                setCalOpen(v => !v)
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
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: MONO, fontSize: 30, fontWeight: 600,
              letterSpacing: '-0.045em', lineHeight: 1, color: INK,
            }}>
              {fmtMoney(scopedTotal)}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>USD</span>
            <Dot />
            <Stat value={String(scopedCount)} label={scopedCount === 1 ? t('order', 'orden') : t('orders', 'órdenes')} />
          </div>
        </div>

        {/* Filter strip — same responsive inset as the header. */}
        <div style={{
          borderTop: `1px solid ${LINE}`, borderBottom: `1px solid ${LINE}`,
          background: SURFACE,
          padding: isBands ? '10px 24px' : '10px 16px',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          {(['all', 'pickup', 'delivery', 'voided'] as const).map(f => {
            const on = filter === f
            const label =
              f === 'all' ? t('All', 'Todo')
                : f === 'pickup' ? t('Pickup', 'Recoger')
                  : f === 'delivery' ? t('Delivery', 'Envío')
                    : t('Voided', 'Anuladas')
            const dot =
              f === 'pickup' ? CHANNEL_TONES.pickup.dot
                : f === 'delivery' ? CHANNEL_TONES.delivery.dot
                  : f === 'voided' ? '#DC2626'
                    : null
            const needs = needsAction[f]
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
                  position: 'relative',
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
                {/* Small orange pip when this channel has orders
                    still waiting on staff. Sits on the top-right
                    corner of the chip so it reads as a "there's
                    work here" signal without cluttering the label. */}
                {needs > 0 && (
                  <span
                    aria-label={`${needs} need${needs === 1 ? 's' : ''} action`}
                    style={{
                      position: 'absolute', top: -3, right: -3,
                      minWidth: 14, height: 14, borderRadius: 999,
                      background: '#EA580C', color: '#fff',
                      fontSize: 9, fontWeight: 700, padding: '0 4px',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      lineHeight: 1, border: '2px solid #fff',
                    }}
                  >
                    {needs}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Rows — phone gets an 8px gutter around the card list;
          md+ hands the list to the row so it can run edge-to-edge
          with the header/filter band. */}
      <div style={{ padding: isBands ? 0 : 8 }}>
        {orders.length === 0 ? (
          <EmptyLedger t={t} isToday={isToday} />
        ) : shown.length === 0 ? (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: FAINT, fontSize: 12 }}>
            {t('No orders match this filter.', 'Ninguna orden coincide con este filtro.')}
          </div>
        ) : shown.map(o => (
          <OrderRowCard
            key={o.id}
            order={o}
            selected={openId === o.id}
            onOpen={() => setOpenId(o.id)}
            t={t}
            locale={locale}
            isBands={isBands}
          />
        ))}
      </div>

      {/* Month picker — portaled to <body> so a scrolled ledger
          can't clip it. Same shape as the sales page picker. */}
      {calOpen && typeof document !== 'undefined' && pickerAnchor && createPortal(
        <MonthPickerOverlay
          date={date}
          today={today}
          month={calMonth}
          setMonth={setCalMonth}
          onPick={(iso) => {
            router.push(`/orders?date=${iso}`)
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
// Row
// ================================================================

function OrderRowCard({
  order, selected, onOpen, t, locale, isBands,
}: {
  order: OrderRow
  selected: boolean
  onOpen: () => void
  t: (en: string, es?: string) => string
  locale: string
  isBands: boolean
}) {
  const tone = CHANNEL_TONES[order.channel]
  const isVoided = order.status === 'voided'
  const title = order.customerName || t('Guest', 'Invitado')
  const time = fmtRowTime(order.createdAt, locale)
  const stateChip = fulfillmentChip(order, t)

  return (
    <div
      onClick={onOpen}
      aria-selected={selected}
      style={{
        display: 'flex', alignItems: 'center', gap: 13,
        // md+ runs edge-to-edge with 24px inset; phone tightens
        // to 12px inside its 8px card gutter for touch comfort.
        padding: isBands ? '11px 24px' : '11px 12px',
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
        {order.channel === 'delivery' ? <DeliveryIcon /> : <PickupIcon />}
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
            {order.itemCount} {order.itemCount === 1 ? t('item', 'artículo') : t('items', 'artículos')}
          </span>
          {isVoided ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', borderRadius: 999,
              padding: '1px 8px', fontSize: 10, fontWeight: 600,
              background: '#FEE2E2', color: '#B91C1C',
            }}>
              {t('Voided', 'Anulada')}
            </span>
          ) : (
            stateChip
          )}
          {/* Short order id — same scannable chip Sales rows carry.
              Sits after the state so the workflow signal reads
              first and the id is a secondary reference. */}
          <span style={{
            fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '0.02em',
          }}>
            #{order.orderNumber}
          </span>
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

function fulfillmentChip(order: OrderRow, t: (en: string, es?: string) => string) {
  const s = order.fulfillmentState
  if (s === 'new') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999,
        padding: '1px 8px', fontSize: 10, fontWeight: 600,
        background: '#FEF3C7', color: '#B45309',
      }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#F59E0B' }} />
        {t('New', 'Nueva')}
      </span>
    )
  }
  if (s === 'ready') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999,
        padding: '1px 8px', fontSize: 10, fontWeight: 600,
        background: '#DBEAFE', color: '#1D4ED8',
      }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3B82F6' }} />
        {t('Ready', 'Lista')}
      </span>
    )
  }
  // completed
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999,
      padding: '1px 8px', fontSize: 10, fontWeight: 600,
      background: '#DCFCE7', color: '#166534',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#22C55E' }} />
      {t('Completed', 'Completada')}
    </span>
  )
}

// ================================================================
// Drawer
// ================================================================

function OrderDrawer({
  order, onClose, t, locale,
}: {
  order: OrderRow
  onClose: () => void
  t: (en: string, es?: string) => string
  locale: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [confirmingVoid, setConfirmingVoid] = useState(false)
  const isVoided = order.status === 'voided'
  const canMarkReady = !isVoided
    && order.channel === 'pickup'
    && order.fulfillmentState === 'new'
  const canVoid = !isVoided

  function handleMarkReady() {
    setError(null)
    const fd = new FormData()
    fd.set('order_id', order.id)
    startTransition(async () => {
      const result = await markReady(fd)
      if ('error' in result) {
        setError(result.error)
      } else {
        router.refresh()
        onClose()
      }
    })
  }

  function handleVoid() {
    setError(null)
    const fd = new FormData()
    fd.set('order_id', order.id)
    startTransition(async () => {
      const result = await voidOrder(null, fd)
      if (result && 'error' in result) {
        setError(result.error)
        setConfirmingVoid(false)
      } else {
        router.refresh()
        onClose()
      }
    })
  }

  // Precomputed views for the drawer body so the JSX below stays
  // readable. Everything is optional-guarded so an incomplete
  // site_orders_link (a legacy row, or a schema in flux) still
  // renders instead of throwing.
  const s = order.shipping
  const addressStreet = [s.line1, s.line2].filter(Boolean).join(', ')
  const addressCity = [s.city, s.state, s.postal].filter(Boolean).join(', ')
  const hasAddress = Boolean(addressStreet || addressCity)
  const summaryRows: Array<[string, string, boolean]> = []
  if (order.subtotal != null) summaryRows.push([t('Subtotal', 'Subtotal'), fmtMoney(order.subtotal), false])
  if (order.discountTotal != null && order.discountTotal > 0) {
    summaryRows.push([t('Discount', 'Descuento'), `−${fmtMoney(order.discountTotal)}`, false])
  }
  if (order.delivery.price != null && order.delivery.price > 0) {
    summaryRows.push([order.delivery.label ?? t('Delivery', 'Envío'), fmtMoney(order.delivery.price), false])
  }
  if (order.taxTotal != null && order.taxTotal > 0) {
    summaryRows.push([t('Tax', 'Impuesto'), fmtMoney(order.taxTotal), false])
  }
  summaryRows.push([t('Total', 'Total'), fmtMoney(order.total), true])

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 40, display: 'flex', justifyContent: 'flex-end',
      color: INK, fontFamily: "'Geist', system-ui, sans-serif",
    }}>
      <div
        onClick={pending ? undefined : onClose}
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(24,24,27,0.28)',
          cursor: pending ? 'wait' : 'pointer',
        }}
      />
      <div style={{
        position: 'relative', width: 440, maxWidth: '100%', flex: '0 0 440px',
        height: '100vh', background: '#fff',
        borderLeft: `1px solid ${LINE}`, boxShadow: '-24px 0 48px rgba(24,24,27,0.10)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '20px 24px 16px', borderBottom: `1px solid ${LINE}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em', color: FAINT,
            }}>
              {t('ORDER', 'ORDEN')} #{order.orderNumber}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginTop: 6, flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: MONO, fontSize: 28, fontWeight: 600,
                letterSpacing: '-0.045em', lineHeight: 1,
                color: isVoided ? MUTED : INK,
                textDecoration: isVoided ? 'line-through' : undefined,
              }}>
                {fmtMoney(order.total)}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>USD</span>
              {!isVoided && fulfillmentChip(order, t)}
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 7 }}>
              {fmtFullDateTime(order.createdAt, locale)} · {order.itemCount} {order.itemCount === 1 ? t('item', 'artículo') : t('items', 'artículos')}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label={t('Close', 'Cerrar')}
            style={{
              border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8,
              width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
              font: 'inherit', fontSize: 15, color: MUTED,
              cursor: pending ? 'not-allowed' : 'pointer', flex: '0 0 auto',
              opacity: pending ? 0.4 : 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 24px 24px' }}>
          {/* Fulfillment — channel chip + shipping address (all
              lines) + marked-ready timestamp when applicable. */}
          <SectionEyebrow label={t('FULFILLMENT', 'ENTREGA')} />
          <div style={{
            border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px',
            background: SURFACE, fontSize: 13, color: INK, marginBottom: 20,
          }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 600,
              background: CHANNEL_TONES[order.channel].tile,
              color: CHANNEL_TONES[order.channel].ink,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: CHANNEL_TONES[order.channel].dot }} />
              {order.channel === 'pickup' ? t('Pickup', 'Recoger') : t('Delivery', 'Envío')}
              {order.delivery.label && (
                <span style={{ opacity: 0.8 }}>· {order.delivery.label}</span>
              )}
            </span>
            {order.delivery.sublabel && (
              <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
                {order.delivery.sublabel}
              </div>
            )}
            {hasAddress && (
              <div style={{ marginTop: 8, fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
                <div style={{ color: FAINT, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
                  {t('Ship to', 'Enviar a')}
                </div>
                {addressStreet && <div style={{ color: INK }}>{addressStreet}</div>}
                {addressCity && <div style={{ color: INK }}>{addressCity}</div>}
                {s.country && s.country.toUpperCase() !== 'US' && <div style={{ color: INK }}>{s.country}</div>}
              </div>
            )}
            {order.readyAt && (
              <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
                {t('Marked ready', 'Marcada lista')}: {fmtFullDateTime(order.readyAt, locale)}
              </div>
            )}
          </div>

          {/* Items + summary rows in one bordered block — matches
              sales drawer's shape so both surfaces read the same. */}
          <SectionEyebrow label={t('ITEMS', 'ARTÍCULOS')} />
          <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
            {order.items.length === 0 ? (
              <div style={{ padding: '10px 12px', fontSize: 12, color: FAINT }}>
                {t('No line items on this order.', 'Sin artículos en esta orden.')}
              </div>
            ) : order.items.map((li, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 11,
                  padding: '9px 12px',
                  borderBottom: `1px solid ${LINE_SOFT}`,
                }}
              >
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 22, height: 20, borderRadius: 6,
                  background: '#F4F4F2', fontFamily: MONO, fontSize: 10, fontWeight: 600,
                  color: '#52525B', padding: '0 4px',
                }}>
                  {li.qty}×
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, letterSpacing: '-0.01em' }}>{li.name}</span>
                  {li.variantLabel && (
                    <span style={{ display: 'block', fontSize: 11, color: FAINT, marginTop: 1 }}>
                      {li.variantLabel}
                    </span>
                  )}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 13, color: '#3F3F46' }}>
                  {fmtMoney(li.lineTotal)}
                </span>
              </div>
            ))}
            {summaryRows.map((r, i) => (
              <div
                key={r[0] + i}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: r[2] ? '10px 12px' : '8px 12px',
                  borderTop: `1px solid ${r[2] ? LINE : LINE_SOFT}`,
                  background: SURFACE,
                }}
              >
                <span style={r[2]
                  ? { fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }
                  : { fontSize: 12, color: MUTED }}>
                  {r[0]}
                </span>
                <span style={r[2]
                  ? { fontFamily: MONO, fontSize: 14, fontWeight: 700, letterSpacing: '-0.02em' }
                  : { fontFamily: MONO, fontSize: 12 }}>
                  {r[1]}
                </span>
              </div>
            ))}
          </div>

          {/* Buyer contact */}
          {(order.buyerEmail || order.buyerPhone || order.customerName) && (
            <>
              <SectionEyebrow label={t('BUYER', 'COMPRADOR')} />
              <div style={{
                border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px',
                fontSize: 13, color: INK, marginBottom: 20,
              }}>
                {order.customerName && <div style={{ fontWeight: 600 }}>{order.customerName}</div>}
                {order.buyerEmail && (
                  <a href={`mailto:${order.buyerEmail}`} style={{ color: '#2563EB', fontSize: 12, display: 'block', marginTop: 4, wordBreak: 'break-all' }}>
                    {order.buyerEmail}
                  </a>
                )}
                {order.buyerPhone && (
                  <a href={`tel:${order.buyerPhone}`} style={{ color: '#2563EB', fontSize: 12, display: 'block', marginTop: 2 }}>
                    {order.buyerPhone}
                  </a>
                )}
              </div>
            </>
          )}

          {/* Payment — card brand + last4 + Poynt reference. Only
              rendered when we have any of it; a truly card-less
              order (all-cash or manual) just skips this block. */}
          {(order.cardBrand || order.cardLast4 || order.paymentReference || order.cardholderName) && (
            <>
              <SectionEyebrow label={t('PAYMENT', 'PAGO')} />
              <div style={{
                border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px',
                fontSize: 13, color: INK, marginBottom: 20,
              }}>
                {(order.cardBrand || order.cardLast4) && (
                  <MetaLine
                    label={t('Card', 'Tarjeta')}
                    value={`${order.cardBrand ?? '—'}${order.cardLast4 ? ` ··${order.cardLast4}` : ''}`}
                    mono
                  />
                )}
                {order.cardholderName && (
                  <MetaLine label={t('Name on card', 'Nombre en tarjeta')} value={order.cardholderName} />
                )}
                {order.paymentReference && (
                  <MetaLine
                    label={t('Poynt ref', 'Ref. Poynt')}
                    value={order.paymentReference}
                    mono
                    small
                  />
                )}
              </div>
            </>
          )}

          {/* Order note — free-text the buyer left at checkout. */}
          {order.note && (
            <>
              <SectionEyebrow label={t('NOTE TO SHOP', 'NOTA A LA TIENDA')} />
              <div style={{
                border: `1px solid ${LINE}`, borderRadius: 10, background: SURFACE,
                padding: '10px 12px', fontSize: 12, color: '#3F3F46', lineHeight: 1.5,
                marginBottom: 20,
              }}>
                {order.note}
              </div>
            </>
          )}
        </div>

        {/* Footer — Void on the left, primary action on the right.
            Two-step confirm mirrors the sales drawer so a stray
            tap can't reverse a live sale. */}
        <div style={{
          borderTop: `1px solid ${LINE}`, padding: '14px 24px',
          display: 'flex', alignItems: 'center', gap: 10, background: '#fff',
          flexWrap: 'wrap',
        }}>
          {confirmingVoid ? (
            <>
              <span style={{ fontSize: 12, color: '#B91C1C', marginRight: 'auto', lineHeight: 1.4, maxWidth: 220 }}>
                {t('Void this order? The record stays.', '¿Anular esta orden? El registro se mantiene.')}
              </span>
              <button
                type="button"
                onClick={() => setConfirmingVoid(false)}
                disabled={pending}
                style={{
                  border: `1px solid ${LINE}`, background: '#fff', color: '#3F3F46',
                  borderRadius: 9, padding: '9px 14px', font: 'inherit',
                  fontSize: 13, fontWeight: 500, cursor: pending ? 'not-allowed' : 'pointer',
                }}
              >
                {t('Keep it', 'Conservar')}
              </button>
              <button
                type="button"
                onClick={handleVoid}
                disabled={pending}
                style={{
                  border: 0, background: '#B91C1C', color: '#fff',
                  borderRadius: 9, padding: '10px 16px', font: 'inherit',
                  fontSize: 13, fontWeight: 600, cursor: pending ? 'wait' : 'pointer',
                  opacity: pending ? 0.7 : 1,
                }}
              >
                {pending ? t('Voiding…', 'Anulando…') : t('Void order', 'Anular orden')}
              </button>
            </>
          ) : (
            <>
              {canVoid && (
                <button
                  type="button"
                  onClick={() => setConfirmingVoid(true)}
                  disabled={pending}
                  style={{
                    border: `1px solid ${LINE}`, background: '#fff', color: '#B91C1C',
                    borderRadius: 9, padding: '9px 14px', font: 'inherit',
                    fontSize: 13, fontWeight: 500,
                    cursor: pending ? 'not-allowed' : 'pointer',
                  }}
                >
                  {t('Void', 'Anular')}
                </button>
              )}
              <div style={{ marginLeft: 'auto' }} />
              {canMarkReady ? (
                <button
                  type="button"
                  onClick={handleMarkReady}
                  disabled={pending}
                  style={{
                    border: 0, background: CHANNEL_TONES.pickup.ink, color: '#fff',
                    borderRadius: 9, padding: '10px 16px',
                    font: 'inherit', fontSize: 13, fontWeight: 600,
                    cursor: pending ? 'wait' : 'pointer',
                    opacity: pending ? 0.75 : 1,
                  }}
                >
                  {pending ? t('Marking…', 'Marcando…') : t('Mark ready for pickup', 'Marcar lista para recoger')}
                </button>
              ) : (
                <span style={{ fontSize: 12, color: MUTED }}>
                  {isVoided
                    ? t('This order was voided.', 'Esta orden fue anulada.')
                    : order.channel === 'delivery'
                      ? t('Shipping workflow coming soon.', 'Flujo de envío próximamente.')
                      : t('Order handled.', 'Orden manejada.')}
                </span>
              )}
              {error && (
                <span style={{ fontSize: 12, color: '#B91C1C', width: '100%', textAlign: 'right' }}>{error}</span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ================================================================
// Bits
// ================================================================

function SectionEyebrow({ label }: { label: string }) {
  return (
    <div style={{
      fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em',
      color: FAINT, marginBottom: 8,
    }}>
      {label}
    </div>
  )
}

function MetaLine({
  label, value, mono, small,
}: {
  label: string
  value: string
  mono?: boolean
  small?: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 12, padding: '4px 0',
    }}>
      <span style={{ fontSize: 12, color: MUTED, flex: '0 0 auto' }}>{label}</span>
      <span style={{
        fontFamily: mono ? MONO : undefined,
        fontSize: small ? 11 : 12,
        color: mono ? '#3F3F46' : INK,
        textAlign: 'right', wordBreak: 'break-all', minWidth: 0,
      }}>
        {value}
      </span>
    </div>
  )
}

function EmptyLedger({ t, isToday }: {
  t: (en: string, es?: string) => string
  isToday: boolean
}) {
  return (
    <div style={{ padding: '44px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#52525B' }}>
        {isToday
          ? t('No online orders today', 'Sin órdenes en línea hoy')
          : t('No online orders on this day', 'Sin órdenes en línea este día')}
      </div>
      <div style={{ fontSize: 12, color: FAINT, marginTop: 3 }}>
        {isToday
          ? t('When buyers check out on the storefront, orders will land here.', 'Cuando los compradores realicen un pedido, aparecerán aquí.')
          : t('Nothing came through the storefront that day.', 'No hubo pedidos por la tienda ese día.')}
      </div>
    </div>
  )
}

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

function PickupIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4.5 7h11l-.9 9.1a1.5 1.5 0 0 1-1.5 1.35H6.9a1.5 1.5 0 0 1-1.5-1.35L4.5 7z"
        stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7.5 7V5.5a2.5 2.5 0 0 1 5 0V7"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function DeliveryIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2.6" y="5.5" width="14.8" height="10" rx="1.6"
        stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.2 6.3l6.8 5.1 6.8-5.1"
        stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

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

// ================================================================
// MonthPickerOverlay — portal-rendered floating calendar. Same
// shape as the sales page picker so both ledgers navigate dates
// with identical mechanics.
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
  t: (en: string, es?: string) => string
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
    // Jan 1 2024 was a Monday — sample by day-of-week for locale-aware initials.
    const sample = new Date(Date.UTC(2024, 0, 1 + i, 12))
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
          <MonthNavBtn dir="‹" onClick={() => shift(-1)} />
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>{monthLabel}</span>
          <MonthNavBtn dir="›" onClick={() => shift(1)} />
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
            {t('Pick a date to see its orders', 'Elige una fecha para ver sus pedidos')}
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

function MonthNavBtn({ dir, onClick }: { dir: string; onClick: () => void }) {
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
