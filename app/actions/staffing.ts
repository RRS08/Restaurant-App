'use server'

import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId, logAudit, formatError } from '@/lib/auth'
import { requireLocationAccess, AuthzError } from '@/lib/authz'
import { normalizeDisplayName, normalizeNameKey } from '@/lib/strings/names'

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
// Set the display color for a role. Stored in staffing_config.role_colors
// (JSONB map: normalized_role_key → color slug). roleTone() on the client
// prefers this over the auto-color regex, so a custom role like "cashier"
// can carry the owner's chosen tone without editing the regex table.
//
// Empty / null color clears the override (falls back to regex → gray).
// Owner-only, same guard as other structure writes.
// ----------------------------------------------------------------
const VALID_ROLE_COLORS = new Set([
  'purple', 'teal', 'rose', 'slate', 'emerald',
  'zinc', 'stone', 'red', 'lime', 'violet',
  'amber', 'sky', 'gray',
])

export async function setRoleColor(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  if (ctx.role !== 'owner') return { error: 'Only the owner can change role colors.' }

  const rawRole = ((formData.get('role') as string) ?? '').trim()
  const roleKey = normalizeNameKey(rawRole)
  if (!roleKey) return { error: 'Role name is required.' }

  const rawColor = ((formData.get('color') as string) ?? '').trim().toLowerCase()
  // Empty string is the sentinel for "clear override"; anything else must
  // be in the palette so we don't stash garbage into the JSONB map.
  if (rawColor && !VALID_ROLE_COLORS.has(rawColor)) {
    return { error: 'Not a valid color.' }
  }

  const { data: config } = await ctx.supabase
    .from('staffing_config')
    .select('role_colors')
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  const current = (config?.role_colors as Record<string, string> | null) ?? {}
  const next = { ...current }
  if (rawColor) next[roleKey] = rawColor
  else delete next[roleKey]

  const { error } = await ctx.supabase.from('staffing_config').upsert(
    { restaurant_id: ctx.restaurantId, role_colors: next },
    { onConflict: 'restaurant_id' },
  )
  if (error) return { error: formatError('role color', error) }

  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return { ok: true }
}

// ----------------------------------------------------------------
// setRoleWage — per-role hourly wage. Stored on staffing_config.
// role_wages as a normalized-key → number map (empty string
// sentinel clears the entry). Owner-only.
//
// Wages moved from per-employee to per-role in 2026-07-26; the
// old employees.hourly_rate column stays as an override slot
// once labor-cost surfaces land. This action only mutates the
// per-role map.
// ----------------------------------------------------------------
export async function setRoleWage(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  if (ctx.role !== 'owner') return { error: 'Only the owner can change role wages.' }

  const rawRole = ((formData.get('role') as string) ?? '').trim()
  const roleKey = normalizeNameKey(rawRole)
  if (!roleKey) return { error: 'Role name is required.' }

  const rawWage = ((formData.get('wage') as string) ?? '').trim()
  // Empty string is the sentinel for "clear override." A supplied
  // value must be a non-negative finite number; anything else is
  // a user error we surface rather than store garbage.
  let parsed: number | null = null
  if (rawWage !== '') {
    parsed = parseFloat(rawWage)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: 'Wage must be 0 or more.' }
    }
    // Two decimals of precision is plenty for hourly rates.
    parsed = Math.round(parsed * 100) / 100
  }

  const { data: config } = await ctx.supabase
    .from('staffing_config')
    .select('role_wages')
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  const current = (config?.role_wages as Record<string, number> | null) ?? {}
  const next = { ...current }
  if (parsed !== null) next[roleKey] = parsed
  else delete next[roleKey]

  const { error } = await ctx.supabase.from('staffing_config').upsert(
    { restaurant_id: ctx.restaurantId, role_wages: next },
    { onConflict: 'restaurant_id' },
  )
  if (error) return { error: formatError('role wage', error) }

  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return { ok: true }
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

  // Owner-only — staffing structure (roles, sections) is restaurant
  // config, not operational. Managers schedule within the structure
  // but don't change what the structure is.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can change staffing structure.' }
  }

  const area = formData.get('area') as 'foh' | 'boh'
  const rawRole = (formData.get('role') as string) ?? ''
  const role = normalizeDisplayName(rawRole)
  const roleKey = normalizeNameKey(rawRole)
  if (!role) return { error: 'Role name is required.' }
  if (area !== 'foh' && area !== 'boh') return { error: 'Invalid house.' }

  const column = area === 'foh' ? 'foh_roles' : 'boh_roles'
  // maybeSingle so a missing config row doesn't error — we'll create
  // one via upsert below. The previous select+update pattern silently
  // failed for restaurants that had no row, since UPDATE with no
  // matching row is a no-op and Postgres doesn't flag it as an error.
  const { data: config } = await ctx.supabase
    .from('staffing_config').select(column).eq('restaurant_id', ctx.restaurantId).maybeSingle()

  const existing: string[] = (config as Record<string, string[]> | null)?.[column] ?? []
  // Duplicate guard uses the normalized key on both sides so casing
  // and whitespace differences collide (was: only case-insensitive).
  if (existing.some((r) => normalizeNameKey(r) === roleKey)) {
    return { error: 'That role already exists for this house.' }
  }

  // Upsert by restaurant_id so this works whether or not a config
  // row exists yet. Defaults match the schema CHECKs: 'split' house
  // model and 'by_role' scheduling style.
  const { error } = await ctx.supabase.from('staffing_config').upsert(
    {
      restaurant_id: ctx.restaurantId,
      [column]: [...existing, role],
    },
    { onConflict: 'restaurant_id' }
  )

  if (error) return { error: formatError('role', error) }
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return null
}

