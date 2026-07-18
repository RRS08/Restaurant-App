'use client'

// ----------------------------------------------------------------
// WebAnalyticsClient — web-native analytics display.
//
//   eyebrow + headline + summary
//   three-cell strip (revenue · orders · avg ticket)
//   daily revenue trend (14 days, thin bar chart)
//   category mix (top six)
//   payment mix
// ----------------------------------------------------------------

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { makeT, type Lang } from '@/lib/i18n'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })
const wrap = (extra: CSSProperties = {}): CSSProperties => ({ maxWidth: 1160, margin: '0 auto', ...extra })
const eyebrow: CSSProperties = mono({
  fontSize: 11.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6B6B70',
})

interface Props {
  lang: Lang
  daily: Array<{ date: string; revenue: number }>
  paymentCounts: { cash: number; card: number; other: number }
  paymentTotal: number
  categoryMix: Array<{ name: string; revenue: number; qty: number }>
  categoryTotal: number
  totalRevenue: number
  totalOrders: number
  avgTicket: number
}

const fmt = (n: number) => `$${n.toFixed(2)}`

export default function WebAnalyticsClient({
  lang, daily, paymentCounts, paymentTotal, categoryMix, categoryTotal,
  totalRevenue, totalOrders, avgTicket,
}: Props) {
  const t = makeT(lang)
  const maxDaily = Math.max(1, ...daily.map((d) => d.revenue))

  return (
    <div style={wrap({ padding: '56px 24px 96px' })}>
      <div style={{ marginBottom: 40 }}>
        <div style={eyebrow}>
          {t('Analytics', 'Analíticas')} · {t('Last 14 days', 'Últimos 14 días')}
        </div>
        <h1 style={{
          fontSize: 'clamp(36px, 5.4vw, 56px)', lineHeight: 1.02,
          letterSpacing: '-1.6px', fontWeight: 700, margin: '14px 0 0', color: '#18181B',
        }}>
          {t('How it’s going.', 'Cómo va.')}
        </h1>
        <p style={{
          fontSize: 17, lineHeight: 1.55, color: '#52525B',
          margin: '18px 0 0', maxWidth: 620,
        }}>
          {t(
            'A plain read of the last two weeks — what sold, how people paid, where the days are trending.',
            'Una lectura clara de las últimas dos semanas — qué se vendió, cómo pagó la gente, hacia dónde van los días.'
          )}
        </p>
      </div>

      {/* Three-cell summary */}
      <section style={{
        marginBottom: 56,
        borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
        display: 'flex',
      }}>
        <Cell label={t('Revenue', 'Ingresos')} value={fmt(totalRevenue)} isFirst />
        <Cell label={t('Orders', 'Órdenes')} value={`${totalOrders}`} />
        <Cell label={t('Avg ticket', 'Ticket promedio')} value={totalOrders > 0 ? fmt(avgTicket) : '—'} />
      </section>

      {/* Daily revenue trend */}
      <section style={{ marginBottom: 56 }}>
        <h2 style={{
          fontSize: 'clamp(22px, 2.4vw, 28px)', lineHeight: 1.1,
          letterSpacing: '-0.6px', fontWeight: 700, margin: '0 0 16px', color: '#18181B',
        }}>
          {t('Daily rhythm', 'Ritmo diario')}
        </h2>
        <div style={{
          display: 'flex', alignItems: 'flex-end', gap: 6, height: 160,
          padding: '12px 0 18px', borderBottom: '1px solid #E7E6E2',
        }}>
          {daily.map((d, idx) => {
            const h = (d.revenue / maxDaily) * 100
            const isToday = idx === daily.length - 1
            return (
              <div key={d.date} title={`${d.date} — ${fmt(d.revenue)}`}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  justifyContent: 'flex-end', height: '100%',
                }}>
                <div style={{
                  width: '100%', height: `${h}%`,
                  background: isToday ? '#18181B' : '#D8D8D4',
                  borderRadius: '3px 3px 0 0',
                  minHeight: d.revenue > 0 ? 3 : 0,
                }} />
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, ...eyebrow, color: '#9CA3AF' }}>
          <span>{formatShort(daily[0]?.date)}</span>
          <span>{formatShort(daily[daily.length - 1]?.date)}</span>
        </div>
      </section>

      {/* Category mix */}
      <section style={{ marginBottom: 56 }}>
        <h2 style={{
          fontSize: 'clamp(22px, 2.4vw, 28px)', lineHeight: 1.1,
          letterSpacing: '-0.6px', fontWeight: 700, margin: '0 0 16px', color: '#18181B',
        }}>
          {t('Category mix', 'Mix por categoría')}
        </h2>
        {categoryMix.length === 0 ? (
          <div style={{
            borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
            padding: '40px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 14,
          }}>
            {t('No category data yet.', 'Aún sin datos de categoría.')}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {categoryMix.map((c, idx) => {
              const pct = categoryTotal > 0 ? Math.round((c.revenue / categoryTotal) * 100) : 0
              return (
                <li key={c.name} style={{
                  borderTop: idx === 0 ? '1px solid #E7E6E2' : undefined,
                  borderBottom: '1px solid #E7E6E2',
                  padding: '14px 0',
                }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, auto) minmax(0, auto)',
                    gap: 18, alignItems: 'center',
                  }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: '#18181B' }}>{c.name}</span>
                    <span style={mono({ fontSize: 12, color: '#9CA3AF' })}>{c.qty} {t('sold', 'vendidos')}</span>
                    <span style={mono({ fontSize: 14, fontWeight: 600, color: '#18181B' })}>{pct}%</span>
                  </div>
                  <div style={{ marginTop: 8, height: 4, background: '#EDEFF2', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: '#18181B' }} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Payment mix */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{
          fontSize: 'clamp(22px, 2.4vw, 28px)', lineHeight: 1.1,
          letterSpacing: '-0.6px', fontWeight: 700, margin: '0 0 16px', color: '#18181B',
        }}>
          {t('Payment mix', 'Mix por pago')}
        </h2>
        <div style={{
          borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
          padding: '20px 0',
        }}>
          <div style={{ display: 'flex', height: 9, borderRadius: 99, overflow: 'hidden', marginBottom: 16 }}>
            <div style={{ width: `${pct(paymentCounts.card, paymentTotal)}%`, background: '#0EA5E9' }} />
            <div style={{ width: `${pct(paymentCounts.cash, paymentTotal)}%`, background: '#EC4899' }} />
            <div style={{ width: `${pct(paymentCounts.other, paymentTotal)}%`, background: '#94A3B8' }} />
          </div>
          <div style={mono({ display: 'flex', gap: 18, fontSize: 12, color: '#71717A', flexWrap: 'wrap' })}>
            <Legend dot="#0EA5E9" label={t('Card', 'Tarjeta')} pct={pct(paymentCounts.card, paymentTotal)} />
            <Legend dot="#EC4899" label={t('Cash', 'Efectivo')} pct={pct(paymentCounts.cash, paymentTotal)} />
            <Legend dot="#94A3B8" label={t('Other', 'Otro')} pct={pct(paymentCounts.other, paymentTotal)} />
          </div>
        </div>
      </section>

      <div style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid #E7E6E2' }}>
        <p style={{ fontSize: 14, color: '#9CA3AF', margin: 0 }}>
          {t('Need item-level growth, predictive depletion, or 60-day trends?', '¿Necesitas crecimiento por artículo, agotamiento predictivo o tendencias de 60 días?')}{' '}
          <Link href="/analytics" style={{ color: '#18181B', textDecoration: 'underline', textUnderlineOffset: 3 }}>
            {t('Open the classic analytics workspace', 'Abre el espacio clásico de analíticas')}
          </Link>.
        </p>
      </div>
    </div>
  )
}

function Cell({ label, value, isFirst }: { label: string; value: string; isFirst?: boolean }) {
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

function Legend({ dot, label, pct }: { dot: string; label: string; pct: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block' }} />
      {label} {pct}%
    </span>
  )
}

function pct(n: number, total: number) {
  if (total <= 0) return 0
  return Math.round((n / total) * 100)
}

function formatShort(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const monthsEn = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
  return `${monthsEn[d.getMonth()]} ${d.getDate()}`
}
