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

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { markReady } from '@/app/actions/pickup'
import { makeT, type Lang } from '@/lib/i18n'

export interface OrderRowItem {
  name: string
  qty: number
  variantLabel: string | null
  lineTotal: number
}

export interface OrderRow {
  id: string
  orderNumber: string
  createdAt: string
  total: number
  status: 'completed' | 'voided'
  fulfillmentState: 'new' | 'ready' | 'completed'
  readyAt: string | null
  customerName: string | null
  channel: 'pickup' | 'delivery'
  itemCount: number
  items: OrderRowItem[]
  buyerEmail: string | null
  buyerPhone: string | null
  shippingLine1: string | null
}

const INK = '#18181B'
const PAPER = '#FAF9F6'
const LINE = '#E7E6E2'
const LINE_SOFT = '#F0EFEB'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const SURFACE = '#FAFAF9'
const MONO = "'Geist Mono', ui-monospace, monospace"

const CHANNEL_TONES = {
  pickup:   { tile: '#FDF1EA', ink: '#C2410C', dot: '#EA580C' },
  delivery: { tile: '#FDF2F8', ink: '#DB2777', dot: '#EC4899' },
} as const

type FilterKey = 'all' | 'pickup' | 'delivery' | 'voided'

export default function OrdersClient({
  lang, orders, businessDate,
}: {
  lang: Lang
  orders: OrderRow[]
  businessDate: string
}) {
  const t = makeT(lang)
  const locale = lang === 'es' ? 'es-ES' : 'en-US'
  const [openId, setOpenId] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')

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
    }}>
      {/* Sticky header — mirrors the sales layout: date heading,
          big mono total, count. Filter strip band underneath. */}
      <div style={{ position: 'sticky', top: 0, zIndex: 5, background: '#fff' }}>
        <div style={{ padding: '16px 24px 14px' }}>
          <div style={{
            fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em',
            color: FAINT, marginBottom: 6,
          }}>
            ORDERS
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 style={{
              margin: 0, fontSize: 21, fontWeight: 700,
              letterSpacing: '-0.035em', whiteSpace: 'nowrap',
            }}>
              {fmtBusinessDateLong(businessDate, locale)}
            </h1>
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

        {/* Filter strip */}
        <div style={{
          borderTop: `1px solid ${LINE}`, borderBottom: `1px solid ${LINE}`,
          background: SURFACE, padding: '10px 24px',
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

      {/* Rows */}
      <div>
        {orders.length === 0 ? (
          <EmptyLedger t={t} />
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
          />
        ))}
      </div>

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
  order, selected, onOpen, t, locale,
}: {
  order: OrderRow
  selected: boolean
  onOpen: () => void
  t: (en: string, es?: string) => string
  locale: string
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
        padding: '11px 24px', cursor: 'pointer',
        borderBottom: `1px solid ${LINE_SOFT}`,
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
  const isVoided = order.status === 'voided'
  const canMarkReady = !isVoided
    && order.channel === 'pickup'
    && order.fulfillmentState === 'new'

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
          {/* Fulfillment */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em', color: FAINT, marginBottom: 8 }}>
              {t('FULFILLMENT', 'ENTREGA')}
            </div>
            <div style={{
              border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px',
              background: SURFACE, fontSize: 13, color: INK,
            }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 600,
                background: CHANNEL_TONES[order.channel].tile,
                color: CHANNEL_TONES[order.channel].ink,
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: CHANNEL_TONES[order.channel].dot }} />
                {order.channel === 'pickup' ? t('Pickup', 'Recoger') : t('Delivery', 'Envío')}
              </span>
              {order.channel === 'delivery' && order.shippingLine1 && (
                <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
                  {t('Ship to', 'Enviar a')}: {order.shippingLine1}
                </div>
              )}
              {order.readyAt && (
                <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
                  {t('Marked ready', 'Marcada lista')}: {fmtFullDateTime(order.readyAt, locale)}
                </div>
              )}
            </div>
          </div>

          {/* Items */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em', color: FAINT, marginBottom: 8 }}>
              {t('ITEMS', 'ARTÍCULOS')}
            </div>
            <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
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
                    borderBottom: i === order.items.length - 1 ? undefined : `1px solid ${LINE_SOFT}`,
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
            </div>
          </div>

          {/* Buyer contact */}
          {(order.buyerEmail || order.buyerPhone) && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em', color: FAINT, marginBottom: 8 }}>
                {t('BUYER', 'COMPRADOR')}
              </div>
              <div style={{
                border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px',
                fontSize: 13, color: INK,
              }}>
                {order.customerName && <div style={{ fontWeight: 600 }}>{order.customerName}</div>}
                {order.buyerEmail && (
                  <a href={`mailto:${order.buyerEmail}`} style={{ color: '#2563EB', fontSize: 12, display: 'block', marginTop: 4 }}>
                    {order.buyerEmail}
                  </a>
                )}
                {order.buyerPhone && (
                  <a href={`tel:${order.buyerPhone}`} style={{ color: '#2563EB', fontSize: 12, display: 'block', marginTop: 2 }}>
                    {order.buyerPhone}
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer — primary action */}
        <div style={{
          borderTop: `1px solid ${LINE}`, padding: '14px 24px',
          display: 'flex', alignItems: 'center', gap: 10, background: '#fff',
        }}>
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
            <span style={{ fontSize: 12, color: '#B91C1C', marginLeft: 'auto' }}>{error}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ================================================================
// Bits
// ================================================================

function EmptyLedger({ t }: { t: (en: string, es?: string) => string }) {
  return (
    <div style={{ padding: '44px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#52525B' }}>
        {t('No online orders today', 'Sin órdenes en línea hoy')}
      </div>
      <div style={{ fontSize: 12, color: FAINT, marginTop: 3 }}>
        {t('When buyers check out on the storefront, orders will land here.', 'Cuando los compradores realicen un pedido, aparecerán aquí.')}
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
