// ----------------------------------------------------------------
// Settings UI primitives — shared visual chrome for the four
// owner/manager-facing cards (Business, Operations, Integrations,
// System Status). Keeps the four cards visually consistent without
// each file re-implementing card shells, eyebrow rows, or status
// pill plumbing.
//
// Strictly presentation. No business logic, no actions.
// ----------------------------------------------------------------

import React from 'react'

// ----------------------------------------------------------------
// SettingsCard — outer card chrome: eyebrow + title + optional
// subtitle on top, content below. Used by every Settings section
// so they share the same rounded-xl + bordered shell.
// ----------------------------------------------------------------
export function SettingsCard({
  eyebrow,
  title,
  subtitle,
  action,
  children,
}: {
  eyebrow: string
  title: string
  subtitle?: string
  /** Optional action node rendered top-right (e.g. Manage / Connect). */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <header className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
            {eyebrow}
          </p>
          <h2 className="mt-0.5 text-sm font-semibold text-gray-900">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">{subtitle}</p>
          )}
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </header>
      <div>{children}</div>
    </section>
  )
}

// ----------------------------------------------------------------
// SettingsRow — single label/value pair, divided row inside a
// SettingsCard. Value can be a plain string or any node (so a
// status pill, link, etc. can drop in).
// ----------------------------------------------------------------
export function SettingsRow({
  label,
  value,
  hint,
}: {
  label: string
  value: React.ReactNode
  /** Optional secondary line under the value. */
  hint?: string
}) {
  return (
    <div className="px-5 py-3 flex items-start justify-between gap-3 border-b border-gray-50 last:border-b-0">
      <div className="min-w-0">
        <p className="text-xs font-medium text-gray-700">{label}</p>
        {hint && <p className="mt-0.5 text-[10.5px] text-gray-400 leading-relaxed">{hint}</p>}
      </div>
      <div className="flex-shrink-0 text-right">
        {typeof value === 'string' ? (
          <p className="text-xs text-gray-900">{value}</p>
        ) : (
          value
        )}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// StatusPill — compact colored status indicator with a small dot.
// Three pilot tones cover the lifecycles we surface:
//   • active  → green  (running fine)
//   • setup   → amber  (needs attention to reach Active)
//   • idle    → gray   (not started / not connected)
// Plus a "blue" tone for in-progress / configured-untested states
// where neither active nor idle fits.
// ----------------------------------------------------------------
export type StatusTone = 'active' | 'setup' | 'idle' | 'info'

const STATUS_STYLES: Record<StatusTone, { bg: string; text: string; dot: string }> = {
  active: { bg: 'bg-green-50',  text: 'text-green-700',  dot: 'bg-green-500'  },
  setup:  { bg: 'bg-amber-50',  text: 'text-amber-700',  dot: 'bg-amber-500'  },
  idle:   { bg: 'bg-gray-100',  text: 'text-gray-600',   dot: 'bg-gray-400'   },
  info:   { bg: 'bg-blue-50',   text: 'text-blue-700',   dot: 'bg-blue-500'   },
}

export function StatusPill({ label, tone }: { label: string; tone: StatusTone }) {
  const s = STATUS_STYLES[tone]
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${s.bg} ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {label}
    </span>
  )
}
