'use client'

// ----------------------------------------------------------------
// Analytics Client — the in-product analyst.
//
// The page surfaces three lenses, presented through a top-level
// mode switch (segmented control), not stacked sections:
//
//   01 · Descriptive  — what happened (concise orientation)
//   02 · Diagnostic   — why it happened (drivers beneath the result)
//   03 · Predictive   — what's likely next (restrained continuation)
//
// Only one mode's content is visible at a time. The default mode
// is Diagnostic — that's where Analytics earns its keep, and we
// want a manager to land directly on signal extraction rather than
// scrolling past an orientation strip.
//
// The 7d / 30d comparison window stays page-wide: it lives in the
// header and feeds every mode. It is intentionally NOT scoped to
// one mode — switching modes should change the lens, not reset the
// time scope.
//
// Charts: exactly one, in Descriptive. Daily rhythm genuinely
// reveals structure (weekly cadence, anomaly days). Everywhere
// else, ranked signal blocks beat a chart wall.
// ----------------------------------------------------------------

import { useState, useMemo } from 'react'
import { makeT, type Lang } from '@/lib/i18n'
import SimpleBarChart from '@/components/bar-chart'

interface DailyBucket {
  date: string
  revenue: number
  orders: number
}
interface CategoryAggregate {
  id: string
  name: string
  currentRevenue: number
  currentQty: number
  previousRevenue: number
  previousQty: number
}
interface ItemAggregate extends CategoryAggregate {
  categoryId: string | null
  categoryName: string | null
}

interface CategoryMixEntry {
  id: string
  name: string
  revenue: number
  qty: number
}

interface PaymentMix {
  cash: { revenue: number; orders: number }
  card: { revenue: number; orders: number }
  other: { revenue: number; orders: number }
  totalRevenue: number
  totalOrders: number
}

interface AtRiskItem {
  id: string
  name: string
  unit: string
  currentStock: number
  threshold: number | null
  daysOfSupply: number
  consumptionPerDay: number
  driverItemName: string | null
}

interface Props {
  lang: Lang
  dailyBuckets: DailyBucket[]
  itemAggregates: ItemAggregate[]
  categoryAggregates: CategoryAggregate[]
  categoryMix7d: CategoryMixEntry[]
  categoryMix30d: CategoryMixEntry[]
  paymentMix7d: PaymentMix
  paymentMix30d: PaymentMix
  atRiskInventory: AtRiskItem[]
}

type Window = '7d' | '30d'
type Metric = 'revenue' | 'orders'
type Mode = 'descriptive' | 'diagnostic' | 'predictive'

// ================================================================
// AnalyticsClient — 2026-07 Claude Design pass.
//
// Single-page surface: header (date + Week/Month toggle) + KPI
// strip, one daily-rhythm bar chart, and two composition cards
// (revenue by category, payment mix). Same visual language as the
// Sales / Staffing / Inventory redesigns.
//
// Design-vs-data reconciliations:
//   • The mock ships hardcoded DAILY / TODAY / CURRENT_WEEK / BASE
//     / PREV_MONTH fixtures. Every one of those is computed here
//     from the real dailyBuckets prop.
//   • The design's "closed Mondays" (revenue === 0) treatment maps
//     onto any past day with 0 revenue AND 0 orders — we don't
//     have a business_hours signal on dailyBuckets yet, so those
//     days render as the design's low stub with copy "No sales"
//     instead of "Closed". A follow-up can join business_hours
//     server-side to get the true closed-day distinction.
//   • Category shares come from categoryMix7d / categoryMix30d
//     (top 5, or top 4 + "Other" rollup when there are more).
//     Historical navigation shows the current-window mix with a
//     "current" subtitle hint so it's honest — mix doesn't
//     rewind because we don't have per-day category totals.
//   • Payment mix uses paymentMix7d / paymentMix30d directly.
//   • Legacy tab surface (Descriptive / Diagnostic / Predictive)
//     is preserved as _LegacyAnalyticsClient below for reference;
//     itemAggregates / atRiskInventory become unused here but the
//     server still computes them until the redesign settles.
// ================================================================

const INK = '#18181B'
const PAPER = '#FAF9F6'
const LINE = '#E7E6E2'
const LINE_SOFT = '#F0EFEB'
const SURFACE = '#FAFAF9'
const FILL = '#F4F4F2'
const BAND = '#F0EFEB'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const GHOST = '#D6D5D1'
const MONO = "'Geist Mono', ui-monospace, monospace"

const MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
const SHORT_EN = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
const SHORT_ES = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom']
const DAY_MS = 86400000

const REVENUE_UNITS = [25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 2500]
const ORDER_UNITS = [1, 2, 3, 5, 8, 10, 15, 20, 25, 50, 100]

// Payment palette from the sales ledger — Card indigo, Cash
// emerald, Other stone.
const PAYMENT_STYLE = {
  card:  { dot: '#6366F1', bg: '#EEF2FF', ink: '#4F46E5' },
  other: { dot: '#A8A29E', bg: '#F5F5F4', ink: '#78716C' },
  cash:  { dot: '#10B981', bg: '#ECFDF5', ink: '#047857' },
} as const

// Design's Day tuple, re-derived from dailyBuckets: [label,
// weekday, revenue|null, orders|null, isWeekend]. Revenue === null
// means "not yet" (future day); 0 means the day happened but had
// no sales (closed or slow — visually treated the same).
type Day = [string, string, number | null, number | null, boolean]

