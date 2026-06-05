// ----------------------------------------------------------------
// SystemStatusCard — compact 2-column readiness checklist.
//
// Drops the per-row prose descriptions to keep the card tight.
// Each row is just `Name  [● Status]`. Two columns on desktop, one
// column on narrow widths. Same plain-language Active / Setup
// needed / Not active mapping as Operations.
//
// Detailed setup guidance still lives inside each pillar's own
// page (Menu, Inventory, etc.); Settings only summarizes state.
// ----------------------------------------------------------------

import type { ReadinessSnapshot, PillarKey, PillarState } from '@/lib/readiness'
import { StatusPill, type StatusTone } from './ui'

function pillarToPilotStatus(state: PillarState): { label: string; tone: StatusTone } {
  switch (state) {
    case 'active':
    case 'active_with_limitations':
      return { label: 'Active', tone: 'active' }
    case 'ready':
    case 'setup_in_progress':
      return { label: 'Setup needed', tone: 'setup' }
    case 'not_started':
    default:
      return { label: 'Not active', tone: 'idle' }
  }
}

const ROWS: { key: PillarKey; name: string }[] = [
  { key: 'sales',     name: 'Sales' },
  { key: 'menu',      name: 'Menu' },
  { key: 'inventory', name: 'Inventory' },
  { key: 'staffing',  name: 'Staffing' },
  { key: 'finance',   name: 'Finance' },
  { key: 'dashboard', name: 'Dashboard' },
  { key: 'analytics', name: 'Analytics' },
]

export default function SystemStatusCard({ readiness }: { readiness: ReadinessSnapshot }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
          System Status
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 px-5 py-3">
        {ROWS.map((row) => {
          const status = pillarToPilotStatus(readiness.pillars[row.key])
          return (
            <div key={row.key} className="flex items-center justify-between gap-2">
              <p className="text-xs text-gray-700">{row.name}</p>
              <StatusPill label={status.label} tone={status.tone} />
            </div>
          )
        })}
      </div>
    </section>
  )
}
