'use client'

// ----------------------------------------------------------------
// WebSalesClient — web-native sales display.
//
//   eyebrow + headline + summary
//   today snapshot (count · revenue · avg ticket)
//   orders list (latest first, urgency-style sort: unpaid → voided → completed)
//   focused card on click → full line items + payment breakdown
// ----------------------------------------------------------------

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { makeT, type Lang } from '@/lib/i18n'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })
const wrap = (extra: CSSProperties = {}): CSSProperties => ({
  maxWidth: 1160, margin: '0 auto', ...extra,
})
const eyebrow: CSSProperties = mono({
  fontSize: 11.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6B6B70',
})

interface LineItem {
  id: string; name: string; quantity: number; unitPrice: number; totalPrice: number
}
interface Order {
  id: string
  total: number
  createdAt: string
  source: 'manual' | 'native_pos' | 'external_pos'
  paymentType: 'cash' | 'card' | 'other'
  paymentStatus: 'paid' | 'unpaid'
  status: 'completed' | 'voided'
  note: string | null
  locationName: string | null
  lineItems: LineItem[]
}

interface Props { lang: Lang; orders: Order[] }

const fmt = (n: number) => `$${n.toFixed(2)}`

export default function WebSalesClient({ lang, orders }: Props) {
  const t = makeT(lang)
  const [focused, setFocused] = useState<Order | null>(null)

  useEffect(() => {
    if (!focused) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocused(null) }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [focused])

  // Today snapshot — count, revenue (paid only), avg ticket. Voided
  // orders are excluded from revenue but still count toward the
  // order count so the manager sees the full volume.
  const today = useMemo(() => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const startTs = start.getTime()
    const todays = orders.filter((o) => new Date(o.createdAt).getTime() >= startTs)
    const revenue = todays
      .filter((o) => o.status !== 'voided' && o.paymentStatus === 'paid')
      .reduce((a, o) => a + o.total, 0)
    const paidCount = todays.filter((o) => o.status !== 'voided').length
    const avg = paidCount > 0 ? revenue / paidCount : 0
    return { count: todays.length, revenue, avg, paidCount }
  }, [orders])

  return (
    <div style={wrap({ padding: '56px 24px 96px' })}>
      {/* HEAD */}
      <div style={{ marginBottom: 40 }}>
        <div style={eyebrow}>
          {t('Sales', 'Ventas')} · {t(`${orders.length} recent orders`, `${orders.length} órdenes recientes`)}
        </div>
        <h1 style={{
          fontSize: 'clamp(36px, 5.4vw, 56px)', lineHeight: 1.02,
          letterSpacing: '-1.6px', fontWeight: 700, margin: '14px 0 0', color: '#18181B',
        }}>
          {t('Today’s takings.', 'Ventas de hoy.')}
        </h1>
        <p style={{
          fontSize: 17, lineHeight: 1.55, color: '#52525B',
          margin: '18px 0 0', maxWidth: 620,
        }}>
          {t(
            'Every order rung up today — counter, online, or imported from your POS — totaled live.',
            'Cada orden cobrada hoy — caja, en línea o importada de tu POS — sumada en vivo.'
          )}
        </p>
      </div>

      {/* SNAPSHOT — today's three numbers, hairline strip on cream */}
      <section style={{
        marginBottom: 36,
        borderTop: '1px solid #E7E6E2',
        borderBottom: '1px solid #E7E6E2',
        display: 'flex',
      }}>
        <SnapshotCell label={t('Orders today', 'Órdenes hoy')} value={`${today.count}`} isFirst />
        <SnapshotCell label={t('Revenue', 'Ingresos')} value={fmt(today.revenue)} />
        <SnapshotCell
          label={t('Avg ticket', 'Ticket promedio')}
          value={today.paidCount > 0 ? fmt(today.avg) : '—'}
        />
      </section>

      {/* ORDERS LIST */}
      <section>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) minmax(80px, auto)',
          gap: 18, alignItems: 'baseline',
          padding: '0 0 12px', borderBottom: '1px solid #E7E6E2',
        }}>
          <div style={eyebrow}>{t('Order', 'Orden')}</div>
          <div style={eyebrow}>{t('Source', 'Origen')}</div>
          <div style={eyebrow}>{t('Total', 'Total')}</div>
          <div style={{ ...eyebrow, textAlign: 'right' }}>{t('Status', 'Estado')}</div>
        </div>
        {orders.length === 0 ? (
          <div style={{
            padding: '40px 0', color: '#9CA3AF', fontSize: 14, textAlign: 'center',
            borderBottom: '1px solid #E7E6E2',
          }}>
            {t('No orders yet.', 'Aún sin órdenes.')}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {orders.map((o) => (
              <li key={o.id} style={{ borderBottom: '1px solid #E7E6E2' }}>
                <button
                  type="button"
                  onClick={() => setFocused(o)}
                  className="web-sales-row"
                  style={{
                    display: 'grid', width: '100%',
                    gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) minmax(80px, auto)',
                    gap: 18, alignItems: 'center', padding: '14px 0',
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    fontFamily: 'inherit', color: 'inherit', textAlign: 'left',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: '#18181B' }}>
                      {o.lineItems.length === 0
                        ? t('Empty order', 'Orden vacía')
                        : o.lineItems.length === 1
                          ? o.lineItems[0].name
                          : t(
                              `${o.lineItems[0].name} + ${o.lineItems.length - 1} more`,
                              `${o.lineItems[0].name} + ${o.lineItems.length - 1} más`
                            )}
                    </div>
                    <div style={mono({ fontSize: 11, color: '#9CA3AF', marginTop: 3 })}>
                      {formatTime(o.createdAt)}
                    </div>
                  </div>
                  <div style={mono({ fontSize: 12, color: '#52525B' })}>
                    {sourceLabel(o.source, lang)}
                  </div>
                  <div style={mono({
                    fontSize: 14.5, fontWeight: 600,
                    color: o.status === 'voided' ? '#9CA3AF' : '#18181B',
                    textDecoration: o.status === 'voided' ? 'line-through' : undefined,
                  })}>
                    {fmt(o.total)}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <StatusPill status={o.status} payment={o.paymentStatus} lang={lang} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        <style>{`.web-sales-row:hover { background: rgba(24,24,27,0.025); }`}</style>
      </section>

      <FooterLink t={t} />

      {focused && (
        <FocusedOrderCard order={focused} onClose={() => setFocused(null)} t={t} lang={lang} />
      )}

      <style>{`
        @keyframes webModalBackdropIn { from{opacity:0} to{opacity:1} }
        @keyframes webModalCardIn { from{opacity:0;transform:translateY(8px) scale(.985)} to{opacity:1;transform:translateY(0) scale(1)} }
      `}</style>
    </div>
  )
}

function SnapshotCell({ label, value, isFirst }: { label: string; value: string; isFirst?: boolean }) {
  return (
    <div style={{
      flex: 1, padding: '18px 20px',
      borderLeft: isFirst ? 'none' : '1px solid #E7E6E2',
    }}>
      <div style={eyebrow}>{label}</div>
      <div style={mono({ fontSize: 26, fontWeight: 600, lineHeight: 1, color: '#18181B', marginTop: 10 })}>
        {value}
      </div>
    </div>
  )
}

function StatusPill({ status, payment, lang }: { status: 'completed' | 'voided'; payment: 'paid' | 'unpaid'; lang: Lang }) {
  const t = makeT(lang)
  let bg = '#F0FDF4'; let fg = '#15803D'; let label = t('Paid', 'Pagado')
  if (status === 'voided') { bg = '#F4F4F1'; fg = '#6B6B70'; label = t('Voided', 'Anulado') }
  else if (payment === 'unpaid') { bg = '#FFFBEB'; fg = '#B45309'; label = t('Unpaid', 'Sin pagar') }
  return (
    <span style={mono({
      fontSize: 10.5, letterSpacing: '0.06em', padding: '4px 9px',
      borderRadius: 6, background: bg, color: fg,
      textTransform: 'uppercase', fontWeight: 600,
    })}>
      {label}
    </span>
  )
}

function FocusedOrderCard({ order, onClose, t, lang }: {
  order: Order; onClose: () => void; t: (en: string, es?: string) => string; lang: Lang
}) {
  return (
    <div
      className="web-modal-backdrop"
      role="dialog" aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(24,24,27,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, backdropFilter: 'saturate(1.1) blur(2px)',
        animation: 'webModalBackdropIn 180ms ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 720, maxHeight: '90vh', overflowY: 'auto',
          background: '#FAF9F6', border: '1px solid #E0DED7',
          borderRadius: 16, boxShadow: '0 24px 60px -20px rgba(24,24,27,0.32)',
          animation: 'webModalCardIn 240ms cubic-bezier(0.22, 0.7, 0.2, 1)',
        }}
      >
        {/* Header */}
        <div style={{
          position: 'sticky', top: 0, background: '#FAF9F6',
          padding: '24px 28px 20px', borderBottom: '1px solid #E7E6E2',
          display: 'flex', justifyContent: 'space-between', gap: 18,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={eyebrow}>{t('Order', 'Orden')}</div>
            <h2 style={{
              fontSize: 'clamp(24px, 3vw, 30px)', lineHeight: 1.1,
              letterSpacing: '-0.8px', fontWeight: 700, margin: '6px 0 0', color: '#18181B',
            }}>
              {fmt(order.total)}
              <span style={mono({ fontSize: 12, color: '#9CA3AF', marginLeft: 12, fontWeight: 500 })}>
                {formatDateTime(order.createdAt, lang)}
              </span>
            </h2>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <StatusPill status={order.status} payment={order.paymentStatus} lang={lang} />
              <span style={mono({
                fontSize: 10.5, letterSpacing: '0.06em', padding: '4px 9px',
                borderRadius: 6, background: '#F1F0EC', color: '#6B6B70',
                textTransform: 'uppercase', fontWeight: 500,
              })}>
                {sourceLabel(order.source, lang)}
              </span>
              <span style={mono({
                fontSize: 10.5, letterSpacing: '0.06em', padding: '4px 9px',
                borderRadius: 6, background: '#F1F0EC', color: '#6B6B70',
                textTransform: 'uppercase', fontWeight: 500,
              })}>
                {paymentLabel(order.paymentType, lang)}
              </span>
            </div>
          </div>
          <button onClick={onClose} aria-label={t('Close', 'Cerrar')} style={closeBtn}>×</button>
        </div>

        <div style={{ padding: '24px 28px 28px' }}>
          {/* Line items */}
          <section>
            <div style={eyebrow}>{t('Line items', 'Artículos')}</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
              {order.lineItems.length === 0 ? (
                <li style={{
                  borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
                  padding: '14px 0', color: '#9CA3AF', fontSize: 14, textAlign: 'center',
                }}>
                  {t('No line items.', 'Sin artículos.')}
                </li>
              ) : (
                order.lineItems.map((li, idx) => (
                  <li key={li.id} style={{
                    borderTop: idx === 0 ? '1px solid #E7E6E2' : undefined,
                    borderBottom: '1px solid #E7E6E2',
                    padding: '12px 0',
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, auto) minmax(0, auto) minmax(0, auto)',
                    gap: 18, alignItems: 'center',
                  }}>
                    <span style={{ fontSize: 14.5, fontWeight: 600, color: '#18181B' }}>{li.name}</span>
                    <span style={mono({ fontSize: 12, color: '#9CA3AF' })}>×{li.quantity}</span>
                    <span style={mono({ fontSize: 12.5, color: '#52525B' })}>{fmt(li.unitPrice)}</span>
                    <span style={mono({ fontSize: 13, fontWeight: 600, color: '#18181B' })}>{fmt(li.totalPrice)}</span>
                  </li>
                ))
              )}
            </ul>
          </section>

          {/* Meta */}
          {(order.locationName || order.note) && (
            <section style={{ marginTop: 32 }}>
              <div style={eyebrow}>{t('Context', 'Contexto')}</div>
              <div style={{ marginTop: 12, fontSize: 14, color: '#52525B', lineHeight: 1.55 }}>
                {order.locationName && (
                  <div>
                    <span style={mono({ fontSize: 11, color: '#9CA3AF', marginRight: 8 })}>
                      {t('LOCATION', 'UBICACIÓN')}
                    </span>
                    {order.locationName}
                  </div>
                )}
                {order.note && (
                  <div style={{ marginTop: 8 }}>
                    <span style={mono({ fontSize: 11, color: '#9CA3AF', marginRight: 8 })}>
                      {t('NOTE', 'NOTA')}
                    </span>
                    {order.note}
                  </div>
                )}
              </div>
            </section>
          )}

          <FooterLinkText t={t} target="/sales" />
        </div>
      </div>
    </div>
  )
}

const closeBtn: CSSProperties = {
  flex: '0 0 auto', width: 36, height: 36, borderRadius: 8,
  border: '1px solid #E7E6E2', background: 'transparent', color: '#6B6B70',
  cursor: 'pointer', fontFamily: 'inherit', fontSize: 18, lineHeight: 1,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}

function FooterLink({ t }: { t: (en: string, es?: string) => string }) {
  return (
    <div style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid #E7E6E2' }}>
      <p style={{ fontSize: 14, color: '#9CA3AF', margin: 0 }}>
        {t('Need to void an order or filter by source?', '¿Necesitas anular una orden o filtrar por origen?')}{' '}
        <Link href="/sales" style={{ color: '#18181B', textDecoration: 'underline', textUnderlineOffset: 3 }}>
          {t('Open the classic sales workspace', 'Abre el espacio clásico de ventas')}
        </Link>
        .
      </p>
    </div>
  )
}

function FooterLinkText({ t, target }: { t: (en: string, es?: string) => string; target: string }) {
  return (
    <p style={{ fontSize: 13, color: '#9CA3AF', margin: '28px 0 0' }}>
      {t('Void this order or review the full receipt in the', 'Anula esta orden o revisa el recibo completo en el')}{' '}
      <Link href={target} style={{ color: '#18181B', textDecoration: 'underline', textUnderlineOffset: 3 }}>
        {t('classic sales workspace', 'espacio clásico de ventas')}
      </Link>
      .
    </p>
  )
}

function sourceLabel(s: Order['source'], lang: Lang) {
  if (s === 'native_pos') return lang === 'es' ? 'POS' : 'POS'
  if (s === 'external_pos') return lang === 'es' ? 'POS externo' : 'External POS'
  return lang === 'es' ? 'Manual' : 'Manual'
}
function paymentLabel(p: Order['paymentType'], lang: Lang) {
  const map = { cash: { en: 'Cash', es: 'Efectivo' }, card: { en: 'Card', es: 'Tarjeta' }, other: { en: 'Other', es: 'Otro' } }
  return lang === 'es' ? map[p].es : map[p].en
}
function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
function formatDateTime(iso: string, lang: Lang): string {
  const d = new Date(iso)
  const weekdaysEn = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
  const monthsEn = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
  const weekdaysEs = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB']
  const monthsEs = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']
  const w = lang === 'es' ? weekdaysEs[d.getDay()] : weekdaysEn[d.getDay()]
  const m = lang === 'es' ? monthsEs[d.getMonth()] : monthsEn[d.getMonth()]
  return `${w} · ${m} ${d.getDate()} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}