// ----------------------------------------------------------------
// renameStaffingRole — rename a role in place. Propagates to:
//   1. staffing_config.foh_roles / boh_roles (whichever holds it)
//   2. staffing_config.role_colors + role_wages (rekey by normalized name)
//   3. shifts.role (all rows currently tagged with the old name)
//   4. employees.role (same)
//
// Idempotent: if the new name is already the same normalized key,
// this is a display-only rename (updates the array + rewrites all
// role text so casing matches the chosen display form). Blocks if
// the target name would collide with a different existing role in
// the same area (avoids silently merging two roles).
// ----------------------------------------------------------------
export async function renameStaffingRole(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  if (ctx.role !== 'owner') return { error: 'Only the owner can rename roles.' }

  const area = formData.get('area') as 'foh' | 'boh'
  const oldRaw = ((formData.get('oldName') as string) ?? '').trim()
  const newRaw = ((formData.get('newName') as string) ?? '').trim()
  const oldKey = normalizeNameKey(oldRaw)
  const newDisplay = normalizeDisplayName(newRaw)
  const newKey = normalizeNameKey(newRaw)
  if (!oldKey) return { error: 'Original role name is required.' }
  if (!newDisplay) return { error: 'New role name is required.' }
  if (area !== 'foh' && area !== 'boh') return { error: 'Invalid house.' }

  const { data: config } = await ctx.supabase
    .from('staffing_config')
    .select('foh_roles, boh_roles, role_colors, role_wages')
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  if (!config) return { error: 'Staffing not configured yet.' }

  const column = area === 'foh' ? 'foh_roles' : 'boh_roles'
  const list: string[] = (config as unknown as Record<string, string[]>)[column] ?? []
  const idx = list.findIndex((r) => normalizeNameKey(r) === oldKey)
  if (idx < 0) return { error: 'Role not found in this house.' }

  // Collision guard — the new normalized key must not already exist
  // in the SAME area under a different display form. Same-key rename
  // (display-only) is allowed and just rewrites the display text.
  const collides = list.some((r, i) => i !== idx && normalizeNameKey(r) === newKey)
  if (collides) return { error: 'A role with that name already exists in this house.' }

  const nextList = [...list]
  nextList[idx] = newDisplay

  // Rekey role_colors + role_wages when the normalized key changes.
  // When only the display form changes (same key), leave them alone —
  // they're keyed by normalized name and nothing needs to move.
  const currentColors = (config.role_colors as Record<string, string> | null) ?? {}
  const currentWages = (config.role_wages as Record<string, number> | null) ?? {}
  const nextColors = { ...currentColors }
  const nextWages = { ...currentWages }
  if (oldKey !== newKey) {
    if (nextColors[oldKey] !== undefined) { nextColors[newKey] = nextColors[oldKey]; delete nextColors[oldKey] }
    if (nextWages[oldKey] !== undefined) { nextWages[newKey] = nextWages[oldKey]; delete nextWages[oldKey] }
  }

  const { error: cfgErr } = await ctx.supabase.from('staffing_config').upsert(
    {
      restaurant_id: ctx.restaurantId,
      [column]: nextList,
      role_colors: nextColors,
      role_wages: nextWages,
    },
    { onConflict: 'restaurant_id' },
  )
  if (cfgErr) return { error: formatError('role rename', cfgErr) }

  // Propagate to shifts + employees. We use case-insensitive match
  // (ilike with the exact escaped oldRaw isn't safe if the display
  // form drifted; use eq on the exact stored variant). Since we can't
  // know every stored casing, fetch the distinct values and match by
  // normalized key.
  const { data: shiftRows } = await ctx.supabase
    .from('shifts').select('id, role').eq('restaurant_id', ctx.restaurantId)
  const shiftIds = (shiftRows ?? []).filter((r) => normalizeNameKey(r.role ?? '') === oldKey).map((r) => r.id)
  if (shiftIds.length > 0) {
    await ctx.supabase.from('shifts').update({ role: newDisplay }).in('id', shiftIds)
  }
  const { data: empRows } = await ctx.supabase
    .from('employees').select('id, role').eq('restaurant_id', ctx.restaurantId)
  const empIds = (empRows ?? []).filter((r) => normalizeNameKey(r.role ?? '') === oldKey).map((r) => r.id)
  if (empIds.length > 0) {
    await ctx.supabase.from('employees').update({ role: newDisplay }).in('id', empIds)
  }

  await logAudit(ctx, null, 'role_renamed', 'staffing_config')
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return { ok: true }
}

