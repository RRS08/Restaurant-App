// ----------------------------------------------------------------
// /finance/report — printable, QuickBooks-style 30-day report.
//
// Server component. Renders a self-contained, print-ready page
// covering:
//   • Cash summary (per-account balances + total)
//   • Net cash flow (income − expense over the window)
//   • Income by category
//   • Expense by category
//   • Top merchants (by expense)
//   • Daily cash flow trend (inline SVG)
//   • Full transaction detail
//
// Transfers are excluded from the P&L side (they're internal
// motion, not net flow) but shown in the detail table so the
// operator can trace them.
//
// Print button hits `window.print()` via a tiny client wrapper.
// CSV download link points at `/finance/report/csv?days=30`.
// ----------------------------------------------------------------

import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveActivePlace } from '@/lib/places'
import { listAccounts, listMovements, cashOnHand } from '@/lib/finance/data'
import type { FinanceAccount, FinanceMovement } from '@/lib/finance/types'
import PrintButton from './print-button'
import ComingSoon from '@/components/coming-soon'

export const metadata = { title: 'Finance report · Checked' }

const REPORT_DAYS_DEFAULT = 30

interface Search { days?: string }

export default async function FinanceReportPage(props: {
  searchParams?: Promise<Search>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return <ComingSoon eyebrow="REPORT" title="Sign in required" body="You need to be signed in." />
  const { data: role } = await supabase
    .from('user_roles').select('restaurant_id').eq('user_id', user.id).single()
  if (!role) return <ComingSoon eyebrow="REPORT" title="No restaurant" body="Finish onboarding first." />
  const restaurantId = role.restaurant_id as string

  const admin = createAdminClient()
  const activePlace = await resolveActivePlace(supabase, restaurantId)

  const search = (await props.searchParams) ?? {}
  const days = Math.max(1, Math.min(365, parseInt(search.days ?? '', 10) || REPORT_DAYS_DEFAULT))

  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  const [accounts, movements, { data: restaurantRow }] = await Promise.all([
    listAccounts(admin, restaurantId, { locationId: activePlace?.id ?? null }),
    listMovements(admin, restaurantId, { from, to, limit: 5000 }),
    admin.from('restaurants').select('name').eq('id', restaurantId).maybeSingle(),
  ])

  const restaurantName = (restaurantRow as { name?: string } | null)?.name ?? 'Business'
  const placeName = activePlace?.name ?? null

  return (
    <ReportView
      restaurantName={restaurantName}
      placeName={placeName}
      accounts={accounts}
      movements={movements}
      from={from}
      to={to}
      days={days}
    />
  )
}

// ================================================================
// Report body
// ================================================================

interface ViewProps {
  restaurantName: string
  placeName: string | null
  accounts: FinanceAccount[]
  movements: FinanceMovement[]
  from: Date
  to: Date
  days: number
}

function ReportView({ restaurantName, placeName, accounts, movements, from, to, days }: ViewProps) {
  const totals = computeTotals(movements)
  const byIncomeCat = groupByCategory(movements, 'income')
  const byExpenseCat = groupByCategory(movements, 'expense')
  const topMerchants = topMerchantsByExpense(movements, 10)
  const dailyTrend = dailyCashFlow(movements, from, to)
  const cash = cashOnHand(accounts)

  return (
    <div style={styles.page}>
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      {/* Toolbar — hidden in print */}
      <div className="no-print" style={styles.toolbar}>
        <Link href="/finance" style={styles.toolbarLink}>← Back to Finance</Link>
        <div style={{ flex: 1 }} />
        <Link href={`/finance/report/csv?days=${days}`} style={styles.toolbarButton}>Download CSV</Link>
        <PrintButton />
      </div>

      {/* Cover header */}
      <header style={styles.cover}>
        <div style={{ fontSize: 11, letterSpacing: '0.14em', color: '#71717A', textTransform: 'uppercase' }}>
          Finance report
        </div>
        <div style={styles.h1}>{restaurantName}{placeName ? ` — ${placeName}` : ''}</div>
        <div style={styles.subtle}>
          {fmtDate(from)} — {fmtDate(to)} · {days} days · generated {fmtDateTime(new Date())}
        </div>
      </header>

      {/* Executive summary strip */}
      <section style={styles.section}>
        <div style={styles.summaryGrid}>
          <SummaryCard label="Cash on hand" value={fmtMoney(cash)} accent="#18181B" />
          <SummaryCard label="Money in" value={fmtMoney(totals.income)} accent="#059669" />
          <SummaryCard label="Money out" value={fmtMoney(totals.expense)} accent="#DC2626" />
          <SummaryCard
            label="Net cash flow"
            value={`${totals.net >= 0 ? '+' : ''}${fmtMoney(totals.net)}`}
            accent={totals.net >= 0 ? '#059669' : '#DC2626'}
          />
        </div>
        <p style={styles.narration}>
          Over the last {days} days, {totals.movementCount} transactions moved through {accounts.length} account
          {accounts.length === 1 ? '' : 's'}. Net cash flow is{' '}
          <strong style={{ color: totals.net >= 0 ? '#059669' : '#DC2626' }}>
            {totals.net >= 0 ? '+' : ''}{fmtMoney(totals.net)}
          </strong>
          {' '}({totals.income > 0
            ? `${Math.round((totals.expense / totals.income) * 100)}% of income spent`
            : 'no income recorded'
          }).{' '}
          {totals.transferCount > 0 && `${totals.transferCount} transfers between your own accounts (excluded from the P&L).`}
        </p>
      </section>

      {/* Accounts */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Accounts</h2>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Account</th>
              <th style={styles.th}>Type</th>
              <th style={styles.thRight}>Current balance</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map(a => (
              <tr key={a.id}>
                <td style={styles.td}>{a.name}</td>
                <td style={{ ...styles.td, color: '#71717A' }}>{labelForKind(a.kind)}</td>
                <td style={styles.tdMoneyRight}>{fmtMoney(a.balance)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid #18181B' }}>
              <td style={{ ...styles.td, fontWeight: 700 }}>Total</td>
              <td style={styles.td}></td>
              <td style={{ ...styles.tdMoneyRight, fontWeight: 700 }}>{fmtMoney(cash)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* P&L */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Profit &amp; loss</h2>
        <div style={styles.plGrid}>
          <div>
            <div style={styles.plHeading}>Income</div>
            <CategoryTable rows={byIncomeCat} total={totals.income} />
          </div>
          <div>
            <div style={styles.plHeading}>Expenses</div>
            <CategoryTable rows={byExpenseCat} total={totals.expense} />
          </div>
        </div>
        <div style={styles.plNetLine}>
          <span>Net</span>
          <span style={{
            fontVariantNumeric: 'tabular-nums',
            color: totals.net >= 0 ? '#059669' : '#DC2626',
          }}>
            {totals.net >= 0 ? '+' : ''}{fmtMoney(totals.net)}
          </span>
        </div>
      </section>

      {/* Top merchants */}
      {topMerchants.length > 0 && (
        <section style={styles.section}>
          <h2 style={styles.h2}>Top merchants (expense)</h2>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Merchant</th>
                <th style={styles.thRight}>Transactions</th>
                <th style={styles.thRight}>Total spent</th>
              </tr>
            </thead>
            <tbody>
              {topMerchants.map(m => (
                <tr key={m.name}>
                  <td style={styles.td}>{m.name}</td>
                  <td style={{ ...styles.td, textAlign: 'right', color: '#71717A' }}>{m.count}</td>
                  <td style={styles.tdMoneyRight}>{fmtMoney(m.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Daily trend */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Daily cash flow</h2>
        <DailyTrend series={dailyTrend} />
      </section>

      {/* Transaction detail */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Transaction detail</h2>
        <table style={{ ...styles.table, fontSize: 11 }}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Description</th>
              <th style={styles.th}>Category</th>
              <th style={styles.th}>Account</th>
              <th style={styles.thRight}>In</th>
              <th style={styles.thRight}>Out</th>
            </tr>
          </thead>
          <tbody>
            {movements.map(m => (
              <tr key={m.id}>
                <td style={{ ...styles.td, whiteSpace: 'nowrap', color: '#71717A' }}>{fmtDateShort(new Date(m.occurred_at))}</td>
                <td style={styles.td}>{m.note || m.memo || '—'}</td>
                <td style={{ ...styles.td, color: '#71717A' }}>
                  {m.category?.name ?? <em style={{ color: '#A1A1AA' }}>Uncategorized</em>}
                </td>
                <td style={{ ...styles.td, color: '#71717A' }}>
                  {m.direction === 'transfer' && m.source && m.dest
                    ? `${m.source.name} → ${m.dest.name}`
                    : (m.source?.name ?? m.dest?.name ?? '—')
                  }
                </td>
                <td style={styles.tdMoneyRight}>{m.direction === 'income' ? fmtMoney(m.amount) : ''}</td>
                <td style={styles.tdMoneyRight}>{m.direction === 'expense' ? fmtMoney(m.amount) : ''}</td>
              </tr>
            ))}
            {movements.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...styles.td, textAlign: 'center', color: '#A1A1AA', padding: 40 }}>
                  No transactions in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <footer style={styles.footer}>
        Report generated by Checked · {fmtDateTime(new Date())}
      </footer>
    </div>
  )
}

// ================================================================
// Analysis helpers
// ================================================================

interface Totals { income: number; expense: number; net: number; movementCount: number; transferCount: number }

function computeTotals(ms: FinanceMovement[]): Totals {
  let income = 0, expense = 0, transferCount = 0
  for (const m of ms) {
    if (m.direction === 'income') income += m.amount
    else if (m.direction === 'expense') expense += m.amount
    else transferCount += 1
  }
  return {
    income: round2(income),
    expense: round2(expense),
    net: round2(income - expense),
    movementCount: ms.length,
    transferCount,
  }
}

interface CatRow { name: string; total: number; count: number; color: string | null }

function groupByCategory(ms: FinanceMovement[], dir: 'income' | 'expense'): CatRow[] {
  const map = new Map<string, CatRow>()
  for (const m of ms) {
    if (m.direction !== dir) continue
    const key = m.category?.name ?? 'Uncategorized'
    const existing = map.get(key)
    if (existing) {
      existing.total += m.amount
      existing.count += 1
    } else {
      map.set(key, {
        name: key,
        total: m.amount,
        count: 1,
        color: m.category?.color ?? null,
      })
    }
  }
  return [...map.values()]
    .map(r => ({ ...r, total: round2(r.total) }))
    .sort((a, b) => b.total - a.total)
}

interface MerchantRow { name: string; total: number; count: number }
function topMerchantsByExpense(ms: FinanceMovement[], limit: number): MerchantRow[] {
  const map = new Map<string, MerchantRow>()
  for (const m of ms) {
    if (m.direction !== 'expense') continue
    const key = (m.note || m.memo || 'Unknown').trim()
    if (!key || key === '—') continue
    const existing = map.get(key)
    if (existing) { existing.total += m.amount; existing.count += 1 }
    else map.set(key, { name: key, total: m.amount, count: 1 })
  }
  return [...map.values()]
    .map(r => ({ ...r, total: round2(r.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
}

interface DayPoint { date: string; income: number; expense: number }
function dailyCashFlow(ms: FinanceMovement[], from: Date, to: Date): DayPoint[] {
  const days: DayPoint[] = []
  const cursor = new Date(from)
  cursor.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(23, 59, 59, 999)
  while (cursor <= end) {
    days.push({ date: cursor.toISOString().slice(0, 10), income: 0, expense: 0 })
    cursor.setDate(cursor.getDate() + 1)
  }
  const byDay = new Map(days.map(d => [d.date, d]))
  for (const m of ms) {
    const key = m.occurred_at.slice(0, 10)
    const d = byDay.get(key)
    if (!d) continue
    if (m.direction === 'income') d.income += m.amount
    else if (m.direction === 'expense') d.expense += m.amount
  }
  return days.map(d => ({ ...d, income: round2(d.income), expense: round2(d.expense) }))
}

// ================================================================
// Small view pieces
// ================================================================

function SummaryCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{
      border: '1px solid #E4E4E7', borderRadius: 8, padding: '14px 16px', background: '#FAFAFA',
    }}>
      <div style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#71717A' }}>
        {label}
      </div>
      <div style={{
        marginTop: 6, fontSize: 24, fontWeight: 600, letterSpacing: '-0.03em', color: accent,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
    </div>
  )
}

function CategoryTable({ rows, total }: { rows: CatRow[]; total: number }) {
  if (rows.length === 0) {
    return <div style={{ color: '#A1A1AA', padding: '8px 0', fontSize: 12 }}>No entries.</div>
  }
  return (
    <table style={styles.table}>
      <tbody>
        {rows.map(r => {
          const pct = total > 0 ? Math.round((r.total / total) * 100) : 0
          return (
            <tr key={r.name}>
              <td style={styles.td}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    display: 'inline-block', width: 8, height: 8, borderRadius: 2,
                    background: r.color ?? '#D4D4D8',
                  }} />
                  {r.name}
                </span>
              </td>
              <td style={{ ...styles.td, color: '#71717A', textAlign: 'right', width: 60 }}>{pct}%</td>
              <td style={styles.tdMoneyRight}>{fmtMoney(r.total)}</td>
            </tr>
          )
        })}
        <tr style={{ borderTop: '2px solid #18181B' }}>
          <td style={{ ...styles.td, fontWeight: 700 }}>Total</td>
          <td style={styles.td}></td>
          <td style={{ ...styles.tdMoneyRight, fontWeight: 700 }}>{fmtMoney(total)}</td>
        </tr>
      </tbody>
    </table>
  )
}

function DailyTrend({ series }: { series: DayPoint[] }) {
  if (series.length === 0) return <div style={{ color: '#A1A1AA', fontSize: 12 }}>No data.</div>
  const max = Math.max(1, ...series.map(d => Math.max(d.income, d.expense)))
  const W = 720
  const H = 160
  const pad = 24
  const barW = (W - pad * 2) / series.length
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', maxWidth: '100%' }}>
      {/* baseline */}
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#E4E4E7" />
      {series.map((d, i) => {
        const x = pad + i * barW
        const inH = ((d.income / max) * (H - pad * 2))
        const outH = ((d.expense / max) * (H - pad * 2))
        return (
          <g key={d.date}>
            <rect
              x={x + barW * 0.15} y={H - pad - inH}
              width={barW * 0.35} height={inH}
              fill="#059669"
            />
            <rect
              x={x + barW * 0.5} y={H - pad - outH}
              width={barW * 0.35} height={outH}
              fill="#DC2626"
            />
          </g>
        )
      })}
      <text x={pad} y={12} fontSize={10} fill="#71717A">Money in (green) vs money out (red) — per day, scale to peak day</text>
    </svg>
  )
}

// ================================================================
// Formatting + styles
// ================================================================

function fmtMoney(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}
function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
function fmtDateShort(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
function fmtDateTime(d: Date): string {
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
}
function round2(n: number): number { return Math.round(n * 100) / 100 }

function labelForKind(k: string): string {
  return { pos: 'POS', cash: 'Cash', digital_wallet: 'Digital wallet', bank: 'Bank', other: 'Other' }[k] ?? k
}

const styles = {
  page: {
    maxWidth: 900, margin: '0 auto', padding: '24px 28px 60px',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
    color: '#18181B', background: '#FFFFFF', fontSize: 13, lineHeight: 1.5,
  },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24,
    paddingBottom: 12, borderBottom: '1px solid #E4E4E7',
  },
  toolbarLink: { color: '#3F3F46', textDecoration: 'none', fontSize: 12 },
  toolbarButton: {
    border: '1px solid #E4E4E7', background: '#FAFAFA', color: '#18181B',
    borderRadius: 6, padding: '6px 12px', textDecoration: 'none', fontSize: 12, fontWeight: 500,
  },
  cover: { marginBottom: 28 },
  h1: {
    fontSize: 28, fontWeight: 700, letterSpacing: '-0.03em',
    margin: '8px 0 4px', lineHeight: 1.1,
  },
  subtle: { color: '#71717A', fontSize: 12 },
  section: { marginTop: 28, breakInside: 'avoid' as const },
  h2: {
    fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em',
    textTransform: 'uppercase' as const, color: '#3F3F46',
    borderBottom: '2px solid #18181B', paddingBottom: 6, margin: '0 0 12px',
  },
  summaryGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10,
  },
  narration: { marginTop: 14, color: '#3F3F46', fontSize: 12.5 },
  table: {
    width: '100%', borderCollapse: 'collapse' as const, fontSize: 12,
  },
  th: {
    textAlign: 'left' as const, padding: '8px 8px', fontWeight: 600,
    color: '#71717A', fontSize: 11, textTransform: 'uppercase' as const,
    borderBottom: '1px solid #E4E4E7', letterSpacing: '0.05em',
  },
  thRight: {
    textAlign: 'right' as const, padding: '8px 8px', fontWeight: 600,
    color: '#71717A', fontSize: 11, textTransform: 'uppercase' as const,
    borderBottom: '1px solid #E4E4E7', letterSpacing: '0.05em',
  },
  td: {
    padding: '8px 8px', borderBottom: '1px solid #F4F4F5', verticalAlign: 'top' as const,
  },
  tdMoneyRight: {
    padding: '8px 8px', borderBottom: '1px solid #F4F4F5', textAlign: 'right' as const,
    fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const,
  },
  plGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 },
  plHeading: {
    fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase' as const,
    color: '#71717A', marginBottom: 8,
  },
  plNetLine: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 16, padding: '12px 8px', borderTop: '2px solid #18181B',
    fontSize: 14, fontWeight: 700,
  },
  footer: {
    marginTop: 40, paddingTop: 12, borderTop: '1px solid #E4E4E7',
    color: '#A1A1AA', fontSize: 10, textAlign: 'center' as const,
  },
}

const PRINT_CSS = `
  @media print {
    .no-print { display: none !important; }
    body { background: #fff !important; }
    section { page-break-inside: avoid; }
  }
  @page { size: letter; margin: 0.5in; }
`
