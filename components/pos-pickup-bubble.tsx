'use client'

// ----------------------------------------------------------------
// POSPickupBubble — the ping at the top of /pos telling the
// counter staff a web pickup order came in.
//
// Rendered even when the pending list is empty so its layout slot
// stays stable (empty state = calm "All pickups handled" pill).
// Click expands into a popover listing every pending pickup for
// today; each row has one action — "Mark ready" — which calls the
// markReady server action, fires the buyer's ready-for-pickup
// email via after(), and refreshes the ledger. The item text on
// each row comes from the frozen cart snapshot so a counter person
// can pack the bag without opening the drawer.
//
// Optimistic UI: rows removed from the list the instant the button
// is clicked so the popover reads as instant regardless of how
// fast Resend / revalidation come back. A failed action rolls the
// row back and shows the error inline.
// ----------------------------------------------------------------

import { useState, useTransition } from 'react'
import { markReady } from '@/app/actions/pickup'
import type { PendingPickup } from '@/lib/orders/pickup'

const INK = '#18181B'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const LINE = '#E7E6E2'
const LINE_SOFT = '#F0EFEB'
const SURFACE = '#FAFAF9'
const MONO = "'Geist Mono', ui-monospace, monospace"
const PICKUP_INK = '#C2410C'
const PICKUP_TILE = '#FDF1EA'
const PICKUP_DOT = '#EA580C'

export default function POSPickupBubble({ initial }: { initial: PendingPickup[] }) {
  const [pending, setPending] = useState<PendingPickup[]>(initial)
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorFor, setErrorFor] = useState<{ id: string; msg: string } | null>(null)
  const [, startTransition] = useTransition()

  const count = pending.length

  function onMarkReady(orderId: string) {
    // Optimistic remove — snap the row out of the list immediately
    // so the popover feels instant. Restore + show error inline
    // if the server action reports back with a failure.
    const snapshot = pending
    setBusyId(orderId)
    setErrorFor(null)
    setPending(snapshot.filter(p => p.id !== orderId))

    const fd = new FormData()
    fd.set('order_id', orderId)
    startTransition(async () => {
      const result = await markReady(fd)
      setBusyId(null)
      if ('error' in result) {
        setPending(snapshot)
        setErrorFor({ id: orderId, msg: result.error })
      }
    })
  }

  return (
    <div style={{ position: 'relative', marginBottom: 16 }}>
      {/* Pill — always rendered so the layout stays stable. Empty
          state is muted; count > 0 flips to the pickup-orange tone
          so it reads at a glance from across the room. */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 10,
          padding: '9px 14px', borderRadius: 999,
          border: `1px solid ${count > 0 ? PICKUP_INK : LINE}`,
          background: count > 0 ? PICKUP_TILE : '#fff',
          color: count > 0 ? PICKUP_INK : MUTED,
          font: 'inherit', fontSize: 13, fontWeight: 600,
          cursor: 'pointer',
          transition: 'background 120ms ease, border-color 120ms ease',
        }}
      >
        <BagIcon />
        {count > 0
          ? `${count} pickup ${count === 1 ? 'order' : 'orders'} to pack`
          : 'All pickups handled'}
        {count > 0 && (
          <span aria-hidden style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minWidth: 20, height: 20, borderRadius: 999,
            background: PICKUP_INK, color: '#fff',
            fontSize: 11, fontWeight: 700, padding: '0 6px',
          }}>
            {count}
          </span>
        )}
      </button>

      {open && count > 0 && (
        <div
          role="dialog"
          aria-label="Pending pickup orders"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', left: 0,
            zIndex: 20, width: 420, maxWidth: 'calc(100vw - 32px)',
            border: `1px solid ${LINE}`, borderRadius: 12,
            background: '#fff', boxShadow: '0 16px 36px rgba(24,24,27,0.14)',
            overflow: 'hidden',
          }}
        >
          <div style={{
            padding: '12px 14px', borderBottom: `1px solid ${LINE}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: SURFACE,
          }}>
            <span style={{
              fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em', color: MUTED,
            }}>
              PENDING PICKUPS
            </span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>{count}</span>
          </div>

          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {pending.map((p, i) => (
              <div
                key={p.id}
                style={{
                  padding: '12px 14px',
                  borderBottom: i === pending.length - 1 ? undefined : `1px solid ${LINE_SOFT}`,
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}
              >
                <div style={{
                  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                  gap: 12,
                }}>
                  <span style={{
                    fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em',
                    color: INK, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {p.customerName || 'Guest'}
                  </span>
                  <span style={{
                    fontFamily: MONO, fontSize: 12, color: MUTED, whiteSpace: 'nowrap',
                  }}>
                    #{p.orderNumber}
                  </span>
                </div>

                {p.itemsSummary && (
                  <span style={{
                    fontSize: 12, color: MUTED, lineHeight: 1.4,
                  }}>
                    {p.itemsSummary}
                  </span>
                )}

                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 10,
                }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    fontFamily: MONO, fontSize: 11, color: FAINT,
                  }}>
                    <span aria-hidden style={{
                      width: 5, height: 5, borderRadius: '50%', background: PICKUP_DOT,
                    }} />
                    {fmtTime(p.createdAt)} · {fmtMoney(p.totalAmount)}
                  </span>
                  <button
                    type="button"
                    disabled={busyId === p.id}
                    onClick={() => onMarkReady(p.id)}
                    style={{
                      border: 0, background: PICKUP_INK, color: '#fff',
                      borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 600,
                      cursor: busyId === p.id ? 'wait' : 'pointer',
                      opacity: busyId === p.id ? 0.6 : 1,
                    }}
                  >
                    {busyId === p.id ? 'Marking…' : 'Mark ready'}
                  </button>
                </div>

                {errorFor?.id === p.id && (
                  <span style={{ fontSize: 11, color: '#B91C1C' }}>{errorFor.msg}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function BagIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4.5 7h11l-.9 9.1a1.5 1.5 0 0 1-1.5 1.35H6.9a1.5 1.5 0 0 1-1.5-1.35L4.5 7z"
        stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7.5 7V5.5a2.5 2.5 0 0 1 5 0V7"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }
  catch { return '' }
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`
}
