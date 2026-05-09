// Staffing preview — resembles the real staffing board layout.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getOnboardingContext } from '@/app/actions/onboarding'
import { TEAM_MODEL_LABEL, SCHEDULING_STYLE_LABEL } from '@/lib/onboarding/types'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const BLOCKS = [
  { name: 'Opening', hours: '6:00a \u2013 2:00p' },
  { name: 'Closing', hours: '2:00p \u2013 11:00p' },
]

export default async function PreviewStaffingPage() {
  const ctx = await getOnboardingContext()
  if (!ctx.ok) redirect('/onboarding')

  const { teamModel, schedulingStyle, rolesGroupA, rolesGroupB } = ctx

  const lanes: { label: string; roles: string[] }[] = (() => {
    if (teamModel === 'unified') return [{ label: 'Team', roles: rolesGroupA }]
    if (teamModel === 'prep_service') return [{ label: 'Service', roles: rolesGroupA }, { label: 'Prep', roles: rolesGroupB }]
    return [{ label: 'Front of House', roles: rolesGroupA }, { label: 'Back of House', roles: rolesGroupB }]
  })()

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        {/* Header bar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600" />
            <span className="text-sm font-semibold text-gray-900">Setup</span>
          </div>
          <span className="text-xs text-gray-400">Preview 2 of 3</span>
        </div>

        {/* Preview banner */}
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-widest text-blue-600 bg-blue-100 px-2 py-0.5 rounded">Preview</span>
          <p className="text-xs text-blue-700">This is a guided preview of your Staffing board structure. No employees or shifts are saved yet — you&apos;ll build the real schedule inside the module.</p>
        </div>

        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Staffing</h1>
          <p className="mt-1 text-sm text-gray-500">
            Board shaped from your answers:
            {' '}<span className="font-medium text-gray-700">{TEAM_MODEL_LABEL[teamModel]}</span>,
            {' '}scheduled <span className="font-medium text-gray-700">{SCHEDULING_STYLE_LABEL[schedulingStyle].toLowerCase()}</span>.
            Add employees and assign shifts once you&apos;re in the product.
          </p>
        </div>

        {/* Board preview */}
        <div className="space-y-6">
          {lanes.map(lane => (
            <div key={lane.label} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              {/* Lane header */}
              <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">{lane.label}</p>
                <p className="text-xs text-gray-400">{lane.roles.length} role{lane.roles.length !== 1 ? 's' : ''}</p>
              </div>

              {schedulingStyle === 'by_role' ? (
                /* By-role: grid with role rows and day columns */
                <div className="overflow-x-auto">
                  {/* Day header row */}
                  <div className="grid border-b border-gray-100" style={{ gridTemplateColumns: '140px repeat(7, 1fr)' }}>
                    <div className="px-4 py-2 text-xs font-medium text-gray-400">Role</div>
                    {DAYS.map(d => (
                      <div key={d} className="px-2 py-2 text-center text-xs font-medium text-gray-400 border-l border-gray-100">{d}</div>
                    ))}
                  </div>
                  {/* Role rows */}
                  {lane.roles.length === 0 && (
                    <div className="px-5 py-4 text-xs text-gray-400 italic">No roles selected</div>
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
                        {lane.roles.length === 0 && <span className="text-xs text-gray-400 italic">No roles selected</span>}
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
          <p className="text-xs font-semibold text-amber-700 mb-1">Board structure only</p>
          <p className="text-xs text-amber-600/80 leading-relaxed">
            The lanes and roles above come from your onboarding answers. You&apos;ll add
            real employees, define shift sections, and assign shifts once you&apos;re
            inside the Staffing module.
          </p>
        </div>

        {/* Footer */}
        <div className="mt-8 flex justify-end">
          <Link href="/onboarding/finance"
            className="px-5 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors">
            Continue to Finance preview
          </Link>
        </div>
      </div>
    </div>
  )
}
