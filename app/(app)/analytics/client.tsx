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

import { useState, useMemo, useEffect } from 'react'
import { makeT, type Lang } from '@/lib/i18n'

interface DailyBucket {
  date: string
  revenue: number
  orders: number
  /** Local hour (0-23) with the most orders that day. null when
   *  the day has no orders. Powers the "peak 7 PM" tooltip line. */
  peakHour: number | null
  /** Order count in the peak hour. null when the day has no orders. */
  peakHourOrders: number | null
}

interface DailyPaymentBucket {
  date: string
  cash: { revenue: number; orders: number }
  card: { revenue: number; orders: number }
  other: { revenue: number; orders: number }
}

interface DailyCategoryEntry {
  date: string
  categoryId: string
  categoryName: string
  revenue: number
  qty: number
}

interface Props {
  lang: Lang
  dailyBuckets: DailyBucket[]
  dailyPayments: DailyPaymentBucket[]
  dailyCategories: DailyCategoryEntry[]
}

type Metric = 'revenue' | 'orders'

// ================================================================
// AnalyticsClient — 2026-07 Claude Design pass.
//
// Single-page Descriptive surface: header (date + Week/Month
// toggle) + KPI strip, one daily-rhythm bar chart, and two
// composition cards (revenue by category, payment mix). Same
// visual language as the Sales / Staffing / Inventory redesigns.
//
// The prior Diagnostic + Predictive surfaces (driver charts,
// growth decomposition, at-risk inventory, next-week projection)
// were dropped 2026-07-28 per pilot feedback — Descriptive alone
// is the current scope.
//
// Design-vs-data reconciliations:
//   • The mock ships hardcoded DAILY / TODAY / CURRENT_WEEK /
//     BASE / PREV_MONTH fixtures. Every one is computed here from
//     the real dailyBuckets prop.
//   • The design's "closed Mondays" treatment maps onto any past
//     day with revenue === 0. Without a business_hours signal on
//     dailyBuckets, those days render as the design's low stub
//     with copy "No sales" instead of "Closed". A follow-up can
//     join business_hours server-side for the honest label.
//   • Category shares are derived from dailyCategories filtered
//     to the currently-visible done days (top 5, plus an "Other"
//     rollup when there are more). Same for payment mix — both
//     match the exact window the KPIs and chart show.
//   • Historical week / month navigation rewinds composition too:
//     jump to a prior week and the cards recompute against those
//     days. Current-week view is Monday-anchored and builds up as
//     the days accumulate.
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
// [label, weekday, revenue|null, orders|null, isWeekend, peakHour|null, peakHourOrders|null]
type Day = [string, string, number | null, number | null, boolean, number | null, number | null]

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
// Format 0-23 as "12 AM" / "7 PM" style. Spanish gets 24h since
// AM/PM isn't idiomatic there.
function formatHour(hour: number, lang: Lang): string {
  if (lang === 'es') return `${hour}:00`
  if (hour === 0) return '12 AM'
  if (hour < 12) return `${hour} AM`
  if (hour === 12) return '12 PM'
  return `${hour - 12} PM`
}

