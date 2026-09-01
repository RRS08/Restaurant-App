// ----------------------------------------------------------------
// /finance/report — Cash-basis Profit & Loss, print-ready.
//
// Server component. Renders one sheet-on-desk layout in the Checked
// brand language (Geist / Geist Mono, ink #18181B, hairline #E7E6E2,
// desk #F1F0EC). Structure:
//
//   Cover        client-logo header
//   Accounts     tile balances + cash-on-hand total
//   P&L          revenue → COGS → gross profit → OpEx → net income
//   Two-up       top merchants  |  weekly cash flow
//   Detail       full transaction table
//   Footer       "Report by checked"
//
// Compute functions (computeTotals, groupByCategory,
// topMerchantsByExpense, pctDelta, dailyCashFlow) are the ones
// already in production — the design pass preserved them verbatim.
// Three new derivations layer on:
//
//   • weeklyBuckets  — chunk daily trend into 7-day windows,
//                       DROP any trailing partial week so the
//                       chart never lies about a half-week's low.
//   • cogs split     — category-name whitelist (inventory / product
//                       cost / cogs / cost of goods / food cost).
//   • transfer label — strip a leading "Chase " (or any prefixed
//                       bank name) from paired-transfer accounts.
//
// Print CSS uses div-grid rows (not <table>) and NEVER
// overflow:hidden on cards — both would make the browser treat a
// section as unsplittable and leave large blank gaps at page
// breaks. Each row carries `break-inside: avoid` and each card /
// column header carries `break-after: avoid` so headings stay
// glued to their first row.
//
// Client logo: read from sites.config.logo_url for this restaurant.
// If no site row exists, or logo_url is unset, the corner is blank
// (no Checked-mark fallback — the footer signature carries that).
// ----------------------------------------------------------------

import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveActivePlace } from '@/lib/places'
import { listAccounts, listMovements, cashOnHand } from '@/lib/finance/data'
import type { FinanceAccount, FinanceMovement } from '@/lib/finance/types'
import PrintButton from './print-button'
import ComingSoon from '@/components/coming-soon'

export const metadata = { title: 'Cash-basis P&L · Checked' }

const REPORT_DAYS_DEFAULT = 30

interface Search { days?: string; embedded?: string; period?: string }

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
  const embedded = search.embedded === '1'

  // Two windowing modes:
  //   • `?period=YYYY-MM` → the calendar month of that period.
  //     Report + prior-period stats scope to that whole month
  //     regardless of today's date. Header shows "MonthName Year"
  //     and duration = days in that month. Used by the Report
  //     modal (which threads the picked period through from the
  //     Finance page's calendar).
  //   • `?days=N` (or default 30) → rolling last-N-days window
  //     ending today. Used when someone opens the report directly
  //     without a period selection.
  const periodMonth = parsePeriodParam(search.period)
  const win = periodMonth
    ? monthWindow(periodMonth)
    : rollingWindow(Math.max(1, Math.min(365, parseInt(search.days ?? '', 10) || REPORT_DAYS_DEFAULT)))
  const { from, to, days, periodLabel } = win
  const { priorFrom, priorTo } = periodMonth
    ? { priorFrom: firstOfPrevMonth(periodMonth), priorTo: lastOfPrevMonth(periodMonth) }
    : { priorFrom: new Date(from.getTime() - days * 24 * 60 * 60 * 1000), priorTo: from }

  // Client logo lookup — sites.config.logo_url for this restaurant,
  // if any site exists at all. Live site preferred over drafts;
  // absent = blank corner (footer signature stays as-is).
  const { data: siteRow } = await admin
    .from('sites')
    .select('config, status')
    .eq('restaurant_id', restaurantId)
    .order('status', { ascending: true })  // 'live' < 'draft' alphabetically? use JS filter instead
    .limit(1)
    .maybeSingle()
  const logoUrl = resolveLogoUrl(siteRow)

  const [accounts, movements, priorMovements, { data: restaurantRow }] = await Promise.all([
    listAccounts(admin, restaurantId, { locationId: activePlace?.id ?? null }),
    listMovements(admin, restaurantId, { from, to, limit: 5000 }),
    listMovements(admin, restaurantId, { from: priorFrom, to: priorTo, limit: 5000 }),
    admin.from('restaurants').select('name').eq('id', restaurantId).maybeSingle(),
  ])

  const restaurantName = (restaurantRow as { name?: string } | null)?.name ?? 'Business'
  const placeName = activePlace?.name ?? null

  return (
    <ReportView
      restaurantName={restaurantName}
      placeName={placeName}
      logoUrl={logoUrl}
      accounts={accounts}
      movements={movements}
      priorMovements={priorMovements}
      embedded={embedded}
      from={from}
      to={to}
      days={days}
      periodLabel={periodLabel}
      isPeriodMode={periodMonth !== null}
    />
  )
}

