'use client'

// ----------------------------------------------------------------
// FinanceDashboardClient — the warm, alive, at-a-glance surface.
//
// Sections top-down:
//   1. Balance anchor (big number, delta, count-up on mount)
//   2. Weekly progress rings (revenue / expenses / net vs typical
//      week — or "learning your typical week" state under 4 weeks
//      of history)
//   3. Money In / Money Out cards (sparkline + attribution chip)
//   4. Net line (this week) with streak / context if it's earned
//   5. Sunday recap (Sun / Mon of the following week only)
//   6. Smart nudge (max one line, colleague tone, never alarm)
//   7. Recent activity ledger (expense rows categorize on tap)
//   8. Small footer link → /finance/details for the classic workspace
//
// Warm palette:
//   • Never a red arrow. Warm neutral for down / negative.
//   • Money in = forward green. Money out = warm slate, not red.
//   • Emoji sparingly, only in earned moments.
// ----------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, useTransition, type CSSProperties } from 'react'
import Link from 'next/link'
import { updateExpenseCategory } from '@/app/actions/finance'
import { EXPENSE_CATEGORIES } from '@/lib/finance/constants'
import { makeT, type Lang } from '@/lib/i18n'

// Duplicate small style helpers here so the component stays a
// self-contained "read the file to understand it" surface.
const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })

// ----------------------------------------------------------------
// Prop shapes match the server-side computation. If those change,
// TypeScript will surface the mismatch here.
// ----------------------------------------------------------------
type Kind = 'order' | 'expense' | 'bank_credit' | 'bank_debit'

interface LedgerRow {
  id: string
  kind: Kind
  amount: number
  label: string
  sub: string | null
  category: string | null
  categoryEditable: boolean
  timestamp: string
}

interface Props {
  lang: Lang
  bank: {
    connected: boolean
    balance: number
    latestSyncAt: string | null
    accountCount: number
  }
  week: {
    startISO: string
    moneyIn: number
    moneyOut: number
    net: number
    inChip: string
    outChip: string
    inSpark: number[]
    outSpark: number[]
    lastWeekNet: number
    streakWeeks: number
  }
  baselines: {
    moneyIn: number | null
    moneyOut: number | null
    net: number | null
    enoughHistory: boolean
  }
  ledger: LedgerRow[]
  nudge: string | null
  recap: string | null
}

// ----------------------------------------------------------------
// Warm palette tokens. Ink for primary text; olive-forward "up"
// green; warm slate for outflow (not red — spending is neutral,
// not bad); soft cream and sand for surfaces.
// ----------------------------------------------------------------
const INK = '#18181B'
const SLATE = '#52525B'
const MUTED = '#9CA3AF'
const HAIR = '#E7E6E2'
const CREAM = '#FAF9F6'
const SAND = '#F4F1EA'
const UP = '#16A34A'         // forward green — earned money, positive delta
const DOWN_WARM = '#B45309'  // warm terra — negative / decline, not alarm
const SPEND = '#78716C'      // warm slate — money out, neutral
const RING_IN = '#16A34A'    // ring 1 fill
const RING_OUT = '#D4A056'   // ring 2 fill
const RING_NET = '#3F6B4C'   // ring 3 fill, deeper green

