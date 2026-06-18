// Staffing preview — resembles the real staffing board layout.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getOnboardingContext } from '@/app/actions/onboarding'
import { TEAM_MODEL_LABEL, SCHEDULING_STYLE_LABEL, type TeamModel, type SchedulingStyle } from '@/lib/onboarding/types'
import { getLang, getT } from '@/lib/i18n-server'

const DAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAYS_ES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

const TEAM_MODEL_LABEL_ES: Record<TeamModel, string> = {
  foh_boh: 'Salón + Cocina',
  unified: 'Equipo unificado',
  prep_service: 'Prep + Servicio',
}

const SCHEDULING_STYLE_LABEL_ES: Record<SchedulingStyle, string> = {
  by_role: 'Por rol',
  by_shift_block: 'Por bloque de turno',
}

export default async function PreviewStaffingPage() {
  const ctx = await getOnboardingContext()
  if (!ctx.ok) redirect('/onboarding')

  const lang = await getLang()
  const t = await getT()
  const isEs = lang === 'es'

  const { teamModel, schedulingStyle, rolesGroupA, rolesGroupB } = ctx

  const DAYS = isEs ? DAYS_ES : DAYS_EN
  const BLOCKS = [
    { name: t('Opening', 'Apertura'), hours: '6:00a – 2:00p' },
    { name: t('Closing', 'Cierre'),   hours: '2:00p – 11:00p' },
  ]

  const lanes: { label: string; roles: string[] }[] = (() => {
    if (teamModel === 'unified') return [{ label: t('Team', 'Equipo'), roles: rolesGroupA }]
    if (teamModel === 'prep_service') return [
      { label: t('Service', 'Servicio'), roles: rolesGroupA },
      { label: t('Prep', 'Preparación'), roles: rolesGroupB },
    ]
    return [
      { label: t('Front of House', 'Salón'), roles: rolesGroupA },
      { label: t('Back of House',  'Cocina'), roles: rolesGroupB },
    ]
  })()

  const teamLabel = isEs ? TEAM_MODEL_LABEL_ES[teamModel] : TEAM_MODEL_LABEL[teamModel]
  const schedLabel = isEs ? SCHEDULING_STYLE_LABEL_ES[schedulingStyle] : SCHEDULING_STYLE_LABEL[schedulingStyle]

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        {/* Header bar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600" />
            <span className="text-sm font-semibold text-gray-900">{t('Setup', 'Configuración')}</span>
          </div>
          <span className="text-xs text-gray-400">{t('Preview 2 of 3', 'Vista previa 2 de 3')}</span>
        </div>

        {/* Preview banner */}
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-widest text-blue-600 bg-blue-100 px-2 py-0.5 rounded">{t('Preview', 'Vista previa')}</span>
          <p className="text-xs text-blue-700">
            {t(
              'This is a guided preview of your Staffing board structure. No employees or shifts are saved yet — you’ll build the real schedule inside the module.',
              'Esta es una vista guiada de la estructura del tablero de Personal. Aún no se han guardado empleados ni turnos — armarás el horario real dentro del módulo.'
            )}
          </p>
        </div>

        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">{t('Staffing', 'Personal')}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {t('Board shaped from your answers:', 'Tablero generado a partir de tus respuestas:')}
            {' '}<span className="font-medium text-gray-700">{teamLabel}</span>,
            {' '}{t('scheduled', 'programado')} <span className="font-medium text-gray-700">{schedLabel.toLowerCase()}</span>.
            {' '}{t('Add employees and assign shifts once you’re in the product.', 'Añade empleados y asigna turnos una vez dentro del producto.')}
          </p>
        </div>

        {/* Board preview */}
        <div className="space-y-6">
          {lanes.map(lane => (
            <div key={lane.label} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              {/* Lane header */}
              <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">{lane.label}</p>
                <p className="text-xs text-gray-400">
                  {lane.roles.length}{' '}
                  {lane.roles.length !== 1 ? t('roles', 'roles') : t('role', 'rol')}
                </p>
              </div>

              {schedulingStyle === 'by_role' ? (
                /* By-role: grid with role rows and day columns */
                <div className="overflow-x-auto">
                  {/* Day header row */}
                  <div className="grid border-b border-gray-100" style={{ gridTemplateColumns: '140px repeat(7, 1fr)' }}>
                    <div className="px-4 py-2 text-xs font-medium text-gray-400">{t('Role', 'Rol')}</div>
                    {DAYS.map(d => (
                      <div key={d} className="px-2 py-2 text-center text-xs font-medium text-gray-400 border-l border-gray-100">{d}</div>
                    ))}
                  </div>
                  {/* Role rows */}
                  {lane.roles.length === 0 && (
                    <div className="px-5 py-4 text-xs text-gray-400 italic">{t('No roles selected', 'Sin roles seleccionados')}</div>
                  )}
                  {lane.roles.map(role => (
                    <div key={role} className="grid border-b border-gray-50 last:border-b-0" style={{ gridTemplateColumns: '140px repeat(7, 1fr)' }}>
                      <div className="px-4 py-3 text-xs font-medium text-gray-700 truncate">{role}</div>
                      {DAYS.map(d => (
                        <div key={d} className="border-l border-gray-100 min-h-[44px]" />
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                /* By shift block: blocks with role chips inside */
                <div className="divide-y divide-gray-100">
                  {BLOCKS.map(block => (
                    <div key={block.name} className="p-4">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-sm font-semibold text-gray-900">{block.name}</p>
                        <p className="text-xs text-gray-400">{block.hours}</p>
                      </div>
                      {/* Role chips */}
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {lane.roles.map(r => (
                          <span key={r} className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-[11px] font-medium text-gray-600">{r}</span>
                        ))}
                        {lane.roles.length === 0 && <span className="text-xs text-gray-400 italic">{t('No roles selected', 'Sin roles seleccionados')}</span>}
                      </div>
                      {/* Day slots */}
                      <div className="grid grid-cols-7 gap-1">
                        {DAYS.map(d => (
                          <div key={d} className="text-center">
                            <p className="text-[10px] text-gray-400 mb-1">{d}</p>
                            <div className="h-10 rounded-lg border border-dashed border-gray-200 bg-gray-50/50" />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Preview note */}
        <div className="mt-6 rounded-xl border border-dashed border-amber-200 bg-amber-50/50 p-5">
          <p className="text-xs font-semibold text-amber-700 mb-1">{t('Board structure only', 'Solo estructura del tablero')}</p>
          <p className="text-xs text-amber-600/80 leading-relaxed">
            {t(
              'The lanes and roles above come from your onboarding answers. You’ll add real employees, define shift sections, and assign shifts once you’re inside the Staffing module.',
              'Las filas y roles de arriba provienen de tus respuestas de la configuración inicial. Añadirás empleados reales, definirás secciones de turno y asignarás turnos una vez dentro del módulo de Personal.'
            )}
          </p>
        </div>

        {/* Footer */}
        <div className="mt-8 flex justify-end">
          <Link href="/onboarding/finance"
            className="px-5 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors">
            {t('Continue to Finance preview', 'Continuar a la vista previa de Finanzas')}
          </Link>
        </div>
      </div>
    </div>
  )
}