/** `?period=YYYY-MM` → first-of-that-month Date, else null. */
function parsePeriodParam(raw: string | undefined): Date | null {
  if (!raw) return null
  const m = /^(\d{4})-(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const y = parseInt(m[1], 10)
  const mo = parseInt(m[2], 10)
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return null
  if (mo < 1 || mo > 12 || y < 2000 || y > 2100) return null
  const out = new Date(y, mo - 1, 1)
  out.setHours(0, 0, 0, 0)
  return out
}

/** Rolling last-N-days window, ending now. */
function rollingWindow(days: number): { from: Date; to: Date; days: number; periodLabel: string | null } {
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  return { from, to, days, periodLabel: null }
}

/** Full calendar-month window for the first-of-month date given.
 *  `to` clamps at "now" when the picked month is the current one
 *  so future-day movements never distort the report. */
function monthWindow(firstOfMonth: Date): { from: Date; to: Date; days: number; periodLabel: string } {
  const from = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth(), 1)
  from.setHours(0, 0, 0, 0)
  const monthEnd = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() + 1, 1)
  monthEnd.setMilliseconds(-1)
  const now = new Date()
  const to = monthEnd > now ? now : monthEnd
  const days = Math.round((monthEnd.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))
  const periodLabel = from.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  return { from, to, days, periodLabel }
}

function firstOfPrevMonth(firstOfMonth: Date): Date {
  const out = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() - 1, 1)
  out.setHours(0, 0, 0, 0)
  return out
}
function lastOfPrevMonth(firstOfMonth: Date): Date {
  const out = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth(), 1)
  out.setMilliseconds(-1)
  return out
}

/** Extract a logo URL from a sites row's JSONB config. Returns
 *  null when there's no site, no config, no logo_url string, or
 *  the value is an empty / whitespace-only string. */