// USD formatter used across the page. Compact (no decimals) for big
// anchor numbers; full for ledger amounts.
const fmt = (n: number, opts?: { compact?: boolean }): string => {
  const abs = Math.abs(n)
  if (opts?.compact) {
    return `${n < 0 ? '-' : ''}$${Math.round(abs).toLocaleString('en-US')}`
  }
  return `${n < 0 ? '-' : ''}$${abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

// Format a delta with a leading "+" for positive amounts; used
// in "vs last week" lines and streak lines.
const fmtDelta = (n: number, opts?: { compact?: boolean }): string => {
  if (n === 0) return fmt(0, opts)
  return `${n > 0 ? '+' : '-'}$${Math.abs(n).toFixed(opts?.compact ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

// ----------------------------------------------------------------
// useCountUp — animate a numeric value from 0 to `target` on mount
// or when `target` changes. Uses requestAnimationFrame; ~800ms
// duration. Respects prefers-reduced-motion by jumping instantly.
// ----------------------------------------------------------------
function useCountUp(target: number, durationMs = 800): number {
  const [value, setValue] = useState(0)
  const startedRef = useRef(false)

  useEffect(() => {
    // Respect reduced motion — jump to target.
    if (typeof window !== 'undefined') {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduced) {
        setValue(target)
        return
      }
    }
    let raf: number
    const startAt = performance.now()
    const from = startedRef.current ? value : 0
    startedRef.current = true
    const tick = (now: number) => {
      const t = Math.min(1, (now - startAt) / durationMs)
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(from + (target - from) * eased)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs])

  return value
}

// ----------------------------------------------------------------
// PageShell — reproduces the classic app-shell page frame so this
// page reads as part of the tablet product family. Title + optional
// subtitle up top, generous horizontal padding, cream page.
// ----------------------------------------------------------------
function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-6" style={{ color: INK }}>
      {children}
    </div>
  )
}

// ----------------------------------------------------------------
// Main component
// ----------------------------------------------------------------
export default function FinanceDashboardClient({
  lang, bank, week, baselines, ledger, nudge, recap,
}: Props) {
  const t = makeT(lang)

  return (
    <PageShell>
      {/* Page title — small, calm; the balance below is the star. */}
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight" style={{ color: INK }}>
            {t('Finance', 'Finanzas')}
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: MUTED }}>
            {t('The week at a glance.', 'La semana de un vistazo.')}
          </p>
        </div>
        <Link
          href="/finance/details"
          className="text-[11px] font-mono uppercase tracking-[0.14em] transition-colors"
          style={{ color: MUTED }}
        >
          {t('Detailed workspace →', 'Espacio detallado →')}
        </Link>
      </div>

      {/* 1 · Balance anchor */}
      <BalanceCard bank={bank} lastWeekNet={week.lastWeekNet} lang={lang} />

      {/* 2 · Weekly progress rings */}
      <div className="mt-5">
        <ProgressRings week={week} baselines={baselines} lang={lang} />
      </div>

      {/* 3 · Money In / Money Out */}
      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        <FlowCard
          direction="in"
          label={t('Money in this week', 'Ingresos esta semana')}
          amount={week.moneyIn}
          spark={week.inSpark}
          chip={week.inChip}
        />
        <FlowCard
          direction="out"
          label={t('Money out this week', 'Egresos esta semana')}
          amount={week.moneyOut}
          spark={week.outSpark}
          chip={week.outChip}
        />
      </div>

      {/* 4 · Net + streak context */}
      <div className="mt-5">
        <NetLine net={week.net} streak={week.streakWeeks} lang={lang} />
      </div>

      {/* 5 · Sunday recap (only when the server said so) */}
      {recap && (
        <div className="mt-5">
          <RecapCard text={recap} lang={lang} />
        </div>
      )}

      {/* 6 · Smart nudge (server picked at most one line) */}
      {nudge && (
        <div className="mt-5">
          <NudgeLine text={nudge} lang={lang} />
        </div>
      )}

      {/* 7 · Recent activity ledger */}
      <div className="mt-6">
        <LedgerSection rows={ledger} lang={lang} />
      </div>
    </PageShell>
  )
}

// ----------------------------------------------------------------
// BalanceCard — the anchor. Big number counts up on mount. Delta
// vs last week's net sits underneath. When bank isn't connected,
// we show a warm nudge in the same slot.
// ----------------------------------------------------------------
function BalanceCard({
  bank, lastWeekNet, lang,
}: { bank: Props['bank']; lastWeekNet: number; lang: Lang }) {
  const t = makeT(lang)
  const shown = useCountUp(bank.connected ? bank.balance : 0)

  if (!bank.connected) {
    return (
      <section
        className="rounded-2xl px-6 py-6"
        style={{ background: SAND, border: `1px solid ${HAIR}` }}
      >
        <p className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: MUTED }}>
          {t('In the bank', 'En el banco')}
        </p>
        <p className="mt-3 text-[15px] leading-relaxed" style={{ color: SLATE, maxWidth: 520 }}>
          {t(
            'Connect your bank to see your real balance here. Without it, everything below still works — we just fall back to sales for the "money in" number.',
            'Conecta tu banco para ver tu saldo real aquí. Sin él, todo lo de abajo sigue funcionando — usamos las ventas como referencia para "ingresos".'
          )}
        </p>
        <div className="mt-4">
          <Link
            href="/settings"
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg text-[13px] font-semibold transition-colors"
            style={{ background: INK, color: CREAM }}
          >
            {t('Connect bank', 'Conectar banco')} →
          </Link>
        </div>
      </section>
    )
  }

  return (
    <section
      className="rounded-2xl px-6 py-6"
      style={{ background: SAND, border: `1px solid ${HAIR}` }}
    >
      <p className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: MUTED }}>
        {t('In the bank', 'En el banco')}
      </p>
      <p
        className="mt-2 leading-none tabular-nums"
        style={{ fontSize: 'clamp(40px, 6vw, 56px)', fontWeight: 700, letterSpacing: '-1.6px', color: INK }}
      >
        {fmt(shown, { compact: true })}
      </p>
      <div className="mt-3 flex items-baseline gap-2 flex-wrap">
        <span className="text-[13px]" style={{ color: SLATE }}>
          {t('Last week net', 'Neto semana pasada')}:
        </span>
        <span
          className="text-[13px] font-semibold tabular-nums"
          style={{ color: lastWeekNet >= 0 ? UP : DOWN_WARM }}
        >
          {fmtDelta(lastWeekNet)}
        </span>
        <span className="text-[11px]" style={{ color: MUTED }}>
          · {bank.accountCount === 1
              ? t('1 account', '1 cuenta')
              : `${bank.accountCount} ${t('accounts', 'cuentas')}`}
        </span>
      </div>
    </section>
  )
}

