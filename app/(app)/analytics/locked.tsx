// ----------------------------------------------------------------
// AnalyticsLocked — shown when the Analytics pillar is not yet
// `active`. Reads differently depending on whether it's warming up
// (sales flowing but not enough live data) or not started at all.
//
// Respects dev overrides transparently — computeReadiness already
// applies them before this component ever runs.
// ----------------------------------------------------------------

import type { ReadinessSnapshot } from '@/lib/readiness'

export default function AnalyticsLocked({ readiness }: { readiness: ReadinessSnapshot }) {
  const analyticsState = readiness.pillars.analytics
  const sales = readiness.signals.sales
  const an = readiness.signals.analytics

  const warming = analyticsState === 'setup_in_progress'
  const daysShort = Math.max(0, an.minDaysRequired - an.daysSinceFirstOrder)
  const ordersShort = Math.max(0, an.minOrdersRequired - sales.completedOrderCount)

  return (
    <div className="max-w-[1400px]">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
        <p className="mt-1 text-sm text-gray-500">
          Patterns, performance, and movement across the business.
        </p>
      </div>

      <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-10 text-center">
        <div className="mx-auto w-11 h-11 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="mt-3 text-base font-semibold text-gray-900">
          {warming ? 'Analytics is warming up' : 'Analytics not started'}
        </h2>
        <p className="mt-1 text-sm text-gray-500 leading-relaxed max-w-md mx-auto">
          {warming ? (
            <>Patterns show up once there&apos;s enough live data to be meaningful.</>
          ) : (
            <>Analytics unlocks after your first sales start flowing. Pick an operating mode
            during onboarding and start ringing up orders to begin.</>
          )}
        </p>

        {warming && (
          <div className="mt-6 grid sm:grid-cols-2 gap-3 max-w-md mx-auto text-left">
            <GateRow
              label="Days of sales history"
              current={`${an.daysSinceFirstOrder}d`}
              target={`${an.minDaysRequired}d`}
              met={an.daysSinceFirstOrder >= an.minDaysRequired}
            />
            <GateRow
              label="Completed orders"
              current={sales.completedOrderCount.toString()}
              target={an.minOrdersRequired.toString()}
              met={sales.completedOrderCount >= an.minOrdersRequired}
            />
          </div>
        )}

        {warming && (daysShort > 0 || ordersShort > 0) && (
          <p className="mt-5 text-[11px] text-gray-400">
            {daysShort > 0 && <>Need {daysShort} more day{daysShort === 1 ? '' : 's'} of sales. </>}
            {ordersShort > 0 && <>Need {ordersShort} more order{ordersShort === 1 ? '' : 's'}.</>}
          </p>
        )}

        <p className="mt-6 text-[10px] text-gray-400">
          Developer? Enable <span className="font-semibold">Bypass all setup gating</span> in Settings → Developer tools.
        </p>
      </div>
    </div>
  )
}

function GateRow({ label, current, target, met }: { label: string; current: string; target: string; met: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${met ? 'bg-green-50 border-green-100' : 'bg-gray-50 border-gray-100'}`}>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{label}</p>
      <div className="mt-1 flex items-baseline justify-between">
        <span className={`text-lg font-bold tabular-nums ${met ? 'text-green-700' : 'text-gray-900'}`}>{current}</span>
        <span className="text-[10px] text-gray-400">of {target}</span>
      </div>
    </div>
  )
}
