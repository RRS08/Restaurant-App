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

import { useMemo, useState } from 'react'
import { makeT, type Lang } from '@/lib/i18n'
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
  lang, accounts, categories: _categories, movements,
  cashOnHand, weekIn, weekOut, activePlaceId: _activePlaceId,
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
            disabled
            title={t('Coming in the next commit', 'Próximamente')}
            style={{
              border: 0, background: INK, color: PAPER,
              borderRadius: 10, padding: '9px 16px',
              font: 'inherit', fontSize: 13, fontWeight: 600,
              cursor: 'not-allowed', opacity: 0.55,
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
            <AddAccountTile t={t} />
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

function AddAccountTile({ t }: { t: (en: string, es?: string) => string }) {
  return (
    <button
      type="button"
      disabled
      title={t('Coming in the next commit', 'Próximamente')}
      style={{
        border: `1px dashed ${LINE}`, borderRadius: 12, background: 'transparent',
        padding: '14px 16px 16px', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 6,
        color: FAINT, fontSize: 13, fontWeight: 500,
        cursor: 'not-allowed', minHeight: 120, font: 'inherit',
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
  if (kind === 'pos') return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2" y="5" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2 9h16" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
  if (kind === 'cash') return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2" y="6" width="16" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="10" cy="10.5" r="2" stroke="currentColor" strokeWidth="1.6" />
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