function money(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function shortMoney(n: number) {
  return '$' + Math.round(n).toLocaleString('en-US')
}

// Smallest tick size whose N steps clear the peak. Keeps
// gridlines whole and the tallest bar nearly touching the top.
function niceCeiling(peak: number, steps: number, units: number[]) {
  for (const u of units) if (u * steps >= peak) return u * steps
  return units[units.length - 1] * steps
}

function sumOn(rows: Day[], i: 2 | 3): number {
  let s = 0
  for (const r of rows) s += (r[i] as number) || 0
  return s
}

function pctChange(now: number, before: number): number {
  if (!before) return 0
  return Math.round(((now - before) / before) * 100)
}

// Parse a YYYY-MM-DD date-key back into a Date in local time.
// Server keys are built via toDateKey (see page.tsx) so this
// mirrors that construction exactly — no timezone drift.
function parseDateKey(key: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return new Date(key)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}
function toDateKey(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function isWeekendDate(d: Date) {
  const day = d.getDay()
  return day === 0 || day === 6
}
function shortWeekdayEN(d: Date): string {
  return SHORT_EN[(d.getDay() + 6) % 7]
}
function shortMonthDay(d: Date, lang: Lang): string {
  return d.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric' })
}

export default function AnalyticsClient(props: Props) {
  const {
    lang,
    dailyBuckets,
    categoryMix7d,
    categoryMix30d,
    paymentMix7d,
    paymentMix30d,
  } = props
  const t = makeT(lang)
  const MONTHS = lang === 'es' ? MONTHS_ES : MONTHS_EN
  const SHORT = lang === 'es' ? SHORT_ES : SHORT_EN

  // ---- Build the design's Monday-anchored DAILY window from real
  // dailyBuckets. Server ships up to WINDOW_DAYS (60) rows ending
  // today. We anchor index 0 to the first Monday in that window
  // so the design's WEEK_START / TODAY math still works.
  const { DAILY, TODAY, CURRENT_WEEK, BASE } = useMemo(() => {
    if (dailyBuckets.length === 0) {
      return { DAILY: [] as Day[], TODAY: 0, CURRENT_WEEK: 0, BASE: new Date() }
    }
    // Find the first Monday in the window; that becomes index 0.
    // JS getDay(): Sun=0 … Sat=6. Convert to Mon=0 … Sun=6 via +6 % 7.
    const first = parseDateKey(dailyBuckets[0].date)
    const offsetToFirstMonday = (7 - ((first.getDay() + 6) % 7)) % 7
    const base = new Date(first.getFullYear(), first.getMonth(), first.getDate() + offsetToFirstMonday)
    const baseKey = toDateKey(base)
    const startIdx = dailyBuckets.findIndex((b) => b.date === baseKey)
    const sliced = startIdx >= 0 ? dailyBuckets.slice(startIdx) : dailyBuckets

    // Today's key — in local time so it matches the server's date-key
    // construction.
    const now = new Date()
    const todayKey = toDateKey(now)

    const rows: Day[] = sliced.map((b) => {
      const d = parseDateKey(b.date)
      const isFuture = d.getTime() > now.getTime() && !sameDay(d, now)
      return [
        shortMonthDay(d, lang),
        shortWeekdayEN(d),
        isFuture ? null : b.revenue,
        isFuture ? null : b.orders,
        isWeekendDate(d),
      ]
    })

    let todayIdx = rows.findIndex((_, i) => toDateKey(parseDateKey(sliced[i].date)) === todayKey)
    if (todayIdx < 0) todayIdx = rows.length - 1
    const currentWeekIdx = todayIdx - ((todayIdx % 7 + 7) % 7)

    return { DAILY: rows, TODAY: todayIdx, CURRENT_WEEK: Math.max(0, currentWeekIdx), BASE: base }
  }, [dailyBuckets, lang])

  // ---- View state ----
  const [range, setRange] = useState<'week' | 'month'>('week')
  const [metric, setMetric] = useState<Metric>('revenue')
  const [weekStart, setWeekStart] = useState<number>(CURRENT_WEEK)
  const [hover, setHover] = useState<number | null>(null)
  const [calOpen, setCalOpen] = useState(false)
  const [calMonth, setCalMonth] = useState<Date>(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [swipeX, setSwipeX] = useState<number | null>(null)
  const [swipeDX, setSwipeDX] = useState(0)

  const isWeek = range === 'week'
  const isRevenue = metric === 'revenue'
  const minStart = isWeek ? 0 : 21
  const start = Math.max(minStart, Math.min(CURRENT_WEEK, weekStart))
  const days = isWeek ? DAILY.slice(start, start + 7) : DAILY.slice(start - 21, start + 7)
  const done = days.filter((d) => d[2] !== null)

  const revenue = sumOn(done, 2)
  const orders = sumOn(done, 3)
  const avgTicket = orders ? revenue / orders : 0
  const tradingDays = done.filter((d) => (d[2] as number) > 0).length

  // Prev-window comparison for delta chips. Week view: 7 days
  // before start. Month view: prev 28-day block from dailyBuckets.
  const prevRows = isWeek ? DAILY.slice(Math.max(0, start - 7), start) : []
  const prev = isWeek && prevRows.length
    ? { revenue: sumOn(prevRows, 2), orders: sumOn(prevRows, 3) }
    : (() => {
        // Month view: sum prior 28 days from the same DAILY window.
        const prev28 = DAILY.slice(Math.max(0, start - 49), Math.max(0, start - 21))
        return { revenue: sumOn(prev28, 2), orders: sumOn(prev28, 3) }
      })()
  const prevAvg = prev.orders ? prev.revenue / prev.orders : 0

  const shiftWeeks = (n: number) => {
    setWeekStart((w) => Math.max(minStart, Math.min(CURRENT_WEEK, w + n * 7)))
    setCalOpen(false)
    setHover(null)
  }

  // ---- Chart scale ----
  const peak = done.length ? Math.max(...done.map((d) => (isRevenue ? d[2] : d[3]) as number)) : 0
  const STEPS = 4
  const ceiling = niceCeiling(peak, STEPS, isRevenue ? REVENUE_UNITS : ORDER_UNITS)
  const barColor = isRevenue ? '#4285F4' : '#7C3AED'
  const ticks = Array.from({ length: STEPS + 1 }, (_, i) => ({
    frac: i / STEPS,
    value: Math.round(ceiling * (i / STEPS)),
  }))

  // ---- Month picker grid (Monday-first, 6 rows) ----
  const cells = useMemo(() => {
    const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1)
    const gridStart = new Date(first.getFullYear(), first.getMonth(), first.getDate() - ((first.getDay() + 6) % 7))
    const from = isWeek ? start : start - 21
    const to = start + 6
    const baseTime = BASE.getTime()
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart.getTime() + i * DAY_MS)
      const idx = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - baseTime) / DAY_MS)
      return {
        d, i, idx,
        inMonth: d.getMonth() === calMonth.getMonth(),
        inWindow: idx >= from && idx <= to,
        isToday: sameDay(d, new Date(BASE.getTime() + TODAY * DAY_MS)),
        hasData: idx >= 0 && idx < DAILY.length,
      }
    })
  }, [calMonth, start, isWeek, BASE, TODAY, DAILY.length])

  // ---- Composition ----
  // Category rows: top 5 by revenue from the appropriate window
  // mix. Anything past the fifth rolls into "Other" so the sum
  // stays honest against the KPI revenue.
  const catSource = isWeek ? categoryMix7d : categoryMix30d
  const cats = useMemo(() => {
    const total = catSource.reduce((s, c) => s + c.revenue, 0)
    if (total <= 0 || catSource.length === 0) {
      return [] as Array<{ name: string; pct: number; amount: number }>
    }
    const top = catSource.slice(0, 5)
    const rest = catSource.slice(5)
    const restRev = rest.reduce((s, c) => s + c.revenue, 0)
    const rows = top.map((c) => ({ name: c.name, pct: Math.round((c.revenue / total) * 100), amount: c.revenue }))
    if (restRev > 0) {
      rows.push({ name: t('Other', 'Otros'), pct: Math.round((restRev / total) * 100), amount: restRev })
    }
    return rows
  }, [catSource, t])

  // Payment rows fixed to Card / Other / Cash in that order,
  // matching the sales-ledger convention.
  const paymentSource = isWeek ? paymentMix7d : paymentMix30d
  const pays = useMemo(() => {
    const rows: Array<{
      key: 'card' | 'other' | 'cash'
      name: string
      count: number
      rev: number
      pct: number
      style: typeof PAYMENT_STYLE[keyof typeof PAYMENT_STYLE]
    }> = [
      { key: 'card',  name: t('Card', 'Tarjeta'), count: paymentSource.card.orders,  rev: paymentSource.card.revenue,  pct: 0, style: PAYMENT_STYLE.card  },
      { key: 'other', name: t('Other', 'Otros'),  count: paymentSource.other.orders, rev: paymentSource.other.revenue, pct: 0, style: PAYMENT_STYLE.other },
      { key: 'cash',  name: t('Cash', 'Efectivo'),count: paymentSource.cash.orders,  rev: paymentSource.cash.revenue,  pct: 0, style: PAYMENT_STYLE.cash  },
    ]
    const total = rows.reduce((s, r) => s + r.count, 0)
    if (total > 0) for (const r of rows) r.pct = Math.round((r.count / total) * 100)
    return rows
  }, [paymentSource, t])
  const leader = pays.reduce((a, b) => (b.count > a.count ? b : a), pays[0])

  // ---- Chart footer stats ----
  const wknd = done.filter((d) => d[4] && (d[2] as number) > 0)
  const wkdy = done.filter((d) => !d[4] && (d[2] as number) > 0)
  const wkndAvg = wknd.length ? sumOn(wknd, 2) / wknd.length : 0
  const wkdyAvg = wkdy.length ? sumOn(wkdy, 2) / wkdy.length : 0
  const lift = wkdyAvg ? Math.round(((wkndAvg - wkdyAvg) / wkdyAvg) * 100) : 0
  const best = done.filter((d) => (d[2] as number) > 0).reduce<Day | null>(
    (a, b) => (!a || (b[2] as number) > (a[2] as number) ? b : a), null,
  )

  const hv = hover === null ? null : days[hover]
  const hvFuture = hv ? hv[2] === null : false
  const hoverPct = hover === null ? 0 : ((hover + 0.5) / days.length) * 100
  const hvHeight = hv && !hvFuture && ceiling
    ? (((isRevenue ? hv[2] : hv[3]) as number) / ceiling) * 100
    : 0

  const seg = (active: boolean): React.CSSProperties => ({
    border: 0, borderRadius: 8, height: 28, padding: '0 12px',
    font: 'inherit', fontSize: 12, cursor: 'pointer',
    background: active ? INK : 'transparent',
    color: active ? PAPER : MUTED,
    fontWeight: active ? 600 : 500,
  })
  const eyebrow: React.CSSProperties = { fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em', color: FAINT }

  const kpis = [
    {
      label: t('REVENUE', 'INGRESOS'),
      value: money(revenue),
      delta: pctChange(revenue, prev.revenue),
      note: isWeek
        ? `${t('full week', 'semana completa')} · ${tradingDays} ${t('open days', 'días abiertos')}`
        : `${t('across', 'a lo largo de')} ${tradingDays} ${t('trading days', 'días de operación')}`,
    },
    {
      label: t('ORDERS', 'ÓRDENES'),
      value: String(orders),
      delta: pctChange(orders, prev.orders),
      note: tradingDays
        ? `${Math.round(orders / tradingDays)} ${t('per open day', 'por día abierto')}`
        : t('no orders yet', 'sin órdenes aún'),
    },
    {
      label: t('AVG TICKET', 'TICKET PROMEDIO'),
      value: money(avgTicket),
      delta: pctChange(avgTicket, prevAvg),
      note: isWeek
        ? t('across the visible week', 'a lo largo de la semana visible')
        : t('steady across the four weeks', 'estable a lo largo de las cuatro semanas'),
    },
  ]

  const headerDateLabel = days.length
    ? `${days[0][0]} — ${days[days.length - 1][0]}, ${BASE.getFullYear()}`
    : ''

  return (
    <div style={{ flex: 1, minWidth: 0, padding: '20px 24px 28px', background: '#fff', fontFamily: "'Geist', system-ui, sans-serif", color: INK }}>

      {/* ---- header + KPIs ---- */}
      <div style={{ position: 'relative', border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', marginBottom: 14 }}>
        <div
          onPointerDown={(e) => { setSwipeX(e.clientX); setSwipeDX(0) }}
          onPointerMove={(e) => { if (swipeX !== null) setSwipeDX(e.clientX - swipeX) }}
          onPointerUp={() => {
            if (swipeX === null) return
            if (swipeDX <= -60) shiftWeeks(1)
            else if (swipeDX >= 60) shiftWeeks(-1)
            setSwipeX(null); setSwipeDX(0)
          }}
          onPointerLeave={() => { setSwipeX(null); setSwipeDX(0) }}
          style={{
            position: 'relative', padding: '16px 16px 14px', display: 'flex',
            alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap',
            touchAction: 'pan-y', cursor: swipeX === null ? 'default' : 'grabbing',
            transform: `translateX(${swipeDX / 6}px)`,
          }}
        >
          <button
            type="button"
            onClick={() => setCalOpen((v) => !v)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, border: '1px solid transparent', background: 'transparent', borderRadius: 9, padding: '2px 8px', marginLeft: -8, font: 'inherit', color: INK, cursor: 'pointer' }}
          >
            <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.035em', whiteSpace: 'nowrap' }}>
              {headerDateLabel}
            </span>
            <span style={{ fontSize: 10, color: FAINT }}>▾</span>
          </button>

          <div style={{ display: 'flex', alignItems: 'center', background: FILL, borderRadius: 10, padding: 3, gap: 2 }}>
            <button type="button" style={seg(isWeek)} onClick={() => { setRange('week'); setHover(null) }}>{t('Week', 'Semana')}</button>
            <button type="button" style={seg(!isWeek)} onClick={() => { setRange('month'); setHover(null); setWeekStart((w) => Math.max(21, w)) }}>{t('Month', 'Mes')}</button>
          </div>
        </div>

        {calOpen && (
          <>
            <div onClick={() => setCalOpen(false)} style={{ position: 'absolute', inset: 0, zIndex: 30 }} />
            <div style={{ position: 'absolute', top: 62, left: 16, zIndex: 31, width: 300, border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', boxShadow: '0 12px 32px rgba(24,24,27,0.14)', padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                <NavBtn dir="‹" onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1))} />
                <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>{MONTHS[calMonth.getMonth()]} {calMonth.getFullYear()}</span>
                <NavBtn dir="›" onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1))} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 0, marginBottom: 6 }}>
                {SHORT.map((l) => (
                  <span key={l} style={{ textAlign: 'center', fontFamily: MONO, fontSize: 9, letterSpacing: '0.1em', color: FAINT }}>{l.charAt(0)}</span>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: '3px 0' }}>
                {cells.map(({ d, i, idx, inMonth, inWindow, isToday, hasData }) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      if (!hasData) return
                      const monday = idx - (((idx % 7) + 7) % 7)
                      setWeekStart(Math.max(minStart, Math.min(CURRENT_WEEK, monday)))
                      setCalOpen(false); setHover(null)
                    }}
                    style={{
                      position: 'relative', border: 0, height: 30, font: 'inherit',
                      fontFamily: MONO, fontSize: 12, cursor: hasData ? 'pointer' : 'default',
                      ...(inWindow
                        ? {
                            background: BAND, color: INK, fontWeight: 600,
                            borderTopLeftRadius: i % 7 === 0 ? 8 : 0, borderBottomLeftRadius: i % 7 === 0 ? 8 : 0,
                            borderTopRightRadius: i % 7 === 6 ? 8 : 0, borderBottomRightRadius: i % 7 === 6 ? 8 : 0,
                          }
                        : { borderRadius: 8, background: 'transparent', fontWeight: 400, color: !hasData ? LINE : inMonth ? '#3F3F46' : GHOST }),
                    }}
                  >
                    {d.getDate()}
                    {isToday && <span style={{ position: 'absolute', left: '50%', bottom: 4, transform: 'translateX(-50%)', width: 3, height: 3, borderRadius: '50%', background: inWindow ? INK : FAINT }} />}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${LINE}` }}>
                <span style={{ fontSize: 11, color: FAINT }}>
                  {isWeek ? t('Pick a date to jump to its week', 'Elige una fecha para ir a su semana') : t('Pick a date to end the month there', 'Elige una fecha para terminar el mes ahí')}
                </span>
                <button type="button" onClick={() => { setWeekStart(CURRENT_WEEK); setCalOpen(false); setCalMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); setHover(null) }} style={{ border: 0, background: 'transparent', padding: 0, font: 'inherit', fontSize: 12, fontWeight: 500, color: '#2563EB', cursor: 'pointer' }}>
                  {t('This week', 'Esta semana')}
                </button>
              </div>
            </div>
          </>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', borderTop: `1px solid ${LINE}` }}>
          {kpis.map((k, i) => (
            <div key={k.label} style={{ padding: '14px 16px 15px', borderRight: i === kpis.length - 1 ? undefined : `1px solid ${LINE}` }}>
              <div style={eyebrow}>{k.label}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginTop: 6, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 600, letterSpacing: '-0.045em', lineHeight: 1 }}>{k.value}</span>
                <span
                  style={{
                    display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '2px 8px',
                    fontFamily: MONO, fontSize: 11, fontWeight: 600,
                    ...(k.delta === 0
                      ? { background: FILL, color: MUTED }
                      : k.delta > 0
                      ? { background: '#ECFDF5', color: '#047857' }
                      : { background: '#FEF2F2', color: '#B91C1C' }),
                  }}
                >
                  {k.delta === 0 ? t('flat', 'plano') : `${k.delta > 0 ? '▲' : '▼'} ${Math.abs(k.delta)}%`}
                </span>
              </div>
              <div style={{ fontSize: 11, color: FAINT, marginTop: 6 }}>{k.note}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ---- daily rhythm ---- */}
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '12px 16px', borderBottom: `1px solid ${LINE}`, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
              {isWeek ? t('This week, day by day', 'Esta semana, día por día') : t('Daily rhythm', 'Ritmo diario')}
            </div>
            <div style={{ fontSize: 12, color: FAINT, marginTop: 1 }}>
              {isWeek ? t('Monday to Sunday.', 'Lunes a domingo.') : t('Four whole weeks, each block starting Monday.', 'Cuatro semanas completas, cada bloque comienza el lunes.')}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', background: FILL, borderRadius: 10, padding: 3, gap: 2 }}>
            <button type="button" style={seg(isRevenue)} onClick={() => setMetric('revenue')}>{t('Revenue', 'Ingresos')}</button>
            <button type="button" style={seg(!isRevenue)} onClick={() => setMetric('orders')}>{t('Orders', 'Órdenes')}</button>
          </div>
        </div>

        <div style={{ padding: '16px 16px 12px', display: 'flex', gap: 12 }}>
          <div style={{ width: 44, flex: '0 0 44px', height: 190, position: 'relative' }}>
            {ticks.map((tk) => (
              <span key={tk.frac} style={{ position: 'absolute', right: 0, bottom: `${tk.frac * 100}%`, transform: 'translateY(50%)', fontFamily: MONO, fontSize: 9, color: FAINT }}>
                {isRevenue && tk.value >= 1000 ? `${tk.value / 1000}k` : tk.value}
              </span>
            ))}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ position: 'relative', height: 190 }}>
              {ticks.map((tk, i) => (
                <span key={tk.frac} style={{ position: 'absolute', left: 0, right: 0, bottom: `${tk.frac * 100}%`, height: 1, background: i === 0 ? LINE : FILL }} />
              ))}

              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 3 }}>
                {days.map((d, i) => {
                  const future = d[2] === null
                  const v = future ? 0 : ((isRevenue ? d[2] : d[3]) as number)
                  const zero = !future && v === 0
                  const h = ceiling ? (v / ceiling) * 100 : 0
                  const weekBreak = !isWeek && i > 0 && d[1] === 'Mon'
                  return (
                    <span
                      key={i}
                      onMouseEnter={() => setHover(i)}
                      onMouseLeave={() => setHover((cur) => (cur === i ? null : cur))}
                      style={{ position: 'relative', flexGrow: 1, flexShrink: 1, flexBasis: '0%', minWidth: 0, height: '100%', display: 'flex', alignItems: 'flex-end', cursor: 'default', marginLeft: weekBreak ? 7 : undefined }}
                    >
                      {hover === i && <span style={{ position: 'absolute', inset: 0, background: FILL, borderRadius: 6 }} />}
                      <span
                        style={
                          future
                            ? { display: 'block', width: '100%', height: '100%', borderRadius: 6, background: '#FCFCFB', border: `1px dashed ${LINE}` }
                            : zero
                            ? { display: 'block', width: '100%', height: 3, borderRadius: 2, background: LINE_SOFT, border: `1px solid ${LINE}` }
                            : { display: 'block', width: '100%', height: `${Math.max(2, h)}%`, borderRadius: '6px 6px 2px 2px', background: barColor }
                        }
                      />
                    </span>
                  )
                })}
              </div>

              {hv && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: `${Math.min(72, hvHeight + 6)}%`,
                    left: `${hoverPct}%`,
                    transform: `translateX(${hoverPct < 12 ? '-6px' : hoverPct > 88 ? '-100%' : '-50%'})`,
                    zIndex: 3, pointerEvents: 'none',
                    border: `1px solid ${LINE}`, borderRadius: 10, background: '#fff',
                    boxShadow: '0 8px 24px rgba(24,24,27,0.12)', padding: '8px 11px', whiteSpace: 'nowrap',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: barColor }} />
                    <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '-0.01em' }}>{hv[1]} {hv[0]}</span>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: hvFuture || hv[2] === 0 ? FAINT : INK }}>
                    {hvFuture
                      ? t('Not yet', 'Aún no')
                      : hv[2] === 0
                      ? t('No sales', 'Sin ventas')
                      : isRevenue
                      ? money(hv[2] as number)
                      : `${hv[3]} ${t('orders', 'órdenes')}`}
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, marginTop: 1 }}>
                    {hvFuture
                      ? t('still to come', 'aún por venir')
                      : hv[2] === 0
                      ? t('closed or slow', 'cerrado o lento')
                      : `${money((hv[2] as number) / (hv[3] as number))} ${t('avg ticket', 'ticket promedio')}`}
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 3, marginTop: 8 }}>
              {days.map((d, i) => {
                const weekBreak = !isWeek && i > 0 && d[1] === 'Mon'
                const isToday = (isWeek ? start + i : start - 21 + i) === TODAY
                const label = isWeek ? `${d[1]} ${d[0].split(' ')[1]}` : d[1] === 'Mon' || i === days.length - 1 ? d[0] : ''
                return (
                  <span
                    key={i}
                    style={{
                      flexGrow: 1, flexShrink: 1, flexBasis: '0%', minWidth: 0, textAlign: 'center',
                      fontFamily: MONO, fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden',
                      marginLeft: weekBreak ? 7 : undefined,
                      color: hover === i || isToday ? INK : d[2] === null ? GHOST : FAINT,
                      fontWeight: hover === i || isToday ? 600 : 400,
                    }}
                  >
                    {label}
                  </span>
                )
              })}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 16px', borderTop: `1px solid ${LINE}`, background: SURFACE, borderBottomLeftRadius: 12, borderBottomRightRadius: 12, flexWrap: 'wrap' }}>
          <FooterStat label={t('Best day', 'Mejor día')} value={best ? `${best[0]} · ${money(best[2] as number)}` : '—'} />
          <FooterStat label={isWeek ? t('Average per open day', 'Promedio por día abierto') : t('Daily average', 'Promedio diario')} value={tradingDays ? money(revenue / tradingDays) : '—'} />
          <FooterStat
            label={t('Weekends run', 'Fines de semana rinden')}
            value={wknd.length && wkdy.length ? `${lift > 0 ? '+' : ''}${lift}% ${t('vs weekdays', 'vs entre semana')}` : '—'}
            color={lift >= 0 ? '#047857' : '#B91C1C'}
          />
        </div>
      </div>

      {/* ---- composition ---- */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <AnalyticsCard
          title={t('Where revenue comes from', 'De dónde vienen los ingresos')}
          subtitle={`${t('Share of tracked revenue by category', 'Participación de los ingresos por categoría')} · ${isWeek ? t('last 7 days', 'últimos 7 días') : t('last 30 days', 'últimos 30 días')}`}
          footLeft={cats.length
            ? `${cats[0].name} ${t('carry', 'lleva')} ${cats[0].pct}% ${t('of revenue', 'de los ingresos')}`
            : t('No category revenue in this window.', 'Sin ingresos por categoría en esta ventana.')}
          footRight={`${shortMoney(cats.reduce((s, c) => s + c.amount, 0))} ${t('tracked', 'rastreado')}`}
        >
          {cats.length === 0 ? (
            <div style={{ padding: '18px 0', fontSize: 12, color: FAINT, textAlign: 'center' }}>
              {t('Categories fill in as sales come through.', 'Las categorías se llenan a medida que llegan las ventas.')}
            </div>
          ) : cats.map((c) => (
            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
              <span style={{ width: 150, flex: '0 0 150px', minWidth: 0, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
              <span style={{ flexGrow: 1, flexShrink: 1, flexBasis: '0%', minWidth: 0, height: 8, borderRadius: 999, background: LINE_SOFT, overflow: 'hidden' }}>
                <span style={{ display: 'block', width: `${c.pct}%`, height: '100%', borderRadius: 999, background: c.pct >= 20 ? INK : '#C4C4C7' }} />
              </span>
              <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, minWidth: 38, textAlign: 'right' }}>{c.pct}%</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT, minWidth: 56, textAlign: 'right' }}>{shortMoney(c.amount)}</span>
            </div>
          ))}
        </AnalyticsCard>

        <AnalyticsCard
          title={t('How guests paid', 'Cómo pagaron los clientes')}
          subtitle={`${t('Share of orders by payment method', 'Participación de órdenes por método de pago')} · ${isWeek ? t('last 7 days', 'últimos 7 días') : t('last 30 days', 'últimos 30 días')}`}
          footLeft={paymentSource.totalOrders
            ? `${leader.name} ${t('leads at', 'lidera con')} ${leader.pct}% ${t('of orders', 'de las órdenes')}`
            : t('No payment mix yet.', 'Sin mezcla de pagos aún.')}
          footRight={`${paymentSource.totalOrders} ${t('orders', 'órdenes')}`}
        >
          {paymentSource.totalOrders === 0 ? (
            <div style={{ padding: '18px 0', fontSize: 12, color: FAINT, textAlign: 'center' }}>
              {t('Payment method breakdown appears as orders come in.', 'El desglose por método de pago aparece cuando entran las órdenes.')}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', gap: 2, marginBottom: 16 }}>
                {pays.filter((p) => p.pct > 0).map((p) => (
                  <span key={p.key} style={{ display: 'block', width: `${p.pct}%`, height: '100%', borderRadius: 999, background: p.style.dot }} />
                ))}
              </div>
              {pays.map((p) => (
                <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: `1px solid ${LINE_SOFT}` }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 9, flex: '0 0 auto', background: p.style.bg, color: p.style.ink }}>
                    <PaymentIcon name={p.key} />
                  </span>
                  <span style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>{p.name}</span>
                    <span style={{ display: 'block', fontFamily: MONO, fontSize: 11, color: FAINT, marginTop: 1 }}>
                      {p.count} {p.count === 1 ? t('order', 'orden') : t('orders', 'órdenes')}
                    </span>
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT, minWidth: 56, textAlign: 'right' }}>
                    {p.count ? `${money(p.rev / p.count)} ${t('avg', 'prom')}` : '—'}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, minWidth: 42, textAlign: 'right' }}>{p.pct}%</span>
                </div>
              ))}
            </>
          )}
        </AnalyticsCard>
      </div>
    </div>
  )
}

// ---- Small building blocks scoped to the new AnalyticsClient ----
function FooterStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontSize: 12, color: MUTED }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color }}>{value}</span>
    </span>
  )
}

function AnalyticsCard({ title, subtitle, footLeft, footRight, children }: {
  title: string; subtitle: string; footLeft: string; footRight: string; children: React.ReactNode
}) {
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${LINE}` }}>
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</div>
        <div style={{ fontSize: 12, color: FAINT, marginTop: 1 }}>{subtitle}</div>
      </div>
      <div style={{ padding: '14px 16px 8px', flex: 1 }}>{children}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 16px', borderTop: `1px solid ${LINE}`, background: SURFACE, borderBottomLeftRadius: 12, borderBottomRightRadius: 12 }}>
        <span style={{ fontSize: 12, color: MUTED }}>{footLeft}</span>
        <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600 }}>{footRight}</span>
      </div>
    </div>
  )
}

