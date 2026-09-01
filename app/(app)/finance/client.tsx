'use client'

// ----------------------------------------------------------------
// Finance client — cash-flow dashboard.
//
// v1 layout mirrors the design mockup exactly:
//   Header:  cash on hand ($8,430.67) · +$X in this week ·
//            -$Y out · [date-range picker] · [Add expense]
//   Tiles:   adaptive grid, one per account, auto-fills columns
//            so 3 tiles look right, so do 5, so do 8.
//   Every movement: filter chips (All / one per account /
//            Expenses) + row list with icon + title + meta line +
//            amount (green + / red - / muted transfers).
//
// The Add-expense / Add-account drawers land in the next commit;
// v1 header CTA is present but disabled with a hint so we can
// eyeball the surface first.
// ----------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { makeT, type Lang } from '@/lib/i18n'
import { addExpense, bridgePlaidAccountsToFinance, disconnectFinanceAccount } from '@/app/actions/finance'
import { createPlaidLinkToken, exchangePlaidPublicToken } from '@/app/actions/bank'
import type {
  FinanceAccount,
  FinanceCategory,
  FinanceMovement,
  FinanceAccountKind,
  FinanceMovementDirection,
} from '@/lib/finance/types'
import { ACCOUNT_KIND_DEFAULTS } from '@/lib/finance/types'
import {
  computeKpis, weeklySeries, expenseByCategory, topMerchants,
  type WeekPoint, type CategorySlice, type MerchantRow,
} from '@/lib/finance/overview'
import { detectRecurring, type RecurringCharge } from '@/lib/finance/recurring'

type TabId = 'overview' | 'transactions' | 'recurring'

// ---------------------------------------------------------------- Palette
const INK = '#18181B'
const PAPER = '#FAF9F6'
const LINE = '#E7E6E2'
const LINE_SOFT = '#F0EFEB'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const SURFACE = '#FAFAF9'
const MONO = "'Geist Mono', ui-monospace, monospace"
const INCOME = '#059669'
const EXPENSE = '#DC2626'

