// ----------------------------------------------------------------
// OperationsCard — compact "how the restaurant runs" snapshot.
//
// Two lines of substance:
//   1. Sales mode  — the foundational onboarding choice
//   2. Active workflows  — inline chip-style names of pillars
//      currently "active" (Inventory · Staffing · Finance, etc.)
//
// We intentionally don't repeat per-pillar status here — System
// Status below carries that detail. Operations only summarizes
// what's RUNNING right now, not which pillars are pending setup.
// Analytics is also omitted here per spec (System Status covers it).
// ----------------------------------------------------------------

import type { ReadinessSnapshot, PillarKey, PillarState, OperatingMode } from '@/lib/readiness'

function isActive(state: PillarState): boolean {
  return state === 'active' || state === 'active_with_limitations'
}

function operatingModeLabel(mode: OperatingMode): string {
  if (mode === 'native_pos')   return 'Native POS'
  if (mode === 'external_pos') return 'External POS'
  return 'Not set'
}

// Operations rolls only the "is this workflow live?" view across
// the three operating pillars the owner cares about day-to-day.
const WORKFLOWS: { key: PillarKey; label: string }[] = [
  { key: 'inventory', label: 'Inventory' },
  { key: 'staffing',  label: 'Staffing'  },
  { key: 'finance',   label: 'Finance'   },
]

export default function OperationsCard({ readiness }: { readiness: ReadinessSnapshot }) {
  const sales = operatingModeLabel(readiness.operatingMode)
  const activeNames = WORKFLOWS
    .filter((w) => isActive(readiness.pillars[w.key]))
    .map((w) => w.label)

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-5 py-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
        Operations
      </p>

      <p className="mt-1.5 text-[11px] text-gray-400">Sales mode</p>
      <p className="mt-0.5 text-base font-semibold text-gray-900">{sales}</p>

      <div className="mt-3 pt-3 border-t border-gray-100">
        <p className="text-[11px] text-gray-400">Active workflows</p>
        {activeNames.length > 0 ? (
          <p className="mt-0.5 text-xs text-gray-700 truncate">{activeNames.join(' · ')}</p>
        ) : (
          <p className="mt-0.5 text-xs text-gray-400">None yet</p>
        )}
      </div>
    </section>
  )
}