// ----------------------------------------------------------------
// deleteStaffingRole — remove a role from the house's role list.
//
// Blocked when any active employee or future shift still carries
// that role. The manager must reassign them first — silently
// deleting would orphan shifts and leave employees with a role
// that no longer appears in the picker.
//
// Also clears the role's color + wage entries so we don't leak
// dangling JSONB keys.
// ----------------------------------------------------------------
export async function deleteStaffingRole(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  if (ctx.role !== 'owner') return { error: 'Only the owner can delete roles.' }

  const area = formData.get('area') as 'foh' | 'boh'
  const raw = ((formData.get('role') as string) ?? '').trim()
  const roleKey = normalizeNameKey(raw)
  if (!roleKey) return { error: 'Role name is required.' }
  if (area !== 'foh' && area !== 'boh') return { error: 'Invalid house.' }

  const { data: config } = await ctx.supabase
    .from('staffing_config')
    .select('foh_roles, boh_roles, role_colors, role_wages')
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  if (!config) return { error: 'Staffing not configured yet.' }

  // Assignment guard — must be zero live shifts and zero active
  // employees still tagged with this role.
  const { data: empRows } = await ctx.supabase
    .from('employees').select('id, role').eq('restaurant_id', ctx.restaurantId).eq('active', true)
  const empHits = (empRows ?? []).filter((r) => normalizeNameKey(r.role ?? '') === roleKey).length
  if (empHits > 0) {
    return { error: `${empHits} active employee${empHits === 1 ? '' : 's'} still assigned. Reassign first.` }
  }
  const { data: shiftRows } = await ctx.supabase
    .from('shifts').select('id, role, end_time').eq('restaurant_id', ctx.restaurantId)
  const nowIso = new Date().toISOString()
  const futureHits = (shiftRows ?? []).filter((r) =>
    normalizeNameKey(r.role ?? '') === roleKey && (r.end_time ?? '') >= nowIso,
  ).length
  if (futureHits > 0) {
    return { error: `${futureHits} upcoming shift${futureHits === 1 ? '' : 's'} still use this role. Clear or reassign first.` }
  }

  const column = area === 'foh' ? 'foh_roles' : 'boh_roles'
  const list: string[] = (config as unknown as Record<string, string[]>)[column] ?? []
  const nextList = list.filter((r) => normalizeNameKey(r) !== roleKey)

  const nextColors = { ...((config.role_colors as Record<string, string> | null) ?? {}) }
  const nextWages = { ...((config.role_wages as Record<string, number> | null) ?? {}) }
  delete nextColors[roleKey]
  delete nextWages[roleKey]

  const { error } = await ctx.supabase.from('staffing_config').upsert(
    {
      restaurant_id: ctx.restaurantId,
      [column]: nextList,
      role_colors: nextColors,
      role_wages: nextWages,
    },
    { onConflict: 'restaurant_id' },
  )
  if (error) return { error: formatError('role delete', error) }

  await logAudit(ctx, null, 'role_deleted', 'staffing_config')
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return { ok: true }
}

// ----------------------------------------------------------------
// moveStaffingRole — flip a role from FOH to BOH or vice versa.
// Colors + wages stay by normalized key; employees + shifts carry
// their role text unchanged (area is derived from staffing_config
// list membership, not from the row itself).
// ----------------------------------------------------------------
export async function moveStaffingRole(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  if (ctx.role !== 'owner') return { error: 'Only the owner can move roles.' }

  const from = formData.get('from') as 'foh' | 'boh'
  const to = formData.get('to') as 'foh' | 'boh'
  const raw = ((formData.get('role') as string) ?? '').trim()
  const roleKey = normalizeNameKey(raw)
  if (!roleKey) return { error: 'Role name is required.' }
  if (from !== 'foh' && from !== 'boh') return { error: 'Invalid source house.' }
  if (to !== 'foh' && to !== 'boh') return { error: 'Invalid target house.' }
  if (from === to) return { ok: true }

  const { data: config } = await ctx.supabase
    .from('staffing_config')
    .select('foh_roles, boh_roles')
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  if (!config) return { error: 'Staffing not configured yet.' }

  const fromCol = from === 'foh' ? 'foh_roles' : 'boh_roles'
  const toCol = to === 'foh' ? 'foh_roles' : 'boh_roles'
  const fromList: string[] = (config as unknown as Record<string, string[]>)[fromCol] ?? []
  const toList: string[] = (config as unknown as Record<string, string[]>)[toCol] ?? []

  const found = fromList.find((r) => normalizeNameKey(r) === roleKey)
  if (!found) return { error: 'Role not found in source house.' }
  if (toList.some((r) => normalizeNameKey(r) === roleKey)) {
    return { error: 'Role already exists in target house.' }
  }

  const nextFrom = fromList.filter((r) => normalizeNameKey(r) !== roleKey)
  const nextTo = [...toList, found]

  const { error } = await ctx.supabase.from('staffing_config').upsert(
    {
      restaurant_id: ctx.restaurantId,
      [fromCol]: nextFrom,
      [toCol]: nextTo,
    },
    { onConflict: 'restaurant_id' },
  )
  if (error) return { error: formatError('role move', error) }

  await logAudit(ctx, null, 'role_moved', 'staffing_config')
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return { ok: true }
}