function resolveLogoUrl(siteRow: unknown): string | null {
  if (!siteRow) return null
  const config = (siteRow as { config?: Record<string, unknown> }).config
  if (!config || typeof config !== 'object') return null
  const raw = (config as { logo_url?: unknown }).logo_url
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

// ================================================================
// Report body
// ================================================================

interface ViewProps {
  restaurantName: string
  placeName: string | null
  logoUrl: string | null
  accounts: FinanceAccount[]
  movements: FinanceMovement[]
  priorMovements: FinanceMovement[]
  embedded: boolean
  from: Date
  to: Date
  days: number
  /** "September 2026" when the report was opened for a specific
   *  month; null on the default rolling window. */
  periodLabel: string | null
  /** True when the window is a calendar month (picker), false on
   *  the rolling default. Drives copy in a couple of spots. */
  isPeriodMode: boolean
}

/** Category names that count as Cost of Goods Sold for a small
 *  retailer / food business. Held as a whitelist so a merchant
 *  renaming "Inventory" to "Product cost" doesn't silently lose
 *  the COGS classification. */
const COGS_CATEGORY_NAMES = new Set(['inventory', 'product cost', 'cogs', 'cost of goods', 'food cost'])

function ReportView({
  restaurantName, placeName, logoUrl,
  accounts, movements, priorMovements,
  embedded,
  from, to, days,
  periodLabel, isPeriodMode,
}: ViewProps) {
  const totals = computeTotals(movements)
  const priorTotals = computeTotals(priorMovements)
  const byIncomeCat = groupByCategory(movements, 'income')
  const byExpenseCat = groupByCategory(movements, 'expense')
  const cogsRows = byExpenseCat.filter(r => COGS_CATEGORY_NAMES.has(r.name.toLowerCase()))
  const opexRows = byExpenseCat.filter(r => !COGS_CATEGORY_NAMES.has(r.name.toLowerCase()))
  const cogsTotal = round2(cogsRows.reduce((s, r) => s + r.total, 0))
  const opexTotal = round2(opexRows.reduce((s, r) => s + r.total, 0))
  const grossProfit = round2(totals.income - cogsTotal)
  const grossMargin = totals.income > 0 ? Math.round((grossProfit / totals.income) * 100) : null
  const netMargin = totals.income > 0 ? Math.round((totals.net / totals.income) * 100) : null
  const topMerchants = topMerchantsByExpense(movements, 10)
  const dailyTrend = dailyCashFlow(movements, from, to)
  const weeklyBars = weeklyBuckets(dailyTrend)
  const cash = cashOnHand(accounts)
  const detailRows = [...movements].sort(
    (a, b) => b.occurred_at.localeCompare(a.occurred_at)
  )

  return (
    <div
      style={{
        ...styles.desk,
        ...(embedded ? { padding: '24px 16px 32px', background: '#F1F0EC' } : null),
      }}
      data-desk
    >
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      {embedded && <style dangerouslySetInnerHTML={{ __html: EMBED_CSS }} />}

      <div style={styles.frame}>
        {/* Toolbar hidden on print AND in embedded mode (the modal
            supplies its own Print / Download CSV chrome). */}
        {!embedded && (
          <div className="no-print" style={styles.toolbar}>
            <Link href="/finance" style={styles.toolbarLink}>← Back to Finance</Link>
            <div style={{ flex: 1 }} />
            <Link href={`/finance/report/csv?days=${days}`} style={styles.toolbarButton}>
              Download CSV
            </Link>
            <PrintButton />
          </div>
        )}

        {/* Sheet — the printable surface. All chrome (desk bg,
            border, radius, shadow, toolbar) drops on print via
            [data-sheet] selectors in PRINT_CSS. */}
        <div style={styles.sheet} data-sheet>

          {/* Cover header */}
          <header style={styles.header}>
            <div style={{ minWidth: 0 }}>
              <div style={styles.headerEyebrow}>Cash-basis profit &amp; loss</div>
              <div style={styles.headerTitle}>
                {restaurantName}
                {placeName && <span style={styles.headerTitleSubtle}> — {placeName}</span>}
              </div>
              <div style={styles.headerDates}>
                {periodLabel
                  ? <>{periodLabel} <span style={{ color: '#D6D5D1' }}>·</span> {fmtDate(from)} — {fmtDate(to)}</>
                  : <>{fmtDate(from)} — {fmtDate(to)} <span style={{ color: '#D6D5D1' }}>·</span> {days} days</>
                }
              </div>
            </div>
            {logoUrl && (
              // Client logo — server-fetched from sites.config.logo_url.
              // No alt-text noise; if the src 404s the img simply
              // collapses to nothing (no fallback badge, per spec).
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt={restaurantName}
                style={styles.headerLogo}
              />
            )}
          </header>

          {/* Accounts card. In historical mode (a picked past
              month) the eyebrow says "As of today" instead of
              "Current balances" so a report from July doesn't
              misread as end-of-July balances — we always show the
              live number, period stats are for movements only. */}
          <Card>
            <CardHeader
              title="Accounts"
              eyebrow={isPeriodMode ? `As of ${fmtDate(new Date())}` : 'Current balances'}
            />
            <ColumnHeader columns="1fr 150px 150px">
              <span>Account</span>
              <span>Type</span>
              <span style={{ textAlign: 'right' }}>Balance</span>
            </ColumnHeader>
            {accounts.map(a => (
              <GridRow key={a.id} columns="1fr 150px 150px">
                <span style={styles.rowName}>{a.name}</span>
                <span style={styles.rowMuted}>{labelForKind(a.kind)}</span>
                <span style={styles.rowMoney}>{fmtMoney(a.balance)}</span>
              </GridRow>
            ))}
            <SubtotalRow columns="1fr 150px" label="Total" value={fmtMoney(cash)} strong />
          </Card>

          {/* P&L card */}
          <Card style={{ marginTop: 22 }}>
            <CardHeader title="Profit & loss" eyebrow={`Cash basis · ${days} days`} />
            <div style={{ padding: '4px 18px 18px' }}>
              {/* Revenue */}
              <SectionEyebrow>Revenue</SectionEyebrow>
              {byIncomeCat.length === 0
                ? <EmptyLine>No revenue yet.</EmptyLine>
                : byIncomeCat.map(r => (
                    <PLRow key={r.name} row={r} total={totals.income} />
                  ))
              }
              <PLSubtotalLine label="Total revenue" value={fmtMoney(totals.income)} />

              {/* COGS */}
              <SectionEyebrow style={{ marginTop: 18 }}>Cost of goods sold</SectionEyebrow>
              {cogsRows.length === 0 ? (
                <EmptyLine>
                  No COGS categorized yet. Tag inventory / product-cost rows to see gross profit here.
                </EmptyLine>
              ) : cogsRows.map(r => (
                <PLRow key={r.name} row={r} total={cogsTotal} />
              ))}
              <PLTotalLine
                label="Gross profit"
                value={fmtMoney(grossProfit)}
                margin={grossMargin}
                color={grossProfit >= 0 ? INK : NEG}
              />

              {/* OpEx */}
              <SectionEyebrow style={{ marginTop: 18 }}>Operating expenses</SectionEyebrow>
              {opexRows.length === 0
                ? <EmptyLine>No operating expenses.</EmptyLine>
                : opexRows.map(r => (
                    <PLRow key={r.name} row={r} total={opexTotal} />
                  ))
              }
              <PLSubtotalLine label="Total operating expenses" value={fmtMoney(opexTotal)} />

              {/* Net income */}
              <div style={styles.plNetLine}>
                <span style={{ fontSize: 14, letterSpacing: '-0.01em' }}>Net income</span>
                <span style={{
                  ...styles.plNetValue,
                  color: totals.net >= 0 ? POS : NEG,
                }}>
                  {totals.net >= 0 ? '+' : ''}{fmtMoney(totals.net)}
                  {netMargin !== null && (
                    <span style={styles.plMarginPill}>{netMargin}% margin</span>
                  )}
                </span>
              </div>

              {/* Prior-period comparison strip — moved off the KPI
                  cards (design dropped them) into a quiet trailing
                  line under Net income so a merchant still reads
                  change, not just level. */}
              {hasAnyDelta(totals, priorTotals) && (
                <div style={styles.priorStrip}>
                  <span style={styles.priorLabel}>vs prior {days} days</span>
                  <DeltaPill label="revenue" delta={pctDelta(totals.income, priorTotals.income)} />
                  <DeltaPill label="expenses" delta={pctDelta(totals.expense, priorTotals.expense, true)} />
                  <DeltaPill label="net" delta={pctDelta(totals.net, priorTotals.net)} />
                </div>
              )}
            </div>
          </Card>

          {/* Two-up: top merchants | weekly cash flow */}
          <div style={styles.twoUp}>
            <Card style={{ display: 'flex', flexDirection: 'column' }}>
              <CardHeader title="Top merchants" eyebrow="By spend" />
              {topMerchants.length === 0
                ? <EmptyLine style={{ padding: '12px 18px' }}>No expenses to rank yet.</EmptyLine>
                : topMerchants.map((m, i) => (
                    <div key={m.name} style={styles.merchantRow}>
                      <span style={styles.merchantRank}>{i + 1}</span>
                      <span style={styles.merchantName}>{m.name}</span>
                      <span style={styles.merchantCount}>{m.count}×</span>
                      <span style={styles.merchantTotal}>{fmtMoney(m.total)}</span>
                    </div>
                  ))
              }
            </Card>

            <Card style={{ display: 'flex', flexDirection: 'column' }}>
              <CardHeader title="Weekly cash flow" eyebrow="In vs out" />
              {weeklyBars.length === 0 ? (
                <EmptyLine style={{ padding: '12px 18px' }}>Not enough history for a full week yet.</EmptyLine>
              ) : (
                <div style={styles.weekBody}>
                  {weeklyBars.map(w => (
                    <div key={w.startIso} style={styles.weekRow}>
                      <div style={styles.weekRowHeader}>
                        <span style={{ fontSize: 12, color: MUTED }}>
                          {fmtDateShort(new Date(w.startIso + 'T12:00:00Z'))} — {fmtDateShort(new Date(w.endIso + 'T12:00:00Z'))}
                        </span>
                        <span style={{
                          ...styles.weekNet,
                          color: w.net >= 0 ? POS : NEG,
                        }}>
                          {w.net >= 0 ? '+' : ''}{fmtMoney(w.net)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 5 }}>
                        <div style={styles.weekBarRow}>
                          <div style={styles.weekTrack}>
                            <div style={{ ...styles.weekFill, background: POS, width: `${w.inPct}%` }} />
                          </div>
                          <span style={styles.weekAmt}>{fmtMoney(w.income)}</span>
                        </div>
                        <div style={styles.weekBarRow}>
                          <div style={styles.weekTrack}>
                            <div style={{ ...styles.weekFill, background: NEG, width: `${w.outPct}%` }} />
                          </div>
                          <span style={styles.weekAmt}>{fmtMoney(w.expense)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div style={styles.weekLegend}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, background: POS, borderRadius: 2, display: 'inline-block' }} />
                  Money in
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, background: NEG, borderRadius: 2, display: 'inline-block' }} />
                  Money out
                </span>
              </div>
            </Card>
          </div>

          {/* Transaction detail */}
          <Card style={{ marginTop: 22 }}>
            <CardHeader
              title="Transaction detail"
              eyebrow={`${detailRows.length} movement${detailRows.length === 1 ? '' : 's'}`}
            />
            <ColumnHeader columns={DETAIL_COLS}>
              <span>Date</span>
              <span>Description</span>
              <span>Category</span>
              <span>Account</span>
              <span style={{ textAlign: 'right' }}>In</span>
              <span style={{ textAlign: 'right' }}>Out</span>
            </ColumnHeader>
            {detailRows.length === 0 ? (
              <div style={{ padding: '32px 18px', textAlign: 'center', color: '#A1A1A6', fontSize: 12 }}>
                No transactions in this window.
              </div>
            ) : detailRows.map(m => {
              const isTransfer = m.direction === 'transfer' && m.source && m.dest
              const account = isTransfer
                ? `${stripBankPrefix(m.source!.name)} → ${stripBankPrefix(m.dest!.name)}`
                : (m.source?.name ?? m.dest?.name ?? '—')
              return (
                <GridRow key={m.id} columns={DETAIL_COLS} style={{ fontSize: 12 }}>
                  <span style={styles.detailDate}>{fmtDateShort(new Date(m.occurred_at))}</span>
                  <span style={styles.detailDesc}>{m.note || m.memo || '—'}</span>
                  <span style={styles.detailCat}>
                    <span style={{
                      display: 'inline-block', width: 7, height: 7, borderRadius: 2,
                      background: m.category?.color ?? '#D6D5D1', flex: '0 0 auto',
                    }} />
                    <span style={styles.detailCatName}>
                      {m.category?.name ?? 'Uncategorized'}
                    </span>
                  </span>
                  <span style={styles.detailAcct}>{account}</span>
                  <span style={{ ...styles.detailAmt, color: m.direction === 'income' ? POS : INK }}>
                    {m.direction === 'income' ? fmtMoney(m.amount) : ''}
                  </span>
                  <span style={styles.detailAmt}>
                    {m.direction === 'expense' ? fmtMoney(m.amount) : ''}
                  </span>
                </GridRow>
              )
            })}
          </Card>

          {/* Footer signature */}
          <footer style={styles.footer}>
            <span style={styles.footerSignature}>
              <span style={{ fontSize: 10.5, color: '#A1A1A6' }}>Report by</span>
              {/* Checked mark cropped to the clipboard glyph (viewBox
                  18 8 28 48) matches the spec's print signature. */}
              <svg
                width="8.75"
                height="15"
                viewBox="18 8 28 48"
                role="img"
                aria-label="Checked"
                style={{ display: 'block', flex: 'none' }}
              >
                <path
                  d="M24 10h16a4 4 0 0 1 4 4v36a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4z"
                  fill="#18181B"
                />
                <rect x="26" y="16" width="14" height="3" rx="1.5" fill="#FAF9F6" />
                <rect x="26" y="23" width="11" height="3" rx="1.5" fill="#FAF9F6" />
                <rect x="26" y="30" width="8" height="3" rx="1.5" fill="#FAF9F6" />
                <path
                  d="M27 41l4 4 8-9"
                  fill="none"
                  stroke="#FAF9F6"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.02em' }}>checked</span>
            </span>
          </footer>

        </div>
      </div>
    </div>
  )
}

// ================================================================
// Compute helpers — kept verbatim from production
// ================================================================

interface Totals { income: number; expense: number; net: number; movementCount: number; transferCount: number; personalCount: number }

function computeTotals(ms: FinanceMovement[]): Totals {
  let income = 0, expense = 0, transferCount = 0, personalCount = 0
  for (const m of ms) {
    if (m.direction === 'transfer') { transferCount += 1; continue }
    if (m.category?.kind === 'transfer') { personalCount += 1; continue }
    if (m.direction === 'income') income += m.amount
    else if (m.direction === 'expense') expense += m.amount
  }
  return {
    income: round2(income),
    expense: round2(expense),
    net: round2(income - expense),
    movementCount: ms.length,
    transferCount,
    personalCount,
  }
}

interface CatRow { name: string; total: number; count: number; color: string | null }

function groupByCategory(ms: FinanceMovement[], dir: 'income' | 'expense'): CatRow[] {
  const map = new Map<string, CatRow>()
  for (const m of ms) {
    if (m.direction !== dir) continue
    if (m.category?.kind === 'transfer') continue
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
    if (m.category?.kind === 'transfer') continue
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

/** Chunk the daily trend into 7-day windows. Drops any trailing
 *  partial week so a half-week's income doesn't display as a
 *  short bar next to full weeks. Bar widths scale to the peak
 *  weekly in/out across the whole window (min 2% so a nonzero
 *  value never renders as invisible). */
interface WeekBar {
  startIso: string
  endIso: string
  income: number
  expense: number
  net: number
  inPct: number
  outPct: number
}
function weeklyBuckets(series: DayPoint[]): WeekBar[] {
  const chunks: DayPoint[][] = []
  for (let i = 0; i + 7 <= series.length; i += 7) chunks.push(series.slice(i, i + 7))
  if (chunks.length === 0) return []
  const raw = chunks.map(w => ({
    startIso: w[0].date,
    endIso: w[w.length - 1].date,
    income: round2(w.reduce((s, d) => s + d.income, 0)),
    expense: round2(w.reduce((s, d) => s + d.expense, 0)),
  }))
  const peak = Math.max(
    1,
    ...raw.map(w => Math.max(w.income, w.expense)),
  )
  return raw.map(w => ({
    ...w,
    net: round2(w.income - w.expense),
    inPct: w.income > 0 ? Math.max(2, Math.round((w.income / peak) * 100)) : 0,
    outPct: w.expense > 0 ? Math.max(2, Math.round((w.expense / peak) * 100)) : 0,
  }))
}

/** Percentage delta between the current and prior period.
 *  `inverseGood=true` flips the color logic — for "Expenses,"
 *  a decrease is good and reads green. */
function pctDelta(current: number, prior: number, inverseGood = false): { pct: number; positive: boolean } | null {
  if (prior === 0) return null
  const raw = ((current - prior) / Math.abs(prior)) * 100
  const rounded = Math.round(raw)
  if (rounded === 0) return null
  const positive = inverseGood ? rounded < 0 : rounded > 0
  return { pct: rounded, positive }
}

function hasAnyDelta(cur: Totals, prior: Totals): boolean {
  return pctDelta(cur.income, prior.income) !== null ||
         pctDelta(cur.expense, prior.expense) !== null ||
         pctDelta(cur.net, prior.net) !== null
}

/** Strip a leading bank-brand word from a transfer account label
 *  so "Chase Checking ··4321 → Chase Savings ··2359" reads as
 *  "Checking ··4321 → Savings ··2359." Purely cosmetic. */
function stripBankPrefix(name: string): string {
  return name.replace(/^(Chase|Bank of America|BofA|Wells Fargo|Citibank|Capital One|US Bank|PNC)\s+/i, '')
}

// ================================================================
// Layout primitives
// ================================================================

const INK = '#18181B'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const LINE = '#E7E6E2'
const ROW_LINE = '#F0EFEB'
const SURFACE = '#FAFAF9'
const DESK = '#F1F0EC'
const PAPER = '#FFFFFF'
const POS = '#059669'
const NEG = '#DC2626'

const DETAIL_COLS = '54px 1fr 118px 158px 86px 86px'
const FONT = "'Geist', system-ui, -apple-system, Segoe UI, sans-serif"
const MONO = "'Geist Mono', ui-monospace, monospace"

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section
      data-sec
      style={{
        border: `1px solid ${LINE}`,
        borderRadius: 14,
        background: PAPER,
        marginTop: 22,
        ...style,
      }}
    >
      {children}
    </section>
  )
}

function CardHeader({ title, eyebrow }: { title: string; eyebrow?: string }) {
  return (
    <div data-header style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      gap: 12, padding: '15px 18px 12px',
    }}>
      <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em' }}>{title}</span>
      {eyebrow && (
        <span style={styles.eyebrowSm}>{eyebrow}</span>
      )}
    </div>
  )
}

