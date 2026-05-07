// ----------------------------------------------------------------
// Staffing page
//
// The old first-use wizard (`setup.tsx`) has been removed. This
// page always renders the main StaffingClient. When no
// staffing_config row exists yet (fresh restaurant), safe defaults
// are forwarded so the board renders in a neutral empty state
// instead of blocking with a setup gate.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import StaffingClient from './client'

export default async function StaffingPage() {
  const supabase = await createClient()

  const { data: config } = await supabase
    .from('staffing_config')
    .select('house_model, scheduling_style, foh_roles, boh_roles')
    .maybeSingle()

  const [
    { data: employees },
    { data: shifts },
    { data: sections },
    { data: locations },
  ] = await Promise.all([
    supabase.from('employees').select('id, name, role, primary_location_id').eq('active', true).order('name'),
    supabase.from('shifts').select('id, location_id, employee_id, section_id, role, start_time, end_time, notes, employees ( name )').order('start_time'),
    supabase.from('shift_sections').select('id, name, role, area, default_start_hour, default_end_hour, sort_order').order('sort_order'),
    supabase.from('locations').select('id, name').order('created_at', { ascending: true }),
  ])

  // Safe defaults when no config exists yet. The client renders
  // an empty but usable board — no blocking wizard.
  const houseModel = config?.house_model === 'unified' ? 'unified' : 'split'
  const schedulingStyle = config?.scheduling_style === 'by_role' ? 'by_role' : 'by_team'

  return (
    <StaffingClient
      defaultLocationId={locations?.[0]?.id ?? null}
      houseModel={houseModel}
      schedulingStyle={schedulingStyle}
      fohRoles={config?.foh_roles ?? []}
      bohRoles={config?.boh_roles ?? []}
      employees={(employees ?? []).map((e) => ({
        id: e.id, name: e.name, role: e.role, primaryLocationId: e.primary_location_id,
      }))}
      shifts={(shifts ?? []).map((s) => ({
        id: s.id, locationId: s.location_id, employeeId: s.employee_id,
        sectionId: s.section_id, role: s.role,
        employeeName: (s.employees as unknown as { name: string } | null)?.name ?? '—',
        startTime: s.start_time, endTime: s.end_time, notes: s.notes ?? null,
      }))}
      sections={(sections ?? []).map((s) => ({
        id: s.id, name: s.name, role: s.role ?? 'General', area: s.area as 'foh' | 'boh',
        defaultStartHour: s.default_start_hour, defaultEndHour: s.default_end_hour,
        sortOrder: s.sort_order,
      }))}
    />
  )
}