// ----------------------------------------------------------------
// Shift sections (a.k.a. shift blocks) — CRUD.
//
// Sections are the rows on the schedule board. They drive lane
// labels, default times for drag-drop assignment, and the shape of
// the by_role / by_team grouping. Managers must be able to evolve
// these past the starter set, so we expose create/update/delete here
// with the same owner-gating used elsewhere.
//
// ON DELETE SET NULL semantics on shifts.section_id mean deleting a
// block does NOT delete shifts under it — those shifts become
// "custom" (sectionId === null) and surface on the Custom lane.
// ----------------------------------------------------------------

const VALID_AREAS = new Set(['foh', 'boh'])

function parseHour(raw: FormDataEntryValue | null, label: string): number | { error: string } {
  const n = parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 0 || n > 24) {
    return { error: `${label} must be between 0 and 24.` }
  }
  return n
}

export async function createShiftSection(
  prevState: { error: string } | null, formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Owner-only — see addStaffingRole above.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can change staffing structure.' }
  }

  const rawName = (formData.get('name') as string) ?? ''
  const name = normalizeDisplayName(rawName)
  const nameKey = normalizeNameKey(rawName)
  const area = (formData.get('area') as string)?.trim()
  const rawRole = (formData.get('role') as string) ?? ''
  const role = normalizeDisplayName(rawRole) || 'General'
  if (!name) return { error: 'Block name is required.' }
  if (!VALID_AREAS.has(area)) return { error: 'Area must be foh or boh.' }

  const start = parseHour(formData.get('default_start_hour'), 'Start hour')
  if (typeof start === 'object') return start
  const end = parseHour(formData.get('default_end_hour'), 'End hour')
  if (typeof end === 'object') return end
  if (end === start) return { error: 'End hour must differ from start hour.' }

  // Same-shape duplicate guard — block the manager from creating a
  // second block with identical (normalized name, area, start, end)
  // for the same restaurant. Now uses normalizeNameKey so "Lunch"
  // and "lunch" collide. We fetch by area + hours (the cheap filter)
  // then check name in JS using the normalized key.
  const { data: candidates } = await ctx.supabase
    .from('shift_sections')
    .select('id, name')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('area', area)
    .eq('default_start_hour', start)
    .eq('default_end_hour', end)
  const existingMatch = (candidates ?? []).find(
    (row) => normalizeNameKey((row.name as string) ?? '') === nameKey,
  )
  if (existingMatch) {
    return { error: 'A block with the same name, house, and hours already exists.' }
  }

  // Append at the end of the existing sort order so newly created
  // blocks land at the bottom of the board, never reshuffling the
  // manager's existing ordering.
  const { data: maxRow } = await ctx.supabase
    .from('shift_sections')
    .select('sort_order')
    .eq('restaurant_id', ctx.restaurantId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextOrder = (maxRow?.sort_order ?? 0) + 10

  const { error } = await ctx.supabase.from('shift_sections').insert({
    restaurant_id: ctx.restaurantId,
    name, area, role,
    default_start_hour: start,
    default_end_hour: end,
    sort_order: nextOrder,
  })
  if (error) return { error: formatError('block', error) }
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return null
}

export async function updateShiftSection(
  prevState: { error: string } | null, formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Owner-only — see addStaffingRole above.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can change staffing structure.' }
  }

  const sectionId = (formData.get('section_id') as string)?.trim()
  const rawName = (formData.get('name') as string) ?? ''
  const name = normalizeDisplayName(rawName)
  const nameKey = normalizeNameKey(rawName)
  if (!sectionId) return { error: 'No block selected.' }
  if (!name) return { error: 'Block name is required.' }

  const start = parseHour(formData.get('default_start_hour'), 'Start hour')
  if (typeof start === 'object') return start
  const end = parseHour(formData.get('default_end_hour'), 'End hour')
  if (typeof end === 'object') return end
  if (end === start) return { error: 'End hour must differ from start hour.' }

  // Block edited-name from colliding with another block in the same
  // restaurant (same area+hours signature). The current section is
  // excluded by id so renaming a block to its own normalized form
  // isn't blocked.
  const { data: currentRow } = await ctx.supabase
    .from('shift_sections')
    .select('area')
    .eq('id', sectionId)
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  if (currentRow) {
    const { data: candidates } = await ctx.supabase
      .from('shift_sections')
      .select('id, name')
      .eq('restaurant_id', ctx.restaurantId)
      .eq('area', currentRow.area)
      .eq('default_start_hour', start)
      .eq('default_end_hour', end)
      .neq('id', sectionId)
    const collision = (candidates ?? []).find(
      (row) => normalizeNameKey((row.name as string) ?? '') === nameKey,
    )
    if (collision) {
      return { error: 'A block with the same name, house, and hours already exists.' }
    }
  }

  const { error } = await ctx.supabase
    .from('shift_sections')
    .update({
      name,
      default_start_hour: start,
      default_end_hour: end,
    })
    .eq('id', sectionId)
    .eq('restaurant_id', ctx.restaurantId)
  if (error) return { error: formatError('block', error) }
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return null
}

