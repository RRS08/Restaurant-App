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

export default function AnalyticsClient({
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

