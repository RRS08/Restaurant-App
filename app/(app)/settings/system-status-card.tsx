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
import { makeT, type Lang } from '@/lib/i18n'

type T = (en: string, es?: string) => string

function pillarToPilotStatus(state: PillarState, t: T): { label: string; tone: StatusTone } {
  switch (state) {
    case 'active':
    case 'active_with_limitations':
      return { label: t('Active', 'Activo'), tone: 'active' }
    case 'ready':
    case 'setup_in_progress':
      return { label: t('Setup needed', 'Configuración pendiente'), tone: 'setup' }
    case 'not_started':
    default:
      return { label: t('Not active', 'Inactivo'), tone: 'idle' }
  }
}

const ROWS: { key: PillarKey; en: string; es: string }[] = [
  { key: 'sales',     en: 'Sales',     es: 'Ventas'    },
  { key: 'menu',      en: 'Menu',      es: 'Menú'      },
  { key: 'inventory', en: 'Inventory', es: 'Inventario'},
  { key: 'staffing',  en: 'Staffing',  es: 'Personal'  },
  { key: 'finance',   en: 'Finance',   es: 'Finanzas'  },
  { key: 'dashboard', en: 'Dashboard', es: 'Panel'     },
  { key: 'analytics', en: 'Analytics', es: 'Analítica' },
]

export default function SystemStatusCard({ lang, readiness }: { lang: Lang; readiness: ReadinessSnapshot }) {
  const t = makeT(lang)
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
          {t('System Status', 'Estado del sistema')}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 px-5 py-3">
        {ROWS.map((row) => {
          const status = pillarToPilotStatus(readiness.pillars[row.key], t)
          return (
            <div key={row.key} className="flex items-center justify-between gap-2">
              <p className="text-xs text-gray-700">{t(row.en, row.es)}</p>
              <StatusPill label={status.label} tone={status.tone} />
            </div>
          )
        })}
      </div>
    </section>
  )
}
