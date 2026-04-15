import { createClient } from '@/lib/supabase/server'
import StaffingClient from './client'
import StaffingSetup from './setup'

export default async function StaffingPage() {
  const supabase = await createClient()

  // Check if staffing setup has been completed.
  // Guard requires BOTH a config row AND at least one shift section.
  // If either is missing, the setup is incomplete.
  const [{ data: config }, { count: sectionCount }] = await Promise.all([
    supabase.from('staffing_config').select('setup_complete, house_model, scheduling_style, foh_roles, boh_roles').single(),
    supabase.from('shift_sections').select('id', { count: 'exact', head: true }),
  ])

  if (!config || !config.setup_complete || (sectionCount ?? 0) === 0) {
    return <StaffingSetup />
  }

  const [
    { data: employees },
    { data: shifts },
    { data: sections },
  ] = await Promise.all([
    supabase.from('employees').select('id, name, role, primary_location_id').eq('active', true).order('name'),
    supabase.from('shifts').select('id, location_id, employee_id, section_id, role, start_time, end_time, notes, employees ( name )').order('start_time'),
    supabase.from('shift_sections').select('id, name, role, area, default_start_hour, default_end_hour, sort_order').order('sort_order'),
  ])

  const { data: locations } = await supabase
    .from('locations').select('id, name').order('created_at', { ascending: true })

  return (
    <StaffingClient
      defaultLocationId={locations?.[0]?.id ?? null}
      houseModel={((config as { house_model?: string } | null)?.house_model === 'unified' ? 'unified' : 'split')}
      schedulingStyle={((config as { scheduling_style?: string } | null)?.scheduling_style === 'by_role' ? 'by_role' : 'by_team')}
      fohRoles={(config as { foh_roles?: string[] } | null)?.foh_roles ?? []}
      bohRoles={(config as { boh_roles?: string[] } | null)?.boh_roles ?? []}
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
