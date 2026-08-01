'use client'

// ----------------------------------------------------------------
// PhonePage — the phone-only ("<md") page wrapper.
//
// The tablet/desktop `AppShell` renders a full sidebar/rail + page
// content. On phone we swap to a fundamentally different shape per
// the Claude Design phone spec: the tab bar (in `AppShell`) is the
// only navigation; each tab renders a `<PhonePage>` with the same
// visual anatomy:
//
//   header (fact — hero + stats + status chip + avatar)
//   feed (full-bleed rows, no cards, hairline dividers)
//   optional CTA (in the thumb arc, above the tab bar)
//
// Tapping the avatar opens a full-screen Profile sheet with an
// account/settings list (deferred to a later pass; today it's a
// simple placeholder rendered from `SETTINGS`).
//
// Design rules the wrapper enforces (see docs/phone-spec):
//   - ONE COLUMN, ALWAYS. No side panels.
//   - Header is a fact, not a title. Hero 36px + stats + chip.
//   - Sections use mono-uppercase + dotted-ink rule.
//   - Rows are 56px min; the whole row is the target.
//   - Read-only until proven otherwise. Only interactive pattern
//     is the ConfirmRow (one question, two answers).
// ----------------------------------------------------------------

import { useEffect, useState } from 'react'

const INK = '#18181B'
const PAPER = '#FAF9F6'
const LINE = '#E7E6E2'
const SOFT = '#F0EFEB'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const GHOST = '#D6D5D1'
const MONO = "'Geist Mono', ui-monospace, monospace"

export const PHONE_PAIR = {
  danger:  ['#FEF2F2', '#B91C1C'] as const,
  warning: ['#FFFBEB', '#B45309'] as const,
  success: ['#ECFDF5', '#047857'] as const,
  card:    ['#EEF2FF', '#4F46E5'] as const,
  ink:     ['#F4F4F5', '#18181B'] as const,
  neutral: ['#F5F5F4', '#78716C'] as const,
}
export const PHONE_TOKENS = { INK, PAPER, LINE, SOFT, MUTED, FAINT, GHOST, MONO }

export type PhoneStat = [value: string, label: string]

export type PhoneRow =
  | { kind: 'section'; label: string; meta?: string }
  | {
      kind: 'row'
      key?: string
      glyph?: 'card' | 'cash' | 'out' | 'low'
      initial?: string
      pair?: readonly [string, string]
      title: string
      sub?: string
      subTone?: string
      subMono?: boolean
      value?: string
      valueTone?: string
      trail?: string
      trailTone?: string
      onClick?: () => void
      last?: boolean
    }
  | {
      kind: 'confirm'
      key?: string
      title: string
      sub: string
      yesLabel?: string
      noLabel?: string
      onYes?: () => void
      onNo?: () => void
      last?: boolean
    }
  | { kind: 'empty'; message: string }