export async function deleteShiftSection(
  prevState: { error: string } | null, formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  // Owner-only — see addStaffingRole above.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can change staffing structure.' }
  }

  const sectionId = (formData.get('section_id') as string)?.trim()
  if (!sectionId) return { error: 'No block selected.' }

  // Shifts under this section are NOT deleted — schema sets
  // section_id to NULL via ON DELETE SET NULL, which surfaces them
  // on the Custom lane in the UI.
  const { error } = await ctx.supabase
    .from('shift_sections')
    .delete()
    .eq('id', sectionId)
    .eq('restaurant_id', ctx.restaurantId)
  if (error) return { error: formatError('block', error) }
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return null
}

// ----------------------------------------------------------------
// Quick assign — drag-and-drop creates a shift instantly
// ----------------------------------------------------------------
export async function quickAssignShift(
  employeeId: string,
  sectionId: string | null,
  dayIso: string,
  // Optional explicit times (used by the new staffing calendar's
  // Day view, which drops onto a specific day without a block).
  // When absent + sectionId given, we use the section's defaults.
  // When absent + no section, we fall back to 9-5 as a starter
  // slot the user can edit via "Set shift time".
  startHour?: number,
  endHour?: number,
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  const { locationId } = await resolveLocationId(ctx)
  if (!locationId) return { error: 'No location.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, locationId)
  if (locAuthErr) return { error: locAuthErr }

  const { data: employee } = await ctx.supabase
    .from('employees').select('role, name, availability').eq('id', employeeId).single()
  if (!employee) return { error: 'Employee not found.' }

  // Availability guard — Mon..Sun (index 0..6). JS getDay() is
  // Sun=0..Sat=6, so we remap. If the day is flagged false, the
  // shift is rejected up front rather than silently created.
  const dayCheck = new Date(dayIso)
  const jsDow = dayCheck.getDay()
  const monIdx = jsDow === 0 ? 6 : jsDow - 1
  const availability = employee.availability
  if (Array.isArray(availability) && availability.length === 7 && availability[monIdx] === false) {
    return { error: `${employee.name ?? 'This employee'} isn’t available that day.` }
  }

  // Resolve start/end hours: explicit params > section defaults > 9-5.
  let sh = startHour ?? 9
  let eh = endHour ?? 17
  let resolvedSectionId: string | null = null
  if (sectionId) {
    const { data: section } = await ctx.supabase
      .from('shift_sections')
      .select('default_start_hour, default_end_hour')
      .eq('id', sectionId)
      .single()
    if (section) {
      sh = section.default_start_hour
      eh = section.default_end_hour
      resolvedSectionId = sectionId
    }
  }

  const day = new Date(dayIso)
  const start = new Date(day); start.setHours(sh, 0, 0, 0)
  const end = new Date(day)
  if (eh <= sh) end.setDate(end.getDate() + 1)
  end.setHours(eh, 0, 0, 0)

  const { error } = await ctx.supabase.from('shifts').insert({
    restaurant_id: ctx.restaurantId, location_id: locationId,
    employee_id: employeeId, section_id: resolvedSectionId,
    role: employee.role,
    start_time: start.toISOString(), end_time: end.toISOString(),
  })

  if (error) return { error: error.message }
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return null
}

// ----------------------------------------------------------------
// copyPreviousWeek — duplicate the previous week's shifts +7 days.
//
// Called from the new staffing calendar's "Copy last week" button.
// Reads every shift whose start_time lands in the week BEFORE
// currentWeekStartIso, shifts each by +7 days, and inserts. Skips
// employees that are no longer active + skips shifts that already
// exist in the target week for the same employee+start (idempotent).
// ----------------------------------------------------------------
export async function copyPreviousWeek(
  currentWeekStartIso: string,
): Promise<{ copied: number; skipped: number } | { error: string }> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }
  if (ctx.role !== 'owner' && ctx.role !== 'manager') {
    return { error: 'Only the owner or a manager can copy a week.' }
  }

  const { locationId } = await resolveLocationId(ctx)
  if (!locationId) return { error: 'No location.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, locationId)
  if (locAuthErr) return { error: locAuthErr }

  const currentWeekStart = new Date(currentWeekStartIso)
  const prevWeekStart = new Date(currentWeekStart); prevWeekStart.setDate(prevWeekStart.getDate() - 7)
  const currentWeekEnd = new Date(currentWeekStart); currentWeekEnd.setDate(currentWeekEnd.getDate() + 7)

  // Fetch previous week + current week's shifts (need current
  // for dedupe). Also fetch active employees to skip inactive ones.
  const [prevRes, currRes, empRes] = await Promise.all([
    ctx.supabase.from('shifts')
      .select('employee_id, section_id, role, start_time, end_time, notes')
      .eq('location_id', locationId)
      .gte('start_time', prevWeekStart.toISOString())
      .lt('start_time', currentWeekStart.toISOString()),
    ctx.supabase.from('shifts')
      .select('employee_id, start_time')
      .eq('location_id', locationId)
      .gte('start_time', currentWeekStart.toISOString())
      .lt('start_time', currentWeekEnd.toISOString()),
    ctx.supabase.from('employees').select('id').eq('active', true),
  ])
  if (prevRes.error) return { error: `Previous week fetch: ${prevRes.error.message}` }

  const activeIds = new Set((empRes.data ?? []).map((e) => e.id as string))
  const existing = new Set(
    (currRes.data ?? []).map((s) => `${s.employee_id}|${new Date(s.start_time as string).getTime()}`),
  )

  const rows: Array<{
    restaurant_id: string; location_id: string; employee_id: string
    section_id: string | null; role: string
    start_time: string; end_time: string; notes: string | null
  }> = []
  let skipped = 0
  for (const s of prevRes.data ?? []) {
    const employeeId = s.employee_id as string
    if (!activeIds.has(employeeId)) { skipped++; continue }
    const newStart = new Date(s.start_time as string); newStart.setDate(newStart.getDate() + 7)
    const newEnd = new Date(s.end_time as string); newEnd.setDate(newEnd.getDate() + 7)
    const dedupeKey = `${employeeId}|${newStart.getTime()}`
    if (existing.has(dedupeKey)) { skipped++; continue }
    rows.push({
      restaurant_id: ctx.restaurantId, location_id: locationId,
      employee_id: employeeId, section_id: (s.section_id as string | null) ?? null,
      role: s.role as string,
      start_time: newStart.toISOString(), end_time: newEnd.toISOString(),
      notes: (s.notes as string | null) ?? null,
    })
  }

  if (rows.length > 0) {
    const { error } = await ctx.supabase.from('shifts').insert(rows)
    if (error) return { error: error.message }
  }

  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return { copied: rows.length, skipped }
}