export default function FinanceClient({
  lang, accounts, categories, movements,
  cashOnHand, periodIn, periodOut, periodStart,
  activePlaceId, plaidConfigured,
}: {
  lang: Lang
  accounts: FinanceAccount[]
  categories: FinanceCategory[]
  movements: FinanceMovement[]
  cashOnHand: number
  periodIn: number
  periodOut: number
  /** ISO of the first day of the current period (a month, at v1).
   *  Fed by the server so client/server share the same anchor
   *  even across midnight. */
  periodStart: string
  activePlaceId: string | null
  /** Server tells us if PLAID_CLIENT_ID + PLAID_SECRET are set.
   *  When false, the + Add account tile disables itself with a
   *  short hint instead of triggering a call that would 500. */
  plaidConfigured: boolean
}) {
  const t = makeT(lang)
  const locale = lang === 'es' ? 'es-ES' : 'en-US'

  const router = useRouter()
  const [tab, setTab] = useState<TabId>('overview')
  const [accountFilter, setAccountFilter] = useState<string | 'all' | 'expenses'>('all')
  const [expenseOpen, setExpenseOpen] = useState(false)

  // Month picker — click the title button, portal opens anchored
  // to the button's bottom-left. Anchor recomputes on scroll/resize
  // so the popover tracks the button even inside a sticky header.
  const titleBtnRef = useRef<HTMLButtonElement | null>(null)
  const [calOpen, setCalOpen] = useState(false)
  const [pickerAnchor, setPickerAnchor] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    if (!calOpen) return
    const compute = () => {
      const r = titleBtnRef.current?.getBoundingClientRect()
      if (r) setPickerAnchor({ top: r.bottom + 8, left: r.left })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [calOpen])

  // 12-week series feeds Overview's bar chart. Empty movements
  // still returns 12 zero-buckets so the chart doesn't collapse.
  const weeklyBars = useMemo(() => weeklySeries(movements, 12), [movements])
  const kpis = useMemo(() => computeKpis(movements), [movements])
  const expenseCats = useMemo(() => expenseByCategory(movements), [movements])
  const merchants = useMemo(() => topMerchants(movements, 6), [movements])
  const recurring = useMemo(() => detectRecurring(movements), [movements])

  // Ledger view — filter by account (source OR dest touches it)
  // or by direction (expenses only). "All" shows everything.
  const shown = useMemo(() => {
    if (accountFilter === 'all') return movements
    if (accountFilter === 'expenses') return movements.filter(m => m.direction === 'expense')
    return movements.filter(m =>
      m.source?.id === accountFilter || m.dest?.id === accountFilter,
    )
  }, [movements, accountFilter])

  // Per-account count for the chip badges + per-direction count.
  const counts = useMemo(() => {
    const byId = new Map<string, number>()
    let expenseCount = 0
    for (const m of movements) {
      if (m.direction === 'expense') expenseCount++
      if (m.source?.id) byId.set(m.source.id, (byId.get(m.source.id) ?? 0) + 1)
      if (m.dest?.id) byId.set(m.dest.id, (byId.get(m.dest.id) ?? 0) + 1)
    }
    return { byAccount: byId, expenses: expenseCount, all: movements.length }
  }, [movements])

  const periodStartDate = useMemo(() => new Date(periodStart), [periodStart])
  const monthTitle = useMemo(
    () => periodStartDate.toLocaleDateString(locale, { month: 'long', year: 'numeric' }),
    [periodStartDate, locale],
  )
  const relativeChip = useMemo(() => monthRelativeLabel(periodStartDate, new Date(), t), [periodStartDate, t])

  return (
    <div style={{
      minHeight: '100vh', background: '#fff', color: INK,
      fontFamily: "'Geist', system-ui, sans-serif",
      padding: 0,
    }}>
      {/* Header — matches the Sales pattern: title button on the
          top-left with a relative chip beside it, big mono total
          below with USD + stat pairs, right-side CTAs. Money-out
          reads black to keep the eye on cash on hand and inflow;
          red would over-weight normal spend as a warning. */}
      <div style={{
        padding: '16px 24px 14px', borderBottom: `1px solid ${LINE}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 24, flexWrap: 'wrap',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {/* Month title — click to open the month picker. Same
                pattern as the sales date title: portal-rendered
                popover anchors under the button, tracks scroll. */}
            <button
              ref={titleBtnRef}
              type="button"
              onClick={() => setCalOpen((v) => !v)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                border: '1px solid transparent', background: 'transparent',
                borderRadius: 9, padding: '2px 8px', marginLeft: -8,
                font: 'inherit', color: INK, cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.035em', whiteSpace: 'nowrap' }}>
                {capitalize(monthTitle)}
              </span>
              <span style={{ fontSize: 10, color: FAINT }}>▾</span>
            </button>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999,
              padding: '3px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
              background: relativeChip.kind === 'this' ? '#F4F4F2' : '#EFF6FF',
              color: relativeChip.kind === 'this' ? MUTED : '#2563EB',
            }}>
              {relativeChip.label}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: MONO, fontSize: 30, fontWeight: 600,
              letterSpacing: '-0.045em', lineHeight: 1, color: INK,
            }}>
              {fmtMoney(cashOnHand)}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>
              {t('CASH ON HAND', 'EFECTIVO')}
            </span>
            <Dot />
            <Stat value={`+${fmtMoney(periodIn)}`} label={t('in', 'entradas')} tone={INCOME} />
            <Dot />
            <Stat value={`−${fmtMoney(periodOut)}`} label={t('out', 'salidas')} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
          <a
            href="/finance/report?days=30"
            target="_blank"
            rel="noopener"
            style={{
              border: `1px solid ${LINE}`, background: '#fff', color: INK,
              borderRadius: 10, height: 34, padding: '0 14px',
              font: 'inherit', fontSize: 13, fontWeight: 500,
              textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
            }}
          >
            {t('Export', 'Exportar')}
          </a>
          <button
            type="button"
            onClick={() => setExpenseOpen(true)}
            disabled={accounts.length === 0}
            title={accounts.length === 0
              ? t('Add an account first to attach the expense to.', 'Añade primero una cuenta para vincular el gasto.')
              : undefined}
            style={{
              border: 0, background: INK, color: PAPER,
              borderRadius: 10, height: 34, padding: '0 16px',
              font: 'inherit', fontSize: 13, fontWeight: 600,
              cursor: accounts.length === 0 ? 'not-allowed' : 'pointer',
              opacity: accounts.length === 0 ? 0.55 : 1,
            }}
          >
            {t('Add expense', 'Añadir gasto')}
          </button>
        </div>
      </div>

      {/* Account tile row — adaptive grid, auto-fill so N tiles
          pack cleanly at any viewport / any count. Empty state
          when no accounts. "+ Add account" tile at the end. */}
      <div style={{ padding: '20px 24px 8px' }}>
        {accounts.length === 0 ? (
          <EmptyAccounts t={t} />
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 12,
          }}>
            {accounts.map(a => (
              <AccountTile key={a.id} a={a} locale={locale} t={t} />
            ))}
            <AddAccountTile
              t={t}
              plaidConfigured={plaidConfigured}
              activePlaceId={activePlaceId}
            />
          </div>
        )}
      </div>

      {/* Tab bar — Overview / Transactions / Recurring. Underline
          marks the active one; hover raises the ink on the others. */}
      <div style={{
        padding: '4px 24px 0', borderBottom: `1px solid ${LINE}`,
        display: 'flex', alignItems: 'flex-end', gap: 4,
      }}>
        <TabButton label={t('Overview', 'Resumen')} active={tab === 'overview'} onClick={() => setTab('overview')} />
        <TabButton label={t('Transactions', 'Transacciones')} active={tab === 'transactions'} onClick={() => setTab('transactions')} />
        <TabButton
          label={t('Recurring', 'Recurrentes')}
          badge={recurring.length > 0 ? String(recurring.length) : undefined}
          active={tab === 'recurring'}
          onClick={() => setTab('recurring')}
        />
      </div>

      {tab === 'overview' && (
        <OverviewPanel
          kpis={kpis}
          weeklyBars={weeklyBars}
          expenseCats={expenseCats}
          merchants={merchants}
          locale={locale}
          t={t}
        />
      )}

      {tab === 'transactions' && (
        <div style={{
          margin: '20px 24px 32px', borderRadius: 14,
          border: `1px solid ${LINE}`, background: '#fff', overflow: 'hidden',
        }}>
          <div style={{
            padding: '14px 18px 12px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em' }}>
              {t('Every movement', 'Todo movimiento')}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '0.14em' }}>
              {t('LAST 90 DAYS', 'ÚLTIMOS 90 DÍAS')}
            </span>
          </div>
          <div style={{
            padding: '10px 18px', borderTop: `1px solid ${LINE_SOFT}`,
            background: SURFACE,
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            <FilterChip
              label={t('All', 'Todo')}
              count={counts.all}
              active={accountFilter === 'all'}
              onClick={() => setAccountFilter('all')}
            />
            {accounts.map(a => (
              <FilterChip
                key={a.id}
                label={a.name}
                count={counts.byAccount.get(a.id) ?? 0}
                tone={tintForAccount(a)}
                active={accountFilter === a.id}
                onClick={() => setAccountFilter(a.id)}
              />
            ))}
            <FilterChip
              label={t('Expenses', 'Gastos')}
              count={counts.expenses}
              tone={{ dot: EXPENSE }}
              active={accountFilter === 'expenses'}
              onClick={() => setAccountFilter('expenses')}
            />
          </div>

          {shown.length === 0 ? (
            <div style={{ padding: '32px 18px', textAlign: 'center', color: FAINT, fontSize: 13 }}>
              {movements.length === 0
                ? t('Nothing has moved yet.', 'Nada se ha movido todavía.')
                : t('No movements match this filter.', 'Ningún movimiento coincide.')}
            </div>
          ) : shown.map(m => (
            <MovementRow key={m.id} m={m} locale={locale} t={t} />
          ))}
        </div>
      )}

      {tab === 'recurring' && (
        <RecurringPanel items={recurring} locale={locale} t={t} />
      )}

      {expenseOpen && (
        <AddExpenseDrawer
          accounts={accounts}
          categories={categories}
          onClose={() => setExpenseOpen(false)}
          t={t}
        />
      )}

      {/* Month picker — portaled to body so a scrolling ancestor's
          overflow can't clip it. Highlights the current month;
          disables future months. */}
      {calOpen && typeof document !== 'undefined' && pickerAnchor && createPortal(
        <MonthPickerOverlay
          selected={periodStartDate}
          today={new Date()}
          anchor={pickerAnchor}
          onPick={(iso) => {
            router.push(`/finance?period=${iso}`)
            setCalOpen(false)
          }}
          onClose={() => setCalOpen(false)}
          locale={locale}
        />,
        document.body,
      )}
    </div>
  )
}

// ================================================================
// Tiles
// ================================================================

function AccountTile({ a, locale: _locale, t }: { a: FinanceAccount; locale: string; t: (en: string, es?: string) => string }) {
  const router = useRouter()
  const tone = tintForAccount(a)
  const [hover, setHover] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)

  const onRemove = () => {
    setRemoving(true)
    disconnectFinanceAccount(a.id)
      .then((res) => {
        if ('error' in res) {
          setRemoving(false)
          setConfirming(false)
          window.alert(res.error)
          return
        }
        router.refresh()
      })
      .catch(() => setRemoving(false))
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setConfirming(false) }}
      style={{
        position: 'relative',
        border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff',
        padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      {/* Hover-revealed remove control. Two-step (× → Remove label)
          so a stray click can't dismiss a tile the operator meant
          to inspect. `disconnectFinanceAccount` also calls
          /item/remove when this is the last tile under a Plaid
          Item, so the trial slot frees up automatically. */}
      {(hover || confirming) && (
        <button
          type="button"
          disabled={removing}
          onClick={() => confirming ? onRemove() : setConfirming(true)}
          title={confirming
            ? t('Click again to remove', 'Haz clic de nuevo para quitar')
            : t('Remove account', 'Quitar cuenta')}
          style={{
            position: 'absolute', top: 8, right: 8,
            border: `1px solid ${confirming ? INK : LINE}`,
            background: confirming ? INK : '#fff',
            color: confirming ? PAPER : MUTED,
            borderRadius: 8, height: 22,
            padding: confirming ? '0 8px' : 0, minWidth: 22,
            font: 'inherit', fontSize: 11, fontWeight: 500,
            cursor: removing ? 'wait' : 'pointer', lineHeight: 1,
          }}
        >
          {removing ? '…' : confirming ? t('Remove', 'Quitar') : '×'}
        </button>
      )}

      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 32, height: 32, borderRadius: 8,
        background: tone.tile, color: tone.ink,
      }}>
        <AccountGlyph kind={a.kind} />
      </span>
      <span style={{
        fontSize: 13, fontWeight: 600, color: INK, letterSpacing: '-0.01em',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {a.name}
      </span>
      <span style={{
        fontFamily: MONO, fontSize: 20, fontWeight: 600,
        letterSpacing: '-0.035em', lineHeight: 1, color: INK,
      }}>
        {fmtMoney(a.balance)}
      </span>
      <span style={{ fontSize: 11, color: FAINT }}>
        {tileSubtitle(a)}
      </span>
    </div>
  )
}

/** Add-account tile — triggers Plaid Link directly (Plaid's own
 *  centered modal overlay). Same lifecycle discipline as
 *  ConnectBankButton in components/bank/connect-bank-button.tsx:
 *  fetch link_token only on click, mount the Plaid hook inside a
 *  short-lived <PlaidLinker/> child so the Plaid script embeds
 *  exactly once per attempt, then unmount cleanly on success/exit.
 *  After exchange, bridgePlaidAccountsToFinance mirrors the newly
 *  connected accounts into finance_accounts so the tile row picks
 *  them up on refresh.
 *
 *  OAuth institutions (Cash App, Venmo, PayPal, most big banks)
 *  need a round-trip: Link → institution's site → back to /finance
 *  carrying ?oauth_state_id=. We stash the link_token in
 *  localStorage right before opening Link so the return trip
 *  finds it, re-opens Link with receivedRedirectUri set, and
 *  Plaid resumes right where it left off. Cleared on success or
 *  exit so a stale token doesn't poison the next attempt.
 */
const PLAID_TOKEN_KEY = 'checked:finance:plaid_link_token'

function AddAccountTile({
  t, plaidConfigured, activePlaceId,
}: {
  t: (en: string, es?: string) => string
  plaidConfigured: boolean
  activePlaceId: string | null
}) {
  const router = useRouter()
  const [linkToken, setLinkToken] = useState<string | null>(null)
  // OAuth resumption: when the page loads with ?oauth_state_id=,
  // we re-open Link with the previous token and this URL so
  // Plaid finishes the flow. Undefined = normal (non-resumed)
  // Link open.
  const [receivedRedirectUri, setReceivedRedirectUri] = useState<string | undefined>(undefined)
  const [isFetching, setIsFetching] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // On mount, detect a Plaid OAuth return and resume Link. Runs
  // once — the effect's empty deps mean it fires on the initial
  // client render only, not on any router.refresh() afterwards.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (!params.has('oauth_state_id')) return
    let stored: string | null = null
    try { stored = window.localStorage.getItem(PLAID_TOKEN_KEY) } catch { /* private mode */ }
    if (!stored) return
    setReceivedRedirectUri(window.location.href)
    setLinkToken(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleClick = useCallback(async () => {
    if (!plaidConfigured || isFetching || isPending || linkToken) return
    setError(null)
    setIsFetching(true)
    try {
      // Absolute redirect URI must match an entry on the Plaid
      // dashboard's Allowed redirect URIs list. Using the current
      // origin + /finance keeps dev + prod pointing at the right
      // place without an env-var handoff. Plaid rejects
      // http:// redirect URIs in production, so skip it when the
      // origin isn't https — OAuth institutions won't work in that
      // case, but non-OAuth ones (and sandbox) still will.
      const isHttps = window.location.protocol === 'https:'
      const redirectUri = isHttps ? `${window.location.origin}/finance` : undefined
      const res = await createPlaidLinkToken(redirectUri)
      if ('error' in res) {
        setError(res.error)
      } else {
        try { window.localStorage.setItem(PLAID_TOKEN_KEY, res.linkToken) } catch { /* private mode */ }
        setLinkToken(res.linkToken)
      }
    } finally {
      setIsFetching(false)
    }
  }, [plaidConfigured, isFetching, isPending, linkToken])

  const handleSuccess = useCallback((publicToken: string) => {
    // Drop the token first so <PlaidLinker/> unmounts and the
    // Plaid script doesn't re-init on the router.refresh().
    setLinkToken(null)
    setReceivedRedirectUri(undefined)
    setError(null)
    try { window.localStorage.removeItem(PLAID_TOKEN_KEY) } catch { /* ignore */ }
    // Strip Plaid's OAuth query params off the URL so a page
    // reload doesn't attempt to resume the completed flow.
    if (typeof window !== 'undefined' && window.location.search.includes('oauth_state_id')) {
      window.history.replaceState(null, '', window.location.pathname)
    }
    startTransition(async () => {
      const fd = new FormData()
      fd.set('public_token', publicToken)
      const exchange = await exchangePlaidPublicToken(null, fd)
      if (exchange && 'error' in exchange) {
        setError(exchange.error)
        return
      }
      const bridge = await bridgePlaidAccountsToFinance(activePlaceId)
      if ('error' in bridge) {
        setError(bridge.error)
        return
      }
      router.refresh()
    })
  }, [router, activePlaceId])

  const handleExit = useCallback(() => {
    setLinkToken(null)
    setReceivedRedirectUri(undefined)
    try { window.localStorage.removeItem(PLAID_TOKEN_KEY) } catch { /* ignore */ }
    if (typeof window !== 'undefined' && window.location.search.includes('oauth_state_id')) {
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [])

  const busy = isFetching || isPending || linkToken !== null
  const disabled = !plaidConfigured || busy

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        title={!plaidConfigured
          ? t('Plaid not configured yet.', 'Plaid aún no está configurado.')
          : undefined}
        style={{
          border: `1px dashed ${LINE}`, borderRadius: 12, background: 'transparent',
          padding: '14px 16px 16px', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 6,
          color: disabled ? FAINT : MUTED, fontSize: 13, fontWeight: 500,
          cursor: disabled ? 'not-allowed' : 'pointer',
          minHeight: 120, font: 'inherit',
          transition: 'border-color .12s ease, color .12s ease, background .12s ease',
        }}
      >
        <span style={{ fontSize: 18, lineHeight: 1 }}>
          {isFetching ? '…' : isPending ? '…' : linkToken ? '…' : '+'}
        </span>
        {isFetching
          ? t('Preparing…', 'Preparando…')
          : isPending
            ? t('Linking…', 'Vinculando…')
            : linkToken
              ? t('Opening…', 'Abriendo…')
              : t('Add account', 'Añadir cuenta')}
        {error && (
          <span style={{ fontSize: 11, color: '#B91C1C', marginTop: 2, textAlign: 'center' }}>
            {error}
          </span>
        )}
      </button>
      {linkToken && (
        <PlaidLinker
          key={linkToken}
          token={linkToken}
          receivedRedirectUri={receivedRedirectUri}
          onSuccess={handleSuccess}
          onExit={handleExit}
        />
      )}
    </>
  )
}

// ----------------------------------------------------------------
// PlaidLinker — owns the usePlaidLink hook and pops the modal
// as soon as it's ready. Rendered only while a link_token is
// live so Plaid's link-initialize.js embeds exactly once per
// attempt. Same shape as components/bank/connect-bank-button.tsx,
// with receivedRedirectUri wired for OAuth resumption from
// Cash App / Venmo / PayPal / OAuth banks.
// ----------------------------------------------------------------
function PlaidLinker({
  token, receivedRedirectUri, onSuccess, onExit,
}: {
  token: string
  receivedRedirectUri?: string
  onSuccess: (publicToken: string) => void
  onExit: () => void
}) {
  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (publicToken) => onSuccess(publicToken),
    onExit: () => onExit(),
    ...(receivedRedirectUri && { receivedRedirectUri }),
  })
  useEffect(() => {
    if (ready) open()
  }, [ready, open])
  return null
}

function EmptyAccounts({ t }: { t: (en: string, es?: string) => string }) {
  return (
    <div style={{
      border: `1px dashed ${LINE}`, borderRadius: 12, padding: '28px 16px',
      textAlign: 'center', color: MUTED, fontSize: 13,
    }}>
      {t('No accounts yet. POS + Register seed automatically; add Venmo / Cash App / Bank as you use them.',
         'Sin cuentas aún. POS + Caja se cargan automáticamente; añade Venmo / Cash App / Banco al usarlos.')}
    </div>
  )
}

// ================================================================
// Movement row
// ================================================================

function MovementRow({
  m, locale, t,
}: {
  m: FinanceMovement
  locale: string
  t: (en: string, es?: string) => string
}) {
  // Expense rows read ink (not red) so a ledger doesn't feel like
  // a bank warning list — the "−" prefix + right-aligned column
  // already carries the outflow signal.
  const dirColor = m.direction === 'income' ? INCOME
    : m.direction === 'expense' ? INK
      : MUTED
  const sign = m.direction === 'income' ? '+'
    : m.direction === 'expense' ? '−'
      : '⇄'
  const title = m.note?.trim() || m.category?.name || defaultTitle(m, t)
  const time = fmtRowTime(m.occurred_at, locale)
  const day = fmtRelativeDay(m.occurred_at, t)

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 13,
        padding: '13px 18px', borderTop: `1px solid ${LINE_SOFT}`,
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 34, height: 34, borderRadius: 10, flex: '0 0 auto',
        background: iconTileFor(m).tile, color: iconTileFor(m).ink,
      }}>
        <MovementGlyph m={m} />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{
          display: 'block', fontSize: 14, fontWeight: 600, letterSpacing: '-0.015em',
          color: INK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {title}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: FAINT }}>{day}</span>
          <Dot />
          <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>{time}</span>
          {m.direction === 'transfer' && m.source && m.dest && (
            <>
              <Dot />
              <AccountPill name={m.source.name} tone={tintForRef(m.source)} />
              <span style={{ fontSize: 11, color: FAINT }}>→</span>
              <AccountPill name={m.dest.name} tone={tintForRef(m.dest)} />
            </>
          )}
          {m.direction === 'income' && m.dest && (
            <>
              <Dot />
              <AccountPill name={m.dest.name} tone={tintForRef(m.dest)} />
            </>
          )}
          {m.direction === 'expense' && (
            <>
              <Dot />
              {m.category && (
                <AccountPill name={m.category.name} tone={{ tile: '#FEE2E2', ink: '#B91C1C', dot: '#DC2626' }} />
              )}
              {m.source && (
                <AccountPill name={m.source.name} tone={tintForRef(m.source)} />
              )}
            </>
          )}
        </span>
      </span>
      <span style={{
        fontFamily: MONO, fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em',
        color: dirColor, whiteSpace: 'nowrap',
      }}>
        {sign}{fmtMoney(m.amount)}
      </span>
    </div>
  )
}

function defaultTitle(m: FinanceMovement, t: (en: string, es?: string) => string): string {
  if (m.direction === 'transfer') return t('Transfer', 'Transferencia')
  if (m.direction === 'income') return t('Income', 'Ingreso')
  return t('Expense', 'Gasto')
}

function iconTileFor(m: FinanceMovement): { tile: string; ink: string } {
  if (m.direction === 'transfer') return { tile: '#EEF2FF', ink: '#4F46E5' }
  if (m.direction === 'income') {
    return m.dest ? tintForRef(m.dest) : { tile: '#ECFDF5', ink: '#059669' }
  }
  // expense
  return { tile: '#FEE2E2', ink: '#B91C1C' }
}

// ================================================================
// Month picker overlay
// ================================================================

function MonthPickerOverlay({
  selected, today, anchor, onPick, onClose, locale,
}: {
  selected: Date
  today: Date
  anchor: { top: number; left: number }
  /** iso in YYYY-MM form */
  onPick: (iso: string) => void
  onClose: () => void
  locale: string
}) {
  const [year, setYear] = useState<number>(selected.getFullYear())
  const currentY = today.getFullYear()
  const currentM = today.getMonth()
  const selectedY = selected.getFullYear()
  const selectedM = selected.getMonth()

  const monthNames = useMemo(
    () => Array.from({ length: 12 }, (_, i) =>
      capitalize(new Date(2024, i, 1).toLocaleDateString(locale, { month: 'short' }))
    ),
    [locale],
  )

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      <div style={{
        position: 'fixed',
        top: anchor.top,
        left: anchor.left,
        zIndex: 41, width: 280,
        border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff',
        boxShadow: '0 12px 32px rgba(24,24,27,0.14)', padding: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
          <NavBtn dir="‹" onClick={() => setYear(y => y - 1)} />
          <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: INK }}>
            {year}
          </span>
          <NavBtn dir="›" onClick={() => setYear(y => y + 1)} disabled={year >= currentY} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
          {monthNames.map((name, i) => {
            const isFuture = year > currentY || (year === currentY && i > currentM)
            const isSelected = year === selectedY && i === selectedM
            const isThisMonth = year === currentY && i === currentM
            const iso = `${year}-${String(i + 1).padStart(2, '0')}`
            return (
              <button
                key={i}
                type="button"
                disabled={isFuture}
                onClick={() => onPick(iso)}
                style={{
                  position: 'relative',
                  border: 0, borderRadius: 8, height: 34,
                  font: 'inherit', fontFamily: MONO, fontSize: 12,
                  cursor: isFuture ? 'not-allowed' : 'pointer',
                  background: isSelected ? INK : 'transparent',
                  color: isFuture ? '#E5E5E5'
                    : isSelected ? PAPER
                      : '#3F3F46',
                  fontWeight: isSelected ? 600 : 400,
                }}
                onMouseEnter={e => { if (!isSelected && !isFuture) e.currentTarget.style.background = LINE_SOFT }}
                onMouseLeave={e => { if (!isSelected && !isFuture) e.currentTarget.style.background = 'transparent' }}
              >
                {name}
                {isThisMonth && !isSelected && (
                  <span style={{
                    position: 'absolute', left: '50%', bottom: 5, transform: 'translateX(-50%)',
                    width: 3, height: 3, borderRadius: '50%', background: FAINT,
                  }} />
                )}
              </button>
            )
          })}
        </div>

      </div>
    </>
  )
}

function NavBtn({ dir, onClick, disabled }: { dir: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8,
        width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
        font: 'inherit', fontSize: 12, color: disabled ? '#D6D5D1' : '#52525B',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {dir}
    </button>
  )
}

// ================================================================
// Tabs
// ================================================================

function TabButton({
  label, active, badge, onClick,
}: {
  label: string
  active: boolean
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'relative',
        border: 0, background: 'transparent', cursor: 'pointer',
        padding: '10px 14px 12px',
        font: 'inherit', fontSize: 13,
        fontWeight: active ? 600 : 500,
        letterSpacing: '-0.01em',
        color: active ? INK : MUTED,
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = INK }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = MUTED }}
    >
      {label}
      {badge && (
        <span style={{
          fontFamily: MONO, fontSize: 10, fontWeight: 600,
          background: SURFACE, color: MUTED,
          border: `1px solid ${LINE}`, borderRadius: 999,
          padding: '1px 6px', minWidth: 18, textAlign: 'center',
        }}>{badge}</span>
      )}
      {/* Underline indicator — sits right on top of the header
          border so the tab-and-border line up as one continuous
          rule instead of a floating pill. */}
      <span style={{
        position: 'absolute', left: 10, right: 10, bottom: -1,
        height: 2, background: active ? INK : 'transparent',
        borderRadius: 2,
      }} />
    </button>
  )
}

// ================================================================
// Overview panel
// ================================================================

function OverviewPanel({
  kpis, weeklyBars, expenseCats, merchants, locale, t,
}: {
  kpis: ReturnType<typeof computeKpis>
  weeklyBars: WeekPoint[]
  expenseCats: CategorySlice[]
  merchants: MerchantRow[]
  locale: string
  t: (en: string, es?: string) => string
}) {
  const noData = kpis.txCount === 0

  if (noData) {
    return (
      <div style={{
        margin: '20px 24px 32px', padding: '48px 20px',
        borderRadius: 14, border: `1px dashed ${LINE}`, background: '#fff',
        textAlign: 'center', color: FAINT, fontSize: 13,
      }}>
        {t(
          'No movements yet. Link an account or add a cash expense — Overview populates automatically.',
          'Sin movimientos aún. Vincula una cuenta o añade un gasto en efectivo — el resumen aparece solo.',
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: '20px 24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* KPI strip */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12,
      }}>
        <Kpi
          label={t('Money in', 'Entradas')}
          value={fmtMoney(kpis.revenue)}
          tone={INCOME}
          sub={t('90-day', '90 días')}
        />
        <Kpi
          label={t('Money out', 'Salidas')}
          value={fmtMoney(kpis.expenses)}
          tone={INK}
          sub={t('90-day', '90 días')}
        />
        <Kpi
          label={t('Net', 'Neto')}
          value={`${kpis.net >= 0 ? '+' : ''}${fmtMoney(kpis.net)}`}
          tone={kpis.net >= 0 ? INCOME : EXPENSE}
          sub={t('90-day', '90 días')}
        />
        <Kpi
          label={t('Biggest expense', 'Mayor gasto')}
          value={kpis.biggestExpense ? fmtMoney(kpis.biggestExpense.amount) : '—'}
          tone={INK}
          sub={kpis.biggestExpense?.note ?? undefined}
        />
      </div>

      {/* Chart + donut side-by-side */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 2fr) minmax(240px, 1fr)',
        gap: 14,
      }}>
        <Card title={t('Money in / out, weekly', 'Entradas / salidas, semanal')}
              subtitle={t('Last 12 weeks', 'Últimas 12 semanas')}>
          <WeeklyBars series={weeklyBars} locale={locale} />
        </Card>
        <Card title={t('Expense breakdown', 'Desglose de gastos')}
              subtitle={t('Where the money went', 'A dónde fue el dinero')}>
          <CategoryList rows={expenseCats.slice(0, 8)} total={kpis.expenses} t={t} />
        </Card>
      </div>

      {/* Top merchants — full width, understated */}
      {merchants.length > 0 && (
        <Card title={t('Top merchants', 'Comercios principales')}
              subtitle={t('By total spent, 90 days', 'Por total gastado, 90 días')}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {merchants.map((m, i) => (
              <div key={m.name} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 2px',
                borderTop: i === 0 ? 0 : `1px solid ${LINE_SOFT}`,
              }}>
                <span style={{
                  fontFamily: MONO, fontSize: 10, color: FAINT,
                  width: 18, textAlign: 'right',
                }}>{i + 1}</span>
                <span style={{ flex: 1, fontSize: 13, color: INK, minWidth: 0,
                               overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.name}
                </span>
                <span style={{ fontSize: 11, color: FAINT, fontFamily: MONO }}>
                  {m.count}×
                </span>
                <span style={{ fontFamily: MONO, fontSize: 14, color: INK, fontWeight: 600,
                               letterSpacing: '-0.02em', minWidth: 90, textAlign: 'right' }}>
                  {fmtMoney(m.total)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function Kpi({ label, value, tone, sub }: { label: string; value: string; tone: string; sub?: string }) {
  return (
    <div style={{
      border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff',
      padding: '14px 16px',
    }}>
      <div style={{
        fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
        color: FAINT, textTransform: 'uppercase',
      }}>{label}</div>
      <div style={{
        marginTop: 6, fontFamily: MONO, fontSize: 22, fontWeight: 600,
        letterSpacing: '-0.04em', color: tone, lineHeight: 1.1,
      }}>{value}</div>
      {sub && (
        <div style={{
          marginTop: 4, fontSize: 11, color: MUTED,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{sub}</div>
      )}
    </div>
  )
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      border: `1px solid ${LINE}`, borderRadius: 14, background: '#fff',
      padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.02em', color: INK }}>{title}</span>
        {subtitle && <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: FAINT, textTransform: 'uppercase' }}>{subtitle}</span>}
      </div>
      {children}
    </div>
  )
}

function WeeklyBars({ series, locale }: { series: WeekPoint[]; locale: string }) {
  const max = Math.max(1, ...series.map(w => Math.max(w.income, w.expense)))
  const H = 140
  return (
    <div>
      <div style={{
        display: 'grid', gridTemplateColumns: `repeat(${series.length}, 1fr)`,
        gap: 6, alignItems: 'end', height: H,
      }}>
        {series.map(w => {
          const inPct = (w.income / max) * 100
          const outPct = (w.expense / max) * 100
          return (
            <div key={w.weekStart} title={`${weekChartLabel(w.weekStart, locale)}: +${fmtMoney(w.income)} / −${fmtMoney(w.expense)}`}
                 style={{ display: 'flex', gap: 3, alignItems: 'end', height: '100%' }}>
              <div style={{
                flex: 1, background: INCOME, opacity: 0.85, borderRadius: '4px 4px 0 0',
                height: `${Math.max(inPct, w.income > 0 ? 2 : 0)}%`,
                minHeight: w.income > 0 ? 3 : 0,
              }} />
              <div style={{
                flex: 1, background: EXPENSE, opacity: 0.85, borderRadius: '4px 4px 0 0',
                height: `${Math.max(outPct, w.expense > 0 ? 2 : 0)}%`,
                minHeight: w.expense > 0 ? 3 : 0,
              }} />
            </div>
          )
        })}
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: `repeat(${series.length}, 1fr)`,
        gap: 6, marginTop: 8,
      }}>
        {series.map((w, i) => (
          <span key={w.weekStart} style={{
            fontFamily: MONO, fontSize: 9, color: FAINT, textAlign: 'center',
            letterSpacing: '0.05em',
          }}>
            {i % 2 === 0 ? weekChartLabel(w.weekStart, locale) : ''}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 11, color: MUTED }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, background: INCOME, borderRadius: 2, display: 'inline-block' }} /> In
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, background: EXPENSE, borderRadius: 2, display: 'inline-block' }} /> Out
        </span>
      </div>
    </div>
  )
}

function CategoryList({ rows, total, t }: { rows: CategorySlice[]; total: number; t: (en: string, es?: string) => string }) {
  if (rows.length === 0) {
    return <div style={{ color: FAINT, fontSize: 12 }}>{t('No expenses yet.', 'Sin gastos aún.')}</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map(r => {
        const pct = total > 0 ? Math.round(r.share * 100) : 0
        return (
          <div key={r.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 2,
                  background: r.color ?? FAINT, flex: '0 0 auto',
                }} />
                <span style={{ fontSize: 12.5, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.name}
                </span>
              </span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: INK, fontWeight: 600, letterSpacing: '-0.02em' }}>
                {fmtMoney(r.total)}
              </span>
            </div>
            <div style={{ height: 4, background: SURFACE, borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${pct}%`,
                background: r.color ?? INK, opacity: 0.85,
              }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function weekChartLabel(iso: string, locale: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

// ================================================================
// Recurring panel
// ================================================================

function RecurringPanel({
  items, locale, t,
}: {
  items: RecurringCharge[]
  locale: string
  t: (en: string, es?: string) => string
}) {
  const monthly = items.reduce((s, r) => {
    switch (r.cadence) {
      case 'weekly':   return s + r.averageAmount * 4.33
      case 'biweekly': return s + r.averageAmount * 2.17
      case 'monthly':  return s + r.averageAmount
      case 'yearly':   return s + r.averageAmount / 12
      default: return s
    }
  }, 0)

  if (items.length === 0) {
    return (
      <div style={{
        margin: '20px 24px 32px', padding: '48px 20px',
        borderRadius: 14, border: `1px dashed ${LINE}`, background: '#fff',
        textAlign: 'center', color: MUTED, fontSize: 13, maxWidth: 520,
        marginLeft: 'auto', marginRight: 'auto',
      }}>
        <div style={{
          fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
          color: FAINT, textTransform: 'uppercase', marginBottom: 8,
        }}>{t('WATCHING YOUR LEDGER', 'OBSERVANDO TU LIBRO')}</div>
        <div style={{ color: INK, fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
          {t('Nothing on repeat yet.', 'Nada recurrente aún.')}
        </div>
        <div style={{ color: MUTED, fontSize: 12.5, lineHeight: 1.5 }}>
          {t(
            'As soon as two charges from the same source land on a similar cadence, they’ll show up here — rent, subscriptions, payroll, anything you can plan around.',
            'En cuanto dos cargos del mismo origen aparezcan con la misma frecuencia, se mostrarán aquí — renta, suscripciones, nómina, todo lo que puedas planear.',
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: '20px 24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Summary strip */}
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap',
        padding: '14px 16px', borderRadius: 12, background: SURFACE,
        border: `1px solid ${LINE_SOFT}`,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: FAINT, textTransform: 'uppercase' }}>
            {t('Locked in, monthly', 'Comprometido, mensual')}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 600, letterSpacing: '-0.04em', color: INK }}>
            {fmtMoney(monthly)}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: MUTED, maxWidth: 360, lineHeight: 1.5 }}>
          {t(
            'Detected from your ledger — no setup. Amounts averaged across occurrences.',
            'Detectado desde tu libro — sin configuración. Montos promediados.',
          )}
        </div>
      </div>

      {/* List */}
      <div style={{
        border: `1px solid ${LINE}`, borderRadius: 14, background: '#fff', overflow: 'hidden',
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1.6fr 0.9fr 1fr 1fr auto',
          gap: 12, padding: '12px 18px',
          borderBottom: `1px solid ${LINE_SOFT}`, background: SURFACE,
          fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
          color: FAINT, textTransform: 'uppercase',
        }}>
          <span>{t('Charge', 'Cargo')}</span>
          <span>{t('Cadence', 'Frecuencia')}</span>
          <span>{t('Account', 'Cuenta')}</span>
          <span>{t('Next expected', 'Próximo')}</span>
          <span style={{ textAlign: 'right' }}>{t('Avg', 'Prom')}</span>
        </div>
        {items.map((r, i) => (
          <div key={r.fingerprint} style={{
            display: 'grid',
            gridTemplateColumns: '1.6fr 0.9fr 1fr 1fr auto',
            gap: 12, padding: '14px 18px', alignItems: 'center',
            borderTop: i === 0 ? 0 : `1px solid ${LINE_SOFT}`,
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{
                fontSize: 13.5, color: INK, fontWeight: 500,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{r.merchant}</span>
              <span style={{ fontSize: 11, color: FAINT, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {r.categoryName && (
                  <>
                    <span style={{ width: 6, height: 6, borderRadius: 1, background: r.categoryColor ?? FAINT }} />
                    {r.categoryName}
                  </>
                )}
                {r.categoryName && <span>·</span>}
                <span>{t(`${r.occurrences} seen`, `${r.occurrences} vistas`)}</span>
              </span>
            </div>
            <span style={{
              fontFamily: MONO, fontSize: 11, color: MUTED, letterSpacing: '0.05em',
              textTransform: 'uppercase',
            }}>{cadenceLabel(r.cadence, t)}</span>
            <span style={{ fontSize: 12.5, color: MUTED,
                           overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.accountName ?? '—'}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: INK }}>
              {fmtRecurringDate(r.nextExpectedAt, locale, t)}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 14, color: INK, fontWeight: 600,
                           letterSpacing: '-0.02em', textAlign: 'right', minWidth: 90 }}>
              {fmtMoney(r.averageAmount)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function cadenceLabel(c: RecurringCharge['cadence'], t: (en: string, es?: string) => string): string {
  switch (c) {
    case 'weekly':   return t('Weekly', 'Semanal')
    case 'biweekly': return t('Bi-weekly', 'Quincenal')
    case 'monthly':  return t('Monthly', 'Mensual')
    case 'yearly':   return t('Yearly', 'Anual')
  }
}

function fmtRecurringDate(iso: string, locale: string, t: (en: string, es?: string) => string): string {
  const d = new Date(iso)
  const now = new Date()
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000)
  if (days < 0) return t('Overdue', 'Atrasado')
  if (days === 0) return t('Today', 'Hoy')
  if (days === 1) return t('Tomorrow', 'Mañana')
  if (days < 7) return t(`In ${days} days`, `En ${days} días`)
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

// ================================================================
// Chips
// ================================================================

function FilterChip({
  label, count, active, onClick, tone,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  tone?: { dot?: string }
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        borderRadius: 999, padding: '5px 12px',
        font: 'inherit', fontSize: 12, cursor: 'pointer',
        border: `1px solid ${active ? INK : LINE}`,
        background: active ? INK : '#fff',
        color: active ? PAPER : '#3F3F46',
        fontWeight: active ? 600 : 500,
      }}
    >
      {tone?.dot && (
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: tone.dot }} />
      )}
      {label}
      <span style={{
        fontFamily: MONO, fontSize: 10,
        color: active ? 'rgba(250,249,246,0.65)' : FAINT,
      }}>
        {count}
      </span>
    </button>
  )
}

function AccountPill({
  name, tone,
}: {
  name: string
  tone: { tile: string; ink: string; dot?: string }
}) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999,
      padding: '1px 8px', fontSize: 10, fontWeight: 600,
      background: tone.tile, color: tone.ink,
    }}>
      {tone.dot && (
        <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: tone.dot }} />
      )}
      {name}
    </span>
  )
}

function Dot() {
  return <span style={{ width: 3, height: 3, borderRadius: '50%', background: '#D6D5D1', alignSelf: 'center' }} />
}

/** Value + label pair — same shape as Sales' Stat so the two
 *  headers scan identically. Money-out passes no tone so the
 *  value renders in ink (black) instead of red. */
function Stat({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, color: tone ?? INK }}>{value}</span>
      <span style={{ fontSize: 12, color: MUTED }}>{label}</span>
    </span>
  )
}

