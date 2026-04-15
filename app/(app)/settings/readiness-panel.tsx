'use client'

// ----------------------------------------------------------------
// Readiness Panel — compact read-only view of pillar states.
// Surfaces operating mode + inventory activation for regular users.
// Dev overrides (if any) flow through here naturally since they're
// already applied inside computeReadiness.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import { setOperatingMode, activateInventory } from '@/app/actions/onboarding'
import type { ReadinessSnapshot, PillarState, PillarKey } from '@/lib/readiness'

const STATE_META: Record<PillarState, { label: string; className: string; dot: string }> = {
  not_started:             { label: 'Not started',       className: 'bg-gray-100 text-gray-500',   dot: 'bg-gray-300' },
  setup_in_progress:       { label: 'Setup in progress', className: 'bg-blue-50 text-blue-700',    dot: 'bg-blue-400' },
  ready:                   { label: 'Ready',             className: 'bg-amber-50 text-amber-700',  dot: 'bg-amber-500' },
  active:                  { label: 'Active',            className: 'bg-green-50 text-green-700',  dot: 'bg-green-500' },
  active_with_limitations: { label: 'Active · limited',  className: 'bg-amber-50 text-amber-700',  dot: 'bg-amber-500' },
}

const PILLAR_ORDER: { key: PillarKey; label: string; hint: string }[] = [
  { key: 'sales',     label: 'Sales',     hint: 'Operating mode + completed orders' },
  { key: 'menu',      label: 'Menu',      hint: 'Categories + items' },
  { key: 'mapping',   label: 'Mapping',   hint: 'Menu items linked to recipe components' },
  { key: 'inventory', label: 'Inventory', hint: 'Items + mapping + baseline + explicit activation' },
  { key: 'staffing',  label: 'Staffing',  hint: 'Employees, shifts, hourly rates' },
  { key: 'finance',   label: 'Finance',   hint: 'Expenses + sales (bank sync optional)' },
  { key: 'bankSync',  label: 'Bank sync', hint: 'External bank intake — coming soon' },
  { key: 'dashboard', label: 'Dashboard', hint: 'Summary layer' },
  { key: 'analytics', label: 'Analytics', hint: 'Setup gate + live-data gate (7 days, 10 orders)' },
]

export default function ReadinessPanel({ readiness }: { readiness: ReadinessSnapshot }) {
  const [modeState, modeAction, modePending] = useActionState(setOperatingMode, null)
  const [invState, invAction, invPending] = useActionState(activateInventory, null)

  const inv = readiness.signals.inventory
  const hasBaseline = inv.baselineCount > 0
  const canActivate = inv.itemCount > 0 && hasBaseline && !inv.activatedAt

  return (
    <div className="space-y-4">
      {/* Operating mode */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Operating mode</p>
            <h3 className="text-sm font-semibold text-gray-900 mt-0.5">How sales are captured</h3>
          </div>
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
            readiness.operatingMode ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
          }`}>
            {readiness.operatingMode
              ? readiness.operatingMode === 'native_pos' ? 'Native POS' : 'External POS'
              : 'Not set'}
          </span>
        </div>

        <form action={modeAction} className="flex flex-wrap items-center gap-2">
          <button type="submit" name="operating_mode" value="native_pos"
            disabled={modePending || readiness.operatingMode === 'native_pos'}
            className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
              readiness.operatingMode === 'native_pos'
                ? 'bg-gray-900 text-white border-gray-900 cursor-default'
                : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
            }`}>
            Native POS
          </button>
          <button type="submit" name="operating_mode" value="external_pos"
            disabled={modePending || readiness.operatingMode === 'external_pos'}
            className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
              readiness.operatingMode === 'external_pos'
                ? 'bg-gray-900 text-white border-gray-900 cursor-default'
                : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
            }`}>
            External POS
          </button>
          {modeState?.error && <span className="text-[11px] text-red-600">{modeState.error}</span>}
        </form>
      </div>

      {/* Pillar grid */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <ul className="divide-y divide-gray-50">
          {PILLAR_ORDER.map((row) => {
            const state = readiness.pillars[row.key]
            const meta = STATE_META[state]
            const overridden = readiness.devBypassAll || row.key in readiness.devPillarOverrides
            return (
              <li key={row.key} className="flex items-start justify-between px-5 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{row.label}</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">{row.hint}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {overridden && (
                    <span className="text-[9px] font-bold uppercase tracking-widest text-amber-700">DEV</span>
                  )}
                  <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${meta.className}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                    {meta.label}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      {/* Inventory activation */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-start justify-between mb-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Inventory tracking</p>
            <h3 className="text-sm font-semibold text-gray-900 mt-0.5">
              {inv.activatedAt ? 'Live tracking active' : 'Not activated'}
            </h3>
          </div>
        </div>
        <p className="text-xs text-gray-500 leading-relaxed mb-3">
          New orders start depleting stock once you activate tracking. Historical sales are never applied retroactively.
        </p>
        {inv.activatedAt ? (
          <p className="text-[11px] text-gray-400">
            Activated {new Date(inv.activatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </p>
        ) : (
          <form action={invAction}>
            <button type="submit" disabled={!canActivate || invPending}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {invPending ? 'Activating…' : 'Activate inventory tracking'}
            </button>
            {!canActivate && (
              <p className="mt-2 text-[10px] text-gray-400 leading-relaxed">
                Requires at least one inventory item and one recorded count.
              </p>
            )}
            {invState?.error && <p className="mt-2 text-[11px] text-red-600">{invState.error}</p>}
          </form>
        )}
      </div>
    </div>
  )
}