// ----------------------------------------------------------------
// updateShiftTimes — thin helper for the day-view "Set shift time"
// affordance. Only touches start/end; leaves employee, section, and
// notes alone. Owner or matching-location manager may call.
// ----------------------------------------------------------------
export async function updateShiftTimes(
  shiftId: string,
  startIso: string,
  endIso: string,
): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  const { data: shift } = await ctx.supabase
    .from('shifts').select('location_id').eq('id', shiftId).single()
  if (!shift) return { error: 'Shift not found.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, shift.location_id as string)
  if (locAuthErr) return { error: locAuthErr }

  const { error } = await ctx.supabase
    .from('shifts')
    .update({ start_time: startIso, end_time: endIso })
    .eq('id', shiftId)
  if (error) return { error: error.message }

  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return null
}

// ----------------------------------------------------------------
// deleteShiftById — non-formData delete used by the day view's
// per-row remove (×). The existing deleteShift(formData) helper
// still exists for form callers.
// ----------------------------------------------------------------
export async function deleteShiftById(shiftId: string): Promise<{ error: string } | null> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  const { data: shift } = await ctx.supabase
    .from('shifts').select('location_id').eq('id', shiftId).single()
  if (!shift) return { error: 'Shift not found.' }
  const locAuthErr = await requireLocResult(ctx.restaurantId, shift.location_id as string)
  if (locAuthErr) return { error: locAuthErr }

  const { error } = await ctx.supabase.from('shifts').delete().eq('id', shiftId)
  if (error) return { error: error.message }

  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
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

  const rawName = (formData.get('name') as string) ?? ''
  const name = normalizeDisplayName(rawName)
  const nameKey = normalizeNameKey(rawName)
  const rawRole = (formData.get('role') as string) ?? ''
  const role = normalizeDisplayName(rawRole)
  const hourlyRateRaw = formData.get('hourly_rate') as string

  if (!name) return { error: 'Employee name is required.' }
  if (!role) return { error: 'Role is required.' }

  const hourlyRate = hourlyRateRaw ? parseFloat(hourlyRateRaw) : null
  if (hourlyRate !== null && (isNaN(hourlyRate) || hourlyRate < 0)) return { error: 'Hourly rate must be 0 or more.' }

  // Duplicate guard — active employees in this restaurant. Two people
  // can legitimately share a name in reality; the manager can
  // disambiguate (e.g. "Juan G." vs "Juan Garcia") when the form
  // rejects. Archived employees don't block — same convention as
  // the inventory + menu guards.
  const { data: existingEmployees } = await ctx.supabase
    .from('employees')
    .select('id, name')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('active', true)
  const collision = (existingEmployees ?? []).find(
    (row) => normalizeNameKey((row.name as string) ?? '') === nameKey,
  )
  if (collision) {
    return {
      error: `An employee named ${normalizeDisplayName((collision.name as string) ?? '')} already exists.`,
    }
  }

  const { error } = await ctx.supabase.from('employees').insert({
    restaurant_id: ctx.restaurantId, primary_location_id: locationId,
    name, role, hourly_rate: hourlyRate,
  })

  if (error) return { error: formatError('employee', error) }
  await logAudit(ctx, locationId, 'create_employee', 'employees')
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return null
}

