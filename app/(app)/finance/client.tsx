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
import { addExpense, bridgePlaidAccountsToFinance, disconnectFinanceAccount, refreshPosBatch, renameFinanceAccount } from '@/app/actions/finance'
import { createPlaidLinkToken, exchangePlaidPublicToken } from '@/app/actions/bank'
import { OpenRegisterModal, CloseRegisterModal } from './register-modal'
import type { CashSession, ExpectedCashBreakdown } from '@/lib/finance/cash'
import type {
  FinanceAccount,
  FinanceCategory,
  FinanceMovement,
  FinanceAccountKind,
  FinanceMovementDirection,
} from '@/lib/finance/types'
import { ACCOUNT_KIND_DEFAULTS } from '@/lib/finance/types'
import { expenseByCategory, type CategorySlice } from '@/lib/finance/overview'

type TabId = 'overview' | 'transactions'

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
  openSession, expectedCash, lastClose,
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
  /** Register session state. Null at the online storefront (no
   *  drawer to count) and null when the register is closed. */
  openSession: CashSession | null
  /** Live expected drawer total while a session is open — computed
   *  server-side so the close modal opens with the number already
   *  in hand. Null when no session is open. */
  expectedCash: ExpectedCashBreakdown | null
  /** Most recent closed session, used to seed the gap
   *  reconciliation on the next open. Null before the first close. */
  lastClose: CashSession | null
}) {
  const t = makeT(lang)
  const locale = lang === 'es' ? 'es-ES' : 'en-US'

  const router = useRouter()
  const [tab, setTab] = useState<TabId>('overview')
  const [accountFilter, setAccountFilter] = useState<string | 'all' | 'expenses'>('all')
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [registerModal, setRegisterModal] = useState<'open' | 'close' | null>(null)

  // Register workflow only applies at a physical place with a cash
  // account. Bank accounts feed the deposit picker in the open flow.
  const registerAccount = accounts.find(a => a.kind === 'cash') ?? null
  const bankAccounts = accounts.filter(a => a.kind === 'bank')
  const canCountRegister = !!registerAccount && !!activePlaceId

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

  // Scope the spend chart to the SAME period as the header counters.
  //
  // This received the full movement list — a 90-day window since the
  // backfill widened — while "+$ in / −$ out" directly above it was
  // computed for the selected month only. Two flow figures sat inches
  // apart on one screen answering different questions, and the chart
  // total (90 days) read as if it were the month's spend: $46,370.18
  // of quarterly spend beside a monthly header. Same window now, so
  // the chart's total and the header's "out" agree by construction.
  const periodMovements = useMemo(() => {
    const start = new Date(periodStart)
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1)
    return movements.filter(m => {
      const ts = new Date(m.occurred_at).getTime()
      return ts >= start.getTime() && ts < end.getTime()
    })
  }, [movements, periodStart])
  const expenseCats = useMemo(() => expenseByCategory(periodMovements), [periodMovements])

  // Ledger view — filter chips are MUTUALLY EXCLUSIVE with the
  // Expenses chip: money leaving an account belongs under
  // Expenses, not under that account's chip. So a Chase Savings
  // expense stops appearing under "Chase Savings" and only lives
  // under "Expenses." Paired transfers still show under both
  // their source and dest accounts since neither side is an
  // expense from the operator's perspective.
  const shown = useMemo(() => {
    if (accountFilter === 'all') return movements
    if (accountFilter === 'expenses') return movements.filter(m => m.direction === 'expense')
    return movements.filter(m => {
      if (m.direction === 'expense') return false
      return m.source?.id === accountFilter || m.dest?.id === accountFilter
    })
  }, [movements, accountFilter])

  // Chip counts follow the same exclusion so the numbers add up
  // (Chase Savings 4 + Expenses 1 = All 5, no double-count).
  const counts = useMemo(() => {
    const byId = new Map<string, number>()
    let expenseCount = 0
    for (const m of movements) {
      if (m.direction === 'expense') { expenseCount++; continue }
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
  // YYYY-MM string threaded into the Report modal's iframe URL so
  // whichever month the picker has selected is what the report
  // opens for. Locked to local time (matches how the server
  // parses ?period=).
  const periodParam = useMemo(
    () => `${periodStartDate.getFullYear()}-${String(periodStartDate.getMonth() + 1).padStart(2, '0')}`,
    [periodStartDate],
  )

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
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            style={{
              border: `1px solid ${LINE}`, background: '#fff', color: INK,
              borderRadius: 10, height: 34, padding: '0 14px',
              font: 'inherit', fontSize: 13, fontWeight: 500,
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
            }}
          >
            {t('Report', 'Reporte')}
          </button>
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
              <AccountTile
                key={a.id}
                a={a}
                locale={locale}
                t={t}
                registerState={
                  a.kind === 'cash' && canCountRegister
                    ? {
                        isOpen: !!openSession,
                        expected: expectedCash?.expected ?? null,
                        onOpen: () => setRegisterModal('open'),
                        onCloseSession: () => setRegisterModal('close'),
                      }
                    : null
                }
              />
            ))}
            <AddAccountTile
              t={t}
              plaidConfigured={plaidConfigured}
              activePlaceId={activePlaceId}
            />
          </div>
        )}
      </div>

      {/* Tab bar — Overview / Transactions. Underline marks the
          active one; hover raises the ink on the others. */}
      <div style={{
        padding: '4px 24px 0', borderBottom: `1px solid ${LINE}`,
        display: 'flex', alignItems: 'flex-end', gap: 4,
      }}>
        <TabButton label={t('Overview', 'Resumen')} active={tab === 'overview'} onClick={() => setTab('overview')} />
        <TabButton label={t('Transactions', 'Transacciones')} active={tab === 'transactions'} onClick={() => setTab('transactions')} />
      </div>

      {tab === 'overview' && (
        <OverviewPanel
          movements={movements}
          cashOnHand={cashOnHand}
          expenseCats={expenseCats}
          periodStartDate={periodStartDate}
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

      {expenseOpen && (
        <AddExpenseDrawer
          accounts={accounts}
          categories={categories}
          onClose={() => setExpenseOpen(false)}
          t={t}
        />
      )}

      {reportOpen && (
        <ReportModal
          onClose={() => setReportOpen(false)}
          t={t}
          period={periodParam}
          periodTitle={capitalize(monthTitle)}
        />
      )}

      {registerModal === 'open' && registerAccount && activePlaceId && (
        <OpenRegisterModal
          locationId={activePlaceId}
          register={registerAccount}
          bankAccounts={bankAccounts}
          priorCloseAmount={lastClose?.closing_amount ?? null}
          onClose={() => setRegisterModal(null)}
        />
      )}

      {registerModal === 'close' && registerAccount && openSession && expectedCash && (
        <CloseRegisterModal
          sessionId={openSession.id}
          register={registerAccount}
          expected={expectedCash.expected}
          breakdown={expectedCash}
          onClose={() => setRegisterModal(null)}
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

/** Register open/close affordance, threaded in only for the cash
 *  tile at a physical place. Null everywhere else. */
interface RegisterState {
  isOpen: boolean
  /** Live expected drawer total while a session is open. The tile
   *  shows this instead of the stored balance so the number reflects
   *  the day as it accumulates, not the last count. */
  expected: number | null
  onOpen: () => void
  onCloseSession: () => void
}

function AccountTile({ a, locale: _locale, t, registerState }: {
  a: FinanceAccount
  locale: string
  t: (en: string, es?: string) => string
  registerState?: RegisterState | null
}) {
  const router = useRouter()
  const tone = tintForAccount(a)
  const [hover, setHover] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Inline rename. Click the tile name → it swaps to an input.
  // Enter or blur commits, Escape reverts. Kept on the name itself
  // rather than a pencil icon because the tile's top-right corner
  // already carries remove + refresh; a third control there would
  // crowd it.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(a.name)
  const [saving, setSaving] = useState(false)

  const beginEdit = () => {
    setDraft(a.name)
    setEditing(true)
  }

  const commitEdit = () => {
    const next = draft.trim()
    if (!next || next === a.name) {
      setEditing(false)
      setDraft(a.name)
      return
    }
    setSaving(true)
    renameFinanceAccount(a.id, next)
      .then((res) => {
        if ('error' in res) {
          window.alert(res.error)
          setDraft(a.name)
          return
        }
        router.refresh()
      })
      .catch(() => setDraft(a.name))
      .finally(() => { setSaving(false); setEditing(false) })
  }

  const cancelEdit = () => {
    setDraft(a.name)
    setEditing(false)
  }

  // Only a processor-backed POS tile has anything to re-read.
  const canRefreshBatch = a.kind === 'pos' && !!a.livePendingSource

  const onRefreshBatch = () => {
    if (refreshing) return
    setRefreshing(true)
    refreshPosBatch()
      .then((res) => {
        if ('error' in res) {
          window.alert(res.error)
          return
        }
        router.refresh()
      })
      .catch(() => { /* leave the last-known number on screen */ })
      .finally(() => setRefreshing(false))
  }

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
      // The whole register card is the affordance — clicking it
      // opens the count workflow. Inner controls (remove, rename,
      // refresh) stopPropagation so they don't double-fire.
      onClick={registerState
        ? () => (registerState.isOpen ? registerState.onCloseSession() : registerState.onOpen())
        : undefined}
      role={registerState ? 'button' : undefined}
      tabIndex={registerState ? 0 : undefined}
      onKeyDown={registerState ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          registerState.isOpen ? registerState.onCloseSession() : registerState.onOpen()
        }
      } : undefined}
      style={{
        position: 'relative',
        border: `1px solid ${registerState && hover ? INK : LINE}`,
        borderRadius: 12, background: '#fff',
        padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8,
        cursor: registerState ? 'pointer' : undefined,
        transition: 'border-color .12s ease',
        outline: 'none',
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
          onClick={(e) => { e.stopPropagation(); confirming ? onRemove() : setConfirming(true) }}
          title={confirming
            ? t('Click again to remove', 'Haz clic de nuevo para quitar')
            : t('Remove account', 'Quitar cuenta')}
          style={{
            // Shifts left to clear the always-present refresh icon
            // on a live POS tile. Only the hover-revealed control
            // moves, so nothing already on screen jumps.
            position: 'absolute', top: 8, right: canRefreshBatch ? 36 : 8,
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

      {/* Manual re-read of the processor batch. Always visible on a
          live POS tile (not hover-gated) — it doubles as the signal
          that this number is live rather than stored. */}
      {canRefreshBatch && (
        <button
          type="button"
          disabled={refreshing}
          onClick={(e) => { e.stopPropagation(); onRefreshBatch() }}
          aria-label={t('Refresh batch total', 'Actualizar total del lote')}
          title={t('Refresh batch total', 'Actualizar total del lote')}
          style={{
            position: 'absolute', top: 8, right: 8,
            border: `1px solid ${LINE}`, background: '#fff', color: MUTED,
            borderRadius: 8, height: 22, width: 22, padding: 0,
            font: 'inherit', fontSize: 12, lineHeight: 1,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            cursor: refreshing ? 'wait' : 'pointer',
            opacity: refreshing ? 0.5 : 1,
          }}
        >
          <span style={{
            display: 'inline-block',
            animation: refreshing ? 'checked-spin 0.8s linear infinite' : undefined,
          }}>
            ↻
          </span>
        </button>
      )}
      <style>{'@keyframes checked-spin{to{transform:rotate(360deg)}}'}</style>

      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 32, height: 32, borderRadius: 8,
        background: tone.tile, color: tone.ink,
      }}>
        <AccountGlyph kind={a.kind} glyph={a.glyph} />
      </span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          disabled={saving}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
            if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
          }}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            fontSize: 13, fontWeight: 600, color: INK, letterSpacing: '-0.01em',
            font: 'inherit', fontFamily: 'inherit',
            border: `1px solid ${INK}`, borderRadius: 6,
            padding: '2px 6px', margin: '-3px -7px',
            width: 'calc(100% + 14px)', background: '#fff',
            opacity: saving ? 0.6 : 1,
          }}
        />
      ) : (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          <span style={{
            fontSize: 13, fontWeight: 600, color: INK, letterSpacing: '-0.01em',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {a.name}
          </span>
          {/* Hover-revealed rename pencil. Sits inline with the name
              rather than the tile's top-right corner, which already
              carries remove + refresh. Reserved width keeps the name
              from reflowing when the icon appears. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); beginEdit() }}
            aria-label={t('Rename account', 'Renombrar cuenta')}
            title={t('Rename account', 'Renombrar cuenta')}
            style={{
              flex: 'none', width: 16, height: 16, padding: 0,
              border: 'none', background: 'none', color: FAINT,
              cursor: 'pointer', lineHeight: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              opacity: hover ? 1 : 0,
              transition: 'opacity .12s ease, color .12s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = INK }}
            onMouseLeave={(e) => { e.currentTarget.style.color = FAINT }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        </span>
      )}
      <span style={{
        fontFamily: MONO, fontSize: 20, fontWeight: 600,
        letterSpacing: '-0.035em', lineHeight: 1, color: INK,
      }}>
        {/* While a session is open the tile shows the LIVE expected
            total (opening + sales − payouts), not the stored balance
            from the last count. That is the number the operator
            checks the drawer against. */}
        {fmtMoney(
          registerState?.isOpen && registerState.expected != null
            ? registerState.expected
            : a.balance
        )}
      </span>
      <span style={{ fontSize: 11, color: FAINT, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {/* An open register says so — the tile is showing a live
            running total at that point, not a settled count, and
            the operator needs to know which. */}
        {registerState?.isOpen
          ? t('Register open', 'Caja abierta')
          : tileSubtitle(a, _locale, t)}
        {/* Sync warning. Deliberately subtle — the number beside it
            is still a real (last-known) balance, not an error
            state, so this informs without alarming. */}
        {a.livePendingError === 'sync_failed' && (
          <span
            title={t(
              "Couldn't reach Poynt — showing last known balance.",
              'No se pudo conectar con Poynt — mostrando el último saldo conocido.',
            )}
            style={{ color: '#B45309', cursor: 'help', whiteSpace: 'nowrap' }}
          >
            ⚠ {t('sync issue', 'error de sync')}
          </span>
        )}
        {/* Bank tile equivalent. Only shows once a run has actually
            failed — a healthy tile stays exactly as it was. The
            failure count is in the tooltip because "failed once"
            and "failed 40 times running" need different reactions. */}
        {a.kind === 'bank' && (a.syncConsecutiveFailures ?? 0) > 0 && (
          <span
            title={t(
              `Bank sync has failed ${a.syncConsecutiveFailures} time(s) in a row. Showing the last successful data.`,
              `La sincronización bancaria ha fallado ${a.syncConsecutiveFailures} vez(ces) seguidas. Mostrando los últimos datos correctos.`,
            )}
            style={{ color: '#B45309', cursor: 'help', whiteSpace: 'nowrap' }}
          >
            ⚠ {t('sync issue', 'error de sync')}
          </span>
        )}
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
          {/* Transfer between two in-system accounts: this is the
              only case that shows a source→dest account-pill pair.
              Pills use a colored dot only — brand identity already
              lives in the leading tile glyph, so a full Venmo V
              inside a trailing pill would double up on identity
              instead of communicating "money moved between these
              two accounts." */}
          {m.direction === 'transfer' && m.source && m.dest && (
            <>
              <Dot />
              <AccountPill name={m.source.name} tone={tintForRef(m.source)} />
              <span style={{ fontSize: 11, color: FAINT }}>→</span>
              <AccountPill name={m.dest.name} tone={tintForRef(m.dest)} />
            </>
          )}
          {/* Standalone income/expense: pill ONLY when a category
              is assigned. Uncategorized rows render clean — the
              leading glyph + signed amount already say what this
              is, and an "Uncategorized" chip on every unlabeled
              row just adds noise. Categorizing will be a separate
              surface (bulk review) rather than a per-row nag. */}
          {m.direction === 'income' && m.category && (
            <>
              <Dot />
              <AccountPill name={m.category.name} tone={{ tile: '#DCFCE7', ink: '#166534', dot: '#059669' }} />
            </>
          )}
          {m.direction === 'expense' && m.category && (
            <>
              <Dot />
              <AccountPill name={m.category.name} tone={{ tile: '#FEE2E2', ink: '#B91C1C', dot: '#DC2626' }} />
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
  // Wallet-brand tint wins first — matches the account tile.
  const brand = counterpartyGlyph(m)
  if (brand) {
    const tone = WALLET_TILE_TONE[brand]
    if (tone) return tone
  }
  // Income landing in a bank account gets the bank tint (piggy in
  // purple, matching the account tile) instead of the generic
  // income green. Same reasoning as the piggy glyph itself: the
  // row IS a bank deposit, so it should read as bank-colored.
  const kind = counterpartyKind(m)
  if (m.direction === 'income' && kind === 'bank') {
    return { tile: ACCOUNT_KIND_DEFAULTS.bank.color, ink: '#7C3AED' }
  }
  if (m.direction === 'transfer') return { tile: '#EEF2FF', ink: '#4F46E5' }
  if (m.direction === 'income') return { tile: '#ECFDF5', ink: '#059669' }
  return { tile: '#FEE2E2', ink: '#B91C1C' }  // expense
}

/** Pastel tile + ink pair per wallet brand — matches the account
 *  tile tints so the ledger's leading icon and the top-of-page
 *  tile scan as the same thing. */
const WALLET_TILE_TONE: Record<string, { tile: string; ink: string }> = {
  venmo:        { tile: '#DFF0FE', ink: '#3D95CE' },
  cashapp:      { tile: '#DFF6E7', ink: '#00A73A' },
  paypal:       { tile: '#DDE7FA', ink: '#003087' },
  'apple-cash': { tile: '#F1F1F3', ink: '#18181B' },
  zelle:        { tile: '#EFE0F5', ink: '#6D1ED4' },
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
// Overview panel — two cards: a 30-day (or picked-month) running
// balance line chart and an expense donut, both interactive.
//
// Windowing: mirrors the report. Current month → rolling last-30
// days (context beyond the month start). Past month → that whole
// month, clamped at "now" when relevant. Chart endpoint dot lands
// on the freshest cash-on-hand number so the tile row and the
// chart tell the same story.
//
// Balance derivation: cumulate BACKWARD from cashOnHand. For
// each day, delta = income − expense (transfers between the
// operator's own accounts net to zero because source+dest cancel).
// Personal-tagged rows COUNT here — cash is cash regardless of
// how the P&L classifies it.
// ================================================================

function OverviewPanel({
  movements, cashOnHand: endBalance, expenseCats,
  periodStartDate, locale, t,
}: {
  movements: FinanceMovement[]
  cashOnHand: number
  expenseCats: CategorySlice[]
  periodStartDate: Date
  locale: string
  t: (en: string, es?: string) => string
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [hoverCat, setHoverCat] = useState<string | null>(null)

  // Windowing: current month → rolling 30d; past month → that
  // whole month (clamped at now if the picked month is somehow
  // still ongoing — defensive).
  const now = new Date()
  const isCurrentMonth =
    periodStartDate.getFullYear() === now.getFullYear() &&
    periodStartDate.getMonth() === now.getMonth()
  const win = isCurrentMonth
    ? rollingBalanceWindow(30)
    : monthBalanceWindow(periodStartDate)
  const balanceSeries = useMemo(
    () => cumulativeBalance(movements, endBalance, win.from, win.to),
    [movements, endBalance, win.from, win.to],
  )

  const totalExpense = expenseCats.reduce((s, r) => s + r.total, 0)
  const hoveredCatObj = hoverCat ? expenseCats.find(c => c.name === hoverCat) : null

  return (
    <div style={{
      padding: '20px 24px 32px',
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1.8fr) minmax(0, 1fr)',
      gap: 22, alignItems: 'stretch',
      // Taller cards so the pair fills the viewport space that
      // used to be dead. Balance chart + donut both scale their
      // inner content on the extra height via flex: 1 rules
      // inside each card.
      minHeight: 520,
    }}>
      {/* Card 1 — Cash balance line chart */}
      <BalanceCard
        series={balanceSeries}
        eyebrow={
          isCurrentMonth
            ? t('Last 30 days', 'Últimos 30 días')
            : periodStartDate.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
        }
        hoverIdx={hoverIdx}
        onHoverIdx={setHoverIdx}
        locale={locale}
        t={t}
      />

      {/* Card 2 — Donut */}
      <DonutCard
        cats={expenseCats}
        total={totalExpense}
        hoveredCat={hoveredCatObj?.name ?? null}
        onHover={setHoverCat}
        t={t}
      />
    </div>
  )
}

// ---------------------------------------------------------------- balance card

interface BalancePoint { date: string; balance: number; delta: number }

function BalanceCard({
  series, eyebrow, hoverIdx, onHoverIdx, locale, t,
}: {
  series: BalancePoint[]
  eyebrow: string
  hoverIdx: number | null
  onHoverIdx: (i: number | null) => void
  locale: string
  t: (en: string, es?: string) => string
}) {
  const n = series.length
  const totalDelta = series.length > 0
    ? series[series.length - 1].balance - series[0].balance + series[0].delta
    : 0
  const min = n > 0 ? Math.min(...series.map(p => p.balance)) : 0
  const max = n > 0 ? Math.max(...series.map(p => p.balance)) : 0
  const range = max - min || 1
  const W = 600, TOP = 8, BOT = 182, H = 190

  const x = (i: number) => n > 1 ? (i / (n - 1)) * W : W / 2
  const y = (v: number) => BOT - ((v - min) / range) * (BOT - TOP)
  const pts = series.map((p, i) => [x(i), y(p.balance)])
  const linePath = pts.length > 0
    ? 'M' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L')
    : ''
  const areaPath = pts.length > 0 ? linePath + ` L${W} ${H} L0 ${H} Z` : ''
  const lastPt = pts[pts.length - 1] ?? [0, 0]

  const halfBand = n > 1 ? W / (n - 1) / 2 : 0

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const idx = Math.max(0, Math.min(n - 1,
      Math.round(((e.clientX - rect.left) / rect.width) * (n - 1))))
    if (idx !== hoverIdx) onHoverIdx(idx)
  }

  const fmtDay = (isoDate: string) => {
    const d = new Date(isoDate + 'T12:00:00')
    return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  }

  // Four axis-label anchors (start / two mids / end)
  const axisAnchors = n > 0
    ? [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1].map(i => series[i]?.date).filter(Boolean)
    : []

  const hoverPt = hoverIdx !== null ? series[hoverIdx] : null

  if (n === 0) {
    return (
      <section style={cardStyles.card}>
        <div style={cardStyles.header}>
          <span style={cardStyles.title}>{t('Cash balance', 'Saldo en efectivo')}</span>
          <span style={cardStyles.eyebrow}>{eyebrow}</span>
        </div>
        <div style={{ padding: '48px 18px', textAlign: 'center', color: FAINT, fontSize: 12 }}>
          {t('No history to plot yet.', 'Sin historial que graficar aún.')}
        </div>
      </section>
    )
  }

  return (
    <section style={cardStyles.card}>
      <div style={{ ...cardStyles.header, paddingBottom: 4 }}>
        <span style={cardStyles.title}>{t('Cash balance', 'Saldo en efectivo')}</span>
        <span style={cardStyles.eyebrow}>
          {eyebrow} · {totalDelta >= 0 ? '+' : ''}{fmtMoney(totalDelta)}
        </span>
      </div>
      <div style={{ flex: 1, padding: '12px 18px 6px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ position: 'relative', flex: 1, minHeight: 180 }}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            onMouseMove={onMove}
            onMouseLeave={() => onHoverIdx(null)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: 'crosshair' }}
          >
            <line x1={0} y1={TOP} x2={W} y2={TOP} stroke={LINE_SOFT} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={0} y1={(TOP + BOT) / 2} x2={W} y2={(TOP + BOT) / 2} stroke={LINE_SOFT} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={0} y1={BOT} x2={W} y2={BOT} stroke={LINE_SOFT} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {hoverIdx !== null && (
              <rect
                x={Math.max(0, pts[hoverIdx][0] - halfBand)}
                y={TOP}
                width={Math.min(W, pts[hoverIdx][0] + halfBand) - Math.max(0, pts[hoverIdx][0] - halfBand)}
                height={BOT - TOP}
                fill={INK}
                opacity={0.04}
              />
            )}
            <path d={areaPath} fill={INCOME} opacity={0.07} />
            <path d={linePath} fill="none" stroke={INCOME} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            <circle cx={lastPt[0]} cy={lastPt[1]} r={3.5} fill={INCOME} />
          </svg>
          {hoverIdx !== null && hoverPt && (
            <>
              <div style={{
                position: 'absolute',
                left: `${(hoverIdx / Math.max(1, n - 1)) * 100}%`,
                top: `${(pts[hoverIdx][1] / H) * 100}%`,
                width: 10, height: 10, borderRadius: 999,
                background: '#fff', border: `2.5px solid ${INCOME}`,
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
                boxShadow: '0 1px 3px rgba(24,24,27,0.15)',
              }} />
              <div style={{
                position: 'absolute',
                left: `${Math.max(14, Math.min(86, (hoverIdx / Math.max(1, n - 1)) * 100))}%`,
                top: `${Math.max(42, (pts[hoverIdx][1] / H) * 100 - 6)}%`,
                transform: 'translate(-50%, -100%)',
                pointerEvents: 'none',
                background: '#fff', borderRadius: 12,
                boxShadow: '0 4px 16px rgba(24,24,27,0.12), 0 1px 3px rgba(24,24,27,0.08)',
                padding: '10px 14px', whiteSpace: 'nowrap', zIndex: 5,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }}>
                  <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: INCOME }} />
                  {fmtDay(hoverPt.date)}
                </div>
                <div style={{
                  fontFamily: MONO, fontSize: 15, fontWeight: 600,
                  letterSpacing: '-0.03em', marginTop: 2,
                }}>{fmtMoney(hoverPt.balance)}</div>
                <div style={{
                  fontFamily: MONO, fontSize: 10.5, marginTop: 2,
                  color: hoverPt.delta > 0 ? INCOME : hoverPt.delta < 0 ? EXPENSE : FAINT,
                }}>
                  {hoverPt.delta === 0
                    ? t('no activity', 'sin actividad')
                    : `${hoverPt.delta > 0 ? '+' : '−'}${fmtMoney(Math.abs(hoverPt.delta))} ${t('that day', 'ese día')}`
                  }
                </div>
              </div>
            </>
          )}
        </div>
        <div style={{
          display: 'flex', justifyContent: 'space-between', marginTop: 6,
          fontFamily: MONO, fontSize: 10, color: FAINT,
        }}>
          {axisAnchors.map(d => <span key={d}>{fmtDay(d)}</span>)}
        </div>
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        padding: '10px 18px 14px', borderTop: `1px solid ${LINE_SOFT}`,
        fontSize: 11, color: MUTED,
      }}>
        <span>{t('Low', 'Mínimo')}: <span style={{ fontFamily: MONO }}>{fmtMoney(min)}</span></span>
        <span>{t('High', 'Máximo')}: <span style={{ fontFamily: MONO }}>{fmtMoney(max)}</span></span>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- donut card

function DonutCard({
  cats, total, hoveredCat, onHover, t,
}: {
  cats: CategorySlice[]
  total: number
  hoveredCat: string | null
  onHover: (n: string | null) => void
  t: (en: string, es?: string) => string
}) {
  const R = 70
  const C = 2 * Math.PI * R
  const gap = 2  // px in stroke-space (matches design)
  let acc = 0

  const hoveredObj = hoveredCat ? cats.find(c => c.name === hoveredCat) : null
  const centerAmt = hoveredObj ? fmtMoney(hoveredObj.total) : fmtMoney(total)
  const centerLabel = hoveredObj && total > 0
    ? `${hoveredObj.name.toUpperCase()} · ${Math.round((hoveredObj.total / total) * 100)}%`
    : t('TOTAL SPEND', 'GASTO TOTAL')

  return (
    <section style={cardStyles.card}>
      <div style={{ ...cardStyles.header, paddingBottom: 4 }}>
        <span style={cardStyles.title}>{t('Where the money went', 'A dónde fue el dinero')}</span>
        <span style={cardStyles.eyebrow}>{t('30 days', '30 días')}</span>
      </div>
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 16, padding: '16px 18px 18px', minHeight: 0,
      }}>
        <div style={{ position: 'relative', width: 260, height: 260, flex: '0 0 auto' }}>
          {cats.length === 0 || total <= 0 ? (
            // Empty state — hollow ring with a single "no expenses"
            // line in the middle. The center readout stays hidden
            // here (would just render "$0.00 · TOTAL SPEND" on top
            // of the copy and look broken).
            <div style={{
              width: '100%', height: '100%',
              borderRadius: '50%', border: `22px solid ${LINE_SOFT}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: FAINT, fontSize: 12, textAlign: 'center', padding: 24,
              boxSizing: 'border-box',
            }}>
              {t('No expenses in this window.', 'Sin gastos en este período.')}
            </div>
          ) : (
            <>
              <svg viewBox="0 0 168 168" style={{ width: 260, height: 260, display: 'block', transform: 'rotate(-90deg)' }}>
                {cats.map(c => {
                  const frac = c.total / total
                  const active = hoveredCat === null || hoveredCat === c.name
                  const dashOn = Math.max(0.1, frac * C - gap)
                  const dashOff = C - dashOn
                  const offset = -acc * C
                  acc += frac
                  const isHovered = hoveredCat === c.name
                  return (
                    <circle
                      key={c.name}
                      cx={84} cy={84} r={R}
                      fill="none"
                      stroke={c.color ?? FAINT}
                      strokeWidth={isHovered ? 27 : 22}
                      strokeDasharray={`${dashOn.toFixed(1)} ${dashOff.toFixed(1)}`}
                      strokeDashoffset={offset.toFixed(1)}
                      opacity={active ? 1 : 0.22}
                      onMouseEnter={() => onHover(c.name)}
                      onMouseLeave={() => onHover(null)}
                      style={{ cursor: 'pointer', transition: 'opacity 0.15s ease, stroke-width 0.15s ease' }}
                    />
                  )
                })}
              </svg>
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none',
              }}>
                <span style={{
                  fontFamily: MONO, fontSize: 19, fontWeight: 600,
                  letterSpacing: '-0.03em', color: INK,
                }}>{centerAmt}</span>
                <span style={{
                  fontFamily: MONO, fontSize: 9, letterSpacing: '0.14em',
                  color: FAINT, textTransform: 'uppercase', marginTop: 3,
                }}>{centerLabel}</span>
              </div>
            </>
          )}
        </div>
      </div>
      {cats.length > 0 && (
        <div style={{
          display: 'flex', justifyContent: 'center', flexWrap: 'wrap',
          gap: '2px 12px', padding: '10px 14px 12px',
          borderTop: `1px solid ${LINE_SOFT}`,
        }}>
          {cats.map(c => {
            const isHovered = hoveredCat === c.name
            return (
              <span
                key={c.name}
                onMouseEnter={() => onHover(c.name)}
                onMouseLeave={() => onHover(null)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '2px 6px', borderRadius: 6,
                  background: isHovered ? SURFACE : 'transparent',
                  cursor: 'default',
                  transition: 'background 0.15s ease',
                  fontSize: 11, color: MUTED,
                }}
              >
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: 2,
                  background: c.color ?? FAINT, flex: '0 0 auto',
                }} />
                {c.name}
              </span>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- window helpers

function rollingBalanceWindow(days: number): { from: Date; to: Date } {
  const to = new Date()
  to.setHours(23, 59, 59, 999)
  const from = new Date(to)
  from.setDate(from.getDate() - (days - 1))
  from.setHours(0, 0, 0, 0)
  return { from, to }
}

function monthBalanceWindow(firstOfMonth: Date): { from: Date; to: Date } {
  const from = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth(), 1)
  from.setHours(0, 0, 0, 0)
  const monthEnd = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() + 1, 1)
  monthEnd.setMilliseconds(-1)
  const now = new Date()
  const to = monthEnd > now ? now : monthEnd
  return { from, to }
}

/** Cumulate cash balance backward from today. For each day in
 *  [from, to] we know the net cash delta (income − expense;
 *  transfers cancel because both source and dest are our
 *  accounts). Rewind from the current cashOnHand to derive the
 *  balance at the start of each day. Local-date keys so the
 *  bucket a movement lands in matches how the merchant would
 *  read it on their phone. */
function cumulativeBalance(
  movements: FinanceMovement[],
  endBalance: number,
  from: Date,
  to: Date,
): BalancePoint[] {
  const byDay = new Map<string, number>()
  for (const m of movements) {
    const d = new Date(m.occurred_at)
    const key = localDateKey(d)
    let delta = 0
    if (m.direction === 'income') delta = m.amount
    else if (m.direction === 'expense') delta = -m.amount
    // transfer: source+dest both our accounts ⇒ net 0
    byDay.set(key, (byDay.get(key) ?? 0) + delta)
  }

  // Walk from `to` back to `from`, cumulating backward.
  const stack: BalancePoint[] = []
  const cursor = new Date(to)
  cursor.setHours(0, 0, 0, 0)
  const stop = new Date(from)
  stop.setHours(0, 0, 0, 0)
  let bal = endBalance
  while (cursor >= stop) {
    const key = localDateKey(cursor)
    const delta = byDay.get(key) ?? 0
    stack.push({ date: key, balance: round2ish(bal), delta: round2ish(delta) })
    bal -= delta
    cursor.setDate(cursor.getDate() - 1)
  }
  return stack.reverse()
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function round2ish(n: number): number { return Math.round(n * 100) / 100 }

const cardStyles: Record<string, React.CSSProperties> = {
  card: {
    border: `1px solid ${LINE}`, borderRadius: 14, overflow: 'hidden',
    display: 'flex', flexDirection: 'column', background: '#fff',
  },
  header: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    gap: 12, padding: '15px 18px 12px',
  },
  title: { fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em' },
  eyebrow: {
    fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
    color: FAINT, textTransform: 'uppercase',
  },
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
  name, tone, glyph, kind,
}: {
  name: string
  tone: { tile: string; ink: string; dot?: string }
  /** Wallet brand slug ('venmo' / 'cashapp' / etc). When set, we
   *  render the brand glyph in place of the dot so the ledger row
   *  matches the account tile at a glance. */
  glyph?: string | null
  /** Account kind. Used as a fallback when there's no brand slug
   *  — bank tiles get a piggy, cash a register, POS a card, etc. */
  kind?: FinanceAccountKind
}) {
  const showGlyph = !!glyph || !!kind
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999,
      padding: '1px 8px', fontSize: 10, fontWeight: 600,
      background: tone.tile, color: tone.ink,
    }}>
      {showGlyph
        ? <PillBrandGlyph glyph={glyph ?? null} kind={kind ?? null} />
        : tone.dot && (
          <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: tone.dot }} />
        )
      }
      {name}
    </span>
  )
}

/** 10px glyph for the ledger row pills. Reuses the same SVG
 *  paths as AccountGlyph but sized down; renders currentColor so
 *  it inherits the pill's ink and stays legible on any tint.
 *  Brand slug wins if set; otherwise falls back to a kind-based
 *  glyph so bank / cash / POS / wallet rows still get an icon. */
function PillBrandGlyph({
  glyph, kind,
}: {
  glyph: string | null
  kind: FinanceAccountKind | null
}) {
  const S = 10
  if (glyph === 'venmo') return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M18.9 4.5c.7 1.1 1 2.3 1 3.9 0 4.9-4.2 11.3-7.6 15.6H5l-3-18 6.5-.6 1.6 12.6c1.5-2.4 3.3-6.2 3.3-8.8 0-1.4-.24-2.4-.62-3.2l6.12-1z"
        fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" />
    </svg>
  )
  if (glyph === 'cashapp') return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M15.3 9.3c-.7-.7-1.7-1.1-2.7-1.1-1 0-1.7.4-1.7 1 0 .7 1 1 2.2 1.4 1.9.6 3.3 1.4 3.3 3.2 0 2-1.5 3.4-4 3.6l-.3 1.5h-1.7l.3-1.5c-1.1-.2-2.1-.7-2.8-1.4l1-1c.8.8 1.9 1.2 3 1.2 1.2 0 1.9-.5 1.9-1.2 0-.7-.9-.9-2.2-1.4-1.6-.5-3.2-1.3-3.2-3.1 0-1.9 1.5-3.3 3.7-3.5l.3-1.5h1.7l-.3 1.5c1 .2 1.8.7 2.4 1.2z" fill="currentColor" />
    </svg>
  )
  if (glyph === 'paypal') return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8.3 4h6.9c2.7 0 4.6 1.4 4 4.6-.7 3.8-3.5 5.4-6.8 5.4h-1.6c-.4 0-.7.3-.8.7L9.3 20H6l2.3-16z" fill="currentColor" />
    </svg>
  )
  if (glyph === 'apple-cash') return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M17 12.8c0-2.5 2-3.6 2.1-3.7-1.2-1.7-3-2-3.6-2-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.4-.8-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.3.8 1.2 1.8 2.6 3.2 2.6 1.3 0 1.8-.8 3.4-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.2-2.5.9-1.3 1.3-2.6 1.4-2.7-.1 0-2.9-1.1-3-4.3z" fill="currentColor" />
    </svg>
  )
  if (glyph === 'zelle') return (
    <svg width={S} height={S} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M10.6 4h2.8v2.4h3.7v2.3l-5.7 8.6h5.7V20h-3.7v2h-2.8v-2H6.9v-2.3l5.7-8.6H6.9V6.4h3.7V4z" fill="currentColor" />
    </svg>
  )
  // Uncategorized state — a dashed circle enclosing a "?" reads
  // as "we don't know yet, tap to assign" without the alarm of
  // a red tint. Distinct from category / direction glyphs so a
  // scan can tell "categorized" from "not" at a glance.
  if (glyph === 'uncategorized') return (
    <svg width={S + 1} height={S + 1} viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx={10} cy={10} r={7} stroke="currentColor" strokeWidth={1.4} strokeDasharray="2 2" />
      <path d="M8 8.2c0-1.2 1-2 2-2s2 .8 2 1.9c0 1.2-1.7 1.4-1.7 2.9" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" fill="none" />
      <circle cx={10.2} cy={13.8} r={0.7} fill="currentColor" />
    </svg>
  )
  // Kind-based fallbacks — outline style, currentColor.
  if (kind === 'bank') return (
    <svg width={S + 2} height={S + 2} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 13c0-3.9 3.6-7 8-7 2 0 3.9.6 5.3 1.7l2.7-1.4v3.6c.6.8 1 1.7 1 2.6 0 1-.4 1.9-1 2.7v2.3h-2.6c-.6.7-1.4 1.3-2.4 1.7v1.3h-3v-1c-.3 0-.7 0-1 0-.3 0-.7 0-1 0v1h-3v-1.3C5 17.7 4 15.4 4 13z"
        stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round"
      />
      <circle cx={15.5} cy={12} r={0.9} fill="currentColor" />
    </svg>
  )
  if (kind === 'pos') return (
    <svg width={S + 2} height={S + 2} viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x={1.5} y={4} width={17} height={12} rx={2.5} stroke="currentColor" strokeWidth={1.6} />
      <path d="M1.5 8h17" stroke="currentColor" strokeWidth={1.6} />
    </svg>
  )
  if (kind === 'cash') return (
    <svg width={S + 2} height={S + 2} viewBox="0 0 20 20" fill="none" aria-hidden>
      <ellipse cx={10} cy={5.3} rx={6.4} ry={2.5} stroke="currentColor" strokeWidth={1.7} />
      <path d="M3.6 5.3v8.8c0 1.38 2.87 2.5 6.4 2.5s6.4-1.12 6.4-2.5V5.3" stroke="currentColor" strokeWidth={1.7} />
    </svg>
  )
  if (kind === 'digital_wallet') return (
    <svg width={S + 2} height={S + 2} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M3 6h11a3 3 0 0 1 3 3v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" stroke="currentColor" strokeWidth={1.7} />
      <circle cx={13.5} cy={11.5} r={1} fill="currentColor" />
    </svg>
  )
  return <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
}

/** Soft grey pill used when a movement has no category assigned.
 *  Distinct from every category chip (which uses the seed's own
 *  color) so a scan reads "needs review" vs "already labeled" at
 *  a glance. Dashed-circle "?" glyph inside signals uncertainty
 *  without the alarm of a red tint. */
function UncategorizedPill() {
  return (
    <AccountPill
      name="Uncategorized"
      tone={{ tile: '#F4F4F2', ink: '#6B6B70' }}
      glyph="uncategorized"
    />
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

function AccountGlyph({ kind, glyph }: { kind: FinanceAccountKind; glyph?: string | null }) {
  // Brand glyphs first — a Plaid-linked Venmo tile is a Venmo
  // tile, not a generic wallet. Slug values come from the bridge
  // step; anything unrecognized falls through to the kind-based
  // generic below.
  if (glyph === 'venmo') return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M18.9 4.5c.7 1.1 1 2.3 1 3.9 0 4.9-4.2 11.3-7.6 15.6H5l-3-18 6.5-.6 1.6 12.6c1.5-2.4 3.3-6.2 3.3-8.8 0-1.4-.24-2.4-.62-3.2l6.12-1z"
        fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
  if (glyph === 'cashapp') return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="5" fill="#00D64F" />
      <path d="M15.3 9.3c-.7-.7-1.7-1.1-2.7-1.1-1 0-1.7.4-1.7 1 0 .7 1 1 2.2 1.4 1.9.6 3.3 1.4 3.3 3.2 0 2-1.5 3.4-4 3.6l-.3 1.5c0 .1-.1.2-.3.2h-1.4c-.2 0-.3-.1-.2-.3l.3-1.5c-1.1-.2-2.1-.7-2.8-1.4-.1-.1-.1-.3 0-.4l1-1c.1-.1.3-.1.4 0 .8.8 1.9 1.2 3 1.2 1.2 0 1.9-.5 1.9-1.2 0-.7-.9-.9-2.2-1.4-1.6-.5-3.2-1.3-3.2-3.1 0-1.9 1.5-3.3 3.7-3.5l.3-1.5c0-.1.1-.2.3-.2h1.4c.2 0 .3.1.2.3l-.3 1.5c1 .2 1.8.7 2.4 1.2.1.1.1.3 0 .4l-1 1c-.1.1-.3.1-.3 0z" fill="#fff" />
    </svg>
  )
  if (glyph === 'paypal') return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8.3 4h6.9c2.7 0 4.6 1.4 4 4.6-.7 3.8-3.5 5.4-6.8 5.4h-1.6c-.4 0-.7.3-.8.7L9.3 20H6l2.3-16z" fill="#003087" />
      <path d="M9.5 6h4.8c2 0 3.3 1 2.9 3.2-.5 2.7-2.5 3.9-4.9 3.9h-1.2c-.3 0-.5.2-.6.5l-.7 4.4H7.6L9.5 6z" fill="#009cde" />
    </svg>
  )
  if (glyph === 'apple-cash') return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M17 12.8c0-2.5 2-3.6 2.1-3.7-1.2-1.7-3-2-3.6-2-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.4-.8-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.3.8 1.2 1.8 2.6 3.2 2.6 1.3 0 1.8-.8 3.4-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.2-2.5.9-1.3 1.3-2.6 1.4-2.7-.1 0-2.9-1.1-3-4.3zM14.5 5.3c.7-.9 1.2-2.1 1.1-3.3-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.2 1.2.1 2.3-.6 3-1.5z" fill="#111" />
    </svg>
  )
  if (glyph === 'zelle') return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2" y="2" width="20" height="20" rx="5" fill="#6D1ED4" />
      <path d="M10.6 4h2.8v2.4h3.7v2.3l-5.7 8.6h5.7V20h-3.7v2h-2.8v-2H6.9v-2.3l5.7-8.6H6.9V6.4h3.7V4z" fill="#fff" />
    </svg>
  )

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
    // Piggy bank — outline style so it sits at the same visual
    // weight as the other kind glyphs. Coin slot on top, ear
    // curl, curly tail, two legs.
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 13c0-3.9 3.6-7 8-7 2 0 3.9.6 5.3 1.7l2.7-1.4v3.6c.6.8 1 1.7 1 2.6 0 1-.4 1.9-1 2.7v2.3h-2.6c-.6.7-1.4 1.3-2.4 1.7v1.3h-3v-1c-.3 0-.7 0-1 0-.3 0-.7 0-1 0v1h-3v-1.3C5 17.7 4 15.4 4 13z"
        stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"
      />
      <circle cx="15.5" cy="12" r="0.9" fill="currentColor" />
      <path d="M9 9c1-.4 2.2-.5 3.3-.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function MovementGlyph({ m }: { m: FinanceMovement }) {
  // Row-leading glyph rule:
  //   • Wallet-brand rows (Venmo / Cash App / PayPal / …) get
  //     their brand glyph — the brand IS the identity.
  //   • Income landing in a bank account → piggy. It reads as
  //     "deposit into your bank," which is the right mental
  //     model for Square payouts, cash tips deposits, and
  //     "Online Transfer from Checking" style movements.
  //   • Everything else uses the DIRECTION arrow. Expenses out
  //     to any account get the receipt (leaving), non-bank
  //     income (rare) gets the up arrow, paired transfers get
  //     the swap.
  const brandGlyph = counterpartyGlyph(m)
  if (brandGlyph) return <AccountGlyph kind="digital_wallet" glyph={brandGlyph} />

  const kind = counterpartyKind(m)
  if (m.direction === 'income' && kind === 'bank') return <AccountGlyph kind="bank" />

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

/** Which counterparty account carries the visual identity for this
 *  row: income → dest, expense → source, transfer → whichever side
 *  has a brand slug (usually one does when a wallet is involved).
 *  Returns null when no brand should override the direction arrow. */
function counterpartyGlyph(m: FinanceMovement): string | null {
  if (m.direction === 'income') return m.dest?.glyph ?? null
  if (m.direction === 'expense') return m.source?.glyph ?? null
  return m.source?.glyph ?? m.dest?.glyph ?? null
}

/** Kind fallback when no brand slug — bank/cash/pos/digital_wallet.
 *  Same counterparty rule as counterpartyGlyph. */
function counterpartyKind(m: FinanceMovement): FinanceAccountKind | null {
  if (m.direction === 'income') return m.dest?.kind ?? null
  if (m.direction === 'expense') return m.source?.kind ?? null
  return m.source?.kind ?? m.dest?.kind ?? null
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

function tileSubtitle(a: FinanceAccount, locale?: string, t?: (en: string, es?: string) => string): string {
  const ago = timeAgo(new Date(a.updated_at))
  const parts: string[] = []
  // Mask lands in the subtitle for Plaid-linked tiles so the
  // title can stay clean ("Chase Savings") while the ··NNNN still
  // shows for disambiguation when the merchant has siblings.
  if (a.mask) parts.push(`··${a.mask}`)
  // A POS tile backed by a live processor read is showing money
  // that is still accumulating in the open batch — it is NOT yet
  // "to be deposited", which would imply it's staged and ready.
  // Tenants with no processor connected keep the original copy.
  if (a.kind === 'pos' && a.livePendingSource === 'poynt') {
    const label = t ? t('In current batch', 'En el lote actual') : 'In current batch'
    const opened = formatBatchOpened(a.livePendingOpenedAt, locale, t)
    parts.push(opened ? `${label} · ${opened}` : label)
  }
  else if (a.kind === 'pos') parts.push('To be deposited')
  else if (a.kind === 'cash') parts.push(`Last counted · ${ago}`)
  else if (a.kind === 'bank') parts.push(`Deposit · ${ago}`)
  else if (a.kind === 'digital_wallet') parts.push(`Payment · ${ago}`)
  else parts.push(ago)
  return parts.join(' · ')
}

/** "since 6:12 AM" for a batch opened today, "since Sep 1" for one
 *  that's been carrying over. Returns '' when we have no opened-at
 *  (an empty batch has no oldest transaction) so the caller can
 *  omit the clause entirely. */
function formatBatchOpened(
  iso: string | null | undefined,
  locale?: string,
  t?: (en: string, es?: string) => string,
): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const loc = locale || 'en-US'
  const since = t ? t('since', 'desde') : 'since'
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) {
    return `${since} ${d.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' })}`
  }
  return `${since} ${d.toLocaleDateString(loc, { month: 'short', day: 'numeric' })}`
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
// Report modal — inline preview of /finance/report inside an
// overlay, so the operator never leaves the Finance page. The
// iframe loads the report in embedded mode (no toolbar) and the
// modal's own chrome supplies Download CSV + Print + Close.
// Print targets the iframe's window so only the report prints,
// not the Finance page underneath.
// ================================================================

function ReportModal({
  onClose, t, period, periodTitle,
}: {
  onClose: () => void
  t: (en: string, es?: string) => string
  /** YYYY-MM — mirrors the Finance page's selected month so the
   *  report opens for whatever the picker had. */
  period: string
  /** Human-readable version of `period` — "September 2026". */
  periodTitle: string
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // Escape closes + body scroll lock while open. Same pattern as
  // the Add expense drawer so keyboard behavior stays consistent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const doPrint = () => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    try {
      win.focus()
      win.print()
    } catch (err) {
      console.error('[finance:report] iframe print failed', err)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(24,24,27,0.42)',
        display: 'flex', alignItems: 'stretch', justifyContent: 'center',
        padding: '24px 24px 24px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14, overflow: 'hidden',
          border: `1px solid ${LINE}`,
          boxShadow: '0 20px 60px rgba(24,24,27,0.28)',
          width: '100%', maxWidth: 980,
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Modal chrome */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', borderBottom: `1px solid ${LINE}`,
          background: '#fff', flex: '0 0 auto',
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {t('Cash-basis P&L', 'P&L base efectivo')}
          </span>
          <span style={{
            fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
            color: FAINT, textTransform: 'uppercase',
          }}>
            {periodTitle}
          </span>
          <div style={{ flex: 1 }} />
          <a
            href={`/finance/report/csv?period=${period}`}
            style={{
              border: `1px solid ${LINE}`, background: '#fff', color: INK,
              borderRadius: 10, height: 32, padding: '0 12px',
              font: 'inherit', fontSize: 12.5, fontWeight: 500,
              textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
            }}
          >
            {t('Download CSV', 'Descargar CSV')}
          </a>
          <button
            type="button"
            onClick={doPrint}
            style={{
              border: 0, background: INK, color: PAPER,
              borderRadius: 10, height: 32, padding: '0 14px',
              font: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {t('Print', 'Imprimir')}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Close', 'Cerrar')}
            style={{
              border: `1px solid ${LINE}`, background: '#fff', color: MUTED,
              borderRadius: 8, width: 32, height: 32, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              font: 'inherit', fontSize: 16, lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Iframe body — loads the embedded report. Sandbox omitted
            deliberately: same-origin, so Print + CSS + fonts all
            work without extra plumbing. */}
        <iframe
          ref={iframeRef}
          src={`/finance/report?period=${period}&embedded=1`}
          title={t('Cash-basis P&L', 'P&L base efectivo')}
          style={{
            flex: 1, width: '100%', border: 0, background: '#F1F0EC',
            minHeight: 400,
          }}
        />
      </div>
    </div>
  )
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
