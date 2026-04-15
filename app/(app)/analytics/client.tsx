'use client'

// ----------------------------------------------------------------
// Analytics Client
//
// Five modules, in this order:
//   1. Overview strip       — orientation signals
//   2. Trend workspace      — main chart, revenue/orders × 7d/30d
//   3. Performance workspace — ranked categories / items
//   4. Relationship workspace — labor vs sales
//   5. Movement view        — risers and decliners (by category)
// ----------------------------------------------------------------

import { useState, useMemo } from 'react'
import SimpleBarChart from '@/components/bar-chart'

interface DailyBucket { date: string; revenue: number; orders: number }
interface Aggregate {
  id: string
  name: string
  currentRevenue: number
  currentQty: number
  previousRevenue: number
}
interface DailyLabor { date: string; laborCost: number }

interface Props {
  dailyBuckets: DailyBucket[]   // last 60 days
  itemAggregates: Aggregate[]
  categoryAggregates: Aggregate[]
  dailyLabor: DailyLabor[]      // last 30 days
}

type Window = '7d' | '30d'
type Metric = 'revenue' | 'orders'
type PerfTab = 'categories' | 'items'

const CURRENCY = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const SHORT_CURRENCY = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`

export default function AnalyticsClient({
  dailyBuckets,
  itemAggregates,
  categoryAggregates,
  dailyLabor,
}: Props) {
  const [win, setWin] = useState<Window>('30d')
  const [metric, setMetric] = useState<Metric>('revenue')
  const [perfTab, setPerfTab] = useState<PerfTab>('categories')

  // --- Slice dailyBuckets into current / previous equal-length halves ---
  const windowSize = win === '7d' ? 7 : 30
  const currentWindow = dailyBuckets.slice(-windowSize)
  const previousWindow = dailyBuckets.slice(-(windowSize * 2), -windowSize)

  const currentRevenue = sum(currentWindow, (d) => d.revenue)
  const previousRevenue = sum(previousWindow, (d) => d.revenue)
  const currentOrders = sum(currentWindow, (d) => d.orders)
  const previousOrders = sum(previousWindow, (d) => d.orders)

  const revenueDelta = pctDelta(currentRevenue, previousRevenue)
  const ordersDelta = pctDelta(currentOrders, previousOrders)

  // --- Overview: top category + top item for CURRENT period ---
  const topCategory = [...categoryAggregates]
    .sort((a, b) => b.currentRevenue - a.currentRevenue)[0] ?? null
  const topItem = [...itemAggregates]
    .sort((a, b) => b.currentRevenue - a.currentRevenue)[0] ?? null

  // --- Trend chart data ---
  const chartData = useMemo(() => {
    return currentWindow.map((d) => ({
      label: formatDayLabel(d.date),
      value: metric === 'revenue' ? d.revenue : d.orders,
    }))
  }, [currentWindow, metric])

  // --- Performance: ranked list, current 30d regardless of window ---
  const perfRows = useMemo(() => {
    const source = perfTab === 'categories' ? categoryAggregates : itemAggregates
    const top = [...source]
      .filter((r) => r.currentRevenue > 0)
      .sort((a, b) => b.currentRevenue - a.currentRevenue)
      .slice(0, 8)
    const totalRevenue = top.reduce((s, r) => s + r.currentRevenue, 0)
    return { rows: top, totalRevenue }
  }, [perfTab, categoryAggregates, itemAggregates])

  // --- Relationship: labor vs sales for current 30d ---
  // Match dailyLabor (30 entries) against the tail 30 entries of
  // dailyBuckets so the dates line up.
  const last30Buckets = dailyBuckets.slice(-30)
  const totalRevenue30 = sum(last30Buckets, (d) => d.revenue)
  const totalLabor30 = sum(dailyLabor, (d) => d.laborCost)
  const laborPct = totalRevenue30 > 0 ? Math.round((totalLabor30 / totalRevenue30) * 100) : 0

  // --- Movement: risers / decliners by category (cleaner than items) ---
  const movement = useMemo(() => {
    const withDelta = categoryAggregates
      .map((c) => ({
        ...c,
        absDelta: c.currentRevenue - c.previousRevenue,
        pctDelta: pctDelta(c.currentRevenue, c.previousRevenue),
      }))
      // Only include categories that had meaningful activity somewhere
      .filter((c) => c.currentRevenue > 0 || c.previousRevenue > 0)
    const risers = [...withDelta]
      .filter((c) => c.pctDelta !== null && c.pctDelta > 0)
      .sort((a, b) => (b.pctDelta ?? 0) - (a.pctDelta ?? 0))
      .slice(0, 3)
    const decliners = [...withDelta]
      .filter((c) => c.pctDelta !== null && c.pctDelta < 0)
      .sort((a, b) => (a.pctDelta ?? 0) - (b.pctDelta ?? 0))
      .slice(0, 3)
    return { risers, decliners }
  }, [categoryAggregates])

  return (
    <div className="max-w-[1400px]">

      {/* ---- HEADER ---- */}
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
        <p className="mt-1 text-sm text-gray-500">
          Patterns, performance, and movement across the business.
        </p>
      </div>

      {/* ================ 1. OVERVIEW STRIP ================ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <OverviewCell
          label="Revenue"
          value={CURRENCY(currentRevenue)}
          delta={revenueDelta}
          hint={win === '7d' ? 'vs previous 7 days' : 'vs previous 30 days'}
        />
        <OverviewCell
          label="Orders"
          value={currentOrders.toString()}
          delta={ordersDelta}
          hint={win === '7d' ? 'vs previous 7 days' : 'vs previous 30 days'}
        />
        <OverviewCell
          label="Top category"
          value={topCategory?.name ?? '—'}
          hint={topCategory ? CURRENCY(topCategory.currentRevenue) + ' · last 30d' : 'No data yet'}
        />
        <OverviewCell
          label="Top item"
          value={topItem?.name ?? '—'}
          hint={topItem ? `${topItem.currentQty} sold · last 30d` : 'No data yet'}
        />
      </div>

      {/* ================ 2. TREND WORKSPACE ================ */}
      <section className="mb-8">
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-1">
              <Toggle label="Revenue" active={metric === 'revenue'} onClick={() => setMetric('revenue')} />
              <Toggle label="Orders" active={metric === 'orders'} onClick={() => setMetric('orders')} />
            </div>
            <div className="flex items-center gap-1">
              <Toggle label="7d" active={win === '7d'} onClick={() => setWin('7d')} small />
              <Toggle label="30d" active={win === '30d'} onClick={() => setWin('30d')} small />
            </div>
          </div>
          <div className="p-5">
            <SimpleBarChart
              data={chartData}
              color={metric === 'revenue' ? '#3b82f6' : '#8b5cf6'}
              height={220}
            />
          </div>
        </div>
      </section>

      {/* ================ 3. PERFORMANCE WORKSPACE ================ */}
      <section className="mb-8">
        <SectionHeader title="Performance · last 30 days" />
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-2.5 flex items-center gap-1">
            <Toggle label="Categories" active={perfTab === 'categories'} onClick={() => setPerfTab('categories')} />
            <Toggle label="Items" active={perfTab === 'items'} onClick={() => setPerfTab('items')} />
          </div>
          {perfRows.rows.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-12">No performance data yet.</p>
          ) : (
            <ul className="divide-y divide-gray-50">
              {perfRows.rows.map((row, i) => {
                const share = perfRows.totalRevenue > 0
                  ? Math.round((row.currentRevenue / perfRows.totalRevenue) * 100)
                  : 0
                return (
                  <li key={row.id} className="px-5 py-3">
                    <div className="flex items-baseline justify-between gap-3 mb-1.5">
                      <div className="min-w-0 flex items-baseline gap-2">
                        <span className="text-[10px] font-bold tabular-nums text-gray-400 w-4">{i + 1}</span>
                        <span className="text-sm font-semibold text-gray-900 truncate">{row.name}</span>
                        <span className="text-[10px] text-gray-400 whitespace-nowrap">· {row.currentQty} sold</span>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-bold tabular-nums text-gray-900">{CURRENCY(row.currentRevenue)}</p>
                        <p className="text-[10px] text-gray-400 tabular-nums">{share}% of top 8</p>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className={`h-full ${perfTab === 'categories' ? 'bg-purple-400' : 'bg-blue-400'}`}
                        style={{ width: `${share}%` }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>

      {/* ================ 4. RELATIONSHIP WORKSPACE ================ */}
      <section className="mb-8">
        <SectionHeader title="Labor vs sales · last 30 days" />
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="grid sm:grid-cols-3 gap-4 mb-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Sales</p>
              <p className="mt-1 text-xl font-bold tabular-nums text-gray-900">{CURRENCY(totalRevenue30)}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Scheduled labor est.</p>
              <p className="mt-1 text-xl font-bold tabular-nums text-gray-900">{CURRENCY(totalLabor30)}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Labor % of sales</p>
              <p className={`mt-1 text-xl font-bold tabular-nums ${
                laborPct === 0 ? 'text-gray-300'
                  : laborPct <= 30 ? 'text-green-700'
                    : laborPct <= 45 ? 'text-gray-900'
                      : 'text-red-600'
              }`}>
                {totalRevenue30 > 0 ? `${laborPct}%` : '—'}
              </p>
            </div>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-amber-400"
              style={{ width: `${Math.min(100, laborPct)}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">
            Estimate only — based on scheduled shifts × employee hourly rates. Not payroll.
          </p>
        </div>
      </section>

      {/* ================ 5. MOVEMENT VIEW ================ */}
      <section className="mb-2">
        <SectionHeader title="Movement · current 30d vs previous 30d" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <MovementCard title="Risers" tone="positive" rows={movement.risers} />
          <MovementCard title="Decliners" tone="negative" rows={movement.decliners} />
        </div>
      </section>
    </div>
  )
}

