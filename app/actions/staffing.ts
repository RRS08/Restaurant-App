'use server'

import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId, logAudit, formatError } from '@/lib/auth'
import { requireLocationAccess, AuthzError } from '@/lib/authz'

// Graceful wrapper so existing { error: string } action returns stay
// intact. Each location-scoped staffing write calls this right after
// resolving the relevant location_id.
async function requireLocResult(restaurantId: string, locationId: string): Promise<string | null> {
  try {
    await requireLocationAccess(restaurantId, locationId)
    return null
  } catch (err) {
    if (err instanceof AuthzError) return err.message
    throw err
  }
}

// ----------------------------------------------------------------
// Fallback: manager forgot a role during onboarding and wants to
// add one on the fly for the current house. Appends (dedup) to the
// staffing_config role array for that area.
// ----------------------------------------------------------------
export async function addStaffingRole(
  prevState: { error: string } | null, formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const area = formData.get('area') as 'foh' | 'boh'
  const role = (formData.get('role') as string)?.trim()
  if (!role) return { error: 'Role name is required.' }
  if (area !== 'foh' && area !== 'boh') return { error: 'Invalid house.' }

  const column = area === 'foh' ? 'foh_roles' : 'boh_roles'
  const { data: config } = await ctx.supabase
    .from('staffing_config').select(column).eq('restaurant_id', ctx.restaurantId).single()

  const existing: string[] = (config as Record<string, string[]> | null)?.[column] ?? []
  if (existing.some((r) => r.toLowerCase() === role.toLowerCase())) {
    return { error: 'That role already exists for this house.' }
  }

  const { error } = await ctx.supabase.from('staffing_config')
    .update({ [column]: [...existing, role] }).eq('restaurant_id', ctx.restaurantId)

  if (error) return { error: formatError('role', error) }
  revalidatePath('/staffing')
  return null
}