function SectionEyebrow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
      color: FAINT, textTransform: 'uppercase',
      padding: '8px 0 4px',
      ...style,
    }}>
      {children}
    </div>
  )
}

function ColumnHeader({ columns, children }: { columns: string; children: React.ReactNode }) {
  return (
    <div data-colhead style={{
      display: 'grid', gridTemplateColumns: columns, gap: '0 12px',
      padding: '7px 18px', borderTop: `1px solid ${ROW_LINE}`, background: SURFACE,
      fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.12em',
      color: FAINT, textTransform: 'uppercase',
    }}>
      {children}
    </div>
  )
}

function GridRow({
  columns, children, style,
}: {
  columns: string
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div data-row style={{
      display: 'grid', gridTemplateColumns: columns, gap: '0 12px',
      alignItems: 'center', padding: '10px 18px',
      borderTop: `1px solid ${ROW_LINE}`,
      ...style,
    }}>
      {children}
    </div>
  )
}

function SubtotalRow({
  columns, label, value, strong,
}: {
  columns: string
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: columns, gap: '0 12px',
      alignItems: 'center', padding: '11px 18px', borderTop: `1px solid ${INK}`,
    }}>
      <span style={{ fontWeight: strong ? 600 : 500 }}>{label}</span>
      <span style={{
        fontFamily: MONO, fontSize: strong ? 13.5 : 13, fontWeight: strong ? 600 : 500,
        letterSpacing: '-0.02em', textAlign: 'right',
      }}>{value}</span>
    </div>
  )
}

