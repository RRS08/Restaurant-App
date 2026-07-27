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
import { getRoleMatrix, getStarterShiftSections } from '@/lib/onboarding/defaults'
import { splitRolesForStorage, type BusinessType, type TeamModel } from '@/lib/onboarding/types'
import { getLang } from '@/lib/i18n-server'
import StaffingClient from './client'

export default async function StaffingPage() {
  const supabase = await createClient()
  const lang = await getLang()

  const { data: config } = await supabase
    .from('staffing_config')
    .select('restaurant_id, house_model, scheduling_style, foh_roles, boh_roles, role_colors, role_wages')
    .maybeSingle()

  // ----------------------------------------------------------------
  // Lazy role backfill.
  //
  // Two failure modes get healed here:
  //   1. staffing_config row exists but foh_roles / boh_roles are
  //      empty arrays. (foh_roles + boh_roles were added by a later
  //      schema ALTER with default '{}', so any restaurant whose
  //      row predates that change carries empty defaults.)
  //   2. staffing_config row doesn't exist at all (older onboarding
  //      flow, prior reset, or partial bootstrap).
  //
  // In either case the Add Employee drawer ends up with zero role
  // options and is unusable. We seed from the same RoleMatrix the
  // wizard uses (business_type + team_model), upserting one row by
  // restaurant_id. business_type comes from restaurant_setup_state
  // when set; if missing we fall back to 'full_service' which has a
  // well-defined matrix entry for every team model.
  //
  // Idempotent: only fires when both role arrays are empty, so
  // legitimate selections are never overwritten. One visit fixes
  // the row permanently.
  // ----------------------------------------------------------------
  let fohRoles = config?.foh_roles ?? []
  let bohRoles = config?.boh_roles ?? []
  const needsBackfill = fohRoles.length === 0 && bohRoles.length === 0

  if (needsBackfill) {
    // Resolve restaurant_id either from the existing config row or
    // from the caller's user_role. We need it both to upsert the
    // staffing_config row and to keep the operation idempotent.
    let restaurantId: string | null = config?.restaurant_id ?? null
    if (!restaurantId) {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: roleRow } = await supabase
          .from('user_roles')
          .select('restaurant_id')
          .eq('user_id', user.id)
          .maybeSingle()
        restaurantId = roleRow?.restaurant_id ?? null
      }
    }

    if (restaurantId) {
      const { data: setup } = await supabase
        .from('restaurant_setup_state')
        .select('business_type')
        .maybeSingle()
      // Default to 'full_service' when business_type is missing —
      // its matrix has entries for every team model and is the
      // safest superset for a restaurant with unknown segment.
      const businessType = ((setup?.business_type ?? 'full_service') as BusinessType)

      // staffing_config.house_model storage values are either the
      // legacy 'split' (no longer written by onboarding) or the
      // team-model values 'foh_boh' / 'unified' / 'prep_service'.
      // Matrix lookup needs a TeamModel; map legacy 'split' to
      // 'foh_boh' (same two-bucket shape). When no row yet, default
      // to 'foh_boh' which is the most common team model.
      const stored = config?.house_model ?? 'foh_boh'
      const teamModelForMatrix: TeamModel =
        stored === 'unified' ? 'unified'
          : stored === 'prep_service' ? 'prep_service'
            : 'foh_boh'

      const matrix = getRoleMatrix(businessType, teamModelForMatrix)
      if (matrix) {
        const seeded = splitRolesForStorage(
          teamModelForMatrix,
          matrix.groupA.recommended,
          matrix.groupB?.recommended ?? []
        )
        // Upsert by restaurant_id so this works whether the row
        // exists (UPDATE) or not (INSERT). When inserting, schema
        // defaults fill house_model='split' and scheduling_style=
        // 'by_role'. We don't override house_model on insert because
        // we don't know the user's actual preference — they can pick
        // it via onboarding rerun if needed; the role list is what
        // unblocks Add Employee.
        const { error: upErr } = await supabase
          .from('staffing_config')
          .upsert(
            {
              restaurant_id: restaurantId,
              foh_roles: seeded.fohRoles,
              boh_roles: seeded.bohRoles,
            },
            { onConflict: 'restaurant_id' }
          )
        if (!upErr) {
          fohRoles = seeded.fohRoles
          bohRoles = seeded.bohRoles
        }
      }
    }
  }

  const [
    { data: employees },
    { data: shifts },
    { data: sectionsData },
    { data: locations },
    { data: businessHours },
    { data: hoursOverrides },
  ] = await Promise.all([
    supabase.from('employees').select('id, name, role, primary_location_id, trained_roles, employment, availability, sort_order').eq('active', true).order('sort_order').order('name'),
    supabase.from('shifts').select('id, location_id, employee_id, section_id, role, start_time, end_time, notes, employees ( name )').order('start_time'),
    supabase.from('shift_sections').select('id, name, role, area, default_start_hour, default_end_hour, sort_order').order('sort_order'),
    supabase.from('locations').select('id, name').order('created_at', { ascending: true }),
    // 7 rows max per location — cheap to fetch in full.
    supabase.from('business_hours').select('location_id, weekday, closed, open_min, close_min'),
    // Overrides are rare (holidays, one-off closes). Fetch all
    // and let the client index by date; total volume is small
    // enough that a rolling window buys nothing here.
    supabase.from('hours_override').select('location_id, date, closed, open_min, close_min'),
  ])

  // ----------------------------------------------------------------
  // Self-healing dedupe of shift_sections.
  //
  // The lazy backfill below has a small race window: if two requests
  // both see zero rows before either inserts, both seed the starter
  // set and the restaurant ends up with duplicate blocks (same
  // name/area/hours, different ids). The "+ Block" button also has
  // no name-collision check on the server, so manual duplicates can
  // exist too.
  //
  // We dedupe defensively at page-load time: group by the
  // shape signature (name + area + start + end), keep the section
  // with the lowest sort_order as canonical, reassign any shifts
  // pointing at the duplicates onto the canonical section, then
  // delete the duplicate rows. Mutation only fires when duplicates
  // actually exist — the no-dup steady-state is a single in-memory
  // pass with no DB writes.
  // ----------------------------------------------------------------
  let sections = sectionsData ?? []

  if (sections.length > 1) {
    type SectionRow = typeof sections[number]
    const groups = new Map<string, SectionRow[]>()
    for (const s of sections) {
      const key = `${s.name}|${s.area}|${s.default_start_hour}|${s.default_end_hour}`
      const arr = groups.get(key) ?? []
      arr.push(s)
      groups.set(key, arr)
    }
    const duplicateGroups = Array.from(groups.values()).filter((g) => g.length > 1)

    if (duplicateGroups.length > 0) {
      for (const group of duplicateGroups) {
        const sorted = [...group].sort((a, b) => a.sort_order - b.sort_order)
        const canonical = sorted[0]
        const duplicateIds = sorted.slice(1).map((s) => s.id)

        // Reassign any shifts that point at duplicates to the
        // canonical section — preserves the schedule the user
        // already built before deletion.
        await supabase
          .from('shifts')
          .update({ section_id: canonical.id })
          .in('section_id', duplicateIds)

        await supabase
          .from('shift_sections')
          .delete()
          .in('id', duplicateIds)
      }

      // Re-fetch after cleanup so the client renders the deduped set.
      const { data: cleaned } = await supabase
        .from('shift_sections')
        .select('id, name, role, area, default_start_hour, default_end_hour, sort_order')
        .order('sort_order')
      sections = cleaned ?? []
    }
  }

  // ----------------------------------------------------------------
  // Lazy shift-section backfill.
  //
  // shift_sections were never seeded by onboarding (the schema
  // comment says "seeded automatically" but no seeder existed). A
  // restaurant with zero blocks gets the empty schedule grid and
  // employees can't be placed. Seed a generic starter set keyed by
  // team model and re-fetch just the inserted rows.
  //
  // Idempotent: only runs when the SELECT returned zero rows. If
  // the manager has any custom block, this is skipped — we never
  // overwrite. One visit fixes the restaurant permanently. If a
  // race ever inserts twice anyway, the dedupe above heals it on
  // the next page load.
  // ----------------------------------------------------------------
  if (sections.length === 0) {
    // Resolve restaurant_id from config if we have it, else from
    // user_roles. Mirrors the role-backfill resolution above.
    let sectionRestaurantId: string | null = config?.restaurant_id ?? null
    if (!sectionRestaurantId) {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: roleRow } = await supabase
          .from('user_roles')
          .select('restaurant_id')
          .eq('user_id', user.id)
          .maybeSingle()
        sectionRestaurantId = roleRow?.restaurant_id ?? null
      }
    }

    if (sectionRestaurantId) {
      const stored = config?.house_model ?? 'foh_boh'
      const teamModelForSeed: TeamModel =
        stored === 'unified' ? 'unified'
          : stored === 'prep_service' ? 'prep_service'
            : 'foh_boh'

      const starters = getStarterShiftSections(teamModelForSeed)
      const insertRows = starters.map((s) => ({
        restaurant_id: sectionRestaurantId,
        ...s,
      }))

      const { data: seeded } = await supabase
        .from('shift_sections')
        .insert(insertRows)
        .select('id, name, role, area, default_start_hour, default_end_hour, sort_order')

      if (seeded && seeded.length > 0) {
        sections = seeded
      }
    }
  }

  // Safe defaults when no config exists yet. The client renders
  // an empty but usable board — no blocking wizard.
  const houseModel = config?.house_model === 'unified' ? 'unified' : 'split'
  const schedulingStyle = config?.scheduling_style === 'by_role' ? 'by_role' : 'by_team'

  // Owner-picked color overrides per role (normalized_role_key →
  // color slug). Empty object if not set. Client's roleTone()
  // consults this before falling back to the auto-color regex.
  const roleColors = (config?.role_colors as Record<string, string> | null) ?? {}
  // Per-role hourly wages (normalized_role_key → hourly rate).
  // Introduced 2026-07-26; empty object if not set. Displayed +
  // edited in the staffing calendar's roles legend popover.
  const roleWages = (config?.role_wages as Record<string, number> | null) ?? {}

  return (
    <StaffingClient
      lang={lang}
      defaultLocationId={locations?.[0]?.id ?? null}
      houseModel={houseModel}
      schedulingStyle={schedulingStyle}
      fohRoles={fohRoles}
      bohRoles={bohRoles}
      roleColors={roleColors}
      roleWages={roleWages}
      employees={(employees ?? []).map((e) => ({
        id: e.id, name: e.name, role: e.role, primaryLocationId: e.primary_location_id,
        trainedRoles: Array.isArray(e.trained_roles) ? (e.trained_roles as string[]) : [],
        employment: (e.employment === 'full_time' ? 'full_time' : 'part_time') as 'part_time' | 'full_time',
        // 7-element boolean array Mon..Sun. Guard against malformed
        // JSON with a shape-check + all-true fallback so a stale row
        // never lands us with a shorter array that indexes out.
        availability: (() => {
          const raw = e.availability
          if (Array.isArray(raw) && raw.length === 7) return raw.map((v) => v !== false)
          return [true, true, true, true, true, true, true]
        })(),
        // sort_order = 0 means "no manual preference" — the client's
        // fallback sort (role priority + name) takes over.
        sortOrder: typeof e.sort_order === 'number' ? e.sort_order : 0,
      }))}
      shifts={(shifts ?? []).map((s) => ({
        id: s.id, locationId: s.location_id, employeeId: s.employee_id,
        sectionId: s.section_id, role: s.role,
        employeeName: (s.employees as unknown as { name: string } | null)?.name ?? '—',
        startTime: s.start_time, endTime: s.end_time, notes: s.notes ?? null,
      }))}
      sections={sections.map((s) => ({
        id: s.id, name: s.name, role: s.role ?? 'General', area: s.area as 'foh' | 'boh',
        defaultStartHour: s.default_start_hour, defaultEndHour: s.default_end_hour,
        sortOrder: s.sort_order,
      }))}
      businessHours={(businessHours ?? []).map((h) => ({
        locationId: h.location_id as string,
        weekday: h.weekday as number,
        closed: !!h.closed,
        openMin: h.open_min as number,
        closeMin: h.close_min as number,
      }))}
      hoursOverrides={(hoursOverrides ?? []).map((h) => ({
        locationId: h.location_id as string,
        // Postgres `date` comes back as 'YYYY-MM-DD'; keep that
        // string form as the key everywhere (avoids TZ drift when
        // constructing a Date from it).
        date: h.date as string,
        closed: !!h.closed,
        openMin: h.open_min as number,
        closeMin: h.close_min as number,
      }))}
    />
  )
}