// ----------------------------------------------------------------
// updateEmployee — name / role / hourly_rate.
//
// Used by the bench's quick-manage drawer. Same owner-gating as
// createEmployee. Restaurant-scoped via the matching restaurant_id
// filter (RLS would also block cross-restaurant writes, but the
// explicit filter is defense in depth).
// ----------------------------------------------------------------
export async function updateEmployee(
  prevState: { error: string } | null, formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const employeeId = (formData.get('employee_id') as string)?.trim()
  if (!employeeId) return { error: 'No employee selected.' }

  // Location enforcement: a manager can only edit an employee
  // whose primary_location_id matches their managedLocationId.
  // Owners pass for any location. Without this check a manager at
  // Location A could craft a form submission to edit an employee
  // at Location B.
  const { data: empRow } = await ctx.supabase
    .from('employees')
    .select('primary_location_id')
    .eq('id', employeeId)
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  if (!empRow) return { error: 'Employee not found.' }
  if (
    ctx.role === 'manager' &&
    ctx.locationId &&
    empRow.primary_location_id !== ctx.locationId
  ) {
    return { error: 'You do not have access to this employee’s location.' }
  }

  const rawName = (formData.get('name') as string) ?? ''
  const name = normalizeDisplayName(rawName)
  const nameKey = normalizeNameKey(rawName)
  const rawRole = (formData.get('role') as string) ?? ''
  const role = normalizeDisplayName(rawRole)
  const hourlyRateRaw = formData.get('hourly_rate') as string

  if (!name) return { error: 'Employee name is required.' }
  if (!role) return { error: 'Role is required.' }

  const hourlyRate = hourlyRateRaw ? parseFloat(hourlyRateRaw) : null
  if (hourlyRate !== null && (isNaN(hourlyRate) || hourlyRate < 0)) {
    return { error: 'Hourly rate must be 0 or more.' }
  }

  // ---- 2026-07-26 employee-profile extensions ----
  // trained_roles: JSON array of role display strings. We strip
  // any that collide with the primary role (redundant to store the
  // primary twice) and dedupe by normalized key.
  const trainedRolesRaw = (formData.get('trained_roles') as string) ?? ''
  let trainedRoles: string[] = []
  if (trainedRolesRaw) {
    try {
      const parsed = JSON.parse(trainedRolesRaw)
      if (Array.isArray(parsed)) {
        const seen = new Set<string>([normalizeNameKey(role)])
        for (const r of parsed) {
          if (typeof r !== 'string') continue
          const clean = normalizeDisplayName(r)
          const k = normalizeNameKey(r)
          if (!clean || !k || seen.has(k)) continue
          seen.add(k)
          trainedRoles.push(clean)
        }
      }
    } catch {
      return { error: 'Trained roles must be a JSON array of role names.' }
    }
  }

  // employment: 'part_time' | 'full_time'. Anything else is a
  // client bug — reject rather than silently coerce.
  const employmentRaw = ((formData.get('employment') as string) ?? '').trim().toLowerCase()
  const employment = employmentRaw === 'full_time' ? 'full_time' : 'part_time'
  if (employmentRaw && employmentRaw !== 'part_time' && employmentRaw !== 'full_time') {
    return { error: 'Employment must be part_time or full_time.' }
  }

  // availability: 7-boolean array Mon..Sun. Missing = leave the
  // stored value untouched.
  const availabilityRaw = (formData.get('availability') as string) ?? ''
  let availabilityUpdate: boolean[] | undefined
  if (availabilityRaw) {
    try {
      const parsed = JSON.parse(availabilityRaw)
      if (!Array.isArray(parsed) || parsed.length !== 7) {
        return { error: 'Availability must be a 7-element array.' }
      }
      availabilityUpdate = parsed.map((v) => v !== false)
    } catch {
      return { error: 'Availability must be a JSON boolean array.' }
    }
  }

  // Duplicate guard — same shape as create. Exclude the current
  // employee so renaming to the same normalized form (e.g. "john
  // garcia" → "John Garcia") isn't blocked by itself.
  const { data: existingEmployees } = await ctx.supabase
    .from('employees')
    .select('id, name')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('active', true)
    .neq('id', employeeId)
  const collision = (existingEmployees ?? []).find(
    (row) => normalizeNameKey((row.name as string) ?? '') === nameKey,
  )
  if (collision) {
    return {
      error: `An employee named ${normalizeDisplayName((collision.name as string) ?? '')} already exists.`,
    }
  }

  const updatePayload: Record<string, unknown> = {
    name, role, hourly_rate: hourlyRate,
    trained_roles: trainedRoles,
    employment,
  }
  if (availabilityUpdate) updatePayload.availability = availabilityUpdate

  const { error } = await ctx.supabase
    .from('employees')
    .update(updatePayload)
    .eq('id', employeeId)
    .eq('restaurant_id', ctx.restaurantId)

  if (error) return { error: formatError('employee', error) }
  await logAudit(ctx, null, 'update_employee', 'employees', employeeId)
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return null
}