// ================================================================
// Helpers
// ================================================================

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3">
      {title}
    </h2>
  )
}

function Toggle({ label, active, onClick, small }: {
  label: string; active: boolean; onClick: () => void; small?: boolean
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

function OverviewCell({ label, value, delta, hint }: {
  label: string
  value: string
  delta?: number | null
  hint: string
}) {
  const deltaTone =
    delta == null ? 'text-gray-300'
      : delta > 0 ? 'text-green-700'
        : delta < 0 ? 'text-red-600'
          : 'text-gray-400'
  const arrow = delta == null ? '·' : delta > 0 ? '↑' : delta < 0 ? '↓' : '·'

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{label}</p>
        {delta !== undefined && (
          <span className={`text-[10px] font-bold tabular-nums ${deltaTone}`}>
            {arrow} {delta != null ? `${Math.abs(delta)}%` : '—'}
          </span>
        )}
      </div>
      <p className="mt-1 text-lg font-bold text-gray-900 truncate">{value}</p>
      <p className="mt-0.5 text-[10px] text-gray-400 truncate">{hint}</p>
    </div>
  )
}

function MovementCard({ title, tone, rows }: {
  title: string
  tone: 'positive' | 'negative'
  rows: { id: string; name: string; currentRevenue: number; previousRevenue: number; pctDelta: number | null }[]
}) {
  const toneColor = tone === 'positive' ? 'text-green-700' : 'text-red-600'
  const arrow = tone === 'positive' ? '↑' : '↓'
  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div className="border-b border-gray-100 px-4 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{title}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-400 text-center py-8">No {title.toLowerCase()} in this period.</p>
      ) : (
        <ul className="divide-y divide-gray-50">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between px-4 py-2.5">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-gray-900 truncate">{r.name}</p>
                <p className="text-[10px] text-gray-400 tabular-nums mt-0.5">
                  {SHORT_CURRENCY(r.previousRevenue)} → {SHORT_CURRENCY(r.currentRevenue)}
                </p>
              </div>
              <span className={`text-xs font-bold tabular-nums ${toneColor}`}>
                {arrow} {r.pctDelta !== null ? `${Math.abs(r.pctDelta)}%` : '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
    return null // undefined growth from zero base
  }
  return Math.round(((current - previous) / previous) * 100)
}

function formatDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