// ================================================================
// Glyphs
// ================================================================

function AccountGlyph({ kind }: { kind: FinanceAccountKind }) {
  // POS + cash glyphs mirror the ones in the Sales row tiles
  // (CardIcon + CashIcon in app/(app)/sales/client.tsx) so the
  // same real-world thing reads identically on both surfaces.
  if (kind === 'pos') return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="1.5" y="4" width="17" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M1.5 8h17" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.5 12.5h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
  if (kind === 'cash') return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden>
      <ellipse cx="10" cy="5.3" rx="6.4" ry="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.6 5.3v4.4c0 1.38 2.87 2.5 6.4 2.5s6.4-1.12 6.4-2.5V5.3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.6 9.7v4.4c0 1.38 2.87 2.5 6.4 2.5s6.4-1.12 6.4-2.5V9.7" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
  if (kind === 'digital_wallet') return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M3 6h11a3 3 0 0 1 3 3v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="13.5" cy="11.5" r="1" fill="currentColor" />
    </svg>
  )
  if (kind === 'bank') return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M2 8l8-4 8 4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M4 8v7M8 8v7M12 8v7M16 8v7M2 16h16" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function MovementGlyph({ m }: { m: FinanceMovement }) {
  if (m.direction === 'transfer') return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4 7h11M12 4l3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 13H5M8 16l-3-3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  if (m.direction === 'income') return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M10 15V5M6 9l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  // expense — receipt icon
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M5 3h10v14l-2-1-1.5 1L10 16l-1.5 1L7 16l-2 1V3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7.5 7h5M7.5 10h5M7.5 13h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

