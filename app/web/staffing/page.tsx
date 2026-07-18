// ----------------------------------------------------------------
// Web-native Staffing  →  /web/staffing
//
// V1 display: today's shifts + the team roster. Schedule editing,
// shift creation, and section management stay in the classic route
// for now.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import WebStaffingClient from './client'

export default async function WebStaffingPage() {
  const supabase = await createClient()
  const lang = await getLang()

  const [
    { data: employees },
    { data: shifts },
    { data: sections },
  ] = await Promise.all([
    supabase.from('employees').select('id, name, role, primary_location_id').eq('active', true).order('name'),
    supabase.from('shifts').select('id, location_id, employee_id, section_id, role, start_time, end_time, notes, employees ( name )').order('start_time'),
    supabase.from('shift_sections').select('id, name, role, area').order('sort_order'),
  ])

  type RawShift = {
    id: string; location_id: string | null; employee_id: string | null
    section_id: string | null; role: string | null
    start_time: string; end_time: string; notes: string | null
    employees: { name: string } | null
  }

  const sectionById = new Map<string, { name: string; area: string }>()
  for (const s of (sections ?? [])) {
    sectionById.set(s.id, { name: s.name, area: s.area })
  }

  const shapedShifts = ((shifts ?? []) as unknown as RawShift[]).map((s) => {
    const section = s.section_id ? sectionById.get(s.section_id) ?? null : null
    return {
      id: s.id,
      employeeName: s.employees?.name ?? null,
      role: s.role,
      sectionName: section?.name ?? null,
      sectionArea: section?.area ?? null,
      startTime: s.start_time,
      endTime: s.end_time,
      notes: s.notes,
    }
  })

  return (
    <WebStaffingClient
      lang={lang}
      employees={(employees ?? []).map((e) => ({
        id: e.id, name: e.name, role: e.role, primaryLocationId: e.primary_location_id,
      }))}
      shifts={shapedShifts}
    />
  )
}
