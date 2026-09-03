'use client'

// ----------------------------------------------------------------
// Register open / close modal.
//
// Counting is done by denomination because that is how a drawer is
// actually counted — stack the twenties, stack the tens. The grid
// live-sums into a total so the operator sees the number build as
// they type, and a miscount is visible before they commit.
//
// OPEN has up to two steps:
//   1. Count the drawer
//   2. If the count is SHORT of what the last session closed at,
//      explain the gap — deposit (books a Register → Bank transfer)
//      or unexplained (requires a note). Skipped entirely when the
//      count matches, runs over, or this is the first session ever.
//
// CLOSE is one step: count, see the variance against expected, and
// write a note if it does not reconcile.
// ----------------------------------------------------------------

import { useState, useMemo, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { openCashSession, closeCashSession } from '@/app/actions/finance'
import { DENOMINATIONS, sumDenominations, type DenominationCounts } from '@/lib/finance/cash'
import type { FinanceAccount } from '@/lib/finance/types'

const INK = '#18181B'
const PAPER = '#FAF9F6'
const LINE = '#E4E4E7'
const MUTED = '#71717A'
const FAINT = '#A1A1AA'
const MONO = "'Geist Mono', ui-monospace, monospace"
const GOOD = '#15803D'
const BAD = '#B91C1C'

function fmt(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

// ================================================================
// Denomination grid — the shared counting surface.
// ================================================================

function DenominationGrid({
  counts,
  onChange,
  disabled,
}: {
  counts: DenominationCounts
  onChange: (next: DenominationCounts) => void
  disabled?: boolean
}) {
  const total = sumDenominations(counts)
  return (
    <div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)',
        gap: '8px 20px',
      }}>
        {DENOMINATIONS.map(d => {
          const n = counts[d.key] ?? 0
          const line = Math.round(n * d.value * 100) / 100
          return (
            <label key={d.key} style={{
              display: 'grid', gridTemplateColumns: '46px 1fr 74px',
              alignItems: 'center', gap: 8,
            }}>
              <span style={{
                fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: INK,
              }}>
                {d.label}
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                disabled={disabled}
                value={n === 0 ? '' : n}
                placeholder="0"
                onChange={(e) => {
                  const raw = parseInt(e.target.value, 10)
                  const next = { ...counts }
                  if (!Number.isFinite(raw) || raw <= 0) delete next[d.key]
                  else next[d.key] = raw
                  onChange(next)
                }}
                style={{
                  width: '100%', height: 32, padding: '0 8px',
                  border: `1px solid ${LINE}`, borderRadius: 7,
                  font: 'inherit', fontSize: 13, color: INK,
                  background: disabled ? '#FAFAFA' : '#fff',
                  textAlign: 'right',
                }}
              />
              <span style={{
                fontFamily: MONO, fontSize: 11.5,
                color: line > 0 ? MUTED : FAINT, textAlign: 'right',
              }}>
                {line > 0 ? fmt(line) : '—'}
              </span>
            </label>
          )
        })}
      </div>
      <div style={{
        marginTop: 14, paddingTop: 12, borderTop: `1px solid ${LINE}`,
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, letterSpacing: '0.08em', color: FAINT, textTransform: 'uppercase' }}>
          Counted
        </span>
        <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 600, letterSpacing: '-0.03em', color: INK }}>
          {fmt(total)}
        </span>
      </div>
    </div>
  )
}

// ================================================================
// Modal shell
// ================================================================

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(24,24,27,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 16, width: '100%', maxWidth: 460,
          maxHeight: '90vh', overflowY: 'auto',
          boxShadow: '0 24px 60px -12px rgba(24,24,27,0.28)',
        }}
      >
        <div style={{ padding: '20px 22px 0' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: INK, letterSpacing: '-0.02em' }}>
                {title}
              </h2>
              {subtitle && (
                <p style={{ margin: '4px 0 0', fontSize: 12.5, color: MUTED, lineHeight: 1.45 }}>
                  {subtitle}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                flex: 'none', width: 26, height: 26, border: `1px solid ${LINE}`,
                borderRadius: 8, background: '#fff', color: MUTED,
                cursor: 'pointer', font: 'inherit', fontSize: 13, lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        </div>
        <div style={{ padding: '18px 22px' }}>{children}</div>
        <div style={{
          padding: '14px 22px', borderTop: `1px solid ${LINE}`,
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          position: 'sticky', bottom: 0, background: '#fff',
          borderBottomLeftRadius: 16, borderBottomRightRadius: 16,
        }}>
          {footer}
        </div>
      </div>
    </div>
  )
}