// ----------------------------------------------------------------
// ProgressRings — three concentric arcs showing progress vs a
// median "typical week." Under 4 weeks of history, shows a
// warm "learning your typical week" state instead of a broken ring.
// ----------------------------------------------------------------
function ProgressRings({
  week, baselines, lang,
}: { week: Props['week']; baselines: Props['baselines']; lang: Lang }) {
  const t = makeT(lang)

  if (!baselines.enoughHistory) {
    return (
      <section
        className="rounded-2xl px-6 py-5"
        style={{ background: CREAM, border: `1px solid ${HAIR}` }}
      >
        <div className="flex items-start gap-4">
          <RingLearningIcon />
          <div>
            <p className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: MUTED }}>
              {t('Weekly rings', 'Anillos semanales')}
            </p>
            <p className="mt-1.5 text-[15px] font-semibold" style={{ color: INK }}>
              {t('Learning your typical week', 'Aprendiendo tu semana promedio')}
            </p>
            <p className="mt-1 text-[12.5px]" style={{ color: SLATE, maxWidth: 520 }}>
              {t(
                'After 4 weeks of activity, this section will show where you are vs. your typical week — revenue, expenses, and net all in one glance.',
                'Después de 4 semanas de actividad, aquí verás cómo va la semana comparada con tu típica — ingresos, gastos y neto de un vistazo.'
              )}
            </p>
          </div>
        </div>
      </section>
    )
  }

  const inPct = baselines.moneyIn && baselines.moneyIn > 0 ? week.moneyIn / baselines.moneyIn : 0
  const outPct = baselines.moneyOut && baselines.moneyOut > 0 ? week.moneyOut / baselines.moneyOut : 0
  // Net rings are a special case: if the baseline is negative or zero,
  // any positive net is "beat typical". Cap fill at 1.5x for the visual.
  const netPct = (() => {
    if (baselines.net === null) return 0
    if (baselines.net <= 0) return week.net > 0 ? 1 : 0
    return week.net / baselines.net
  })()

  return (
    <section
      className="rounded-2xl px-6 py-5"
      style={{ background: CREAM, border: `1px solid ${HAIR}` }}
    >
      <div className="flex items-start gap-6 flex-wrap">
        <RingsSvg inPct={inPct} outPct={outPct} netPct={netPct} />
        <div className="flex-1 min-w-[200px]">
          <p className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: MUTED }}>
            {t('This week vs typical', 'Esta semana vs promedio')}
          </p>
          <div className="mt-2 space-y-1.5">
            <RingLegend color={RING_IN} label={t('Revenue', 'Ingresos')} value={inPct} baseline={baselines.moneyIn ?? 0} />
            <RingLegend color={RING_OUT} label={t('Expenses', 'Gastos')} value={outPct} baseline={baselines.moneyOut ?? 0} />
            <RingLegend color={RING_NET} label={t('Net', 'Neto')} value={netPct} baseline={baselines.net ?? 0} />
          </div>
        </div>
      </div>
    </section>
  )
}

function RingLegend({ color, label, value, baseline }: { color: string; label: string; value: number; baseline: number }) {
  const pct = Math.round(Math.min(1.5, Math.max(0, value)) * 100)
  return (
    <div className="flex items-center gap-3 text-[13px]">
      <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color }} />
      <span style={{ color: INK, minWidth: 74 }}>{label}</span>
      <span className="font-mono tabular-nums" style={{ color: SLATE }}>{pct}%</span>
      <span style={{ color: MUTED, fontSize: 11 }}>
        · typical {fmt(baseline, { compact: true })}
      </span>
    </div>
  )
}

