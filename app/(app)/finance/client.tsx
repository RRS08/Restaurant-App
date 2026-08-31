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

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { makeT, type Lang } from '@/lib/i18n'
import { addExpense, createAccount } from '@/app/actions/finance'
import type {
  FinanceAccount,
  FinanceCategory,
  FinanceMovement,
  FinanceAccountKind,
  FinanceMovementDirection,
} from '@/lib/finance/types'
import { ACCOUNT_KIND_DEFAULTS } from '@/lib/finance/types'

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
  cashOnHand, weekIn, weekOut, activePlaceId,
}: {
  lang: Lang
  accounts: FinanceAccount[]
  categories: FinanceCategory[]
  movements: FinanceMovement[]
  cashOnHand: number
  weekIn: number
  weekOut: number
  activePlaceId: string | null
}) {
  const t = makeT(lang)
  const locale = lang === 'es' ? 'es-ES' : 'en-US'

  const [accountFilter, setAccountFilter] = useState<string | 'all' | 'expenses'>('all')
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)

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

  const weekLabel = weekRangeLabel(new Date(), locale)

  return (
    <div style={{
      minHeight: '100vh', background: '#fff', color: INK,
      fontFamily: "'Geist', system-ui, sans-serif",
      padding: 0,
    }}>
      {/* Header — cash on hand, weekly delta, date range, add
          expense CTA. */}
      <div style={{
        padding: '20px 24px 18px', borderBottom: `1px solid ${LINE}`,
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.035em' }}>
              {t('Finance', 'Finanzas')}
            </span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999,
              padding: '3px 10px', fontSize: 11, fontWeight: 500,
              background: SURFACE, color: MUTED, border: `1px solid ${LINE}`,
            }}>
              {weekLabel}
              <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
            </span>
          </div>
          <button
            type="button"
            onClick={() => setExpenseOpen(true)}
            disabled={accounts.length === 0}
            title={accounts.length === 0
              ? t('Add an account first to attach the expense to.', 'Añade primero una cuenta para vincular el gasto.')
              : undefined}
            style={{
              border: 0, background: INK, color: PAPER,
              borderRadius: 10, padding: '9px 16px',
              font: 'inherit', fontSize: 13, fontWeight: 600,
              cursor: accounts.length === 0 ? 'not-allowed' : 'pointer',
              opacity: accounts.length === 0 ? 0.55 : 1,
            }}
          >
            {t('Add expense', 'Añadir gasto')}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <span style={{
            fontFamily: MONO, fontSize: 34, fontWeight: 600,
            letterSpacing: '-0.045em', lineHeight: 1, color: INK,
          }}>
            {fmtMoney(cashOnHand)}
          </span>
          <span style={{
            fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: FAINT,
          }}>
            {t('CASH ON HAND', 'EFECTIVO A LA MANO')}
          </span>
          <Dot />
          <span style={{ fontSize: 13, color: INCOME, fontFamily: MONO, fontWeight: 600 }}>
            +{fmtMoney(weekIn)}
          </span>
          <span style={{ fontSize: 12, color: MUTED }}>{t('in this week', 'esta semana')}</span>
          <Dot />
          <span style={{ fontSize: 13, color: EXPENSE, fontFamily: MONO, fontWeight: 600 }}>
            −{fmtMoney(weekOut)}
          </span>
          <span style={{ fontSize: 12, color: MUTED }}>{t('out', 'salida')}</span>
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
              <AccountTile key={a.id} a={a} locale={locale} />
            ))}
            <AddAccountTile t={t} onClick={() => setAccountOpen(true)} />
          </div>
        )}
      </div>

      {/* Every movement — filter chips + row list. */}
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
            {weekLabel.toUpperCase()}
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
              ? t('Nothing has moved yet this week.', 'Nada se ha movido esta semana.')
              : t('No movements match this filter.', 'Ningún movimiento coincide.')}
          </div>
        ) : shown.map(m => (
          <MovementRow key={m.id} m={m} locale={locale} t={t} />
        ))}
      </div>

      {expenseOpen && (
        <AddExpenseDrawer
          accounts={accounts}
          categories={categories}
          onClose={() => setExpenseOpen(false)}
          t={t}
        />
      )}
      {accountOpen && (
        <AddAccountDrawer
          activePlaceId={activePlaceId}
          onClose={() => setAccountOpen(false)}
          t={t}
        />
      )}
    </div>
  )
}