// ----------------------------------------------------------------
// archiveEmployee — soft delete: sets active=false.
//
// We never hard-delete employees because shifts have an FK to
// employees with ON DELETE CASCADE — a hard delete would wipe their
// schedule history. Archiving keeps history while hiding the
// employee from the bench (the page filters by active=true).
// Existing past shifts continue to render on the board until the
// week passes out of view; that's intentional — managers shouldn't
// see archive holes in last week's schedule.
// ----------------------------------------------------------------
export async function archiveEmployee(
  prevState: { error: string } | null, formData: FormData
) {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }

  const employeeId = (formData.get('employee_id') as string)?.trim()
  if (!employeeId) return { error: 'No employee selected.' }

  // Location enforcement — see updateEmployee above.
  const { data: empRow } = await ctx.supabase
    .from('employees')
    .select('primary_location_id')
    .eq('id', employeeId)
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  if (!empRow) return { error: 'Employee not found.' }
  if (
    ctx.role === 'manager' &&
    ctx.locationId &&
    empRow.primary_location_id !== ctx.locationId
  ) {
    return { error: 'You do not have access to this employee’s location.' }
  }

  const { error } = await ctx.supabase
    .from('employees')
    .update({ active: false })
    .eq('id', employeeId)
    .eq('restaurant_id', ctx.restaurantId)

  if (error) return { error: formatError('employee', error) }
  await logAudit(ctx, null, 'archive_employee', 'employees', employeeId)
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
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
  revalidatePath('/web/staffing')
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

  const { data: employee } = await ctx.supabase
    .from('employees')
    .select('role, trained_roles')
    .eq('id', employeeId)
    .single()
  if (!employee) return { error: 'Employee not found.' }

  // Optional role override (shift edit drawer's role picker).
  // Must be either the employee's primary role or one of their
  // trained roles — anything else is a client-side tampering
  // attempt, not a valid selection.
  const rawRoleOverride = ((formData.get('role') as string) ?? '').trim()
  let resolvedRole = employee.role as string
  if (rawRoleOverride) {
    const wantKey = normalizeNameKey(rawRoleOverride)
    const primaryKey = normalizeNameKey(employee.role ?? '')
    const trainedList = (Array.isArray(employee.trained_roles) ? employee.trained_roles : []) as string[]
    const trainedKeys = trainedList.map((r) => normalizeNameKey(r))
    if (wantKey === primaryKey) {
      resolvedRole = employee.role as string
    } else if (trainedKeys.includes(wantKey)) {
      // Pull the display form back off the trained_roles list to
      // preserve whatever casing the manager stored.
      const idx = trainedKeys.indexOf(wantKey)
      resolvedRole = trainedList[idx]
    } else {
      return { error: `Role “${rawRoleOverride}” isn’t in the employee’s primary or trained set.` }
    }
  }

  const { error } = await ctx.supabase.from('shifts').update({
    employee_id: employeeId, role: resolvedRole, start_time: startTime, end_time: endTime, notes,
  }).eq('id', shiftId)

  if (error) return { error: formatError('shift', error) }
  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
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
  revalidatePath('/web/staffing')
  return null
}

// ----------------------------------------------------------------
// Testing utility — archives all employees and clears their shifts.
// Preserves staffing config + shift sections.
// ----------------------------------------------------------------
export async function clearAllEmployees() {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.', cleared: 0 }

  // Owner-only — destructive restaurant-wide reset.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can clear the roster.', cleared: 0 }
  }

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

  await logAudit(ctx, null, 'clear_all_employees', 'employees', undefined, { archived_count: count })

  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return { error: null, cleared: count, message: `Archived ${count} employee${count !== 1 ? 's' : ''} and cleared all shifts.` }
}

// ----------------------------------------------------------------
// Full staffing reset — clears everything so /staffing shows
// the first-time onboarding wizard again.
// ----------------------------------------------------------------
export async function resetStaffingSetup() {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  // Owner-only — destructive restaurant-wide reset.
  if (ctx.role !== 'owner') {
    return { error: 'Only the owner can reset staffing.' }
  }

  // Order matters: shifts reference employees + sections, so delete shifts first
  await ctx.supabase.from('shifts').delete().eq('restaurant_id', ctx.restaurantId)
  await ctx.supabase.from('employees').update({ active: false }).eq('restaurant_id', ctx.restaurantId)
  await ctx.supabase.from('shift_sections').delete().eq('restaurant_id', ctx.restaurantId)
  await ctx.supabase.from('staffing_config').delete().eq('restaurant_id', ctx.restaurantId)

  await logAudit(ctx, null, 'reset_staffing_setup')

  revalidatePath('/staffing')
  revalidatePath('/web/staffing')
  return { error: null, message: 'Staffing reset complete. Visit Staffing to run setup again.' }
}