function PLRow({ row, total }: { row: CatRow; total: number }) {
  const pct = total > 0 ? Math.round((row.total / total) * 100) : 0
  return (
    <div data-row style={{
      display: 'grid', gridTemplateColumns: '1fr 64px 130px', gap: '0 12px',
      alignItems: 'center', padding: '8px 0', borderTop: `1px solid ${ROW_LINE}`,
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: 2,
          background: row.color ?? '#D6D5D1', flex: '0 0 auto',
        }} />
        <span style={{ fontWeight: 500, letterSpacing: '-0.01em' }}>{row.name}</span>
      </span>
      <span style={{ fontFamily: MONO, fontSize: 11.5, color: FAINT, textAlign: 'right' }}>
        {pct}%
      </span>
      <span style={{
        fontFamily: MONO, fontSize: 13, fontWeight: 500,
        letterSpacing: '-0.02em', textAlign: 'right',
      }}>{fmtMoney(row.total)}</span>
    </div>
  )
}

function PLSubtotalLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '9px 0', borderTop: `1px solid #D6D5D1`, fontWeight: 600,
    }}>
      <span style={{ fontSize: 12.5 }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 13, letterSpacing: '-0.02em' }}>{value}</span>
    </div>
  )
}

function PLTotalLine({
  label, value, margin, color,
}: {
  label: string
  value: string
  margin: number | null
  color: string
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 0', borderTop: `1px solid ${INK}`, fontWeight: 600,
    }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: 13.5, letterSpacing: '-0.02em', color }}>
        {value}
        {margin !== null && (
          <span style={styles.plMarginPill}>{margin}% margin</span>
        )}
      </span>
    </div>
  )
}

