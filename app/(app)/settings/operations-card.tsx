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
import { makeT, type Lang } from '@/lib/i18n'

function isActive(state: PillarState): boolean {
  return state === 'active' || state === 'active_with_limitations'
}

function operatingModeLabel(mode: OperatingMode, t: (en: string, es?: string) => string): string {
  if (mode === 'native_pos')   return t('Native POS', 'POS nativo')
  if (mode === 'external_pos') return t('External POS', 'POS externo')
  return t('Not set', 'Sin configurar')
}

// Operations rolls only the "is this workflow live?" view across
// the three operating pillars the owner cares about day-to-day.
const WORKFLOWS: { key: PillarKey; en: string; es: string }[] = [
  { key: 'inventory', en: 'Inventory', es: 'Inventario' },
  { key: 'staffing',  en: 'Staffing',  es: 'Personal'   },
  { key: 'finance',   en: 'Finance',   es: 'Finanzas'   },
]

export default function OperationsCard({ lang, readiness }: { lang: Lang; readiness: ReadinessSnapshot }) {
  const t = makeT(lang)
  const sales = operatingModeLabel(readiness.operatingMode, t)
  const activeNames = WORKFLOWS
    .filter((w) => isActive(readiness.pillars[w.key]))
    .map((w) => t(w.en, w.es))

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-5 py-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
        {t('Operations', 'Operación')}
      </p>

      <p className="mt-1.5 text-[11px] text-gray-400">{t('Sales mode', 'Modo de ventas')}</p>
      <p className="mt-0.5 text-base font-semibold text-gray-900">{sales}</p>

      <div className="mt-3 pt-3 border-t border-gray-100">
        <p className="text-[11px] text-gray-400">{t('Active workflows', 'Flujos activos')}</p>
        {activeNames.length > 0 ? (
          <p className="mt-0.5 text-xs text-gray-700 truncate">{activeNames.join(' · ')}</p>
        ) : (
          <p className="mt-0.5 text-xs text-gray-400">{t('None yet', 'Ninguno aún')}</p>
        )}
      </div>
    </section>
  )
}