function PrimaryButton({
  children, onClick, disabled,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 34, padding: '0 16px', borderRadius: 9, border: 'none',
        background: disabled ? '#D4D4D8' : INK, color: PAPER,
        font: 'inherit', fontSize: 13, fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}

function GhostButton({
  children, onClick,
}: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 34, padding: '0 14px', borderRadius: 9,
        border: `1px solid ${LINE}`, background: '#fff', color: INK,
        font: 'inherit', fontSize: 13, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

// ================================================================
// OPEN
// ================================================================

export function OpenRegisterModal({
  locationId,
  register,
  bankAccounts,
  priorCloseAmount,
  onClose,
}: {
  locationId: string
  register: FinanceAccount
  bankAccounts: FinanceAccount[]
  priorCloseAmount: number | null
  onClose: () => void
}) {
  const router = useRouter()
  const [counts, setCounts] = useState<DenominationCounts>({})
  const [gapReason, setGapReason] = useState<'deposit' | 'unexplained' | null>(null)
  const [depositAmount, setDepositAmount] = useState('')
  const [depositTo, setDepositTo] = useState(bankAccounts[0]?.id ?? '')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const counted = sumDenominations(counts)
  const gap = priorCloseAmount == null
    ? null
    : Math.round((counted - priorCloseAmount) * 100) / 100
  const isShort = gap != null && gap < -0.004
  const shortBy = isShort ? Math.abs(gap) : 0

  // Prefill the deposit field with the full shortfall — the common
  // case is that the whole difference went to the bank.
  useEffect(() => {
    if (gapReason === 'deposit' && !depositAmount && shortBy > 0) {
      setDepositAmount(shortBy.toFixed(2))
    }
  }, [gapReason, shortBy, depositAmount])

  const canSubmit = useMemo(() => {
    if (counted <= 0) return false
    if (!isShort) return true
    if (gapReason === 'deposit') {
      const n = parseFloat(depositAmount)
      return Number.isFinite(n) && n > 0 && n <= shortBy + 0.005
    }
    if (gapReason === 'unexplained') return note.trim().length > 0
    return false
  }, [counted, isShort, gapReason, depositAmount, shortBy, note])

  const submit = () => {
    if (saving || !canSubmit) return
    setSaving(true)
    setError(null)
    openCashSession({
      locationId,
      registerAccountId: register.id,
      denominations: counts as Record<string, number>,
      gapReason: isShort ? (gapReason ?? undefined) : 'none',
      gapDepositAmount: gapReason === 'deposit' ? parseFloat(depositAmount) : undefined,
      gapNote: gapReason === 'unexplained' ? note.trim() : undefined,
      depositToAccountId: gapReason === 'deposit' ? depositTo : undefined,
    })
      .then((res) => {
        if ('error' in res) { setError(res.error); setSaving(false); return }
        router.refresh()
        onClose()
      })
      .catch(() => { setError('Something went wrong.'); setSaving(false) })
  }

  return (
    <ModalShell
      title="Open register"
      subtitle={priorCloseAmount == null
        ? 'Count the drawer to start the day.'
        : `Last closed at ${fmt(priorCloseAmount)}. Count the drawer to start the day.`}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={submit} disabled={!canSubmit || saving}>
            {saving ? 'Opening…' : 'Open register'}
          </PrimaryButton>
        </>
      }
    >
      <DenominationGrid counts={counts} onChange={setCounts} disabled={saving} />

      {isShort && (
        <div style={{
          marginTop: 18, padding: 14, borderRadius: 10,
          background: '#FEF9F3', border: '1px solid #F5D9BC',
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 3 }}>
            {fmt(shortBy)} less than at close
          </div>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
            Was some of this deposited at the bank?
          </p>

          <div style={{ display: 'flex', gap: 8, marginBottom: gapReason ? 12 : 0 }}>
            {(['deposit', 'unexplained'] as const).map(r => (
              <button
                key={r}
                type="button"
                onClick={() => setGapReason(r)}
                style={{
                  flex: 1, height: 34, borderRadius: 9,
                  border: `1px solid ${gapReason === r ? INK : LINE}`,
                  background: gapReason === r ? INK : '#fff',
                  color: gapReason === r ? PAPER : INK,
                  font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                }}
              >
                {r === 'deposit' ? 'Yes, deposited' : 'No'}
              </button>
            ))}
          </div>

          {gapReason === 'deposit' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, letterSpacing: '0.06em', color: FAINT, textTransform: 'uppercase' }}>
                  How much was deposited
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  style={{
                    height: 34, padding: '0 10px', border: `1px solid ${LINE}`,
                    borderRadius: 8, font: 'inherit', fontSize: 13.5,
                    fontFamily: MONO, color: INK,
                  }}
                />
              </label>
              {bankAccounts.length > 0 && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, letterSpacing: '0.06em', color: FAINT, textTransform: 'uppercase' }}>
                    Deposited to
                  </span>
                  <select
                    value={depositTo}
                    onChange={(e) => setDepositTo(e.target.value)}
                    style={{
                      height: 34, padding: '0 8px', border: `1px solid ${LINE}`,
                      borderRadius: 8, font: 'inherit', fontSize: 13, color: INK,
                      background: '#fff',
                    }}
                  >
                    {bankAccounts.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {parseFloat(depositAmount) > 0 && parseFloat(depositAmount) < shortBy - 0.005 && (
                <p style={{ margin: 0, fontSize: 12, color: '#B45309', lineHeight: 1.45 }}>
                  {fmt(shortBy - parseFloat(depositAmount))} is still unaccounted for.
                </p>
              )}
            </div>
          )}

          {gapReason === 'unexplained' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, letterSpacing: '0.06em', color: FAINT, textTransform: 'uppercase' }}>
                What happened?
              </span>
              <textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Required — this is the record of the shortfall."
                style={{
                  padding: 9, border: `1px solid ${LINE}`, borderRadius: 8,
                  font: 'inherit', fontSize: 13, color: INK, resize: 'vertical',
                }}
              />
            </label>
          )}
        </div>
      )}

      {gap != null && gap > 0.004 && (
        <p style={{ marginTop: 14, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
          {fmt(gap)} more than at close. Recorded as-is.
        </p>
      )}

      {error && (
        <p style={{ marginTop: 14, fontSize: 12.5, color: BAD, lineHeight: 1.45 }}>{error}</p>
      )}
    </ModalShell>
  )
}