// Rings SVG — three concentric arcs. Rendered with a subtle grow-in
// animation from empty to their target percentages.
function RingsSvg({ inPct, outPct, netPct }: { inPct: number; outPct: number; netPct: number }) {
  const [animatedPct, setAnimatedPct] = useState({ i: 0, o: 0, n: 0 })
  useEffect(() => {
    let raf: number
    const start = performance.now()
    const duration = 900
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setAnimatedPct({ i: inPct * eased, o: outPct * eased, n: netPct * eased })
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [inPct, outPct, netPct])

  const size = 140
  const cx = size / 2
  const cy = size / 2
  const stroke = 10
  const gap = 4
  // radii: outer, middle, inner
  const r1 = cx - stroke / 2 - 2
  const r2 = r1 - stroke - gap
  const r3 = r2 - stroke - gap

  const arc = (r: number, frac: number) => {
    const C = 2 * Math.PI * r
    const filled = C * Math.min(1, Math.max(0, frac))
    return { C, filled }
  }
  const a1 = arc(r1, animatedPct.i)
  const a2 = arc(r2, animatedPct.o)
  const a3 = arc(r3, animatedPct.n)

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
      {/* Track circles — very light */}
      {[r1, r2, r3].map((r) => (
        <circle
          key={r}
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke={HAIR}
          strokeWidth={stroke}
        />
      ))}
      {/* Foreground arcs — rotate -90deg so they start at 12 o'clock */}
      <g transform={`rotate(-90 ${cx} ${cy})`}>
        <circle
          cx={cx} cy={cy} r={r1}
          fill="none"
          stroke={RING_IN}
          strokeWidth={stroke}
          strokeDasharray={`${a1.filled} ${a1.C}`}
          strokeLinecap="round"
        />
        <circle
          cx={cx} cy={cy} r={r2}
          fill="none"
          stroke={RING_OUT}
          strokeWidth={stroke}
          strokeDasharray={`${a2.filled} ${a2.C}`}
          strokeLinecap="round"
        />
        <circle
          cx={cx} cy={cy} r={r3}
          fill="none"
          stroke={RING_NET}
          strokeWidth={stroke}
          strokeDasharray={`${a3.filled} ${a3.C}`}
          strokeLinecap="round"
        />
      </g>
    </svg>
  )
}

function RingLearningIcon() {
  return (
    <svg width={56} height={56} viewBox="0 0 56 56" style={{ flex: '0 0 auto', marginTop: 2 }}>
      <circle cx="28" cy="28" r="22" fill="none" stroke={HAIR} strokeWidth="6" strokeDasharray="6 8" />
      <circle cx="28" cy="28" r="14" fill="none" stroke={HAIR} strokeWidth="6" strokeDasharray="4 6" />
      <circle cx="28" cy="28" r="6" fill={HAIR} />
    </svg>
  )
}

// ----------------------------------------------------------------
// FlowCard — Money In or Money Out. Big number counting up, thin
// sparkline underneath, attribution chip on the right.
// ----------------------------------------------------------------
function FlowCard({
  direction, label, amount, spark, chip,
}: {
  direction: 'in' | 'out'
  label: string
  amount: number
  spark: number[]
  chip: string
}) {
  const shown = useCountUp(amount)
  const accent = direction === 'in' ? UP : SPEND

  return (
    <section
      className="rounded-2xl px-5 py-5"
      style={{ background: CREAM, border: `1px solid ${HAIR}` }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: MUTED }}>
          {label}
        </p>
        <span
          className="text-[10.5px] font-mono uppercase tracking-[0.1em] px-2 py-1 rounded-md"
          style={{ background: SAND, color: SLATE }}
        >
          {chip}
        </span>
      </div>
      <p
        className="mt-3 leading-none tabular-nums"
        style={{ fontSize: 'clamp(28px, 4vw, 36px)', fontWeight: 700, letterSpacing: '-1px', color: accent }}
      >
        {direction === 'in' ? '+' : ''}
        {fmt(shown, { compact: true })}
      </p>
      <div className="mt-4">
        <Sparkline values={spark} color={accent} />
      </div>
    </section>
  )
}