export function PhonePage({
  hero, unit, delta, heroTone,
  stats,
  chip, chipPair,
  avatarInitials,
  cta,
  onCtaClick,
  feed,
}: {
  hero: string
  unit: string
  delta?: string | null
  heroTone?: string
  stats: PhoneStat[]
  chip: string
  chipPair: readonly [string, string]
  avatarInitials: string
  cta?: string | null
  onCtaClick?: () => void
  feed: PhoneRow[]
}) {
  const [profileOpen, setProfileOpen] = useState(false)
  if (profileOpen) return <PhoneProfileSheet initials={avatarInitials} onBack={() => setProfileOpen(false)} />

  return (
    <div style={{
      width: '100%', minHeight: '100dvh',
      display: 'flex', flexDirection: 'column',
      background: '#fff', color: INK,
      fontFamily: "'Geist', system-ui, sans-serif",
      // Bottom padding covers the fixed 4-tab bar (see app-shell)
      // + the iOS home indicator safe area.
      paddingBottom: 'calc(78px + env(safe-area-inset-bottom))',
    }}>

      {/* HEADER — fact, not title. Row 1: hero + avatar. Row 2: stats + chip. */}
      <div style={{ flex: '0 0 auto', padding: '14px 20px 16px', borderBottom: `1px solid ${LINE}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 9, minWidth: 0, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: MONO, fontSize: 36, fontWeight: 600, letterSpacing: '-0.05em', lineHeight: 1, color: heroTone ?? INK }}>
              {hero}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>{unit}</span>
            {delta && (
              <span style={{
                fontFamily: MONO, fontSize: 13, fontWeight: 600,
                color: delta.startsWith('↓') ? '#B91C1C' : '#047857',
              }}>
                {delta}
              </span>
            )}
          </span>
          <button
            type="button"
            title="Profile and settings"
            onClick={() => setProfileOpen(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 34, height: 34, border: `1px solid ${LINE}`, borderRadius: 999,
              background: '#F4F4F2', fontFamily: MONO, fontSize: 11, fontWeight: 600,
              color: '#52525B', cursor: 'pointer', padding: 0, flex: '0 0 auto',
            }}
          >
            {avatarInitials}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
            {stats.map(([v, l], i) => (
              <span key={l + i} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
                {i > 0 && <span style={{ width: 3, height: 3, borderRadius: '50%', background: GHOST, alignSelf: 'center', margin: '0 4px 0 2px' }} />}
                <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600 }}>{v}</span>
                <span style={{ fontSize: 12, color: MUTED }}>{l}</span>
              </span>
            ))}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center',
            borderRadius: 999, padding: '3px 10px',
            fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
            background: chipPair[0], color: chipPair[1],
          }}>
            {chip}
          </span>
        </div>
      </div>

      {/* FEED — full-bleed rows, hidden scrollbar */}
      <div data-phone-scroll style={{ flex: 1, minHeight: 0 }}>
        {feed.map((r, i) => {
          if (r.kind === 'section') return <PhoneSectionRow key={`s${i}`} label={r.label} meta={r.meta} />
          if (r.kind === 'confirm') return <PhoneConfirmRow key={r.key ?? `c${i}`} row={r} />
          if (r.kind === 'empty') return (
            <div key={`e${i}`} style={{ padding: '32px 20px', textAlign: 'center', fontSize: 13, color: MUTED }}>
              {r.message}
            </div>
          )
          return <PhoneItemRow key={r.key ?? `r${i}`} r={r} />
        })}
      </div>

      {/* CTA — only when the tab genuinely has an action worth taking */}
      {cta && (
        <div style={{
          flex: '0 0 auto',
          padding: '10px 20px 12px',
          borderTop: `1px solid ${SOFT}`,
          // Sit above the fixed tab bar
          position: 'fixed', left: 0, right: 0,
          bottom: 'calc(78px + env(safe-area-inset-bottom))',
          background: '#fff', zIndex: 20,
        }}>
          <button
            type="button"
            onClick={onCtaClick}
            style={{
              display: 'block', width: '100%', textAlign: 'center',
              border: 0, background: INK, color: PAPER, borderRadius: 12,
              padding: '14px 0', fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
              letterSpacing: '-0.01em', cursor: 'pointer',
            }}
          >
            {cta}
          </button>
        </div>
      )}

      {/* Global hidden-scrollbar rule scoped by data-phone-scroll */}
      <style>{`
        [data-phone-scroll], [data-phone-scroll] * { scrollbar-width: none; -ms-overflow-style: none; }
        [data-phone-scroll]::-webkit-scrollbar,
        [data-phone-scroll] *::-webkit-scrollbar { width: 0; height: 0; display: none; }
      `}</style>
    </div>
  )
}

// ================================================================
// Row components
// ================================================================

function PhoneSectionRow({ label, meta }: { label: string; meta?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '18px 20px 9px' }}>
      <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, letterSpacing: '0.14em', color: INK, flex: '0 0 auto' }}>
        {label}
      </span>
      <span aria-hidden style={{ flexGrow: 1, flexShrink: 1, flexBasis: '0%', height: 0, borderTop: `1px dotted ${INK}` }} />
      {meta && <span style={{ fontFamily: MONO, fontSize: 11, color: '#C4C4C7', flex: '0 0 auto' }}>{meta}</span>}
    </div>
  )
}

function PhoneItemRow({ r }: { r: Extract<PhoneRow, { kind: 'row' }> }) {
  const pair = r.pair ?? PHONE_PAIR.ink
  const clickable = !!r.onClick
  return (
    <div
      onClick={r.onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.onClick?.() } } : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '11px 20px', minHeight: 56,
        borderBottom: r.last ? undefined : `1px solid ${SOFT}`,
        cursor: clickable ? 'pointer' : 'default',
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 34, height: 34, borderRadius: 10, flex: '0 0 auto',
        background: pair[0], color: pair[1],
      }}>
        {r.glyph === 'card' && <CardGlyph />}
        {r.glyph === 'cash' && <CashGlyph />}
        {r.glyph === 'out' && <OutGlyph />}
        {r.glyph === 'low' && <LowGlyph />}
        {r.initial && <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600 }}>{r.initial}</span>}
      </span>

      <span style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, letterSpacing: '-0.015em', lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.title}
        </span>
        {r.sub && (
          <span style={{
            display: 'block', fontSize: 11, marginTop: 3,
            color: r.subTone ?? FAINT,
            fontFamily: r.subMono ? MONO : undefined,
          }}>
            {r.sub}
          </span>
        )}
      </span>

      {(r.value || r.trail) && (
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flex: '0 0 auto' }}>
          {r.value && (
            <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: r.valueTone ?? INK }}>
              {r.value}
            </span>
          )}
          {r.trail && (
            <span style={{ fontFamily: MONO, fontSize: 11, color: r.trailTone ?? FAINT }}>
              {r.trail}
            </span>
          )}
        </span>
      )}
    </div>
  )
}

function PhoneConfirmRow({ row }: { row: Extract<PhoneRow, { kind: 'confirm' }> }) {
  return (
    <div style={{ display: 'flex', padding: '13px 20px 15px', borderBottom: row.last ? undefined : `1px solid ${SOFT}` }}>
      <span style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, letterSpacing: '-0.015em', lineHeight: 1.3 }}>{row.title}</span>
        <span style={{ display: 'block', fontFamily: MONO, fontSize: 11, color: FAINT, marginTop: 4 }}>{row.sub}</span>
        <span style={{ display: 'flex', gap: 9, marginTop: 11 }}>
          <button
            type="button"
            onClick={row.onNo}
            style={{ flex: 1, border: `1px solid ${LINE}`, background: '#fff', borderRadius: 10, padding: '11px 0', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: '#3F3F46', cursor: 'pointer' }}
          >
            {row.noLabel ?? 'Not it'}
          </button>
          <button
            type="button"
            onClick={row.onYes}
            style={{ flex: 1, border: 0, background: INK, color: PAPER, borderRadius: 10, padding: '11px 0', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            {row.yesLabel ?? 'Yes'}
          </button>
        </span>
      </span>
    </div>
  )
}

// ================================================================
// Profile sheet — full-screen replacement.
// Placeholder settings list for now. Real wiring (sign out, name
// edit, notifications) comes later.
// ================================================================

const SETTINGS: ({ head: string } | { title: string; sub?: string; value?: string })[] = [
  { head: 'ACCOUNT' },
  { title: 'Your details', sub: 'Name, email, phone' },
  { title: 'Notifications', sub: 'Low stock, shift reminders', value: 'On' },
  { head: 'SHOP' },
  { title: 'Opening hours', sub: 'Mon closed · Tue–Sun 12p' },
  { title: 'People', sub: 'Roles and who can sign in', value: '5' },
  { head: 'DEVICE' },
  { title: 'Lock this device', sub: 'Ask for a PIN when idle', value: 'Off' },
  { title: 'Connected accounts', sub: 'POS · bank', value: '2' },
  { title: 'Help and support', sub: 'Guides, or message us' },
]

function PhoneProfileSheet({ initials, onBack }: { initials: string; onBack: () => void }) {
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      display: 'flex', flexDirection: 'column',
      background: '#fff', color: INK,
      fontFamily: "'Geist', system-ui, sans-serif",
    }}>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px 16px', borderBottom: `1px solid ${LINE}` }}>
        <button
          type="button"
          onClick={onBack}
          title="Back"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, border: `1px solid ${LINE}`, borderRadius: 999, background: '#fff', fontFamily: 'inherit', color: '#3F3F46', cursor: 'pointer', padding: 0, flex: '0 0 auto' }}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: 999, background: '#F4F4F2', fontFamily: MONO, fontSize: 16, fontWeight: 600, color: '#52525B', flex: '0 0 auto' }}>
          {initials}
        </span>
        <span style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
          <span style={{ display: 'block', fontSize: 19, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.2 }}>Account</span>
          <span style={{ display: 'block', fontSize: 12, color: FAINT, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Settings and preferences</span>
        </span>
      </div>

      <div data-phone-scroll style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {SETTINGS.map((s, i) =>
          'head' in s ? (
            <PhoneSectionRow key={`h${i}`} label={s.head} />
          ) : (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 20px', minHeight: 56, borderBottom: `1px solid ${SOFT}`, cursor: 'pointer' }}>
              <span style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600, letterSpacing: '-0.015em', lineHeight: 1.3 }}>{s.title}</span>
                {s.sub && <span style={{ display: 'block', fontSize: 11, color: FAINT, marginTop: 3 }}>{s.sub}</span>}
              </span>
              {s.value && <span style={{ fontFamily: MONO, fontSize: 12, color: FAINT, flex: '0 0 auto' }}>{s.value}</span>}
              <span aria-hidden style={{ fontSize: 14, color: GHOST, flex: '0 0 auto' }}>›</span>
            </div>
          ),
        )}

        <div style={{ padding: '20px 20px 8px' }}>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              style={{ width: '100%', border: `1px solid ${LINE}`, background: '#fff', borderRadius: 12, padding: '14px 0', fontFamily: 'inherit', fontSize: 14, fontWeight: 600, color: '#B91C1C', cursor: 'pointer' }}
            >
              Sign out
            </button>
          </form>
        </div>
        <div style={{ padding: '6px 20px 40px', textAlign: 'center' }}>
          <span style={{ fontFamily: MONO, fontSize: 10, color: GHOST }}>CHECKED</span>
        </div>
      </div>
    </div>
  )
}

// ================================================================
// Glyphs
// ================================================================

const st = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

function CardGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" {...st} strokeWidth={1.6} aria-hidden>
      <rect x="1.5" y="4" width="17" height="12" rx="2.5" />
      <path d="M1.5 8h17" />
      <path d="M4.5 12.5h3" />
    </svg>
  )
}
function CashGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" {...st} aria-hidden>
      <ellipse cx="10" cy="5.3" rx="6.4" ry="2.5" />
      <path d="M3.6 5.3v4.4c0 1.38 2.87 2.5 6.4 2.5s6.4-1.12 6.4-2.5V5.3" />
      <path d="M3.6 9.7v4.4c0 1.38 2.87 2.5 6.4 2.5s6.4-1.12 6.4-2.5V9.7" />
    </svg>
  )
}
function OutGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" {...st} aria-hidden>
      <path d="M10 2.8l6.4 11H3.6l6.4-11z" />
      <path d="M10 7v2.8" />
      <circle cx="10" cy="11.6" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  )
}
function LowGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" {...st} aria-hidden>
      <circle cx="10" cy="10" r="6.2" />
      <path d="M10 6.4v3.8" />
      <circle cx="10" cy="13.3" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  )
}