export default function AnalyticsClient(props: Props) {
  const {
    lang,
    dailyBuckets,
    dailyPayments,
    dailyCategories,
  } = props
  const t = makeT(lang)
  const MONTHS = lang === 'es' ? MONTHS_ES : MONTHS_EN
  const SHORT = lang === 'es' ? SHORT_ES : SHORT_EN

  // ---- Build the design's Monday-anchored DAILY window from real
  // dailyBuckets. Server ships up to WINDOW_DAYS (60) rows ending
  // today. We anchor index 0 to the first Monday in that window
  // so the design's WEEK_START / TODAY math still works. dateKeys
  // is the parallel ISO-key array so composition math can filter
  // dailyPayments / dailyCategories by the visible window.
  const { DAILY, TODAY, CURRENT_WEEK, BASE, dateKeys } = useMemo(() => {
    if (dailyBuckets.length === 0) {
      return { DAILY: [] as Day[], TODAY: 0, CURRENT_WEEK: 0, BASE: new Date(), dateKeys: [] as string[] }
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
        isFuture ? null : b.peakHour,
        isFuture ? null : b.peakHourOrders,
      ]
    })

    const keys = sliced.map((b) => b.date)

    // Server data ends today. Pad forward with null-future days
    // until the visible week is complete (rows ends on a Sunday
    // in Monday-first counting). Without this, mid-week loads
    // deliver 2-3 rows to DAILY.slice(start, start + 7), and the
    // chart's flex distribution stretches the real bars across
    // the empty space instead of leaving future-day placeholders
    // where they belong.
    if (sliced.length > 0) {
      const lastKey = sliced[sliced.length - 1].date
      const lastDate = parseDateKey(lastKey)
      const dowMondayFirst = (lastDate.getDay() + 6) % 7
      const daysUntilSunday = 6 - dowMondayFirst
      for (let i = 1; i <= daysUntilSunday; i++) {
        const d = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate() + i)
        rows.push([shortMonthDay(d, lang), shortWeekdayEN(d), null, null, isWeekendDate(d), null, null])
        keys.push(toDateKey(d))
      }
    }

    let todayIdx = rows.findIndex((_, i) => keys[i] === todayKey)
    if (todayIdx < 0) todayIdx = rows.length - 1
    const currentWeekIdx = todayIdx - ((todayIdx % 7 + 7) % 7)

    return { DAILY: rows, TODAY: todayIdx, CURRENT_WEEK: Math.max(0, currentWeekIdx), BASE: base, dateKeys: keys }
  }, [dailyBuckets, lang])

  // ---- View state ----
  // Week and Month are two independent navigation axes. Week is
  // indexed against DAILY (Monday-anchored); Month tracks a real
  // calendar month so "August" reads as August 1–31, not "last 28
  // days ending Sunday". Switching modes doesn't cross-sync — each
  // mode remembers its own position.
  const [range, setRange] = useState<'week' | 'month'>('week')
  const [metric, setMetric] = useState<Metric>('revenue')
  const [weekStart, setWeekStart] = useState<number>(CURRENT_WEEK)
  const nowRef = new Date()
  const [monthAnchor, setMonthAnchor] = useState<{ y: number; m: number }>(() => ({
    y: nowRef.getFullYear(),
    m: nowRef.getMonth(),
  }))
  const [hover, setHover] = useState<number | null>(null)
  const [calOpen, setCalOpen] = useState(false)
  const [calMonth, setCalMonth] = useState<Date>(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [swipeX, setSwipeX] = useState<number | null>(null)
  const [swipeDX, setSwipeDX] = useState(0)
  const [hoveredPay, setHoveredPay] = useState<'card' | 'other' | 'cash' | null>(null)
  const [hoveredCat, setHoveredCat] = useState<string | null>(null)

  // Bands treatment at all md+ widths — full-bleed header band
  // with an inline stat row, then a padded content region below
  // holding three data cards (chart, category, payment). Phone
  // (<md) keeps the old bordered-card + 3-KPI-grid layout.
  const [isBands, setIsBands] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const update = () => setIsBands(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  const isWeek = range === 'week'
  const isRevenue = metric === 'revenue'

  // Fast lookup from date-key → DAILY row. Month view generates
  // its day range from calendar math and pulls each day's row
  // from here, filling gaps outside the server window with a
  // future/no-data placeholder.
  const daysByKey = useMemo(() => {
    const m = new Map<string, Day>()
    DAILY.forEach((d, i) => m.set(dateKeys[i], d))
    return m
  }, [DAILY, dateKeys])

  // Visible days + their date-keys, mode-aware.
  const { days, visibleKeys } = useMemo(() => {
    if (isWeek) {
      const s = Math.max(0, Math.min(CURRENT_WEEK, weekStart))
      return {
        days: DAILY.slice(s, s + 7),
        visibleKeys: dateKeys.slice(s, s + 7),
      }
    }
    // Month: enumerate each day-of-month (1..lastDay) and pull the
    // row from daysByKey. Days outside the server window (before
    // the fetch cutoff) render as zero-bar "no data" days; days in
    // the future render as null-revenue placeholders.
    const lastDay = new Date(monthAnchor.y, monthAnchor.m + 1, 0)
    const now = new Date()
    const outDays: Day[] = []
    const outKeys: string[] = []
    for (let d = 1; d <= lastDay.getDate(); d++) {
      const day = new Date(monthAnchor.y, monthAnchor.m, d)
      const key = toDateKey(day)
      outKeys.push(key)
      const existing = daysByKey.get(key)
      if (existing) {
        outDays.push(existing)
      } else {
        const isFuture = day.getTime() > now.getTime() && !sameDay(day, now)
        outDays.push([
          shortMonthDay(day, lang),
          shortWeekdayEN(day),
          isFuture ? null : 0,
          isFuture ? null : 0,
          isWeekendDate(day),
          null,
          null,
        ])
      }
    }
    return { days: outDays, visibleKeys: outKeys }
  }, [isWeek, weekStart, monthAnchor, daysByKey, DAILY, dateKeys, CURRENT_WEEK, lang])

  const done = days.filter((d) => d[2] !== null)

  const revenue = sumOn(done, 2)
  const orders = sumOn(done, 3)
  const avgTicket = orders ? revenue / orders : 0
  const tradingDays = done.filter((d) => (d[2] as number) > 0).length

  // Prev-period comparison for the delta chips.
  //
  // Week: prior week's same first-N days as done (aligned days of
  // the week — "Mon–Tue this week" vs "Mon–Tue last week").
  // Month: prior calendar month's same first-N days-of-month as
  // done (Aug 1–2 vs Jul 1–2). This keeps partial current periods
  // from losing to fully-realized prior ones.
  const prevRows = useMemo(() => {
    if (isWeek) {
      const s = Math.max(0, Math.min(CURRENT_WEEK, weekStart))
      const from = Math.max(0, s - 7)
      const to = Math.min(DAILY.length, from + done.length)
      return DAILY.slice(from, to)
    }
    // Prior calendar month, same day-of-month range as done.
    const rows: Day[] = []
    for (let i = 0; i < done.length; i++) {
      const day = new Date(monthAnchor.y, monthAnchor.m - 1, i + 1)
      const key = toDateKey(day)
      const existing = daysByKey.get(key)
      if (existing) rows.push(existing)
    }
    return rows
  }, [isWeek, weekStart, monthAnchor, done.length, daysByKey, DAILY, CURRENT_WEEK])
  const prev = { revenue: sumOn(prevRows, 2), orders: sumOn(prevRows, 3) }
  const prevAvg = prev.orders ? prev.revenue / prev.orders : 0

  // Earliest month present in the fetched window — bounds the
  // month picker so users can't navigate to months with no data.
  const earliestMonth = useMemo(() => {
    if (dateKeys.length === 0) return { y: nowRef.getFullYear(), m: nowRef.getMonth() }
    const first = parseDateKey(dateKeys[0])
    // The earliest FULL month is the first-of-month that's >=
    // dateKeys[0]. If dateKeys[0] falls mid-month, that month's
    // data is partial; still allow it as a valid anchor.
    return { y: first.getFullYear(), m: first.getMonth() }
  }, [dateKeys, nowRef])
  const latestMonth = { y: nowRef.getFullYear(), m: nowRef.getMonth() }

  const shift = (n: number) => {
    if (isWeek) {
      setWeekStart((w) => Math.max(0, Math.min(CURRENT_WEEK, w + n * 7)))
    } else {
      setMonthAnchor((a) => {
        const next = { y: a.y, m: a.m + n }
        // Normalize m to 0..11
        while (next.m < 0) { next.m += 12; next.y -= 1 }
        while (next.m > 11) { next.m -= 12; next.y += 1 }
        // Clamp: not past the current month, not before the earliest.
        if (next.y > latestMonth.y || (next.y === latestMonth.y && next.m > latestMonth.m)) return latestMonth
        if (next.y < earliestMonth.y || (next.y === earliestMonth.y && next.m < earliestMonth.m)) return earliestMonth
        return next
      })
    }
    setCalOpen(false)
    setHover(null)
  }
  // Old name kept for pointer handlers below — they call shiftWeeks
  // but the new implementation dispatches to the mode-aware shift.
  const shiftWeeks = shift

  // ---- Chart scale ----
  const peak = done.length ? Math.max(...done.map((d) => (isRevenue ? d[2] : d[3]) as number)) : 0
  const STEPS = 4
  const ceiling = niceCeiling(peak, STEPS, isRevenue ? REVENUE_UNITS : ORDER_UNITS)
  // Deeper Revenue blue + Orders violet chosen to sit next to the
  // Card indigo / Cash emerald pills in the payment card — same
  // "confident but not shouting" saturation instead of the brighter
  // Google-blue and violet-500 the design first shipped with.
  const barColor = isRevenue ? '#2563EB' : '#6D28D9'
  const ticks = Array.from({ length: STEPS + 1 }, (_, i) => ({
    frac: i / STEPS,
    value: Math.round(ceiling * (i / STEPS)),
  }))

  // ---- Month picker grid (Monday-first, 6 rows) ----
  // In Week mode the highlight band spans the anchored Monday–
  // Sunday range. In Month mode it spans the entire anchored
  // calendar month (may cross the picker's rendered month if the
  // picker is showing a different month).
  const cells = useMemo(() => {
    const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1)
    const gridStart = new Date(first.getFullYear(), first.getMonth(), first.getDate() - ((first.getDay() + 6) % 7))
    const baseTime = BASE.getTime()
    const todayDate = new Date(BASE.getTime() + TODAY * DAY_MS)
    // Precompute window bounds so inWindow is a simple range check.
    let windowFrom = 0, windowTo = -1
    if (isWeek) {
      const s = Math.max(0, Math.min(CURRENT_WEEK, weekStart))
      windowFrom = s
      windowTo = s + 6
    } else {
      const firstOfMonth = new Date(monthAnchor.y, monthAnchor.m, 1)
      const lastOfMonth = new Date(monthAnchor.y, monthAnchor.m + 1, 0)
      windowFrom = Math.round((firstOfMonth.getTime() - baseTime) / DAY_MS)
      windowTo = Math.round((lastOfMonth.getTime() - baseTime) / DAY_MS)
    }
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart.getTime() + i * DAY_MS)
      const idx = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - baseTime) / DAY_MS)
      return {
        d, i, idx,
        inMonth: d.getMonth() === calMonth.getMonth(),
        inWindow: idx >= windowFrom && idx <= windowTo,
        isToday: sameDay(d, todayDate),
        hasData: idx >= 0 && idx < DAILY.length,
      }
    })
  }, [calMonth, isWeek, weekStart, monthAnchor, BASE, TODAY, DAILY.length, CURRENT_WEEK])

  // ---- Composition ----
  // Everything in the two cards is derived from the currently-
  // visible done days so historical navigation rewinds the mix,
  // and the current week/month "builds up" as days accumulate
  // instead of showing a stale rolling snapshot.
  const visibleDoneKeys = useMemo(() => {
    const keys = new Set<string>()
    for (let i = 0; i < days.length; i++) {
      if (days[i][2] !== null) keys.add(visibleKeys[i])
    }
    return keys
  }, [days, visibleKeys])

  // Category rows: sum revenue per category across the visible
  // done days, sort desc, keep top 5, roll the rest into "Other".
  const cats = useMemo(() => {
    if (visibleDoneKeys.size === 0) {
      return [] as Array<{ name: string; pct: number; amount: number }>
    }
    const byCat = new Map<string, { name: string; revenue: number }>()
    for (const e of dailyCategories) {
      if (!visibleDoneKeys.has(e.date)) continue
      const row = byCat.get(e.categoryId) ?? { name: e.categoryName, revenue: 0 }
      row.revenue += e.revenue
      byCat.set(e.categoryId, row)
    }
    const sorted = Array.from(byCat.values()).sort((a, b) => b.revenue - a.revenue)
    const total = sorted.reduce((s, c) => s + c.revenue, 0)
    if (total <= 0) return []
    const top = sorted.slice(0, 5)
    const rest = sorted.slice(5)
    const restRev = rest.reduce((s, c) => s + c.revenue, 0)
    const rows = top.map((c) => ({
      name: c.name,
      pct: Math.round((c.revenue / total) * 100),
      amount: Math.round(c.revenue * 100) / 100,
    }))
    if (restRev > 0) {
      rows.push({
        name: t('Other', 'Otros'),
        pct: Math.round((restRev / total) * 100),
        amount: Math.round(restRev * 100) / 100,
      })
    }
    return rows
  }, [visibleDoneKeys, dailyCategories, t])

  // Payment rows: fixed Card / Other / Cash order, matching the
  // sales-ledger convention. Sums pulled from dailyPayments over
  // the visible done days.
  const paySums = useMemo(() => {
    const acc = { cash: { revenue: 0, orders: 0 }, card: { revenue: 0, orders: 0 }, other: { revenue: 0, orders: 0 } }
    for (const p of dailyPayments) {
      if (!visibleDoneKeys.has(p.date)) continue
      for (const k of ['cash', 'card', 'other'] as const) {
        acc[k].revenue += p[k].revenue
        acc[k].orders += p[k].orders
      }
    }
    return acc
  }, [visibleDoneKeys, dailyPayments])
  const payTotalOrders = paySums.card.orders + paySums.other.orders + paySums.cash.orders

  // Card subtitles echo the exact done-day range so the composition
  // cards obviously match the chart / KPIs. Current partial week
  // appends "so far" so the "builds up as the week fills" behavior
  // is legible instead of surprising.
  const hasFutureInWindow = days.some((d) => d[2] === null)
  const windowSubtitle = done.length === 0
    ? t('no days recorded yet', 'sin días registrados aún')
    : `${done[0][0]} – ${done[done.length - 1][0]}${hasFutureInWindow ? ` · ${t('so far', 'hasta ahora')}` : ''}`

  const pays = useMemo(() => {
    const rows: Array<{
      key: 'card' | 'other' | 'cash'
      name: string
      count: number
      rev: number
      pct: number
      style: typeof PAYMENT_STYLE[keyof typeof PAYMENT_STYLE]
    }> = [
      { key: 'card',  name: t('Card', 'Tarjeta'),  count: paySums.card.orders,  rev: paySums.card.revenue,  pct: 0, style: PAYMENT_STYLE.card  },
      { key: 'other', name: t('Other', 'Otros'),   count: paySums.other.orders, rev: paySums.other.revenue, pct: 0, style: PAYMENT_STYLE.other },
      { key: 'cash',  name: t('Cash', 'Efectivo'), count: paySums.cash.orders,  rev: paySums.cash.revenue,  pct: 0, style: PAYMENT_STYLE.cash  },
    ]
    const total = rows.reduce((s, r) => s + r.count, 0)
    if (total > 0) for (const r of rows) r.pct = Math.round((r.count / total) * 100)
    return rows
  }, [paySums, t])
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

  // Header label: Week shows the visible range; Month shows the
  // full month name so navigation reads "July → August" instead
  // of "Jul 1–Jul 31 → Aug 1–Aug 31".
  const headerDateLabel = !days.length
    ? ''
    : isWeek
    ? `${days[0][0]} — ${days[days.length - 1][0]}, ${BASE.getFullYear()}`
    : `${MONTHS[monthAnchor.m]} ${monthAnchor.y}`

  // Bands header date copy — "Week of" prefix + full date incl.
  // year for the week view. Uses Sales' fmtBusinessDateLong
  // shape (weekday + long month + day) + explicit year appended
  // so the phrase is self-anchored no matter how far back the
  // manager has navigated.
  //   Week  → "Week of Monday, July 27, 2026"
  //   Month → "July 2026"
  const bandsDateLocale = lang === 'es' ? 'es-ES' : 'en-US'
  const bandsDateLabel = ((): string => {
    if (!days.length) return ''
    if (isWeek) {
      const mondayIdx = Math.max(0, Math.min(CURRENT_WEEK, weekStart))
      const monday = new Date(BASE.getTime() + mondayIdx * DAY_MS)
      const dateStr = monday.toLocaleDateString(bandsDateLocale, {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      })
      return `${t('Week of', 'Semana del')} ${dateStr}`
    }
    return `${MONTHS[monthAnchor.m]} ${monthAnchor.y}`
  })()

  // "This week / Past week / This month / Past month" pill next
  // to the date. Signals whether historical navigation is active.
  const isCurrent = isWeek
    ? Math.max(0, Math.min(CURRENT_WEEK, weekStart)) === CURRENT_WEEK
    : monthAnchor.y === nowRef.getFullYear() && monthAnchor.m === nowRef.getMonth()
  const rangeChipLabel = isCurrent
    ? isWeek ? t('This week', 'Esta semana') : t('This month', 'Este mes')
    : isWeek ? t('Past week', 'Semana pasada') : t('Past month', 'Mes pasado')

  // Header row body used by BOTH the bands and cards render
  // paths. Extracted so the swipe handler + date button + Week/
  // Month toggle stay in one place regardless of whether the
  // wrapper around them is a bordered card or a full-bleed band.
  const headerRow = (
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
        position: 'relative',
        padding: isBands ? '16px 24px 15px' : '16px 16px 14px',
        display: 'flex',
        // Bands: top-align because the left column has TWO stacked
        // rows (title + stat line); the toggle needs align-self to
        // vertically center against both. Cards: single row.
        alignItems: isBands ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: 24, flexWrap: 'wrap',
        touchAction: 'pan-y', cursor: swipeX === null ? 'default' : 'grabbing',
        transform: `translateX(${swipeDX / 6}px)`,
      }}
    >
      {/* Left column — title row + stat row (bands). Cards mode
          just renders the title button here and puts KPIs below. */}
      <div style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
          <button
            type="button"
            onClick={() => setCalOpen((v) => !v)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, border: '1px solid transparent', background: 'transparent', borderRadius: 9, padding: '2px 8px', marginLeft: -8, font: 'inherit', color: INK, cursor: 'pointer' }}
          >
            <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.035em', whiteSpace: 'nowrap' }}>
              {isBands ? bandsDateLabel : headerDateLabel}
            </span>
            <span style={{ fontSize: 10, color: FAINT }}>▾</span>
          </button>
          {isBands && (
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', borderRadius: 999,
                padding: '3px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                background: isCurrent ? FILL : '#EFF6FF',
                color: isCurrent ? MUTED : '#2563EB',
              }}
            >
              {rangeChipLabel}
            </span>
          )}
        </div>

        {/* Stat row — bands only. Hero total + USD + revenue
            delta, then orders + avg-ticket trailing stats with
            their own deltas. Deltas are plain colored text (not
            pills) so the line reads as one continuous statement. */}
        {isBands && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: MONO, fontSize: 30, fontWeight: 600, letterSpacing: '-0.045em', lineHeight: 1 }}>
              {money(revenue)}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>USD</span>
            <Delta pct={pctChange(revenue, prev.revenue)} />
            <StatSep />
            <StatCell value={String(orders)} label={t('orders', 'órdenes')} delta={pctChange(orders, prev.orders)} />
            <StatSep />
            <StatCell value={money(avgTicket)} label={t('avg ticket', 'ticket promedio')} delta={pctChange(avgTicket, prevAvg)} />
          </div>
        )}
      </div>

      {/* Week/Month toggle — align-self:center on bands so it
          centers against BOTH the title and stat rows in the
          left column. */}
      <div
        style={{
          display: 'flex', alignItems: 'center', background: FILL,
          borderRadius: 10, padding: 3, gap: 2,
          alignSelf: isBands ? 'center' : undefined,
          flex: '0 0 auto',
        }}
      >
        <button type="button" style={seg(isWeek)} onClick={() => { setRange('week'); setHover(null) }}>{t('Week', 'Semana')}</button>
        <button
          type="button"
          style={seg(!isWeek)}
          onClick={() => {
            setRange('month')
            setHover(null)
            // Land on the current calendar month by default so
            // switching modes lands the user on "now" instead of
            // whatever historical month they last inspected.
            setMonthAnchor({ y: nowRef.getFullYear(), m: nowRef.getMonth() })
          }}
        >
          {t('Month', 'Mes')}
        </button>
      </div>
    </div>
  )

  return (
    <div
      style={{
        flex: 1, minWidth: 0,
        // Bands: no page padding — AppShell already zeros main at
        // md+, so bands touch the viewport edges. Cards: the old
        // 20/24/28 padding sits around the bordered card.
        padding: isBands ? 0 : '20px 24px 28px',
        background: '#fff', fontFamily: "'Geist', system-ui, sans-serif", color: INK,
      }}
    >

      {/* ---- header ----
          Bands: full-bleed with a hairline bottom, positioning
          context for the picker.
          Cards: bordered card with rounded corners. */}
      <div
        style={{
          position: 'relative',
          border: isBands ? 0 : `1px solid ${LINE}`,
          borderRadius: isBands ? 0 : 12,
          borderBottom: isBands ? `1px solid ${LINE}` : undefined,
          background: '#fff',
          marginBottom: isBands ? 0 : 14,
        }}
      >
        {headerRow}

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
                      if (isWeek) {
                        const monday = idx - (((idx % 7) + 7) % 7)
                        setWeekStart(Math.max(0, Math.min(CURRENT_WEEK, monday)))
                      } else {
                        // Jump to the calendar month containing the
                        // clicked date, clamped to the fetch window.
                        let next = { y: d.getFullYear(), m: d.getMonth() }
                        if (next.y > latestMonth.y || (next.y === latestMonth.y && next.m > latestMonth.m)) next = latestMonth
                        if (next.y < earliestMonth.y || (next.y === earliestMonth.y && next.m < earliestMonth.m)) next = earliestMonth
                        setMonthAnchor(next)
                      }
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
                  {isWeek ? t('Pick a date to jump to its week', 'Elige una fecha para ir a su semana') : t('Pick a date to jump to its month', 'Elige una fecha para ir a su mes')}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (isWeek) setWeekStart(CURRENT_WEEK)
                    else setMonthAnchor({ y: nowRef.getFullYear(), m: nowRef.getMonth() })
                    setCalOpen(false)
                    setCalMonth(new Date(nowRef.getFullYear(), nowRef.getMonth(), 1))
                    setHover(null)
                  }}
                  style={{ border: 0, background: 'transparent', padding: 0, font: 'inherit', fontSize: 12, fontWeight: 500, color: '#2563EB', cursor: 'pointer' }}
                >
                  {t('This week', 'Esta semana')}
                </button>
              </div>
            </div>
          </>
        )}

        {/* KPI 3-column grid — cards mode only. Bands mode has
            the inline stat row inside the header already. */}
        {!isBands && (
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
        )}
      </div>

      {/* ---- content region ----
          Bands: 16/24/24 padded region wraps chart + composition
          grid so all three cards share the same 24px inset as
          the header band's inner content — one vertical rail
          runs through the whole page. Cards: no wrapper. */}
      <div
        style={{
          padding: isBands ? '16px 24px 24px' : 0,
          display: isBands ? 'flex' : 'block',
          flexDirection: isBands ? 'column' : undefined,
          gap: isBands ? 16 : undefined,
        }}
      >

      {/* ---- daily rhythm ---- */}
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', marginBottom: isBands ? 0 : 14 }}>
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
          <div style={{ width: 44, flex: '0 0 44px', height: isBands ? 152 : 190, position: 'relative' }}>
            {ticks.map((tk) => (
              <span key={tk.frac} style={{ position: 'absolute', right: 0, bottom: `${tk.frac * 100}%`, transform: 'translateY(50%)', fontFamily: MONO, fontSize: 9, color: FAINT }}>
                {isRevenue && tk.value >= 1000 ? `${tk.value / 1000}k` : tk.value}
              </span>
            ))}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ position: 'relative', height: isBands ? 152 : 190 }}>
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
                      ? t("this day hasn't happened yet", 'este día aún no ha ocurrido')
                      : hv[2] === 0
                      ? t('closed or slow', 'cerrado o lento')
                      : isRevenue
                      ? `${money((hv[2] as number) / (hv[3] as number))} ${t('avg ticket', 'ticket promedio')}`
                      : hv[5] !== null && hv[6] !== null
                      ? `${t('peak', 'pico')} ${formatHour(hv[5], lang)} · ${hv[6]} ${hv[6] === 1 ? t('order', 'orden') : t('orders', 'órdenes')}`
                      : `${hv[3]} ${t('orders total', 'órdenes en total')}`}
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 3, marginTop: 8 }}>
              {days.map((d, i) => {
                const weekBreak = !isWeek && i > 0 && d[1] === 'Mon'
                // isToday check: position-based, no date-string math.
                // Week: index into DAILY, compare against TODAY index.
                // Month: day-of-month at position i is i+1, and we're
                // today only if the anchored (year, month) is right now.
                const isToday = isWeek
                  ? Math.max(0, Math.min(CURRENT_WEEK, weekStart)) + i === TODAY
                  : monthAnchor.y === nowRef.getFullYear()
                    && monthAnchor.m === nowRef.getMonth()
                    && i + 1 === nowRef.getDate()
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
          subtitle={`${t('Share of tracked revenue by category', 'Participación de los ingresos por categoría')} · ${windowSubtitle}`}
          footLeft={cats.length
            ? `${cats[0].name} ${t('carry', 'lleva')} ${cats[0].pct}% ${t('of revenue', 'de los ingresos')}`
            : t('No category revenue in this window.', 'Sin ingresos por categoría en esta ventana.')}
          footRight={`${shortMoney(cats.reduce((s, c) => s + c.amount, 0))} ${t('tracked', 'rastreado')}`}
        >
          {cats.length === 0 ? (
            <div style={{ padding: '18px 0', fontSize: 12, color: FAINT, textAlign: 'center' }}>
              {t('Categories fill in as sales come through.', 'Las categorías se llenan a medida que llegan las ventas.')}
            </div>
          ) : cats.map((c, i) => {
            const isHov = hoveredCat === c.name
            // Leader (top by revenue) gets ink; the rest shade
            // down so the eye lands on the carrying category first.
            // cats is already sorted revenue-desc.
            const barColor = i === 0 ? INK : '#C4C4C7'
            // Anchor tooltip near the fill's right edge, clamped so
            // near-zero bars still get a readable position and near-
            // full bars don't overflow the card. Same edge-safe
            // pattern as the payment-bar tooltip.
            const anchorPct = Math.min(Math.max(c.pct, 4), 96)
            const clampedTx = c.pct < 12 ? '-4px' : c.pct > 88 ? '-100%' : '-50%'
            return (
              <div
                key={c.name}
                onMouseEnter={() => setHoveredCat(c.name)}
                onMouseLeave={() => setHoveredCat((cur) => (cur === c.name ? null : cur))}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', cursor: 'default' }}
              >
                <span style={{ width: 150, flex: '0 0 150px', minWidth: 0, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                <span style={{ position: 'relative', flexGrow: 1, flexShrink: 1, flexBasis: '0%', minWidth: 0, height: 8, borderRadius: 999, background: LINE_SOFT }}>
                  <span style={{ display: 'block', width: `${c.pct}%`, height: '100%', borderRadius: 999, background: barColor }} />
                  {isHov && (
                    <div
                      style={{
                        position: 'absolute', bottom: 14, left: `${anchorPct}%`,
                        transform: `translateX(${clampedTx})`,
                        zIndex: 3, pointerEvents: 'none',
                        border: `1px solid ${LINE}`, borderRadius: 10, background: '#fff',
                        boxShadow: '0 8px 24px rgba(24,24,27,0.12)', padding: '7px 10px', whiteSpace: 'nowrap',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: barColor }} />
                        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '-0.01em' }}>{c.name}</span>
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 1 }}>
                        {money(c.amount)}
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, marginTop: 1 }}>
                        {c.pct}% {t('of tracked revenue', 'de los ingresos rastreados')}
                      </div>
                    </div>
                  )}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, minWidth: 38, textAlign: 'right' }}>{c.pct}%</span>
              </div>
            )
          })}
        </AnalyticsCard>

        <AnalyticsCard
          title={t('How guests paid', 'Cómo pagaron los clientes')}
          subtitle={`${t('Share of orders by payment method', 'Participación de órdenes por método de pago')} · ${windowSubtitle}`}
          footLeft={payTotalOrders
            ? `${leader.name} ${t('leads at', 'lidera con')} ${leader.pct}% ${t('of orders', 'de las órdenes')}`
            : t('No payment mix yet.', 'Sin mezcla de pagos aún.')}
          footRight={`${payTotalOrders} ${t('orders', 'órdenes')}`}
        >
          {payTotalOrders === 0 ? (
            <div style={{ padding: '18px 0', fontSize: 12, color: FAINT, textAlign: 'center' }}>
              {t('Payment method breakdown appears as orders come in.', 'El desglose por método de pago aparece cuando entran las órdenes.')}
            </div>
          ) : (
            <>
              {/* Stacked segment bar. Each segment reveals its
                  method's total revenue on hover — the size hints
                  at "how much" but the dollars underneath make it
                  precise. Tooltip anchors to the segment's own
                  center via cumulative-percentage math. */}
              <div style={{ position: 'relative', marginBottom: 16 }}>
                {hoveredPay && (() => {
                  const visible = pays.filter((p) => p.pct > 0)
                  let cum = 0
                  for (const p of visible) {
                    if (p.key === hoveredPay) {
                      const center = cum + p.pct / 2
                      const clampedTx = center < 12 ? '-4px' : center > 88 ? '-100%' : '-50%'
                      return (
                        <div
                          key="tt"
                          style={{
                            position: 'absolute', bottom: 18, left: `${center}%`,
                            transform: `translateX(${clampedTx})`,
                            zIndex: 3, pointerEvents: 'none',
                            border: `1px solid ${LINE}`, borderRadius: 10, background: '#fff',
                            boxShadow: '0 8px 24px rgba(24,24,27,0.12)', padding: '7px 10px', whiteSpace: 'nowrap',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: p.style.dot }} />
                            <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '-0.01em' }}>{p.name}</span>
                          </div>
                          <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 1 }}>
                            {money(p.rev)}
                          </div>
                          <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, marginTop: 1 }}>
                            {p.count} {p.count === 1 ? t('order', 'orden') : t('orders', 'órdenes')} · {p.pct}%
                          </div>
                        </div>
                      )
                    }
                    cum += p.pct
                  }
                  return null
                })()}
                <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', gap: 2 }}>
                  {pays.filter((p) => p.pct > 0).map((p) => (
                    <span
                      key={p.key}
                      onMouseEnter={() => setHoveredPay(p.key)}
                      onMouseLeave={() => setHoveredPay((cur) => (cur === p.key ? null : cur))}
                      title={`${p.name}: ${money(p.rev)}`}
                      style={{ display: 'block', width: `${p.pct}%`, height: '100%', borderRadius: 999, background: p.style.dot, cursor: 'default' }}
                    />
                  ))}
                </div>
              </div>
              {pays.filter((p) => p.count > 0).map((p) => (
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
                    {`${money(p.rev / p.count)} ${t('avg', 'prom')}`}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, minWidth: 42, textAlign: 'right' }}>{p.pct}%</span>
                </div>
              ))}
            </>
          )}
        </AnalyticsCard>
      </div>

      </div>{/* /content region */}
    </div>
  )
}

// ---- Small building blocks scoped to the new AnalyticsClient ----

// Plain colored delta text — never a pill. Kept flat so the
// header's stat line reads as one continuous statement instead
// of "a value + a badge". A rounded-to-zero move reads as the
// word "flat" in muted grey, never a green ↑ 0%.
function Delta({ pct, size = 12 }: { pct: number; size?: number }) {
  const color = pct === 0 ? FAINT : pct > 0 ? '#047857' : '#B91C1C'
  return (
    <span style={{ fontFamily: MONO, fontSize: size, fontWeight: 600, color }}>
      {pct === 0 ? 'flat' : `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}%`}
    </span>
  )
}
// Tiny dot separator between trailing stats in the header row.
function StatSep() {
  return <span style={{ width: 3, height: 3, borderRadius: '50%', background: GHOST, alignSelf: 'center' }} />
}
// A trailing stat cell — value + label + delta, matched to the
// design's typography scale (14/600 value, 12 label, 11 delta).
function StatCell({ value, label, delta }: { value: string; label: string; delta: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600 }}>{value}</span>
      <span style={{ fontSize: 12, color: MUTED }}>{label}</span>
      <Delta pct={delta} size={11} />
    </span>
  )
}

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