// Sparkline — 7 daily values, draws left-to-right with a subtle
// stroke-dasharray reveal. Fills the width of its container.
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const [drawn, setDrawn] = useState(0)
  const w = 240
  const h = 32
  const max = Math.max(1, ...values)
  const pts = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * (w - 4) + 2
    const y = h - (v / max) * (h - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const d = `M ${pts.join(' L ')}`

  useEffect(() => {
    let raf: number
    const start = performance.now()
    const duration = 700
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setDrawn(eased)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [values])

  // Approximate the path length for dasharray reveal. SVG path
  // length varies; overshooting a bit is fine (extra dash trailing
  // off-screen is invisible).
  const approxLen = 400
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={approxLen}
        strokeDashoffset={approxLen * (1 - drawn)}
      />
      {/* End dot pulses at the current day */}
      {pts.length > 0 && drawn > 0.9 && (
        <circle
          cx={pts[pts.length - 1].split(',')[0]}
          cy={pts[pts.length - 1].split(',')[1]}
          r={3}
          fill={color}
        />
      )}
    </svg>
  )
}

// ----------------------------------------------------------------
// NetLine — one-liner summary of the week's net. Streak context
// appears only when it's earned (2+ weeks in a row).
// ----------------------------------------------------------------
function NetLine({ net, streak, lang }: { net: number; streak: number; lang: Lang }) {
  const t = makeT(lang)
  const positive = net > 0
  const streakLabel = (() => {
    if (streak < 2) return null
    if (streak === 2) return t('Two profitable weeks in a row', 'Dos semanas positivas seguidas')
    if (streak === 3) return t('3 weeks in a row — nice run', '3 semanas seguidas — buena racha')
    if (streak >= 4) return t(`${streak} profitable weeks in a row`, `${streak} semanas positivas seguidas`)
    return null
  })()

  return (
    <section
      className="rounded-2xl px-5 py-4 flex items-baseline flex-wrap gap-x-4 gap-y-1"
      style={{ background: CREAM, border: `1px solid ${HAIR}` }}
    >
      <p className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: MUTED }}>
        {t('Net this week', 'Neto de esta semana')}
      </p>
      <p
        className="text-[22px] leading-none font-semibold tabular-nums"
        style={{ color: positive ? UP : DOWN_WARM, letterSpacing: '-0.5px' }}
      >
        {fmtDelta(net)}
      </p>
      {streakLabel && (
        <p className="text-[13px]" style={{ color: SLATE }}>
          <span style={{ marginRight: 6 }}>🎉</span>
          {streakLabel}
        </p>
      )}
    </section>
  )
}

// ----------------------------------------------------------------
// RecapCard — Sunday-Monday only. Server decides when.
// ----------------------------------------------------------------
function RecapCard({ text, lang }: { text: string; lang: Lang }) {
  const t = makeT(lang)
  return (
    <section
      className="rounded-2xl px-5 py-4"
      style={{
        background: `linear-gradient(180deg, ${SAND} 0%, ${CREAM} 100%)`,
        border: `1px solid ${HAIR}`,
      }}
    >
      <p className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: DOWN_WARM }}>
        {t('Last week wrapped', 'Semana pasada')}
      </p>
      <p className="mt-2 text-[15px] leading-relaxed" style={{ color: INK }}>
        {text}
      </p>
    </section>
  )
}

// ----------------------------------------------------------------
// NudgeLine — the colleague voice, calm. Server picks at most one.
// ----------------------------------------------------------------
function NudgeLine({ text, lang }: { text: string; lang: Lang }) {
  const t = makeT(lang)
  return (
    <p
      className="text-[13.5px] leading-relaxed px-1"
      style={{ color: SLATE }}
    >
      <span aria-hidden="true" style={{ marginRight: 8 }}>💬</span>
      <span style={{ color: MUTED, marginRight: 6 }}>{t('Heads up:', 'Aviso:')}</span>
      {text}
    </p>
  )
}