// ================================================================
// Formatting + palette helpers
// ================================================================

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtRowTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
}

function fmtRelativeDay(iso: string, t: (en: string, es?: string) => string): string {
  const d = new Date(iso)
  const now = new Date()
  const midnightToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const midnightThat = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = Math.round((midnightToday.getTime() - midnightThat.getTime()) / 86_400_000)
  if (diff === 0) return t('Today', 'Hoy')
  if (diff === 1) return t('Yesterday', 'Ayer')
  if (diff > 1 && diff < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'long' })
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function monthRelativeLabel(
  periodStart: Date,
  now: Date,
  t: (en: string, es?: string) => string,
): { kind: 'this' | 'past'; label: string } {
  const sameMonth = periodStart.getFullYear() === now.getFullYear() &&
                    periodStart.getMonth() === now.getMonth()
  if (sameMonth) return { kind: 'this', label: t('This month', 'Este mes') }
  const monthsBack =
    (now.getFullYear() - periodStart.getFullYear()) * 12 +
    (now.getMonth() - periodStart.getMonth())
  if (monthsBack === 1) return { kind: 'past', label: t('Last month', 'Mes pasado') }
  return { kind: 'past', label: t(`${monthsBack} months ago`, `hace ${monthsBack} meses`) }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}

function tintForAccount(a: FinanceAccount): { tile: string; ink: string; dot: string } {
  const base = a.color ?? ACCOUNT_KIND_DEFAULTS[a.kind].color
  return { tile: base, ink: darkFor(a.kind), dot: darkFor(a.kind) }
}