// ================================================================
// Tiles
// ================================================================

function AccountTile({ a, locale: _locale }: { a: FinanceAccount; locale: string }) {
  const tone = tintForAccount(a)
  return (
    <div
      style={{
        border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff',
        padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 32, height: 32, borderRadius: 8,
        background: tone.tile, color: tone.ink,
      }}>
        <AccountGlyph kind={a.kind} />
      </span>
      <span style={{
        fontSize: 12, color: MUTED, letterSpacing: '-0.005em',
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

function AddAccountTile({
  t, onClick,
}: {
  t: (en: string, es?: string) => string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px dashed ${LINE}`, borderRadius: 12, background: 'transparent',
        padding: '14px 16px 16px', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 6,
        color: MUTED, fontSize: 13, fontWeight: 500,
        cursor: 'pointer', minHeight: 120, font: 'inherit',
        transition: 'border-color .12s ease, color .12s ease, background .12s ease',
      }}
    >
      <span style={{ fontSize: 18, lineHeight: 1 }}>+</span>
      {t('Add account', 'Añadir cuenta')}
    </button>
  )
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
  const dirColor = m.direction === 'income' ? INCOME
    : m.direction === 'expense' ? EXPENSE
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

function weekRangeLabel(now: Date, locale: string): string {
  const day = now.getDay()
  const diff = (day + 6) % 7
  const start = new Date(now)
  start.setDate(now.getDate() - diff)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  const startStr = start.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  const endStr = end.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  return `${startStr} – ${endStr}`
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
// Add account drawer
// ================================================================

function AddAccountDrawer({
  activePlaceId, onClose, t,
}: {
  activePlaceId: string | null
  onClose: () => void
  t: (en: string, es?: string) => string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [plaidNotice, setPlaidNotice] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [kind, setKind] = useState<FinanceAccountKind>('digital_wallet')
  const [balanceStr, setBalanceStr] = useState('')

  function save() {
    setError(null)
    if (!name.trim()) {
      setError(t('Give the account a name.', 'Ponle un nombre a la cuenta.'))
      return
    }
    const balance = balanceStr.trim() === '' ? 0 : parseFloat(balanceStr)
    if (!Number.isFinite(balance)) {
      setError(t('Starting balance must be a number.', 'El saldo inicial debe ser un número.'))
      return
    }
    startTransition(async () => {
      const result = await createAccount({
        name: name.trim(),
        kind,
        // Every account is location-scoped for now — the pilot
        // target is single-place vendors, and scoping matches
        // their mental model. Shop-wide accounts across multiple
        // locations get a picker back when we have that user.
        location_id: activePlaceId,
        color: ACCOUNT_KIND_DEFAULTS[kind].color,
        balance,
      })
      if ('error' in result) {
        setError(result.error)
      } else {
        router.refresh()
        onClose()
      }
    })
  }

  function openPlaid() {
    // Plaid Link fires from here once the tenant has Plaid Dev
    // credentials configured on the server (PLAID_CLIENT_ID +
    // PLAID_SECRET + PLAID_ENV env vars). Until then, this
    // surface exists so the operator can see where the flow
    // will live — a stub notice tells them what's missing.
    setPlaidNotice(t(
      'Plaid credentials not configured yet. Set up a Plaid Development account (free, ~1 day) — Chat says: I have Plaid keys — and this button connects to your Venmo, Cash App, Zelle, and every US bank in one flow.',
      'Plaid aún no está configurado. Regístrate en Plaid Development (gratis, ~1 día) y este botón conectará Venmo, Cash App, Zelle y cualquier banco de EE.UU.',
    ))
  }

  const kindOptions: Array<{ value: FinanceAccountKind; label: string }> = [
    { value: 'digital_wallet', label: t('Digital wallet', 'Billetera digital') },
    { value: 'bank',           label: t('Bank', 'Banco') },
    { value: 'cash',           label: t('Cash drawer', 'Caja') },
    { value: 'pos',            label: t('POS', 'POS') },
    { value: 'other',          label: t('Other', 'Otra') },
  ]

  return (
    <DrawerShell
      title={t('Add account', 'Añadir cuenta')}
      eyebrow={t('NEW ACCOUNT', 'NUEVA CUENTA')}
      onClose={onClose}
      pending={pending}
      footer={
        <DrawerFooter
          onCancel={onClose}
          onSave={save}
          saveLabel={pending ? t('Saving…', 'Guardando…') : t('Add account', 'Añadir cuenta')}
          pending={pending}
          error={error}
          t={t}
        />
      }
    >
      {/* Plaid connect — one integration unlocks Venmo, Cash App,
          Zelle, and every US bank in a single Link flow. Sits at
          the top so an operator with a payment app to add reaches
          for it first; the manual form below is the fallback for
          accounts Plaid can't touch (own cash drawer, unlisted
          neo-bank, etc.). */}
      <div style={{
        border: `1px solid ${LINE}`, borderRadius: 12, background: SURFACE,
        padding: '14px 14px 14px', marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Plaid brand mark — the rounded-square "P" from their
              favicon / app icon. Ink background, paper glyph so it
              reads at a small tile size. */}
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: 8, background: '#000', color: '#fff',
          }}>
            <svg width="18" height="18" viewBox="0 0 32 32" fill="none" aria-hidden>
              <rect width="32" height="32" rx="7" fill="#000" />
              <path
                d="M11 8h6.2c3.4 0 5.6 2 5.6 5.1 0 3.1-2.2 5.1-5.6 5.1H14V24h-3V8zm3 2.6v4.9h2.9c1.9 0 3-1 3-2.5s-1.1-2.4-3-2.4H14z"
                fill="#fff"
              />
            </svg>
          </span>
          <span style={{ minWidth: 0, flex: 1, fontSize: 13, fontWeight: 600, color: INK }}>
            {t('Connect via Plaid', 'Conectar con Plaid')}
          </span>
          <button
            type="button"
            onClick={openPlaid}
            style={{
              border: 0, background: INK, color: PAPER,
              borderRadius: 8, padding: '7px 12px', font: 'inherit',
              fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: '0 0 auto',
            }}
          >
            {t('Connect', 'Conectar')}
          </button>
        </div>
        {plaidNotice && (
          <div style={{
            marginTop: 10, padding: '9px 11px', border: `1px solid #FCD34D`,
            borderRadius: 8, background: '#FFFBEB',
            fontSize: 12, color: '#78350F', lineHeight: 1.5,
          }}>
            {plaidNotice}
          </div>
        )}
      </div>

      {/* Divider — "or add manually" so the two paths are clear. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        margin: '4px 0 14px',
        fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
        color: FAINT, textTransform: 'uppercase',
      }}>
        <span style={{ flex: 1, height: 1, background: LINE }} />
        {t('or add manually', 'o añadir manualmente')}
        <span style={{ flex: 1, height: 1, background: LINE }} />
      </div>

      <Field label={t('Kind', 'Tipo')} required>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {kindOptions.map(o => {
            const previewTone = tintForKind(o.value)
            return (
              <PickerPill
                key={o.value}
                label={o.label}
                tone={previewTone}
                active={kind === o.value}
                onClick={() => setKind(o.value)}
              />
            )
          })}
        </div>
      </Field>

      <Field label={t('Name', 'Nombre')} required hint={t('e.g. Venmo, Chase Business, Zelle', 'ej. Venmo, Chase Business, Zelle')}>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('Account name', 'Nombre de la cuenta')}
          autoFocus
          style={fieldInputStyle()}
        />
      </Field>

      <Field label={t('Starting balance', 'Saldo inicial')} hint={t('Current amount in the account. Leave blank for zero.', 'Cantidad actual en la cuenta. Deja en blanco para cero.')}>
        <span style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px',
          border: `1px solid ${LINE}`, borderRadius: 8, background: '#fff',
        }}>
          <span style={{ fontFamily: MONO, fontSize: 14, color: MUTED }}>$</span>
          <input
            type="text"
            inputMode="decimal"
            value={balanceStr}
            onChange={e => setBalanceStr(e.target.value)}
            placeholder="0.00"
            style={{
              flex: 1, border: 0, outline: 'none', background: 'transparent',
              font: 'inherit', fontFamily: MONO, fontSize: 14, color: INK, minWidth: 0,
            }}
          />
        </span>
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