// ----------------------------------------------------------------
// LedgerSection — recent activity feed. Expense rows are
// categorize-on-tap; other kinds show their meta read-only.
// ----------------------------------------------------------------
function LedgerSection({ rows, lang }: { rows: LedgerRow[]; lang: Lang }) {
  const t = makeT(lang)

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-[11px] font-mono uppercase tracking-[0.16em]" style={{ color: MUTED }}>
          {t('Recent activity', 'Actividad reciente')}
        </p>
        <span className="text-[10.5px] font-mono uppercase tracking-[0.1em]" style={{ color: MUTED }}>
          {rows.length}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[13px] px-1 py-6 text-center" style={{ color: MUTED }}>
          {t('Nothing yet — quiet start to the week.', 'Nada aún — semana empieza tranquila.')}
        </p>
      ) : (
        <ul className="rounded-2xl overflow-hidden" style={{ background: CREAM, border: `1px solid ${HAIR}` }}>
          {rows.map((r, idx) => (
            <li
              key={r.id}
              style={{ borderTop: idx === 0 ? 'none' : `1px solid ${HAIR}` }}
            >
              <LedgerRow row={r} lang={lang} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Single ledger row — icon + amount + label + category chip + time.
function LedgerRow({ row, lang }: { row: LedgerRow; lang: Lang }) {
  const t = makeT(lang)
  const isIn = row.kind === 'order' || row.kind === 'bank_credit'
  const iconColor = isIn ? UP : SPEND

  return (
    <div
      className="grid gap-3 px-4 py-3 items-center"
      style={{ gridTemplateColumns: '24px minmax(0, 1fr) minmax(0, auto) 90px' }}
    >
      {/* Icon */}
      <div
        className="flex items-center justify-center w-6 h-6 rounded-full text-[13px] font-bold"
        style={{ background: `${iconColor}15`, color: iconColor }}
        aria-hidden="true"
      >
        {isIn ? '+' : '−'}
      </div>

      {/* Label + sub */}
      <div className="min-w-0">
        <p className="text-[14px] font-semibold truncate" style={{ color: INK }}>
          {row.label}
        </p>
        {row.sub && (
          <p className="text-[11.5px] mt-0.5 truncate" style={{ color: MUTED }}>
            {row.sub}
          </p>
        )}
      </div>

      {/* Category chip (editable for expenses) */}
      <div className="min-w-0">
        {row.categoryEditable && row.category ? (
          <CategoryChip
            expenseId={row.id.replace(/^e:/, '')}
            initial={row.category}
            lang={lang}
          />
        ) : row.category ? (
          <span
            className="text-[10.5px] font-mono uppercase tracking-[0.1em] px-2 py-1 rounded-md"
            style={{ background: SAND, color: SLATE }}
          >
            {row.category}
          </span>
        ) : (
          <span className="text-[10.5px] font-mono uppercase tracking-[0.1em]" style={{ color: MUTED }}>
            {row.kind === 'order' ? t('Sale', 'Venta') : t('Bank', 'Banco')}
          </span>
        )}
      </div>

      {/* Amount + time */}
      <div className="text-right min-w-0">
        <p
          className="text-[14px] font-semibold font-mono tabular-nums"
          style={{ color: isIn ? UP : SPEND }}
        >
          {isIn ? '+' : '−'}{fmt(row.amount)}
        </p>
        <p className="text-[11px] mt-0.5" style={{ color: MUTED }}>
          {formatTime(row.timestamp)}
        </p>
      </div>
    </div>
  )
}

// CategoryChip — tap opens an inline select of EXPENSE_CATEGORIES.
// Optimistic update: chip flips immediately; server error rolls
// back with a soft red flash.
function CategoryChip({ expenseId, initial, lang }: { expenseId: string; initial: string; lang: Lang }) {
  const t = makeT(lang)
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [errored, setErrored] = useState(false)

  const commit = (next: string) => {
    setOpen(false)
    if (next === current) return
    const prev = current
    setCurrent(next) // optimistic
    startTransition(async () => {
      const res = await updateExpenseCategory(expenseId, next)
      if (res?.error) {
        setCurrent(prev)
        setErrored(true)
        setTimeout(() => setErrored(false), 1200)
      }
    })
  }

  if (open) {
    return (
      <select
        autoFocus
        value={current}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setOpen(false)}
        className="text-[11px] font-mono uppercase tracking-[0.08em] px-2 py-1 rounded-md focus:outline-none"
        style={{
          background: CREAM,
          color: INK,
          border: `1px solid ${INK}`,
        }}
      >
        {EXPENSE_CATEGORIES.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      title={t('Change category', 'Cambiar categoría')}
      className="text-[10.5px] font-mono uppercase tracking-[0.1em] px-2 py-1 rounded-md transition-all cursor-pointer"
      style={{
        background: errored ? '#FDE4E1' : SAND,
        color: errored ? '#B91C1C' : SLATE,
        border: `1px dashed ${errored ? '#F5B7B1' : HAIR}`,
        opacity: pending ? 0.6 : 1,
      }}
    >
      {current}
    </button>
  )
}

// ----------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------
function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// The `mono` helper is referenced from the shared style block; keep it
// alive here to satisfy the linter even if unused directly today.
export const _mono = mono