// ================================================================
// CLOSE
// ================================================================

export function CloseRegisterModal({
  sessionId,
  register,
  expected,
  breakdown,
  onClose,
}: {
  sessionId: string
  register: FinanceAccount
  expected: number
  breakdown: { opening: number; cashSales: number; cashPaidOut: number; cashAddedIn: number }
  onClose: () => void
}) {
  const router = useRouter()
  const [counts, setCounts] = useState<DenominationCounts>({})
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const counted = sumDenominations(counts)
  const variance = Math.round((counted - expected) * 100) / 100
  const off = Math.abs(variance) >= 0.01
  const touched = Object.keys(counts).length > 0
  const canSubmit = touched && (!off || note.trim().length > 0)

  const submit = () => {
    if (saving || !canSubmit) return
    setSaving(true)
    setError(null)
    closeCashSession({
      sessionId,
      registerAccountId: register.id,
      denominations: counts as Record<string, number>,
      note: note.trim() || undefined,
    })
      .then((res) => {
        if ('error' in res) { setError(res.error); setSaving(false); return }
        router.refresh()
        onClose()
      })
      .catch(() => { setError('Something went wrong.'); setSaving(false) })
  }

  const Row = ({ label, value, dim }: { label: string; value: number; dim?: boolean }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5 }}>
      <span style={{ color: dim ? FAINT : MUTED }}>{label}</span>
      <span style={{ fontFamily: MONO, color: dim ? FAINT : INK }}>{fmt(value)}</span>
    </div>
  )

  return (
    <ModalShell
      title="Close register"
      subtitle="Count the drawer. We compare it against what should be there."
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={submit} disabled={!canSubmit || saving}>
            {saving ? 'Closing…' : 'Close register'}
          </PrimaryButton>
        </>
      }
    >
      {/* Expected breakdown — shown before the count so the operator
          can sanity-check the inputs, not just the result. */}
      <div style={{
        padding: 12, borderRadius: 10, background: '#FAFAFA',
        border: `1px solid ${LINE}`, display: 'flex', flexDirection: 'column', gap: 5,
        marginBottom: 18,
      }}>
        <Row label="Opened with" value={breakdown.opening} />
        <Row label="Cash sales" value={breakdown.cashSales} />
        {breakdown.cashPaidOut > 0 && <Row label="Paid out" value={-breakdown.cashPaidOut} />}
        {breakdown.cashAddedIn > 0 && <Row label="Added in" value={breakdown.cashAddedIn} />}
        <div style={{
          marginTop: 4, paddingTop: 7, borderTop: `1px solid ${LINE}`,
          display: 'flex', justifyContent: 'space-between', gap: 12,
        }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>Should be in drawer</span>
          <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, color: INK }}>{fmt(expected)}</span>
        </div>
      </div>

      <DenominationGrid counts={counts} onChange={setCounts} disabled={saving} />

      {touched && (
        <div style={{
          marginTop: 16, padding: '11px 13px', borderRadius: 10,
          background: off ? (variance > 0 ? '#F0FDF4' : '#FEF2F2') : '#F0FDF4',
          border: `1px solid ${off ? (variance > 0 ? '#BBF7D0' : '#FECACA') : '#BBF7D0'}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12,
        }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>
            {!off ? 'Balances exactly' : variance > 0 ? 'Over' : 'Short'}
          </span>
          <span style={{
            fontFamily: MONO, fontSize: 15, fontWeight: 600,
            color: !off ? GOOD : variance > 0 ? GOOD : BAD,
          }}>
            {off ? (variance > 0 ? '+' : '') + fmt(variance) : fmt(0)}
          </span>
        </div>
      )}

      {off && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 }}>
          <span style={{ fontSize: 11, letterSpacing: '0.06em', color: FAINT, textTransform: 'uppercase' }}>
            Why the difference?
          </span>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Required when the drawer does not balance."
            style={{
              padding: 9, border: `1px solid ${LINE}`, borderRadius: 8,
              font: 'inherit', fontSize: 13, color: INK, resize: 'vertical',
            }}
          />
        </label>
      )}

      {error && (
        <p style={{ marginTop: 14, fontSize: 12.5, color: BAD, lineHeight: 1.45 }}>{error}</p>
      )}
    </ModalShell>
  )
}