function PaymentIcon({ name }: { name: 'card' | 'cash' | 'other' }) {
  if (name === 'card')
    return (
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden>
        <rect x="1.5" y="4" width="17" height="12" rx="2.5" strokeWidth="1.6" />
        <path d="M1.5 8h17" strokeWidth="1.6" />
        <path d="M4.5 12.5h3" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  if (name === 'cash')
    return (
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden>
        <ellipse cx="10" cy="5.3" rx="6.4" ry="2.5" strokeWidth="1.7" />
        <path d="M3.6 5.3v4.4c0 1.38 2.87 2.5 6.4 2.5s6.4-1.12 6.4-2.5V5.3" strokeWidth="1.7" />
        <path d="M3.6 9.7v4.4c0 1.38 2.87 2.5 6.4 2.5s6.4-1.12 6.4-2.5V9.7" strokeWidth="1.7" />
      </svg>
    )
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden>
      <circle cx="10" cy="10" r="7.2" strokeWidth="1.6" />
      <path d="M10 6.4v7.2M6.4 10h7.2" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function NavBtn({ dir, onClick }: { dir: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', font: 'inherit', fontSize: 12, color: '#52525B', cursor: 'pointer' }}>
      {dir}
    </button>
  )
}

// Mode catalog. Owns the button label, the section's analytical
// identity (title), and a single-line context description used as
// the mode intro under the switch. Predictive's eyebrow keeps the →
// cue so the forward intent reads in the segmented control itself.
function buildModes(lang: Lang): {
  id: Mode
  eyebrow: string
  label: string
  title: string
  sub: string
}[] {
  const t = makeT(lang)
  return [
    {
      id: 'descriptive',
      eyebrow: '01',
      label: t('Descriptive', 'Descriptivo'),
      title: t('What happened', 'Qué pasó'),
      sub: t('The numbers, plain — for the selected window.', 'Los números, simples — para la ventana seleccionada.'),
    },
    {
      id: 'diagnostic',
      eyebrow: '02',
      label: t('Diagnostic', 'Diagnóstico'),
      title: t('Why it happened', 'Por qué pasó'),
      sub: t("What's driving the headline number.", 'Qué está impulsando el número principal.'),
    },
    {
      id: 'predictive',
      eyebrow: '03 →',
      label: t('Predictive', 'Predictivo'),
      title: t("What's likely next", 'Qué es probable que siga'),
      sub: t('Where current direction points if conditions hold.', 'A dónde apunta la dirección actual si las condiciones se mantienen.'),
    },
  ]
}

const CURRENCY = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const SHORT_CURRENCY = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`

// Kept as reference during the 2026-07 Claude Design pass. The new
// default-exported AnalyticsClient above replaces this three-tab
// (Descriptive/Diagnostic/Predictive) surface with a single-page
// layout. We keep the code so we can reach for pieces (item
// aggregates, at-risk inventory, signal blocks) if the new
// surface grows to cover them.
function _LegacyAnalyticsClient({
  lang,
  dailyBuckets,
  itemAggregates,
  categoryAggregates,
  categoryMix7d,
  categoryMix30d,
  paymentMix7d,
  paymentMix30d,
  atRiskInventory,
}: Props) {
  // atRiskInventory currently consumed only for prop-shape compatibility.
  void atRiskInventory
  const t = makeT(lang)
  const MODES = useMemo(() => buildModes(lang), [lang])
  const [win, setWin] = useState<Window>('30d')
  const [metric, setMetric] = useState<Metric>('revenue')
  // Default mode is Descriptive — the entry orientation, "what
  // happened." Diagnostic and Predictive stay one click away;
  // landing on Descriptive lets the page open as a calm report and
  // pulls users into the deeper modes on their own pace.
  const [mode, setMode] = useState<Mode>('descriptive')
  const activeMode = MODES.find((m) => m.id === mode) ?? MODES[0]

  // ---- Descriptive scalars (current vs previous, same window) ----
  const size = win === '7d' ? 7 : 30
  const currentWindow = dailyBuckets.slice(-size)
  const previousWindow = dailyBuckets.slice(-(size * 2), -size)

  const currentRevenue = sum(currentWindow, (d) => d.revenue)
  const previousRevenue = sum(previousWindow, (d) => d.revenue)
  const currentOrders = sum(currentWindow, (d) => d.orders)
  const previousOrders = sum(previousWindow, (d) => d.orders)

  const ticketCurrent = currentOrders > 0 ? currentRevenue / currentOrders : 0
  const ticketPrevious = previousOrders > 0 ? previousRevenue / previousOrders : 0

  const revDelta = pctDelta(currentRevenue, previousRevenue)
  const ordDelta = pctDelta(currentOrders, previousOrders)
  const ticketDelta = pctDelta(ticketCurrent, ticketPrevious)

  // ---- Descriptive chart ----
  const chartData = useMemo(
    () =>
      currentWindow.map((d) => ({
        label: formatDayLabel(d.date),
        value: metric === 'revenue' ? d.revenue : d.orders,
      })),
    [currentWindow, metric],
  )

  // ---- Diagnostic: category carry ----
  // Surface categories where one item provides most of the revenue.
  // This is the "fragile category" pattern — strong number masking
  // weakness in the rest of the lineup.
  const categoryCarry = useMemo(() => {
    type Row = {
      categoryId: string
      categoryName: string
      topItemName: string
      topItemShare: number
      restRevenue: number
      restPrevious: number
      restDelta: number | null
    }
    const out: Row[] = []
    for (const cat of categoryAggregates) {
      if (cat.currentRevenue <= 0) continue
      const items = itemAggregates
        .filter((i) => i.categoryId === cat.id)
        .sort((a, b) => b.currentRevenue - a.currentRevenue)
      if (items.length < 2) continue
      const top = items[0]
      const share = top.currentRevenue / cat.currentRevenue
      if (share < 0.65) continue
      const restCurrent = cat.currentRevenue - top.currentRevenue
      const restPrevious = cat.previousRevenue - top.previousRevenue
      out.push({
        categoryId: cat.id,
        categoryName: cat.name,
        topItemName: top.name,
        topItemShare: Math.round(share * 100),
        restRevenue: restCurrent,
        restPrevious,
        restDelta: pctDelta(restCurrent, restPrevious),
      })
    }
    return out.sort((a, b) => b.topItemShare - a.topItemShare).slice(0, 3)
  }, [categoryAggregates, itemAggregates])

  // ---- Diagnostic: mix shift (avg item price) ----
  // Revenue per unit sold. Different from ticket size: this is
  // sensitive to which items guests are buying, independent of how
  // many items per order.
  const mixShift = useMemo(() => {
    const curUnits = sum(itemAggregates, (i) => i.currentQty)
    const curRev = sum(itemAggregates, (i) => i.currentRevenue)
    const prevUnits = sum(itemAggregates, (i) => i.previousQty)
    const prevRev = sum(itemAggregates, (i) => i.previousRevenue)
    const curAvg = curUnits > 0 ? curRev / curUnits : 0
    const prevAvg = prevUnits > 0 ? prevRev / prevUnits : 0
    return {
      curAvg,
      prevAvg,
      delta: pctDelta(curAvg, prevAvg),
    }
  }, [itemAggregates])

  // Threshold lowered from 8% → 6% so Mix shift now picks up
  // subtler composition changes too. With Quiet declines removed,
  // Mix shift carries the "subtle under-the-surface change" role
  // for Diagnostic on its own.
  const mixShiftMaterial = mixShift.delta !== null && Math.abs(mixShift.delta) >= 6

  // ---- Descriptive composition: window-active mixes ----
  // Both blocks track the comparison window: switching 7d / 30d
  // changes which mix is rendered.
  const activeCategoryMix = win === '7d' ? categoryMix7d : categoryMix30d
  const activePaymentMix = win === '7d' ? paymentMix7d : paymentMix30d

  // Top-5 categories by revenue share for the descriptive snapshot.
  const topCategoryMix = useMemo(() => {
    const total = activeCategoryMix.reduce((s, c) => s + c.revenue, 0)
    if (total <= 0) return { rows: [] as { id: string; name: string; revenue: number; share: number }[], total: 0 }
    const rows = activeCategoryMix
      .slice(0, 5)
      .map((c) => ({ id: c.id, name: c.name, revenue: c.revenue, share: c.revenue / total }))
    return { rows, total }
  }, [activeCategoryMix])

  // ---- Predictive 1: next-7-days outlook ----
  // Project the upcoming week's revenue rhythm from day-of-week
  // patterns in the trailing 60 days. The signal answers "which
  // days are likely to be strong / soft next?" using the
  // restaurant's own weekly rhythm — no recommendation, just a
  // continuation read of the cadence already in the data.
  const next7Outlook = useMemo(() => {
    const buckets: { revenues: number[] }[] = Array.from({ length: 7 }, () => ({ revenues: [] }))
    for (const b of dailyBuckets) {
      if (b.revenue <= 0 && b.orders === 0) continue
      const [y, m, d] = b.date.split('-').map(Number)
      const dow = new Date(y, m - 1, d).getDay()
      buckets[dow].revenues.push(b.revenue)
    }
    const avgByDow = buckets.map((b) => ({
      avg: b.revenues.length > 0 ? b.revenues.reduce((s, r) => s + r, 0) / b.revenues.length : 0,
      sampleSize: b.revenues.length,
    }))
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const upcoming: { dayLabel: string; dateLabel: string; projected: number; sampleSize: number }[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(today)
      d.setDate(today.getDate() + i)
      const dow = d.getDay()
      upcoming.push({
        dayLabel: d.toLocaleDateString('en-US', { weekday: 'short' }),
        dateLabel: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        projected: Math.round(avgByDow[dow].avg * 100) / 100,
        sampleSize: avgByDow[dow].sampleSize,
      })
    }
    const sortedByValue = [...upcoming]
      .filter((u) => u.projected > 0)
      .sort((a, b) => b.projected - a.projected)
    return {
      upcoming,
      strongest: sortedByValue[0] ?? null,
      softest: sortedByValue[sortedByValue.length - 1] ?? null,
      total: upcoming.reduce((s, u) => s + u.projected, 0),
    }
  }, [dailyBuckets])

  // ---- Predictive 2: recent weekly pace ----
  // The four trailing weekly totals leading into the projected
  // rhythm above. Answers a different operational question than the
  // day-by-day rhythm — "is overall demand healthy or soft right
  // now?" — by showing how the business has been pacing week over
  // week. Pure roll-up of the existing dailyBuckets values; no new
  // analytics, just a different aggregation.
  const recentWeeks = useMemo(() => {
    type Week = {
      total: number
      startDate: string
      endDate: string
    }
    const out: Week[] = []
    const buckets = dailyBuckets.slice(-28)
    if (buckets.length === 0) return out
    // Walk backward from the end in 7-day chunks. Newest chunk last
    // so the bars read chronologically top → bottom in the card.
    for (let i = 0; i < 4; i++) {
      const sliceEnd = buckets.length - i * 7
      const sliceStart = Math.max(0, sliceEnd - 7)
      if (sliceEnd <= sliceStart) break
      const week = buckets.slice(sliceStart, sliceEnd)
      if (week.length === 0) break
      const total = sum(week, (d) => d.revenue)
      out.unshift({
        total,
        startDate: week[0].date,
        endDate: week[week.length - 1].date,
      })
    }
    return out
  }, [dailyBuckets])

  return (
    <div className="max-w-[1400px]">
      {/* ---- HEADER ----
          Calm identity-only header. The comparison window sits in
          the control band below, alongside the mode switch. */}
      <div className="mb-7 pb-5 border-b border-gray-100">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">
          {t('Analytics', 'Analíticas')}
        </h1>
        <p className="mt-1.5 text-sm text-gray-500 leading-relaxed">
          {t("Patterns, drivers, and what's likely next.", 'Patrones, impulsores y qué es probable que siga.')}
        </p>
      </div>

      {/* ---- WORKSPACE CONTROLS ----
          Same horizontal band: mode switch on the left (the lens),
          comparison window on the right (the scope). Together they
          read as the active page's controls. The comparison window
          stays page-wide — switching modes does not reset it. */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div
          role="tablist"
          aria-label={t('Analytics mode', 'Modo de analíticas')}
          className="grid grid-cols-3 gap-1 rounded-xl bg-gray-100 p-1 w-full sm:w-auto sm:max-w-2xl"
        >
          {MODES.map((m) => (
            <ModeButton
              key={m.id}
              active={mode === m.id}
              onClick={() => setMode(m.id)}
              eyebrow={m.eyebrow}
              label={m.label}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500">{t('Last', 'Últimos')}</span>
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5">
            <Toggle label="7d" active={win === '7d'} onClick={() => setWin('7d')} small />
            <Toggle label="30d" active={win === '30d'} onClick={() => setWin('30d')} small />
          </div>
        </div>
      </div>

      {/* Active mode's analytical identity. Title + one-line sub. */}
      <ModeIntro title={activeMode.title} sub={activeMode.sub} />

      {/* ============ DESCRIPTIVE CONTENT ============ */}
      {mode === 'descriptive' && (
        <>
        <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
          <DescriptiveStat
            label={t('Revenue', 'Ingresos')}
            value={CURRENCY(currentRevenue)}
            delta={revDelta}
            hint={t(`vs previous ${size} days`, `vs ${size} días anteriores`)}
          />
          <DescriptiveStat
            label={t('Orders', 'Pedidos')}
            value={currentOrders.toLocaleString()}
            delta={ordDelta}
            hint={t(`vs previous ${size} days`, `vs ${size} días anteriores`)}
          />
          <DescriptiveStat
            label={t('Avg ticket', 'Ticket promedio')}
            value={CURRENCY(ticketCurrent)}
            delta={ticketDelta}
            hint={t(`vs previous ${size} days`, `vs ${size} días anteriores`)}
          />
        </div>

        <div className="border-t border-gray-100 bg-gray-50/40 px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <p className="text-[11px] font-medium text-gray-500">{t('Daily rhythm', 'Ritmo diario')}</p>
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-white border border-gray-200 p-0.5">
            <Toggle
              label={t('Revenue', 'Ingresos')}
              active={metric === 'revenue'}
              onClick={() => setMetric('revenue')}
              small
            />
            <Toggle
              label={t('Orders', 'Pedidos')}
              active={metric === 'orders'}
              onClick={() => setMetric('orders')}
              small
            />
          </div>
        </div>
        <div className="px-5 pt-4 pb-5 bg-gray-50/40">
          <SimpleBarChart
            data={chartData}
            color={metric === 'revenue' ? '#3b82f6' : '#8b5cf6'}
            height={140}
          />
        </div>
        </div>

        {/* Supporting surfaces — composition snapshots that sit
            beneath the lead overview. Window-responsive: switching
            7d / 30d updates both. */}
        <SupportEyebrow>{t('Composition', 'Composición')}</SupportEyebrow>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <CategoryMixSnapshot rows={topCategoryMix.rows} total={topCategoryMix.total} size={size} lang={lang} />
          <PaymentMixSnapshot mix={activePaymentMix} size={size} lang={lang} />
        </div>
        </>
      )}

      {/* ============ DIAGNOSTIC CONTENT ============
          Two-band hierarchy, deliberately simple:
            1 · Driver chart — visual decomposition of the move.
            2 · Supporting signals — category concentration + mix shift
                when material.
          Analyst read + Driver breakdown were removed at the user's
          request: for now the chart carries the visual answer and
          the supporting signals carry the evidence; no middle text
          layer is needed. */}
      {mode === 'diagnostic' && (
        <>
          {/* 1 · Driver chart — centered-baseline horizontal bars in
              green/red/gray so the direction and relative magnitude
              of Revenue / Orders / Avg ticket reads at a glance. */}
          <DiagnosticDriverChart
            revDelta={revDelta}
            ordDelta={ordDelta}
            ticketDelta={ticketDelta}
            lang={lang}
          />

          <SupportEyebrow>{t('Supporting signals', 'Señales de apoyo')}</SupportEyebrow>

          {/* 2a · Category concentration — evidence-row layout per
              category. */}
          <CategoryCarryEvidence items={categoryCarry} lang={lang} />

          {/* 2b · Mix shift — kept as a small supporting signal when
              material. Same calculation + threshold as before. */}
          {mixShiftMaterial && (
            <SignalBlock
              title={t('Mix shift', 'Cambio de mix')}
              tone="mix"
              verdict={(mixShift.delta ?? 0) < 0 ? t('Cheaper mix', 'Mix más barato') : t('Pricier mix', 'Mix más caro')}
              headline={t(
                `Average item price moved ${CURRENCY(mixShift.prevAvg)} → ${CURRENCY(mixShift.curAvg)} (${deltaText(mixShift.delta)}). A subtle composition shift beneath the surface — guests are buying ${(mixShift.delta ?? 0) < 0 ? 'lower' : 'higher'}-priced items independent of how many items per order.`,
                `El precio promedio por artículo pasó de ${CURRENCY(mixShift.prevAvg)} → ${CURRENCY(mixShift.curAvg)} (${deltaText(mixShift.delta)}). Un cambio sutil de composición bajo la superficie — los huéspedes están comprando artículos de ${(mixShift.delta ?? 0) < 0 ? 'menor' : 'mayor'} precio independientemente de cuántos artículos por pedido.`
              )}
              evidence={[
                { label: t('Previous avg', 'Promedio anterior'), value: CURRENCY(mixShift.prevAvg) },
                { label: t('Current avg', 'Promedio actual'), value: CURRENCY(mixShift.curAvg) },
              ]}
            />
          )}
        </>
      )}

      {/* ============ PREDICTIVE CONTENT ============
          Two-band hierarchy, deliberately simple:
            1 · Next 7 days rhythm — the forward shape.
            2 · Recent weekly pace — the trajectory leading into it.
          Analyst read, projection summary, and the at-risk /
          continuation supporting signals were removed at the user's
          request. The rhythm answers "which days are likely
          strong"; the recent pace answers "are we in a strong or
          soft period right now?" — together they cover what's next
          and where it's coming from. */}
      {mode === 'predictive' && (
        <>
          <PredictiveRhythmChart outlook={next7Outlook} lang={lang} />
          <PredictiveRecentWeeks weeks={recentWeeks} lang={lang} />
        </>
      )}
    </div>
  )
}

// ================================================================
// ModeButton — one segment of the top-level mode switch. Bigger and
// more substantial than the small Toggle (used for window/metric
// flips) so the mode switch reads as the page's primary control,
// not a secondary filter. Dark fill when active; on hover it shows
// a white surface against the gray-100 segmented container — same
// language the rest of the system uses for segmented controls.
// ================================================================
function ModeButton({
  active,
  onClick,
  eyebrow,
  label,
}: {
  active: boolean
  onClick: () => void
  eyebrow: string
  label: string
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`text-left px-4 py-2.5 rounded-lg transition-colors ${
        active
          ? 'bg-gray-900 text-white shadow-sm'
          : 'text-gray-700 hover:bg-white/70'
      }`}
    >
      <p
        className={`text-[10px] font-semibold uppercase tracking-widest ${
          active ? 'text-white/60' : 'text-gray-400'
        }`}
      >
        {eyebrow}
      </p>
      <p className="text-sm font-bold mt-0.5 leading-tight">{label}</p>
    </button>
  )
}

// ================================================================
// ModeIntro — the active mode's analytical identity. Title + one
// short context line, sitting directly under the mode switch. The
// mode switch carries the navigational identity; this carries the
// analytical identity ("What happened" / "Why it happened" /
// "What's likely next").
// ================================================================
function ModeIntro({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-lg font-bold text-gray-900 tracking-tight">{title}</h2>
      <p className="mt-1 text-xs text-gray-500 leading-relaxed max-w-3xl">{sub}</p>
    </div>
  )
}

// ================================================================
// DescriptiveStat — an inline stat used inside the unified
// descriptive panel. Borderless (the panel provides the chrome),
// divided from its siblings by the panel's vertical rules.
// ================================================================
function DescriptiveStat({
  label,
  value,
  delta,
  hint,
}: {
  label: string
  value: string
  delta: number | null
  hint: string
}) {
  const deltaTone =
    delta == null
      ? 'text-gray-300'
      : delta > 0
        ? 'text-green-700'
        : delta < 0
          ? 'text-red-600'
          : 'text-gray-400'
  const arrow = delta == null ? '·' : delta > 0 ? '↑' : delta < 0 ? '↓' : '·'

  return (
    <div className="px-5 py-4">
      <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
        {label}
      </p>
      <div className="mt-1.5 flex items-baseline gap-2">
        <p className="text-xl font-bold font-mono tabular-nums text-gray-900 truncate">{value}</p>
        <span className={`text-[11px] font-bold font-mono tabular-nums ${deltaTone}`}>
          {arrow} {delta != null ? `${Math.abs(delta)}%` : '—'}
        </span>
      </div>
      <p className="mt-0.5 text-[10px] text-gray-400 truncate">{hint}</p>
    </div>
  )
}

// ================================================================
// Signal tone palette
//
// Per-block identity tones for the diagnostic section. The palette
// stays restrained — the page is for operators, not a marketing
// dashboard — but each insight type gets a distinct visual identity
// so the section is easier to scan emotionally and structurally.
//
//   neutral   — gray  (default fallback)
//   info      — blue  (Growth decomposition — objective)
//   category  — violet (Category carry — compositional / structural)
//   warn      — amber (Quiet declines — soft warning)
//   mix       — orange (Mix shift — distinct from warn)
//   positive  — green
//
// Each tone produces a thin 2px left accent stripe, a pill bg, and
// a dot fill. Verdict pills inherit the same tone for visual rhyme.
// ================================================================
type SignalTone = 'neutral' | 'info' | 'category' | 'warn' | 'mix' | 'positive'

const SIGNAL_TONE: Record<
  SignalTone,
  { pillBg: string; dot: string; accent: string; headerTint: string }
> = {
  neutral: {
    pillBg: 'bg-gray-100 text-gray-700',
    dot: 'bg-gray-400',
    accent: '',
    headerTint: '',
  },
  info: {
    pillBg: 'bg-blue-50 text-blue-800',
    dot: 'bg-blue-500',
    accent: 'border-l-2 border-l-blue-300',
    headerTint: 'bg-blue-50/30',
  },
  category: {
    pillBg: 'bg-violet-50 text-violet-800',
    dot: 'bg-violet-500',
    accent: 'border-l-2 border-l-violet-300',
    headerTint: 'bg-violet-50/30',
  },
  warn: {
    pillBg: 'bg-amber-50 text-amber-800',
    dot: 'bg-amber-500',
    accent: 'border-l-2 border-l-amber-300',
    headerTint: 'bg-amber-50/30',
  },
  mix: {
    pillBg: 'bg-orange-50 text-orange-800',
    dot: 'bg-orange-500',
    accent: 'border-l-2 border-l-orange-300',
    headerTint: 'bg-orange-50/30',
  },
  positive: {
    pillBg: 'bg-green-50 text-green-800',
    dot: 'bg-green-500',
    accent: 'border-l-2 border-l-green-300',
    headerTint: 'bg-green-50/30',
  },
}

// ================================================================
// SignalBlock — a single diagnostic finding with verdict + headline
// + supporting evidence. Tone drives a thin left accent stripe, the
// verdict pill, and a faint header tint — enough to differentiate
// insight types without becoming a colored-alert wall.
// ================================================================
function SignalBlock({
  title,
  verdict,
  headline,
  evidence,
  tone = 'neutral',
}: {
  title: string
  verdict: string
  headline: string
  evidence: { label: string; value: string }[]
  tone?: SignalTone
}) {
  const t = SIGNAL_TONE[tone]
  return (
    <div
      className={`rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] mb-3 overflow-hidden ${t.accent}`}
    >
      <div
        className={`border-b border-gray-100 px-5 py-2.5 flex items-center justify-between gap-2 ${t.headerTint}`}
      >
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          {title}
        </p>
        <span
          className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${t.pillBg}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden="true" />
          {verdict}
        </span>
      </div>
      <div className="px-5 py-4">
        <p className="text-[15px] font-semibold text-gray-900 leading-relaxed">
          {headline}
        </p>
        {evidence.length > 0 && (
          <div className="mt-4 pt-3 border-t border-gray-100 grid grid-cols-2 gap-4">
            {evidence.map((e) => (
              <div key={e.label}>
                <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
                  {e.label}
                </p>
                <p className="mt-0.5 text-sm font-bold text-gray-900 font-mono tabular-nums">
                  {e.value}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ================================================================
// SignalBlockMulti — a ranked list of diagnostic findings of the
// same kind (e.g. several categories carrying on one item). Renders
// an empty-state message when no rows match the pattern — that is
// itself a signal (no fragility detected).
// ================================================================
// ================================================================
// DiagnosticDriverChart — Diagnostic's tier-1 surface (the visual
// answer). Centered-baseline horizontal bars for the three drivers
// (Revenue / Orders / Avg ticket). Bars extend right for positive
// deltas, left for negative — the relative widths show which driver
// did the moving, without the reader having to parse percentages.
//
// Pure UI over the existing revDelta / ordDelta / ticketDelta
// values — no new calculation.
// ================================================================
function DiagnosticDriverChart({
  revDelta,
  ordDelta,
  ticketDelta,
  lang,
}: {
  revDelta: number | null
  ordDelta: number | null
  ticketDelta: number | null
  lang: Lang
}) {
  const t = makeT(lang)
  const rows: { label: string; value: number | null }[] = [
    { label: t('Revenue', 'Ingresos'), value: revDelta },
    { label: t('Orders', 'Pedidos'), value: ordDelta },
    { label: t('Avg ticket', 'Ticket promedio'), value: ticketDelta },
  ]
  // Shared scale across the three bars so the visual is honest about
  // relative magnitudes. Floor at 1% so a single zero-delta row
  // doesn't divide by zero.
  const scale = Math.max(
    Math.abs(revDelta ?? 0),
    Math.abs(ordDelta ?? 0),
    Math.abs(ticketDelta ?? 0),
    1,
  )
  const allNull = revDelta === null && ordDelta === null && ticketDelta === null
  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] mb-3 overflow-hidden border-l-2 border-l-blue-300">
      <div className="border-b border-gray-100 px-6 py-3 bg-blue-50/30">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-700">
          {t('Driver chart', 'Gráfico de impulsores')}
        </p>
        <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">
          {t('What moved the headline number — visually, side by side.', 'Qué movió el número principal — visualmente, lado a lado.')}
        </p>
      </div>
      {allNull ? (
        <p className="px-6 py-8 text-xs text-gray-400 text-center">
          {t('Not enough history yet to decompose the move.', 'Aún no hay suficiente historial para descomponer el movimiento.')}
        </p>
      ) : (
        <div className="px-6 py-5 space-y-3.5">
          {rows.map((r) => (
            <DriverBar key={r.label} label={r.label} value={r.value} scale={scale} />
          ))}
        </div>
      )}
    </div>
  )
}

// One row of the driver chart: label / centered-baseline bar /
// signed delta. Bar fills toward the right for positive values and
// toward the left for negative ones. Color tone matches sign.
function DriverBar({
  label,
  value,
  scale,
}: {
  label: string
  value: number | null
  scale: number
}) {
  const v = value ?? 0
  const isMissing = value === null
  const isFlat = !isMissing && v === 0
  const isPositive = v > 0
  // Bar can fill at most one half of the track (centered baseline).
  const widthPct = Math.min(50, (Math.abs(v) / scale) * 50)
  const tone = isMissing || isFlat
    ? 'text-gray-400'
    : isPositive
      ? 'text-green-700'
      : 'text-red-600'
  const barTone = isMissing
    ? 'bg-gray-200'
    : isFlat
      ? 'bg-gray-300'
      : isPositive
        ? 'bg-green-400'
        : 'bg-red-400'
  return (
    <div className="grid grid-cols-[96px_1fr_72px] items-center gap-3">
      <span className="text-[12px] font-semibold text-gray-700">{label}</span>
      <div className="relative h-2.5 bg-gray-50 rounded-full overflow-hidden">
        {/* Center baseline */}
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-gray-200" aria-hidden="true" />
        {!isMissing && (
          <div
            className={`absolute top-0 bottom-0 ${barTone} rounded-full`}
            style={
              isPositive || isFlat
                ? { left: '50%', width: `${Math.max(widthPct, isFlat ? 2 : 1)}%` }
                : { right: '50%', width: `${widthPct}%` }
            }
          />
        )}
      </div>
      <span className={`text-[12px] font-bold font-mono tabular-nums text-right ${tone}`}>
        {deltaText(value)}
      </span>
    </div>
  )
}

// ================================================================
// CategoryCarryEvidence — supporting signal block for Diagnostic.
// Replaces the bulleted SignalBlockMulti rendering with an
// evidence-row layout: each row reads as a category name eyebrow,
// a top-item sentence, and a quiet "rest of category" delta line.
// Feels like supporting evidence, not a bullet list.
//
// Uses the same `categoryCarry` data shape produced upstream — no
// calculation change, just presentation.
// ================================================================
function CategoryCarryEvidence({
  items,
  lang,
}: {
  items: {
    categoryId: string
    categoryName: string
    topItemName: string
    topItemShare: number
    restRevenue: number
    restPrevious: number
    restDelta: number | null
  }[]
  lang: Lang
}) {
  const tr = makeT(lang)
  const t = SIGNAL_TONE.category
  return (
    <div
      className={`rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] mb-3 overflow-hidden ${t.accent}`}
    >
      <div className={`border-b border-gray-100 px-5 py-3 ${t.headerTint}`}>
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          {tr('Category concentration', 'Concentración de categoría')}
        </p>
        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed max-w-2xl">
          {tr('These categories leaned on a single item for most of their revenue.', 'Estas categorías se apoyaron en un solo artículo para la mayor parte de sus ingresos.')}
        </p>
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-6 text-xs text-gray-400">
          {tr('No category leans on a single item. Revenue is spread across the lineup.', 'Ninguna categoría se apoya en un solo artículo. Los ingresos están distribuidos en toda la lista.')}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {items.map((c) => {
            const restTone =
              c.restDelta !== null && c.restDelta < 0
                ? 'text-amber-700'
                : c.restDelta !== null && c.restDelta > 0
                  ? 'text-green-700'
                  : 'text-gray-500'
            return (
              <li key={c.categoryId} className="px-5 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-500">
                  {c.categoryName}
                </p>
                <p className="mt-1 text-[14px] text-gray-900 leading-snug">
                  <span className="font-semibold">{c.topItemName}</span> {tr('carried', 'aportó')}{' '}
                  <span className="font-semibold font-mono tabular-nums">{c.topItemShare}%</span> {tr('of revenue.', 'de los ingresos.')}
                </p>
                <p className="mt-1 text-[11px] text-gray-500 leading-relaxed font-mono tabular-nums">
                  {tr('Rest of category:', 'Resto de la categoría:')} {SHORT_CURRENCY(c.restPrevious)} → {SHORT_CURRENCY(c.restRevenue)}{' '}
                  <span className={`font-semibold ${restTone}`}>({deltaText(c.restDelta)})</span>
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function SignalBlockMulti({
  title,
  subtitle,
  empty,
  items,
  tone = 'neutral',
}: {
  title: string
  subtitle: string
  empty: string
  items: {
    key: string
    headline: string
    detail: string | null
    tone: 'neutral' | 'warn' | 'positive'
  }[]
  tone?: SignalTone
}) {
  const t = SIGNAL_TONE[tone]
  return (
    <div
      className={`rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] mb-3 overflow-hidden ${t.accent}`}
    >
      <div className={`border-b border-gray-100 px-5 py-3 ${t.headerTint}`}>
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          {title}
        </p>
        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed max-w-2xl">
          {subtitle}
        </p>
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-6 text-xs text-gray-400">{empty}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {items.map((it) => {
            const dotTone =
              it.tone === 'warn'
                ? 'bg-amber-500'
                : it.tone === 'positive'
                  ? 'bg-green-500'
                  : 'bg-gray-300'
            return (
              <li key={it.key} className="px-5 py-3.5 flex gap-3">
                <span
                  className={`mt-2 h-1.5 w-1.5 rounded-full flex-shrink-0 ${dotTone}`}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-gray-900 leading-snug">
                    {it.headline}
                  </p>
                  {it.detail && (
                    <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                      {it.detail}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ================================================================
// SupportEyebrow — the small "below the lead" section divider used
// at the seam between each mode's lead surface and its supporting
// surfaces. Tiny uppercase eyebrow + thin trailing rule. Makes the
// lead/support layout grammar explicit without adding chrome.
// ================================================================
function SupportEyebrow({ children }: { children: string }) {
  return (
    <div className="mt-6 mb-3 flex items-center gap-3">
      <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
        {children}
      </p>
      <span className="flex-1 h-px bg-gray-100" />
    </div>
  )
}

// ================================================================
// CategoryMixSnapshot — descriptive composition. Three-band card
// (header / body / tinted footer) to mirror the structural rhythm
// of the upper descriptive panel (stat strip / chart strip). The
// footer band carries the tracked-total summary, so the card feels
// like a first-class analytic surface rather than a header+list.
// ================================================================
function CategoryMixSnapshot({
  rows,
  total,
  size,
  lang,
}: {
  rows: { id: string; name: string; revenue: number; share: number }[]
  total: number
  size: number
  lang: Lang
}) {
  const t = makeT(lang)
  const topShare = rows[0]?.share ?? 0
  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col">
      <div className="border-b border-gray-100 px-5 py-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
            {t('Category mix', 'Mix de categorías')}
          </p>
          <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
            {t('Top categories by revenue share.', 'Categorías top por participación de ingresos.')}
          </p>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full whitespace-nowrap">
          {t(`Last ${size}d`, `Últimos ${size}d`)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="flex-1 px-5 py-8 text-xs text-gray-400 text-center">
          {t('No category revenue in this window yet.', 'Sin ingresos por categoría en esta ventana aún.')}
        </p>
      ) : (
        <ul className="flex-1 px-5 py-4 space-y-3">
          {rows.map((r, i) => {
            const pct = Math.round(r.share * 100)
            const isLeader = i === 0
            return (
              <li key={r.id} className="text-[12px]">
                <div className="flex items-baseline justify-between gap-3 mb-1.5">
                  <span className={`truncate ${isLeader ? 'text-gray-900 font-semibold' : 'text-gray-700 font-medium'}`}>
                    {r.name}
                  </span>
                  <span className="text-gray-900 font-bold font-mono tabular-nums flex-shrink-0">
                    {pct}%
                  </span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className={`h-full ${isLeader ? 'bg-gray-700' : 'bg-gray-400'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <div className="border-t border-gray-100 bg-gray-50/40 px-5 py-2.5 flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          {t('Tracked total', 'Total rastreado')}
        </span>
        <span className="text-[12px] font-bold font-mono tabular-nums text-gray-800">
          ${total.toLocaleString(lang === 'es' ? 'es-ES' : 'en-US', { maximumFractionDigits: 0 })}
          {topShare > 0 && (
            <span className="ml-2 text-[10px] font-medium text-gray-500">
              · {t('leader', 'líder')} {Math.round(topShare * 100)}%
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

// ================================================================
// PaymentMixSnapshot — descriptive composition. Three-band card
// matching CategoryMixSnapshot's structure: header / body (stacked
// bar + legend) / tinted footer with the total order count. Bucket
// tones are Card=purple, Cash=orange, Other=gray — same palette
// the Sales row uses, so the user reads the same color for "card"
// across the app.
// ================================================================
function PaymentMixSnapshot({
  mix,
  size,
  lang,
}: {
  mix: {
    cash: { revenue: number; orders: number }
    card: { revenue: number; orders: number }
    other: { revenue: number; orders: number }
    totalRevenue: number
    totalOrders: number
  }
  size: number
  lang: Lang
}) {
  const t = makeT(lang)
  const buckets = [
    { key: 'card' as const, label: t('Card', 'Tarjeta'), tone: 'bg-purple-400' },
    { key: 'cash' as const, label: t('Cash', 'Efectivo'), tone: 'bg-orange-400' },
    { key: 'other' as const, label: t('Other', 'Otro'), tone: 'bg-gray-300' },
  ]
  const empty = mix.totalRevenue === 0
  // Order buckets by share descending so the legend reads in the
  // order of importance and the largest share leads.
  const sortedBuckets = [...buckets].sort(
    (a, b) => mix[b.key].revenue - mix[a.key].revenue,
  )
  const leader = sortedBuckets[0]
  const leaderShare = empty ? 0 : (mix[leader.key].revenue / mix.totalRevenue) * 100
  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col">
      <div className="border-b border-gray-100 px-5 py-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
            {t('Payment mix', 'Mix de pagos')}
          </p>
          <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
            {t('How guests paid.', 'Cómo pagaron los huéspedes.')}
          </p>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full whitespace-nowrap">
          {t(`Last ${size}d`, `Últimos ${size}d`)}
        </span>
      </div>
      {empty ? (
        <p className="flex-1 px-5 py-8 text-xs text-gray-400 text-center">
          {t('No payments in this window yet.', 'Sin pagos en esta ventana aún.')}
        </p>
      ) : (
        <div className="flex-1 px-5 py-4">
          {/* Stacked share bar — a bit taller for stronger presence */}
          <div className="flex w-full h-2.5 rounded-full overflow-hidden bg-gray-100">
            {sortedBuckets.map((b) => {
              const pct = (mix[b.key].revenue / mix.totalRevenue) * 100
              if (pct <= 0) return null
              return <div key={b.key} className={b.tone} style={{ width: `${pct}%` }} />
            })}
          </div>
          <ul className="mt-4 space-y-2">
            {sortedBuckets.map((b) => {
              const pct = Math.round((mix[b.key].revenue / mix.totalRevenue) * 100)
              const orders = mix[b.key].orders
              if (pct === 0 && orders === 0) return null
              return (
                <li
                  key={b.key}
                  className="flex items-baseline justify-between text-[12px] gap-3"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`h-2 w-2 rounded-full flex-shrink-0 ${b.tone}`} aria-hidden="true" />
                    <span className="text-gray-800 font-medium">{b.label}</span>
                    <span className="text-[10px] text-gray-400 font-mono tabular-nums truncate">
                      {orders} {lang === 'es' ? (orders === 1 ? 'pedido' : 'pedidos') : (orders === 1 ? 'order' : 'orders')}
                    </span>
                  </span>
                  <span className="text-gray-900 font-bold font-mono tabular-nums flex-shrink-0">
                    {pct}%
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <div className="border-t border-gray-100 bg-gray-50/40 px-5 py-2.5 flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          {t('Tracked orders', 'Pedidos rastreados')}
        </span>
        <span className="text-[12px] font-bold font-mono tabular-nums text-gray-800">
          {mix.totalOrders.toLocaleString()}
          {!empty && (
            <span className="ml-2 text-[10px] font-medium text-gray-500">
              · {leader.label.toLowerCase()} {t('leads', 'lidera')} {Math.round(leaderShare)}%
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

// ================================================================
// PredictiveRecentWeeks — Predictive's tier-2 surface. Companion to
// the next-7-days rhythm chart above.
//
// The rhythm chart answers "which days will be strong?" — what it
// can't answer is "are we currently in a strong period or a soft
// one?" This card fills that gap: the last four weekly revenue
// totals as calm horizontal bars, with a Rising / Steady /
// Softening trend chip and the 4-week average in the footer band.
//
// Pure roll-up of existing `dailyBuckets` — no new analytics, no
// new server call, no forecast. The card frames itself as context
// for the projection, not as a forecast of next week.
// ================================================================
function PredictiveRecentWeeks({
  weeks,
  lang,
}: {
  weeks: { total: number; startDate: string; endDate: string }[]
  lang: Lang
}) {
  const t = makeT(lang)
  if (weeks.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] mb-3 overflow-hidden">
        <div className="border-b border-gray-100 px-6 py-3">
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
            {t('Recent weekly pace', 'Ritmo semanal reciente')}
          </p>
        </div>
        <p className="px-6 py-8 text-xs text-gray-400 text-center">
          {t('Not enough history yet to show recent weekly pace.', 'Aún no hay suficiente historial para mostrar el ritmo semanal reciente.')}
        </p>
      </div>
    )
  }

  const max = Math.max(...weeks.map((w) => w.total), 1)
  const earliest = weeks[0].total
  const latest = weeks[weeks.length - 1].total
  const avgAll = weeks.reduce((s, w) => s + w.total, 0) / weeks.length

  // Trend classification: latest vs earliest, with a 15% deadband
  // so small wiggles don't read as "trending" anything.
  let trendLabel = t('Steady', 'Estable')
  let trendTone = 'text-gray-700 bg-gray-100'
  if (earliest > 0) {
    const change = (latest - earliest) / earliest
    if (change > 0.15) {
      trendLabel = t('Rising', 'Subiendo')
      trendTone = 'text-green-800 bg-green-50'
    } else if (change < -0.15) {
      trendLabel = t('Softening', 'Suavizando')
      trendTone = 'text-red-700 bg-red-50'
    }
  }

  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] mb-3 overflow-hidden">
      <div className="border-b border-gray-100 px-6 py-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
            {t('Recent weekly pace', 'Ritmo semanal reciente')}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">
            {t('The last four weeks leading into the projected rhythm above.', 'Las últimas cuatro semanas que llevan al ritmo proyectado arriba.')}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full flex-shrink-0 ${trendTone}`}
        >
          {trendLabel}
        </span>
      </div>
      <div className="px-6 py-4 space-y-2.5">
        {weeks.map((w, i) => {
          const isLatest = i === weeks.length - 1
          const pct = (w.total / max) * 100
          return (
            <div key={w.startDate} className="grid grid-cols-[110px_1fr_72px] items-center gap-3">
              <span
                className={`text-[11px] font-mono tabular-nums ${
                  isLatest ? 'text-gray-900 font-semibold' : 'text-gray-500'
                }`}
              >
                {formatWeekLabel(w.startDate, w.endDate, lang)}
              </span>
              <div className="relative h-2.5 bg-gray-50 rounded-full overflow-hidden">
                <div
                  className={`absolute top-0 bottom-0 left-0 rounded-full ${
                    isLatest ? 'bg-indigo-400' : 'bg-gray-300'
                  }`}
                  style={{ width: `${Math.max(pct, 1)}%` }}
                />
              </div>
              <span
                className={`text-[12px] font-bold font-mono tabular-nums text-right ${
                  isLatest ? 'text-gray-900' : 'text-gray-700'
                }`}
              >
                {SHORT_CURRENCY(w.total)}
              </span>
            </div>
          )
        })}
      </div>
      <div className="border-t border-gray-100 bg-gray-50/40 px-6 py-2 flex items-baseline justify-between gap-3 flex-wrap text-[11px]">
        <span className="text-gray-600">
          <span className="text-gray-400 mr-1">{t(`${weeks.length}-week average:`, `Promedio de ${weeks.length} semanas:`)}</span>
          <span className="font-mono tabular-nums font-bold text-gray-800">{SHORT_CURRENCY(avgAll)}</span>
        </span>
        <span className="text-[10px] text-gray-400">
          {t('Context for the projection above — not a forecast of next week.', 'Contexto para la proyección de arriba — no es un pronóstico de la próxima semana.')}
        </span>
      </div>
    </div>
  )
}

// ================================================================
// PredictiveRhythmChart — Predictive's tier-1 surface (the visual
// forward shape). 7-cell day strip where each cell carries a mini
// vertical bar sized to the day's projected revenue relative to
// the strongest projected day. Strongest day picks up an indigo
// highlight; everything else stays neutral.
//
// Pure UI over the existing `next7Outlook` value — no new
// calculation, no new aggregate, no schema change.
// ================================================================
function PredictiveRhythmChart({
  outlook,
  lang,
}: {
  outlook: {
    upcoming: { dayLabel: string; dateLabel: string; projected: number; sampleSize: number }[]
    strongest: { dayLabel: string; dateLabel: string; projected: number; sampleSize: number } | null
    softest: { dayLabel: string; dateLabel: string; projected: number; sampleSize: number } | null
    total: number
  }
  lang: Lang
}) {
  const t = makeT(lang)
  const empty = !outlook.strongest || outlook.total === 0
  const max = outlook.strongest ? outlook.strongest.projected : 0
  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] mb-3 overflow-hidden border-l-2 border-l-indigo-300">
      <div className="border-b border-gray-100 px-6 py-3 bg-indigo-50/30">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-indigo-700">
          {t('Next 7 days rhythm', 'Ritmo de los próximos 7 días')}
        </p>
        <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">
          {t('Day-by-day projected shape based on weekday averages from recent history.', 'Forma proyectada día a día basada en promedios por día de la semana del historial reciente.')}
        </p>
      </div>
      {empty ? (
        <p className="px-6 py-10 text-xs text-gray-400 text-center">
          {t('Not enough weekday history yet to project a day-by-day rhythm.', 'Aún no hay suficiente historial por día de la semana para proyectar un ritmo día a día.')}
        </p>
      ) : (
        <div className="px-6 py-5">
          <div className="grid grid-cols-7 gap-2">
            {outlook.upcoming.map((u, i) => {
              const isStrongest = u.projected === max && u.projected > 0
              const fillPct = max > 0 ? (u.projected / max) * 100 : 0
              return (
                <div
                  key={i}
                  className={`rounded-xl border px-2 pt-2 pb-2 text-center flex flex-col ${
                    isStrongest
                      ? 'border-indigo-200 bg-indigo-50/60'
                      : 'border-gray-100 bg-gray-50/40'
                  }`}
                >
                  <p
                    className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${
                      isStrongest ? 'text-indigo-800' : 'text-gray-500'
                    }`}
                  >
                    {u.dayLabel}
                  </p>
                  <p className="text-[10px] font-mono tabular-nums text-gray-400">
                    {u.dateLabel}
                  </p>
                  {/* Mini bar: vertical fill scaled to strongest day */}
                  <div className="mt-2 mb-1.5 h-12 flex items-end justify-center">
                    {u.projected > 0 ? (
                      <div
                        className={`w-2 rounded-full ${
                          isStrongest ? 'bg-indigo-400' : 'bg-gray-300'
                        }`}
                        style={{ height: `${Math.max(fillPct, 6)}%` }}
                      />
                    ) : (
                      <div className="w-2 h-1 rounded-full bg-gray-200" aria-hidden="true" />
                    )}
                  </div>
                  <p
                    className={`text-[12px] font-bold font-mono tabular-nums ${
                      isStrongest ? 'text-indigo-900' : 'text-gray-700'
                    }`}
                  >
                    {u.projected > 0 ? SHORT_CURRENCY(u.projected) : '—'}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {!empty && (
        <div className="border-t border-gray-100 bg-gray-50/40 px-6 py-2.5 flex items-baseline justify-between gap-3 flex-wrap text-[11px]">
          <div className="flex items-center gap-4">
            {outlook.strongest && (
              <span className="text-gray-600">
                <span className="text-gray-400 mr-1">{t('Strongest:', 'Más fuerte:')}</span>
                <span className="font-semibold text-gray-800">{outlook.strongest.dayLabel}</span>
                <span className="text-gray-400 mx-1">·</span>
                <span className="font-mono tabular-nums font-bold text-indigo-700">
                  {SHORT_CURRENCY(outlook.strongest.projected)}
                </span>
              </span>
            )}
            {outlook.softest &&
              outlook.softest.projected !== outlook.strongest?.projected && (
                <span className="text-gray-600">
                  <span className="text-gray-400 mr-1">{t('Softest:', 'Más suave:')}</span>
                  <span className="font-semibold text-gray-800">{outlook.softest.dayLabel}</span>
                  <span className="text-gray-400 mx-1">·</span>
                  <span className="font-mono tabular-nums font-bold text-gray-700">
                    {SHORT_CURRENCY(outlook.softest.projected)}
                  </span>
                </span>
              )}
          </div>
          <p className="text-[10px] text-gray-400 leading-relaxed">
            {t('Directional read · seasonality, holidays, and one-offs not factored.', 'Lectura direccional · estacionalidad, feriados y eventos únicos no considerados.')}
          </p>
        </div>
      )}
    </div>
  )
}

// ================================================================
// Toggle — same family as the cash/card workflow buttons used in
// POS. Stays restrained to keep with the rest of the system.
// ================================================================
function Toggle({
  label,
  active,
  onClick,
  small,
}: {
  label: string
  active: boolean
  onClick: () => void
  small?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${small ? 'text-[10px] px-2 py-1' : 'text-xs px-3 py-1.5'} font-semibold rounded-lg transition-colors ${
        active ? 'bg-gray-900 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {label}
    </button>
  )
}

// ----------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------

function sum<T>(arr: T[], get: (t: T) => number): number {
  let s = 0
  for (const it of arr) s += get(it)
  return Math.round(s * 100) / 100
}

function pctDelta(current: number, previous: number): number | null {
  if (previous === 0) {
    if (current === 0) return 0
    return null
  }
  return Math.round(((current - previous) / previous) * 100)
}

function deltaText(d: number | null): string {
  if (d === null) return '—'
  if (d === 0) return 'flat'
  return d > 0 ? `+${d}%` : `${d}%`
}

function formatDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Format a "May 4 – May 10" / "May 25 – Jun 1" week range from
// two ISO date keys. Used by PredictiveRecentWeeks to label each
// trailing-week bar.
function formatWeekLabel(startDate: string, endDate: string, lang: Lang = 'en'): string {
  const locale = lang === 'es' ? 'es-ES' : 'en-US'
  const [y1, m1, d1] = startDate.split('-').map(Number)
  const [y2, m2, d2] = endDate.split('-').map(Number)
  const start = new Date(y1, m1 - 1, d1)
  const end = new Date(y2, m2 - 1, d2)
  if (m1 === m2) {
    return `${start.toLocaleDateString(locale, { month: 'short' })} ${d1}–${d2}`
  }
  return `${start.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`
}

