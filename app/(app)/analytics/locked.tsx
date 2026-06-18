// ----------------------------------------------------------------
// AnalyticsLocked — shown when the Analytics pillar is not yet
// `active`. Reads differently depending on whether it's warming up
// (sales flowing but not enough live data) or not started at all.
//
// Respects dev overrides transparently — computeReadiness already
// applies them before this component ever runs.
// ----------------------------------------------------------------

import type { ReadinessSnapshot } from '@/lib/readiness'
import { makeT, type Lang } from '@/lib/i18n'

export default function AnalyticsLocked({ readiness, lang }: { readiness: ReadinessSnapshot; lang: Lang }) {
  const t = makeT(lang)
  const analyticsState = readiness.pillars.analytics
  const sales = readiness.signals.sales
  const an = readiness.signals.analytics

  const warming = analyticsState === 'setup_in_progress'
  const daysShort = Math.max(0, an.minDaysRequired - an.daysSinceFirstOrder)
  const ordersShort = Math.max(0, an.minOrdersRequired - sales.completedOrderCount)

  return (
    <div className="max-w-[1400px]">
      <div className="mb-5">
        <h1 className="text-2xl tracking-tight font-bold text-gray-900">{t('Analytics', 'Analíticas')}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t('Patterns, performance, and movement across the business.', 'Patrones, rendimiento y movimiento en todo el negocio.')}
        </p>
      </div>

      <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-10 text-center">
        <div className="mx-auto w-11 h-11 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="mt-3 text-base font-semibold text-gray-900">
          {warming ? t('Analytics is warming up', 'Las analíticas están calentando') : t('Analytics not started', 'Analíticas no iniciadas')}
        </h2>
        <p className="mt-1 text-sm text-gray-500 leading-relaxed max-w-md mx-auto">
          {warming ? (
            <>{t("Patterns show up once there's enough live data to be meaningful.", 'Los patrones aparecen cuando hay suficientes datos en vivo para ser significativos.')}</>
          ) : (
            <>{t('Analytics unlocks after your first sales start flowing. Pick an operating mode during onboarding and start ringing up orders to begin.', 'Las analíticas se desbloquean cuando comienzan a fluir tus primeras ventas. Elige un modo de operación durante la incorporación y empieza a registrar pedidos para comenzar.')}</>
          )}
        </p>

        {warming && (
          <div className="mt-6 grid sm:grid-cols-2 gap-3 max-w-md mx-auto text-left">
            <GateRow
              label={t('Days of sales history', 'Días de historial de ventas')}
              current={`${an.daysSinceFirstOrder}d`}
              target={`${an.minDaysRequired}d`}
              met={an.daysSinceFirstOrder >= an.minDaysRequired}
              ofLabel={t('of', 'de')}
            />
            <GateRow
              label={t('Completed orders', 'Pedidos completados')}
              current={sales.completedOrderCount.toString()}
              target={an.minOrdersRequired.toString()}
              met={sales.completedOrderCount >= an.minOrdersRequired}
              ofLabel={t('of', 'de')}
            />
          </div>
        )}

        {warming && (daysShort > 0 || ordersShort > 0) && (
          <p className="mt-5 text-[11px] text-gray-400">
            {daysShort > 0 && <>{t(`Need ${daysShort} more day${daysShort === 1 ? '' : 's'} of sales.`, `Faltan ${daysShort} día${daysShort === 1 ? '' : 's'} más de ventas.`)} </>}
            {ordersShort > 0 && <>{t(`Need ${ordersShort} more order${ordersShort === 1 ? '' : 's'}.`, `Faltan ${ordersShort} pedido${ordersShort === 1 ? '' : 's'} más.`)}</>}
          </p>
        )}

        <p className="mt-6 text-[10px] text-gray-400">
          {t('Developer?', '¿Desarrollador?')} {t('Enable', 'Activa')} <span className="font-semibold">{t('Bypass all setup gating', 'Omitir todas las restricciones de configuración')}</span> {t('in Settings → Developer tools.', 'en Ajustes → Herramientas de desarrollador.')}
        </p>
      </div>
    </div>
  )
}

function GateRow({ label, current, target, met, ofLabel }: { label: string; current: string; target: string; met: boolean; ofLabel: string }) {
  return (
    <div className={`rounded-lg border p-3 ${met ? 'bg-green-50 border-green-100' : 'bg-gray-50 border-gray-100'}`}>
      <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">{label}</p>
      <div className="mt-1 flex items-baseline justify-between">
        <span className={`text-lg font-bold font-mono tabular-nums ${met ? 'text-green-700' : 'text-gray-900'}`}>{current}</span>
        <span className="text-[10px] text-gray-400">{ofLabel} {target}</span>
      </div>
    </div>
  )
}
