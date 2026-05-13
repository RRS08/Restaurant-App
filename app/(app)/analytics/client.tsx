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
const MODES: {
  id: Mode
  eyebrow: string
  label: string
  title: string
  sub: string
}[] = [
  {
    id: 'descriptive',
    eyebrow: '01',
    label: 'Descriptive',
    title: 'What happened',
    sub: 'Orientation only. The numbers in plain form for the chosen comparison window.',
  },
  {
    id: 'diagnostic',
    eyebrow: '02',
    label: 'Diagnostic',
    title: 'Why it happened',
    sub: 'Drivers beneath the headline. Each block surfaces only when the underlying pattern is real.',
  },
  {
    id: 'predictive',
    eyebrow: '03 →',
    label: 'Predictive',
    title: "What's likely next",
    sub: 'Restrained continuation signals. Not recommendations — just where the current direction points if conditions hold.',
  },
]

const CURRENCY = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const SHORT_CURRENCY = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`

export default function AnalyticsClient({
  dailyBuckets,
  itemAggregates,
  categoryAggregates,
  categoryMix7d,
  categoryMix30d,
  paymentMix7d,
  paymentMix30d,
  atRiskInventory,
}: Props) {
  const [win, setWin] = useState<Window>('30d')
  const [metric, setMetric] = useState<Metric>('revenue')
  // Default mode is Diagnostic — that's where Analytics earns its
  // keep. Landing on Descriptive would feel like a report. Landing
  // on Diagnostic immediately frames the page as an analyst.
  const [mode, setMode] = useState<Mode>('diagnostic')
  const activeMode = MODES.find((m) => m.id === mode) ?? MODES[1]

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

  // ---- Diagnostic 1: growth decomposition ----
  // Decompose the headline revenue move into orders × ticket-size.
  // Volume-led means orders moved more than ticket size; ticket-led
  // is the reverse. Both can coexist with a flat or down headline.
  const growthDecomp = useMemo(
    () => buildGrowthDecomp(revDelta, ordDelta, ticketDelta),
    [revDelta, ordDelta, ticketDelta],
  )

  // ---- Diagnostic 2: category carry ----
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

  // ---- Diagnostic 3: mix shift (avg item price) ----
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

  // ---- Predictive 1: 7-day pace projection ----
  // The lead surface for Predictive. We add prior-7-days revenue
  // so the lead can show a delta vs the previous week — gives the
  // pace number meaningful context as a continuation read rather
  // than a number floating without a frame of reference.
  const last7 = dailyBuckets.slice(-7)
  const prior7 = dailyBuckets.slice(-14, -7)
  const last7Revenue = sum(last7, (d) => d.revenue)
  const last7Orders = sum(last7, (d) => d.orders)
  const prior7Revenue = sum(prior7, (d) => d.revenue)
  const paceDelta = pctDelta(last7Revenue, prior7Revenue)

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

  // ---- Predictive 4: next-7-days outlook ----
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

  // ---- Predictive 3: near-term continuation ----
  // Items with material, directionally-clear movement that's worth
  // calling out as likely to keep moving the same way. Built on the
  // same itemAggregates the diagnostic blocks use — we just lean
  // into the higher-confidence (high absolute, clear delta) rows.
  const continuation = useMemo(() => {
    const enriched = itemAggregates
      .filter((i) => i.previousRevenue >= 50 || i.currentRevenue >= 50)
      .map((i) => ({
        ...i,
        revenueDelta: pctDelta(i.currentRevenue, i.previousRevenue),
      }))
      .filter((i) => i.revenueDelta !== null && Math.abs(i.revenueDelta) >= 15)
    const holding = enriched
      .filter((i) => (i.revenueDelta ?? 0) > 0)
      .sort((a, b) => b.currentRevenue - a.currentRevenue)
      .slice(0, 3)
    const weak = enriched
      .filter((i) => (i.revenueDelta ?? 0) < 0)
      .sort((a, b) => b.previousRevenue - a.previousRevenue)
      .slice(0, 3)
    return { holding, weak }
  }, [itemAggregates])

  return (
    <div className="max-w-[1400px]">
      {/* ---- HEADER ----
          Identity-only header. The comparison window moved down to
          sit beside the mode switch so it reads as a control for the
          analytical workspace, not detached page chrome. */}
      <div className="mb-8 pb-5 border-b border-gray-100">
        <h1 className="text-2xl font-bold text-gray-900 leading-tight">Analytics</h1>
        <p className="mt-1.5 text-sm text-gray-500 leading-relaxed max-w-2xl">
          The in-product analyst.{' '}
          <span className="text-gray-400">
            Patterns, drivers, and what&apos;s likely next — across orders, items,
            and categories.
          </span>
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
          aria-label="Analytics mode"
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
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            Comparison window
          </p>
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
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
          <DescriptiveStat
            label="Revenue"
            value={CURRENCY(currentRevenue)}
            delta={revDelta}
            hint={`vs previous ${size} days`}
          />
          <DescriptiveStat
            label="Orders"
            value={currentOrders.toLocaleString()}
            delta={ordDelta}
            hint={`vs previous ${size} days`}
          />
          <DescriptiveStat
            label="Avg ticket"
            value={CURRENCY(ticketCurrent)}
            delta={ticketDelta}
            hint={`vs previous ${size} days`}
          />
        </div>

        <div className="border-t border-gray-100 bg-gray-50/40 px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            Daily rhythm
          </p>
          <div className="inline-flex items-center gap-0.5 rounded-lg bg-white border border-gray-200 p-0.5">
            <Toggle
              label="Revenue"
              active={metric === 'revenue'}
              onClick={() => setMetric('revenue')}
              small
            />
            <Toggle
              label="Orders"
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
        <SupportEyebrow>Composition</SupportEyebrow>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <CategoryMixSnapshot rows={topCategoryMix.rows} total={topCategoryMix.total} size={size} />
          <PaymentMixSnapshot mix={activePaymentMix} size={size} />
        </div>
        </>
      )}

      {/* ============ DIAGNOSTIC CONTENT ============ */}
      {mode === 'diagnostic' && (
        <>
          {/* Lead surface — Growth decomposition reads as the
              primary driver explanation, with a richer header,
              bigger headline, and three driver cells (revenue,
              orders, avg ticket) prominent in the footer band. */}
          <LeadGrowthDecomposition
            verdict={growthDecomp.verdict}
            headline={growthDecomp.headline}
            revDelta={revDelta}
            ordDelta={ordDelta}
            ticketDelta={ticketDelta}
          />

          <SupportEyebrow>Supporting signals</SupportEyebrow>

          {/* 2b · Category carry — category (violet) identity */}
          <SignalBlockMulti
            title="Category carry"
            tone="category"
            subtitle="Categories where one item provides most of the revenue. Fragile by construction — the rest of the lineup is doing less than it looks."
            empty="No category leans on a single item right now. Revenue is spread across the lineup."
            items={categoryCarry.map((c) => ({
              key: c.categoryId,
              headline: `${c.categoryName}: ${c.topItemName} carries ${c.topItemShare}% of revenue.`,
              detail: `Rest of category: ${SHORT_CURRENCY(c.restPrevious)} → ${SHORT_CURRENCY(c.restRevenue)} (${deltaText(c.restDelta)}).`,
              tone: c.restDelta !== null && c.restDelta < 0 ? 'warn' : 'neutral',
            }))}
          />

          {/* 2c · Mix shift — mix (orange) identity. Now carries
              the full "subtle under-the-surface change" role: a
              composition shift in what guests are buying that
              revenue and ticket-size alone won't reveal. Lower
              trigger threshold (6%) widens the signal so subtler
              moves still surface. */}
          {mixShiftMaterial && (
            <SignalBlock
              title="Mix shift"
              tone="mix"
              verdict={(mixShift.delta ?? 0) < 0 ? 'Cheaper mix' : 'Pricier mix'}
              headline={`Average item price moved ${CURRENCY(mixShift.prevAvg)} → ${CURRENCY(mixShift.curAvg)} (${deltaText(mixShift.delta)}). A subtle composition shift beneath the surface — guests are buying ${
                (mixShift.delta ?? 0) < 0 ? 'lower' : 'higher'
              }-priced items independent of how many items per order. Easy to miss if only watching revenue and ticket size.`}
              evidence={[
                { label: 'Previous avg', value: CURRENCY(mixShift.prevAvg) },
                { label: 'Current avg', value: CURRENCY(mixShift.curAvg) },
              ]}
            />
          )}
        </>
      )}

      {/* ============ PREDICTIVE CONTENT ============
          Compact lead + supporting layout:
            • Lead — Weekly rhythm: pace projection + the upcoming
              week's day-by-day rhythm in a single anchored panel
              with indigo accents.
            • Supporting — At-risk stock pressure (cross-pillar) and
              Near-term demand continuation (item-level direction).
          Category momentum and the separate pace tile were removed
          to keep Predictive compact and to make the lead clearly
          dominant. */}
      {mode === 'predictive' && (
        <>
          {/* Lead surface — weekly rhythm with embedded pace */}
          <LeadWeeklyRhythm
            outlook={next7Outlook}
            last7Revenue={last7Revenue}
            last7Orders={last7Orders}
            prior7Revenue={prior7Revenue}
            paceDelta={paceDelta}
          />

          <SupportEyebrow>Supporting forward signals</SupportEyebrow>

          <AtRiskStockPressure items={atRiskInventory} />
          <NearTermContinuation holding={continuation.holding} weak={continuation.weak} />
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
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
        {label}
      </p>
      <div className="mt-1.5 flex items-baseline gap-2">
        <p className="text-xl font-bold tabular-nums text-gray-900 truncate">{value}</p>
        <span className={`text-[11px] font-bold tabular-nums ${deltaTone}`}>
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
      className={`rounded-xl border border-gray-200 bg-white mb-3 overflow-hidden ${t.accent}`}
    >
      <div
        className={`border-b border-gray-100 px-5 py-2.5 flex items-center justify-between gap-2 ${t.headerTint}`}
      >
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
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
                <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                  {e.label}
                </p>
                <p className="mt-0.5 text-sm font-bold text-gray-900 tabular-nums">
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
// LeadGrowthDecomposition — the diagnostic mode's lead surface.
// Same `info` (blue) identity as the previous Growth decomposition
// SignalBlock, but structurally richer: three bands (header /
// headline body / driver footer), bigger headline, three driver
// cells (Revenue / Orders / Avg ticket) prominent in the footer.
// The "Primary driver" eyebrow tag is the explicit lead/support
// signal that makes the layout grammar visible.
// ================================================================
function LeadGrowthDecomposition({
  verdict,
  headline,
  revDelta,
  ordDelta,
  ticketDelta,
}: {
  verdict: string
  headline: string
  revDelta: number | null
  ordDelta: number | null
  ticketDelta: number | null
}) {
  const t = SIGNAL_TONE.info
  return (
    <div
      className={`rounded-xl border border-gray-200 bg-white mb-3 overflow-hidden ${t.accent}`}
    >
      <div
        className={`border-b border-gray-100 px-6 py-3 flex items-start justify-between gap-3 ${t.headerTint}`}
      >
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            Primary driver · Growth decomposition
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">
            The lead explanation of why the headline number moved.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full flex-shrink-0 ${t.pillBg}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden="true" />
          {verdict}
        </span>
      </div>
      <div className="px-6 py-5">
        <p className="text-[17px] font-semibold text-gray-900 leading-relaxed max-w-3xl">
          {headline}
        </p>
      </div>
      <div className="border-t border-gray-100 bg-gray-50/40 grid grid-cols-3 divide-x divide-gray-100">
        <DriverCell label="Revenue" value={deltaText(revDelta)} />
        <DriverCell label="Orders" value={deltaText(ordDelta)} />
        <DriverCell label="Avg ticket" value={deltaText(ticketDelta)} />
      </div>
    </div>
  )
}

// Small footer cell used by LeadGrowthDecomposition — three side
// by side, divided. Matches the descriptive panel's inline-stat
// cell language so the family stays consistent.
function DriverCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-5 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-bold tabular-nums text-gray-900">{value}</p>
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
      className={`rounded-xl border border-gray-200 bg-white mb-3 overflow-hidden ${t.accent}`}
    >
      <div className={`border-b border-gray-100 px-5 py-3 ${t.headerTint}`}>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
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
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
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
}: {
  rows: { id: string; name: string; revenue: number; share: number }[]
  total: number
  size: number
}) {
  const topShare = rows[0]?.share ?? 0
  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden flex flex-col">
      <div className="border-b border-gray-100 px-5 py-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            Category mix
          </p>
          <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
            Top categories by revenue share.
          </p>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full whitespace-nowrap">
          Last {size}d
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="flex-1 px-5 py-8 text-xs text-gray-400 text-center">
          No category revenue in this window yet.
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
                  <span className="text-gray-900 font-bold tabular-nums flex-shrink-0">
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
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
          Tracked total
        </span>
        <span className="text-[12px] font-bold tabular-nums text-gray-800">
          ${total.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          {topShare > 0 && (
            <span className="ml-2 text-[10px] font-medium text-gray-500">
              · leader {Math.round(topShare * 100)}%
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
}: {
  mix: {
    cash: { revenue: number; orders: number }
    card: { revenue: number; orders: number }
    other: { revenue: number; orders: number }
    totalRevenue: number
    totalOrders: number
  }
  size: number
}) {
  const buckets = [
    { key: 'card' as const, label: 'Card', tone: 'bg-purple-400' },
    { key: 'cash' as const, label: 'Cash', tone: 'bg-orange-400' },
    { key: 'other' as const, label: 'Other', tone: 'bg-gray-300' },
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
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden flex flex-col">
      <div className="border-b border-gray-100 px-5 py-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            Payment mix
          </p>
          <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
            How guests paid — composition of revenue.
          </p>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full whitespace-nowrap">
          Last {size}d
        </span>
      </div>
      {empty ? (
        <p className="flex-1 px-5 py-8 text-xs text-gray-400 text-center">
          No payments in this window yet.
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
                    <span className="text-[10px] text-gray-400 tabular-nums truncate">
                      {orders} {orders === 1 ? 'order' : 'orders'}
                    </span>
                  </span>
                  <span className="text-gray-900 font-bold tabular-nums flex-shrink-0">
                    {pct}%
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <div className="border-t border-gray-100 bg-gray-50/40 px-5 py-2.5 flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
          Tracked orders
        </span>
        <span className="text-[12px] font-bold tabular-nums text-gray-800">
          {mix.totalOrders.toLocaleString()}
          {!empty && (
            <span className="ml-2 text-[10px] font-medium text-gray-500">
              · {leader.label.toLowerCase()} leads {Math.round(leaderShare)}%
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

// ================================================================
// AtRiskStockPressure — predictive cross-pillar continuation.
// Surfaces inventory items whose current stock + 30-day consumption
// rate suggests near-term (< 14d) supply pressure. Frames the
// reading as continuation, not advice.
// ================================================================
function AtRiskStockPressure({ items }: { items: AtRiskItem[] }) {
  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white overflow-hidden border-l-2 border-l-indigo-200">
      <div className="border-b border-gray-100 px-5 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
          <span className="text-gray-400 mr-1" aria-hidden="true">
            →
          </span>
          At-risk stock pressure
        </p>
        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed max-w-2xl">
          Inventory items likely to hit supply pressure within two weeks if current
          sales pace continues. Based on the last 30 days of demand and the latest
          stock count.
        </p>
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-6 text-xs text-gray-400">
          No items projected to hit near-term pressure at current pace.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {items.map((it) => {
            const urgent = it.daysOfSupply < 7
            return (
              <li key={it.id} className="px-5 py-3.5 flex gap-3 items-start">
                <span
                  className={`mt-2 h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                    urgent ? 'bg-red-500' : 'bg-amber-500'
                  }`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-[14px] font-semibold text-gray-900 truncate">
                      {it.name}
                    </p>
                    <p
                      className={`text-[12px] font-bold tabular-nums flex-shrink-0 ${
                        urgent ? 'text-red-700' : 'text-amber-700'
                      }`}
                    >
                      ~{it.daysOfSupply}d left
                    </p>
                  </div>
                  <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                    {it.currentStock} {it.unit} on hand · using ~
                    {it.consumptionPerDay.toFixed(2)} {it.unit}/day
                    {it.driverItemName ? <> · driven by {it.driverItemName}</> : null}
                  </p>
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
// NearTermContinuation — predictive read on items expected to keep
// moving in their current direction. Two short lists: holding
// strength (positive delta + meaningful revenue) and remaining weak.
// More concrete than category arrows because it names items and
// shows where the revenue actually sits.
// ================================================================
function NearTermContinuation({
  holding,
  weak,
}: {
  holding: { id: string; name: string; currentRevenue: number; revenueDelta: number | null }[]
  weak: { id: string; name: string; previousRevenue: number; revenueDelta: number | null }[]
}) {
  const empty = holding.length === 0 && weak.length === 0
  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white overflow-hidden border-l-2 border-l-indigo-200">
      <div className="border-b border-gray-100 px-5 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
          <span className="text-gray-400 mr-1" aria-hidden="true">
            →
          </span>
          Near-term demand continuation
        </p>
        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed max-w-2xl">
          Items where the current 30-day move is clear enough to expect continuation
          if conditions hold. Not a forecast — a directional read.
        </p>
      </div>
      {empty ? (
        <p className="px-5 py-6 text-xs text-gray-400">
          No items with strong, clearly directional movement right now.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
          <div className="px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-700 mb-2">
              Likely holding strength
            </p>
            {holding.length === 0 ? (
              <p className="text-[11px] text-gray-400">None with clear upside.</p>
            ) : (
              <ul className="space-y-2.5">
                {holding.map((i) => (
                  <li key={i.id} className="text-[12px]">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-gray-900 font-medium truncate">{i.name}</span>
                      <span className="text-green-700 font-bold tabular-nums flex-shrink-0">
                        ↑ {deltaText(i.revenueDelta)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-gray-400 tabular-nums">
                      ${i.currentRevenue.toLocaleString('en-US', { maximumFractionDigits: 0 })} current
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-700 mb-2">
              Likely remaining weak
            </p>
            {weak.length === 0 ? (
              <p className="text-[11px] text-gray-400">None with clear downside.</p>
            ) : (
              <ul className="space-y-2.5">
                {weak.map((i) => (
                  <li key={i.id} className="text-[12px]">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-gray-900 font-medium truncate">{i.name}</span>
                      <span className="text-red-600 font-bold tabular-nums flex-shrink-0">
                        ↓ {deltaText(i.revenueDelta)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-gray-400 tabular-nums">
                      ${i.previousRevenue.toLocaleString('en-US', { maximumFractionDigits: 0 })} prior
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ================================================================
// LeadWeeklyRhythm — the predictive mode's lead surface.
//
// Combines two predictive reads that used to sit as separate cards:
//   • the 7-day pace projection (this week's revenue + delta vs the
//     prior 7 days), and
//   • the day-of-week rhythm for the upcoming 7 days.
//
// Three bands: indigo-tinted header / body with pace + day grid /
// tinted footer with strongest+softest summary. Indigo left edge
// accent + indigo header tint + indigo highlight on the strongest
// expected day give Predictive its forward-leaning color identity
// without breaking calm family consistency.
// ================================================================
function LeadWeeklyRhythm({
  outlook,
  last7Revenue,
  last7Orders,
  prior7Revenue,
  paceDelta,
}: {
  outlook: {
    upcoming: { dayLabel: string; dateLabel: string; projected: number; sampleSize: number }[]
    strongest: { dayLabel: string; dateLabel: string; projected: number; sampleSize: number } | null
    softest: { dayLabel: string; dateLabel: string; projected: number; sampleSize: number } | null
    total: number
  }
  last7Revenue: number
  last7Orders: number
  prior7Revenue: number
  paceDelta: number | null
}) {
  const empty = !outlook.strongest || outlook.total === 0
  const deltaTone =
    paceDelta === null
      ? 'text-gray-400'
      : paceDelta > 0
        ? 'text-green-700'
        : paceDelta < 0
          ? 'text-red-600'
          : 'text-gray-400'
  const arrow = paceDelta === null ? '·' : paceDelta > 0 ? '↑' : paceDelta < 0 ? '↓' : '·'
  return (
    <div className="rounded-xl border border-gray-200 bg-white mb-3 overflow-hidden border-l-2 border-l-indigo-300">
      <div className="border-b border-gray-100 px-6 py-3 bg-indigo-50/30">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-indigo-700">
          <span className="mr-1" aria-hidden="true">
            →
          </span>
          Lead continuation read · next 7 days rhythm
        </p>
        <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">
          The week ahead — projected pace and day-by-day rhythm based on weekday
          averages from recent history.
        </p>
      </div>

      <div className="px-6 py-5">
        <p className="text-xs text-gray-500 leading-relaxed mb-2">
          At this week&apos;s pace, the next 7 days project to:
        </p>
        <div className="flex items-baseline gap-4 flex-wrap">
          <p className="text-4xl font-bold tabular-nums text-gray-900 leading-none">
            {CURRENCY(last7Revenue)}
          </p>
          {paceDelta !== null && (
            <span className={`text-sm font-bold tabular-nums ${deltaTone}`}>
              {arrow} {Math.abs(paceDelta)}% vs prior 7 days
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-gray-600 leading-relaxed">
          Based on{' '}
          <span className="font-semibold text-gray-800 tabular-nums">{last7Orders}</span>{' '}
          orders this past week
          {prior7Revenue > 0 && (
            <>
              {' '}· prior 7 days were{' '}
              <span className="font-semibold text-gray-800 tabular-nums">
                {CURRENCY(prior7Revenue)}
              </span>
            </>
          )}
          .
        </p>

        {!empty && (
          <div className="mt-6 pt-5 border-t border-gray-100">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-3">
              Daily projection
            </p>
            <div className="grid grid-cols-7 gap-1.5">
              {outlook.upcoming.map((u, i) => {
                const isStrongest =
                  outlook.strongest !== null &&
                  u.projected === outlook.strongest.projected &&
                  u.projected > 0
                return (
                  <div
                    key={i}
                    className={`rounded-lg px-2 py-2.5 text-center ${
                      isStrongest ? 'bg-indigo-100' : 'bg-gray-50/60'
                    }`}
                  >
                    <p
                      className={`text-[10px] font-semibold uppercase tracking-widest ${
                        isStrongest ? 'text-indigo-800' : 'text-gray-400'
                      }`}
                    >
                      {u.dayLabel}
                    </p>
                    <p className="mt-0.5 text-[10px] tabular-nums text-gray-400">
                      {u.dateLabel}
                    </p>
                    <p
                      className={`mt-2 text-[13px] font-bold tabular-nums ${
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

        {empty && (
          <p className="mt-6 pt-5 border-t border-gray-100 text-xs text-gray-400 text-center">
            Not enough weekday history yet to project a day-by-day rhythm.
          </p>
        )}
      </div>

      {!empty && (
        <div className="border-t border-gray-100 bg-gray-50/40 px-6 py-2.5 flex items-baseline justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-4 text-[11px]">
            {outlook.strongest && (
              <span className="text-gray-700">
                <span className="text-gray-400 mr-1">Strongest:</span>
                <span className="font-semibold">{outlook.strongest.dayLabel}</span>
                <span className="text-gray-400"> · </span>
                <span className="tabular-nums font-bold text-indigo-700">
                  {SHORT_CURRENCY(outlook.strongest.projected)}
                </span>
              </span>
            )}
            {outlook.softest &&
              outlook.softest.projected !== outlook.strongest?.projected && (
                <span className="text-gray-700">
                  <span className="text-gray-400 mr-1">Softest:</span>
                  <span className="font-semibold">{outlook.softest.dayLabel}</span>
                  <span className="text-gray-400"> · </span>
                  <span className="tabular-nums font-bold text-gray-700">
                    {SHORT_CURRENCY(outlook.softest.projected)}
                  </span>
                </span>
              )}
          </div>
          <p className="text-[10px] text-gray-400 leading-relaxed">
            Pace projection only — does not factor seasonality, holidays, or one-offs.
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

function buildGrowthDecomp(
  revDelta: number | null,
  ordDelta: number | null,
  ticketDelta: number | null,
): { verdict: string; headline: string } {
  if (revDelta === null || ordDelta === null || ticketDelta === null) {
    return {
      verdict: 'No comparison',
      headline:
        'Not enough history in the previous window to decompose the move yet. Come back once two full periods of data are in.',
    }
  }
  if (revDelta === 0 && ordDelta === 0 && ticketDelta === 0) {
    return {
      verdict: 'Flat',
      headline: 'Revenue, orders, and ticket size are all flat against the previous window.',
    }
  }
  const absOrd = Math.abs(ordDelta)
  const absTicket = Math.abs(ticketDelta)
  let verdict: string
  if (absOrd >= absTicket * 2) verdict = 'Volume-led'
  else if (absTicket >= absOrd * 2) verdict = 'Ticket-led'
  else verdict = 'Mixed'

  const direction = revDelta > 0 ? 'rose' : revDelta < 0 ? 'fell' : 'held'
  const magnitude = revDelta === 0 ? '' : ` ${Math.abs(revDelta)}%`
  const drive =
    verdict === 'Volume-led'
      ? `Orders did the moving (${deltaText(ordDelta)}); avg ticket was ${deltaText(ticketDelta)}.`
      : verdict === 'Ticket-led'
        ? `Ticket size did the moving (${deltaText(ticketDelta)}); orders were ${deltaText(ordDelta)}.`
        : `Orders ${deltaText(ordDelta)} and avg ticket ${deltaText(ticketDelta)} contributed roughly together.`

  return {
    verdict,
    headline: `Revenue ${direction}${magnitude}. ${drive}`,
  }
}