function DeltaPill({ label, delta }: { label: string; delta: { pct: number; positive: boolean } | null }) {
  if (!delta) return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
      <span style={{
        fontFamily: MONO, fontSize: 12, fontWeight: 600,
        color: delta.positive ? POS : NEG,
      }}>
        {delta.positive ? '↑' : '↓'} {Math.abs(delta.pct)}%
      </span>
      <span style={{ fontSize: 11, color: MUTED }}>{label}</span>
    </span>
  )
}

function EmptyLine({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      color: FAINT, padding: '10px 0', fontSize: 12,
      ...style,
    }}>{children}</div>
  )
}

// ================================================================
// Formatting
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
function round2(n: number): number { return Math.round(n * 100) / 100 }

function labelForKind(k: string): string {
  return ({ pos: 'POS', cash: 'Cash', digital_wallet: 'Digital wallet', bank: 'Bank', other: 'Other' } as Record<string, string>)[k] ?? k
}

// ================================================================
// Styles
// ================================================================

const styles: Record<string, React.CSSProperties> = {
  desk: {
    minHeight: '100vh',
    padding: '28px 24px 64px',
    background: DESK,
    fontFamily: FONT,
    color: INK,
    fontSize: 13,
    lineHeight: 1.5,
  },
  frame: { maxWidth: 880, margin: '0 auto' },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 8,
    marginBottom: 16,
  },
  toolbarLink: {
    fontSize: 12.5, fontWeight: 500, textDecoration: 'none',
    color: '#52525B', padding: '0 4px',
  },
  toolbarButton: {
    border: `1px solid ${LINE}`, background: PAPER, color: INK,
    borderRadius: 10, height: 34, padding: '0 14px',
    fontSize: 13, fontWeight: 500, textDecoration: 'none',
    display: 'inline-flex', alignItems: 'center',
  },
  sheet: {
    background: PAPER, border: `1px solid ${LINE}`, borderRadius: 16,
    padding: '44px 48px 36px',
    boxShadow: '0 1px 2px rgba(24,24,27,0.04)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 24,
  },
  headerEyebrow: {
    fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em',
    color: FAINT, textTransform: 'uppercase',
  },
  headerTitle: {
    fontSize: 29, fontWeight: 700, letterSpacing: '-0.035em',
    margin: '10px 0 6px', lineHeight: 1.1,
  },
  headerTitleSubtle: { color: FAINT, fontWeight: 500 },
  headerDates: { fontFamily: MONO, fontSize: 11.5, color: MUTED },
  headerLogo: {
    height: 92, width: 'auto', maxWidth: 300,
    objectFit: 'contain', flex: '0 0 auto',
  },
  eyebrowSm: {
    fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
    color: FAINT, textTransform: 'uppercase',
  },
  rowName: { fontWeight: 500, letterSpacing: '-0.01em' },
  rowMuted: { fontSize: 12, color: MUTED },
  rowMoney: {
    fontFamily: MONO, fontSize: 13, fontWeight: 500,
    letterSpacing: '-0.02em', textAlign: 'right',
  },
  plMarginPill: {
    fontFamily: FONT, fontSize: 11, color: FAINT,
    fontWeight: 400, marginLeft: 6,
  },
  plNetLine: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 14, padding: '12px 0 2px',
    borderTop: `2px solid ${INK}`, fontWeight: 700,
  },
  plNetValue: {
    fontFamily: MONO, fontSize: 15, letterSpacing: '-0.02em',
  },
  priorStrip: {
    display: 'flex', alignItems: 'baseline', gap: 14,
    flexWrap: 'wrap',
    marginTop: 10, paddingTop: 8, borderTop: `1px dashed ${ROW_LINE}`,
  },
  priorLabel: {
    fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
    color: FAINT, textTransform: 'uppercase',
  },
  twoUp: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: 22, marginTop: 22, alignItems: 'stretch',
  },
  merchantRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 18px', borderTop: `1px solid ${ROW_LINE}`,
  },
  merchantRank: {
    fontFamily: MONO, fontSize: 10, color: FAINT,
    width: 16, textAlign: 'right', flex: '0 0 auto',
  },
  merchantName: {
    flex: 1, fontSize: 12.5, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  merchantCount: {
    fontFamily: MONO, fontSize: 11, color: FAINT, flex: '0 0 auto',
  },
  merchantTotal: {
    fontFamily: MONO, fontSize: 12.5, fontWeight: 600,
    letterSpacing: '-0.02em', minWidth: 80, textAlign: 'right', flex: '0 0 auto',
  },
  weekBody: {
    flex: 1, display: 'flex', flexDirection: 'column',
    justifyContent: 'space-evenly',
  },
  weekRow: { padding: '7px 18px', borderTop: `1px solid ${ROW_LINE}` },
  weekRowHeader: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10,
  },
  weekNet: {
    fontFamily: MONO, fontSize: 12.5, fontWeight: 600, letterSpacing: '-0.02em',
  },
  weekBarRow: { display: 'flex', alignItems: 'center', gap: 8 },
  weekTrack: {
    flex: 1, height: 5, borderRadius: 3, background: ROW_LINE, overflow: 'hidden',
  },
  weekFill: { height: '100%', borderRadius: 3 },
  weekAmt: {
    fontFamily: MONO, fontSize: 10.5, color: FAINT,
    width: 62, textAlign: 'right', flex: '0 0 auto',
  },
  weekLegend: {
    display: 'flex', gap: 14,
    padding: '10px 18px 13px', borderTop: `1px solid ${ROW_LINE}`,
    fontSize: 11, color: MUTED,
  },
  detailDate: {
    fontFamily: MONO, fontSize: 11, color: FAINT, whiteSpace: 'nowrap',
  },
  detailDesc: {
    fontWeight: 500, letterSpacing: '-0.01em',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  detailCat: {
    display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0,
  },
  detailCatName: {
    fontSize: 11.5, color: MUTED,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  detailAcct: { fontSize: 11.5, color: MUTED, lineHeight: 1.35 },
  detailAmt: {
    fontFamily: MONO, fontSize: 12, fontWeight: 500,
    letterSpacing: '-0.02em', textAlign: 'right', whiteSpace: 'nowrap',
    color: INK,
  },
  footer: {
    marginTop: 28,
    display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', gap: 24,
  },
  footerSignature: {
    display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto',
  },
}

// ================================================================
// Print CSS — div-grid rows (not <table>), no overflow:hidden on
// cards, break-inside: avoid on every row, break-after: avoid on
// every card + column header. Anything else and the browser leaves
// large blank gaps at page boundaries.
// ================================================================

// Embedded mode — nuke the (app) shell chrome that the parent
// layout renders around every protected page. The report is
// loaded inside a modal iframe on /finance; the operator should
// see only the sheet, not a second sidebar / rail / phone tab
// bar. Selectors match the exact class combinations AppShell
// uses (see app/(app)/app-shell.tsx). Layout-fragile by design;
// the app shell isn't going to churn.
const EMBED_CSS = `
  div.fixed.inset-y-0.left-0 { display: none !important; }
  main.md\\:pl-14, main[class*="pl-14"], main[class*="pl-60"] {
    padding-left: 0 !important;
  }
  .md\\:hidden { display: none !important; }
`

const PRINT_CSS = `
  @media print {
    .no-print { display: none !important; }
    [data-desk] {
      padding: 0 !important;
      background: #fff !important;
      min-height: 0 !important;
    }
    [data-sheet] {
      border: none !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      padding: 0 !important;
    }
    [data-sec] { break-inside: auto; page-break-inside: auto; }
    [data-row] { break-inside: avoid; page-break-inside: avoid; }
    [data-header], [data-colhead] {
      break-after: avoid; page-break-after: avoid;
      break-inside: avoid;
    }
    [data-sec] {
      background: #fff !important;
    }
  }
  @page { size: letter; margin: 0.5in; }
`