// ----------------------------------------------------------------
// Quick assign — drag-and-drop creates a shift instantly
// ----------------------------------------------------------------
export async function quickAssignShift(
  employeeId: string, sectionId: string, dayIso: string
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  const { locationId } = await resolveLocationId(ctx)
  if (!locationId) return { error: 'No location.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, locationId)
  if (locAuthErr) return { error: locAuthErr }

  const { data: employee } = await ctx.supabase
    .from('employees').select('role').eq('id', employeeId).single()
  if (!employee) return { error: 'Employee not found.' }

  const { data: section } = await ctx.supabase
    .from('shift_sections').select('default_start_hour, default_end_hour').eq('id', sectionId).single()
  if (!section) return { error: 'Section not found.' }

  const day = new Date(dayIso)
  const start = new Date(day); start.setHours(section.default_start_hour, 0, 0, 0)
  const end = new Date(day)
  if (section.default_end_hour <= section.default_start_hour) end.setDate(end.getDate() + 1)
  end.setHours(section.default_end_hour, 0, 0, 0)

  const { error } = await ctx.supabase.from('shifts').insert({
    restaurant_id: ctx.restaurantId, location_id: locationId,
    employee_id: employeeId, section_id: sectionId,
    role: employee.role,
    start_time: start.toISOString(), end_time: end.toISOString(),
  })

  if (error) return { error: error.message }
  revalidatePath('/staffing')
  return null
}

// ----------------------------------------------------------------
// Employee CRUD
// ----------------------------------------------------------------
export async function createEmployee(
  prevState: { error: string } | null, formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const formLocationId = formData.get('primary_location_id') as string
  const { locationId, error: locError } = await resolveLocationId(ctx, formLocationId)
  if (locError) return { error: locError }
  const locAuthErr = await requireLocResult(ctx.restaurantId, locationId)
  if (locAuthErr) return { error: locAuthErr }

  const name = (formData.get('name') as string)?.trim()
  const role = (formData.get('role') as string)?.trim()
  const hourlyRateRaw = formData.get('hourly_rate') as string

  if (!name) return { error: 'Employee name is required.' }
  if (!role) return { error: 'Role is required.' }

  const hourlyRate = hourlyRateRaw ? parseFloat(hourlyRateRaw) : null
  if (hourlyRate !== null && (isNaN(hourlyRate) || hourlyRate < 0)) return { error: 'Hourly rate must be 0 or more.' }

  const { error } = await ctx.supabase.from('employees').insert({
    restaurant_id: ctx.restaurantId, primary_location_id: locationId,
    name, role, hourly_rate: hourlyRate,
  })

  if (error) return { error: formatError('employee', error) }
  await logAudit(ctx, locationId, 'create_employee', 'employees')
  revalidatePath('/staffing')
  return null
}

// ----------------------------------------------------------------
// Shift CRUD (for drawer edits)
// ----------------------------------------------------------------
export async function createShift(
  prevState: { error: string } | null, formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const formLocationId = formData.get('location_id') as string
  const { locationId, error: locError } = await resolveLocationId(ctx, formLocationId)
  if (locError) return { error: locError }
  const locAuthErr = await requireLocResult(ctx.restaurantId, locationId)
  if (locAuthErr) return { error: locAuthErr }

  const employeeId = formData.get('employee_id') as string
  const sectionId = (formData.get('section_id') as string) || null
  const startTime = formData.get('start_time') as string
  const endTime = formData.get('end_time') as string
  const notes = (formData.get('notes') as string)?.trim() || null

  if (!employeeId) return { error: 'Please select an employee.' }
  if (!startTime || !endTime) return { error: 'Times are required.' }
  if (new Date(endTime) <= new Date(startTime)) return { error: 'End must be after start.' }

  const { data: employee } = await ctx.supabase
    .from('employees').select('role, primary_location_id').eq('id', employeeId).single()
  if (!employee) return { error: 'Employee not found.' }

  const { error } = await ctx.supabase.from('shifts').insert({
    restaurant_id: ctx.restaurantId, location_id: locationId,
    employee_id: employeeId, section_id: sectionId,
    role: employee.role, start_time: startTime, end_time: endTime, notes,
  })

  if (error) return { error: formatError('shift', error) }
  revalidatePath('/staffing')
  return null
}

export async function updateShift(
  prevState: { error: string } | null, formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const shiftId = formData.get('shift_id') as string
  const employeeId = formData.get('employee_id') as string
  const startTime = formData.get('start_time') as string
  const endTime = formData.get('end_time') as string
  const notes = (formData.get('notes') as string)?.trim() || null

  if (!shiftId || !employeeId || !startTime || !endTime) return { error: 'Missing fields.' }
  if (new Date(endTime) <= new Date(startTime)) return { error: 'End must be after start.' }

  const { data: shiftRow } = await ctx.supabase
    .from('shifts').select('location_id').eq('id', shiftId).single()
  if (!shiftRow) return { error: 'Shift not found.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, shiftRow.location_id)
  if (locAuthErr) return { error: locAuthErr }

  const { data: employee } = await ctx.supabase.from('employees').select('role').eq('id', employeeId).single()
  if (!employee) return { error: 'Employee not found.' }

  const { error } = await ctx.supabase.from('shifts').update({
    employee_id: employeeId, role: employee.role, start_time: startTime, end_time: endTime, notes,
  }).eq('id', shiftId)

  if (error) return { error: formatError('shift', error) }
  revalidatePath('/staffing')
  return null
}

export async function deleteShift(
  prevState: { error: string } | null, formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  const shiftId = formData.get('shift_id') as string
  if (!shiftId) return { error: 'No shift.' }

  const { data: shiftRow } = await ctx.supabase
    .from('shifts').select('location_id').eq('id', shiftId).single()
  if (!shiftRow) return { error: 'Shift not found.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, shiftRow.location_id)
  if (locAuthErr) return { error: locAuthErr }

  await ctx.supabase.from('shifts').delete().eq('id', shiftId)
  revalidatePath('/staffing')
  return null
}

// ----------------------------------------------------------------
// Testing utility — archives all employees and clears their shifts.
// Preserves staffing config + shift sections.
// ----------------------------------------------------------------
export async function clearAllEmployees() {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.', cleared: 0 }

  // Delete all shifts for this restaurant first (FK cascade would handle it, but explicit is clearer)
  await ctx.supabase.from('shifts').delete().eq('restaurant_id', ctx.restaurantId)

  // Archive all employees (set active = false) to preserve any historical references
  const { data: employees } = await ctx.supabase
    .from('employees').select('id').eq('restaurant_id', ctx.restaurantId).eq('active', true)

  const count = (employees ?? []).length

  if (count > 0) {
    await ctx.supabase
      .from('employees')
      .update({ active: false })
      .eq('restaurant_id', ctx.restaurantId)
  }

  revalidatePath('/staffing')
  return { error: null, cleared: count, message: `Archived ${count} employee${count !== 1 ? 's' : ''} and cleared all shifts.` }
}

// ----------------------------------------------------------------
// Full staffing reset — clears everything so /staffing shows
// the first-time onboarding wizard again.
// ----------------------------------------------------------------
export async function resetStaffingSetup() {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  // Order matters: shifts reference employees + sections, so delete shifts first
  await ctx.supabase.from('shifts').delete().eq('restaurant_id', ctx.restaurantId)
  await ctx.supabase.from('employees').update({ active: false }).eq('restaurant_id', ctx.restaurantId)
  await ctx.supabase.from('shift_sections').delete().eq('restaurant_id', ctx.restaurantId)
  await ctx.supabase.from('staffing_config').delete().eq('restaurant_id', ctx.restaurantId)

  revalidatePath('/staffing')
  return { error: null, message: 'Staffing reset complete. Visit Staffing to run setup again.' }
}