function tintForRef(ref: { kind: FinanceAccountKind; color: string | null }): { tile: string; ink: string; dot: string } {
  const base = ref.color ?? ACCOUNT_KIND_DEFAULTS[ref.kind].color
  return { tile: base, ink: darkFor(ref.kind), dot: darkFor(ref.kind) }
}

function darkFor(kind: FinanceAccountKind): string {
  switch (kind) {
    case 'pos': return '#4F46E5'
    case 'cash': return '#047857'
    case 'digital_wallet': return '#0EA5E9'
    case 'bank': return '#7C3AED'
    default: return '#52525B'
  }
}

function tileSubtitle(a: FinanceAccount): string {
  const ago = timeAgo(new Date(a.updated_at))
  if (a.kind === 'pos') return 'To be deposited'
  if (a.kind === 'cash') return `Last counted · ${ago}`
  if (a.kind === 'bank') return `Deposit · ${ago}`
  if (a.kind === 'digital_wallet') return `Payment · ${ago}`
  return ago
}

function timeAgo(d: Date): string {
  const diff = Date.now() - d.getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.round(hrs / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ================================================================
// Add expense drawer
// ================================================================

function AddExpenseDrawer({
  accounts, categories, onClose, t,
}: {
  accounts: FinanceAccount[]
  categories: FinanceCategory[]
  onClose: () => void
  t: (en: string, es?: string) => string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Only expense categories are pickable here; income/transfer
  // categories don't apply to an expense event.
  const expenseCategories = categories.filter(c => c.kind === 'expense')

  const [sourceId, setSourceId] = useState<string>(accounts[0]?.id ?? '')
  const [categoryId, setCategoryId] = useState<string>('')
  const [amountStr, setAmountStr] = useState('')
  const [note, setNote] = useState('')
  const [memo, setMemo] = useState('')
  const [occurred, setOccurred] = useState<string>(defaultLocalDateTimeInput())

  function save() {
    setError(null)
    const amt = parseFloat(amountStr)
    if (!Number.isFinite(amt) || amt <= 0) {
      setError(t('Amount must be greater than zero.', 'El monto debe ser mayor que cero.'))
      return
    }
    if (!sourceId) {
      setError(t('Pick an account.', 'Elige una cuenta.'))
      return
    }
    startTransition(async () => {
      const result = await addExpense({
        source_account_id: sourceId,
        amount: amt,
        category_id: categoryId || null,
        note: note.trim() || null,
        memo: memo.trim() || null,
        occurred_at: new Date(occurred).toISOString(),
      })
      if ('error' in result) {
        setError(result.error)
      } else {
        router.refresh()
        onClose()
      }
    })
  }

  return (
    <DrawerShell
      title={t('Add expense', 'Añadir gasto')}
      eyebrow={t('NEW EXPENSE', 'NUEVO GASTO')}
      onClose={onClose}
      pending={pending}
      footer={
        <DrawerFooter
          onCancel={onClose}
          onSave={save}
          saveLabel={pending ? t('Saving…', 'Guardando…') : t('Save expense', 'Guardar gasto')}
          pending={pending}
          error={error}
          t={t}
        />
      }
    >
      <Field label={t('Amount', 'Monto')} required>
        <span style={{
          display: 'flex', alignItems: 'baseline', gap: 6, padding: '10px 12px',
          border: `1px solid ${LINE}`, borderRadius: 8, background: '#fff',
        }}>
          <span style={{ fontFamily: MONO, fontSize: 20, color: MUTED }}>$</span>
          <input
            type="text"
            inputMode="decimal"
            value={amountStr}
            onChange={e => setAmountStr(e.target.value)}
            placeholder="0.00"
            style={{
              flex: 1, border: 0, outline: 'none', background: 'transparent',
              font: 'inherit', fontFamily: MONO, fontSize: 22, fontWeight: 600,
              letterSpacing: '-0.02em', color: INK, minWidth: 0,
            }}
          />
        </span>
      </Field>

      <Field label={t('Pay from', 'Pagar de')} required>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {accounts.map(a => (
            <PickerPill
              key={a.id}
              label={a.name}
              tone={tintForAccount(a)}
              active={sourceId === a.id}
              onClick={() => setSourceId(a.id)}
            />
          ))}
        </div>
      </Field>

      <Field label={t('Category', 'Categoría')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <PickerPill
            label={t('None', 'Ninguna')}
            active={categoryId === ''}
            onClick={() => setCategoryId('')}
          />
          {expenseCategories.map(c => (
            <PickerPill
              key={c.id}
              label={c.name}
              tone={{ tile: c.color ? `${c.color}22` : '#F4F4F5', ink: c.color ?? '#52525B' }}
              active={categoryId === c.id}
              onClick={() => setCategoryId(c.id)}
            />
          ))}
        </div>
      </Field>

      <Field label={t('When', 'Cuándo')}>
        <input
          type="datetime-local"
          value={occurred}
          onChange={e => setOccurred(e.target.value)}
          style={fieldInputStyle()}
        />
      </Field>

      <Field label={t('Note', 'Nota')} hint={t('Short — shows on the row.', 'Corta — se muestra en la fila.')}>
        <input
          type="text"
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder={t('e.g. Rent · September', 'ej. Renta · septiembre')}
          style={fieldInputStyle()}
        />
      </Field>

      <Field label={t('Memo', 'Memo')} hint={t('Optional detail for the export.', 'Detalle opcional para el reporte.')}>
        <textarea
          value={memo}
          rows={3}
          onChange={e => setMemo(e.target.value)}
          style={{
            ...fieldInputStyle(),
            resize: 'vertical', lineHeight: 1.5,
            fontFamily: "'Geist', system-ui, sans-serif",
          }}
        />
      </Field>
    </DrawerShell>
  )
}

// ================================================================
// Drawer primitives — shared between the two drawers so both read
// as one visual system.
// ================================================================

function DrawerShell({
  title, eyebrow, onClose, pending, footer, children,
}: {
  title: string
  eyebrow: string
  onClose: () => void
  pending: boolean
  footer: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 40, display: 'flex', justifyContent: 'flex-end',
      color: INK, fontFamily: "'Geist', system-ui, sans-serif",
    }}>
      <div
        onClick={pending ? undefined : onClose}
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(24,24,27,0.28)',
          cursor: pending ? 'wait' : 'pointer',
        }}
      />
      <div style={{
        position: 'relative', width: 460, maxWidth: '100%', flex: '0 0 460px',
        height: '100vh', background: '#fff',
        borderLeft: `1px solid ${LINE}`, boxShadow: '-24px 0 48px rgba(24,24,27,0.10)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '18px 22px 14px', borderBottom: `1px solid ${LINE}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
        }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em', color: FAINT }}>
              {eyebrow}
            </div>
            <div style={{ marginTop: 4, fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em' }}>
              {title}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Close"
            style={{
              border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8,
              width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
              font: 'inherit', fontSize: 15, color: MUTED,
              cursor: pending ? 'not-allowed' : 'pointer',
              opacity: pending ? 0.4 : 1,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 22px 22px' }}>
          {children}
        </div>
        {footer}
      </div>
    </div>
  )
}

function DrawerFooter({
  onCancel, onSave, saveLabel, pending, error, t,
}: {
  onCancel: () => void
  onSave: () => void
  saveLabel: string
  pending: boolean
  error: string | null
  t: (en: string, es?: string) => string
}) {
  return (
    <div style={{
      borderTop: `1px solid ${LINE}`, padding: '14px 22px',
      display: 'flex', alignItems: 'center', gap: 10, background: '#fff',
      flexWrap: 'wrap',
    }}>
      {error && <span style={{ fontSize: 12, color: '#B91C1C' }}>{error}</span>}
      <div style={{ marginLeft: 'auto' }} />
      <button
        type="button"
        onClick={onCancel}
        disabled={pending}
        style={{
          border: `1px solid ${LINE}`, background: '#fff', color: '#3F3F46',
          borderRadius: 9, padding: '9px 14px', font: 'inherit',
          fontSize: 13, fontWeight: 500, cursor: pending ? 'not-allowed' : 'pointer',
        }}
      >
        {t('Cancel', 'Cancelar')}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={pending}
        style={{
          border: 0, background: INK, color: PAPER,
          borderRadius: 9, padding: '10px 16px', font: 'inherit',
          fontSize: 13, fontWeight: 600, cursor: pending ? 'wait' : 'pointer',
          opacity: pending ? 0.75 : 1,
        }}
      >
        {saveLabel}
      </button>
    </div>
  )
}

function Field({
  label, hint, required, children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: MUTED, fontWeight: 600, marginBottom: 6,
      }}>
        {label}{required && <span style={{ color: '#B91C1C', marginLeft: 3 }}>*</span>}
      </div>
      {children}
      {hint && <div style={{ fontSize: 11, color: FAINT, marginTop: 5 }}>{hint}</div>}
    </div>
  )
}

function PickerPill({
  label, tone, active, onClick,
}: {
  label: string
  tone?: { tile: string; ink: string; dot?: string }
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        border: `1px solid ${active ? INK : LINE}`,
        background: active ? INK : (tone ? tone.tile : '#fff'),
        color: active ? PAPER : (tone ? tone.ink : '#3F3F46'),
        borderRadius: 999, padding: '6px 12px',
        font: 'inherit', fontSize: 12.5, fontWeight: active ? 600 : 500,
        cursor: 'pointer',
      }}
    >
      {tone?.dot && !active && (
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: tone.dot }} />
      )}
      {label}
    </button>
  )
}

function fieldInputStyle(): React.CSSProperties {
  return {
    width: '100%', padding: '10px 12px', font: 'inherit', fontSize: 13,
    border: `1px solid ${LINE}`, borderRadius: 8, background: '#fff',
    color: INK, outline: 'none',
  }
}

function tintForKind(kind: FinanceAccountKind): { tile: string; ink: string } {
  const base = ACCOUNT_KIND_DEFAULTS[kind].color
  return { tile: base, ink: darkFor(kind) }
}

/** Local datetime input format: YYYY-MM-DDTHH:mm. Anchors on
 *  "right now" so the operator only edits it when the expense
 *  hit at a different time. */
function defaultLocalDateTimeInput(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day}T${h}:${min}`
}
