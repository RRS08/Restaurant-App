'use client'

import { useEffect, useMemo, useRef, useState, useActionState, useTransition, type DragEvent } from 'react'
import {
  quickAssignShift,
  createEmployee,
  updateEmployee,
  archiveEmployee,
  createShift,
  updateShift,
  deleteShift,
  addStaffingRole,
  createShiftSection,
  updateShiftSection,
  deleteShiftSection,
} from '@/app/actions/staffing'

interface Employee { id: string; name: string; role: string; primaryLocationId: string }
interface Section { id: string; name: string; role: string; area: 'foh' | 'boh'; defaultStartHour: number; defaultEndHour: number; sortOrder: number }
interface Shift {
  id: string; locationId: string; employeeId: string; sectionId: string | null
  employeeName: string; role: string; startTime: string; endTime: string; notes: string | null
}
interface Props {
  defaultLocationId: string | null; employees: Employee[]; shifts: Shift[]; sections: Section[]
  houseModel: 'split' | 'unified'
  schedulingStyle: 'by_role' | 'by_team'
  fohRoles: string[]; bohRoles: string[]
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function getMonday(d: Date) { const date = new Date(d); const day = date.getDay(); date.setDate(date.getDate() - (day === 0 ? 6 : day - 1)); date.setHours(0,0,0,0); return date }
function getWeekDays(mon: Date) { return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d }) }
function sameDay(a: Date, b: Date) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() }
function fmt(d: string) { return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }
function hL(h: number) { return h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h-12}p` }
function toLocal(d: Date) { const p = (n: number) => n.toString().padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }

// ----------------------------------------------------------------
// Weekly hours threshold model.
//
// One source of truth for how scheduled hours map to a tier so the
// bench card (and any future hour-aware surface) tells the same
// story. Bands match the spec:
//   normal  <32h   nothing surprising
//   caution 32–39  approaching full-time, watch
//   near    40     at the limit
//   over    >40    overtime risk
//
// Kept lightweight on purpose — this is a planning hint, not a
// payroll calculation.
// ----------------------------------------------------------------
type HoursTier = 'normal' | 'caution' | 'near' | 'over'

function hoursTier(h: number): HoursTier {
  if (h > 40) return 'over'
  if (h >= 40) return 'near'
  if (h >= 32) return 'caution'
  return 'normal'
}

function formatHours(h: number): string {
  if (h <= 0) return '0h'
  // Whole numbers as 36h, fractional as 36.5h. Avoids the visual
  // noise of "36.0h" while still showing the half when it matters.
  return h % 1 === 0 ? `${h.toFixed(0)}h` : `${h.toFixed(1)}h`
}

// HoursIndicator — restrained per-tier text label + optional pill.
// • normal/caution: text-only color so low-signal cases stay quiet.
// • near/over: a soft pill so 40+ hour employees pop at a glance.
// Always tabular-nums so digit columns don't dance between cards.
// HoursIndicator — restrained per-tier label. Per the status-
// signaling rule, no tier relies on lightness alone:
//   • 0h        → text-gray-600 "Unscheduled" pill (visible, calm)
//                 — managers need to spot people without shifts;
//                 faint gray-300 made them disappear.
//   • normal    → text-gray-700 plain text (quiet, not faint)
//   • caution   → text-amber-700 plain text (soft warning)
//   • near (40) → amber pill (text-amber-800, bg-amber-100)
//   • over (>40)→ red pill (text-red-700, bg-red-50)
// Always tabular-nums so digit columns line up across cards.
function HoursIndicator({ hours, tier }: { hours: number; tier: HoursTier }) {
  if (hours <= 0) {
    return (
      <span
        className="text-[10px] font-medium tabular-nums text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded flex-shrink-0"
        aria-label="No shifts scheduled this week"
        title="No shifts scheduled this week"
      >
        Unscheduled
      </span>
    )
  }
  const className = (() => {
    switch (tier) {
      case 'over':    return 'text-red-700 bg-red-50 px-1.5 py-0.5 rounded font-semibold'
      case 'near':    return 'text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded font-semibold'
      case 'caution': return 'text-amber-700 font-semibold'
      case 'normal':  return 'text-gray-700 font-medium'
    }
  })()
  const ariaSuffix = tier === 'over'
    ? ' — over 40 hours, overtime risk'
    : tier === 'near'
      ? ' — at 40-hour limit'
      : tier === 'caution'
        ? ' — approaching full time'
        : ''
  return (
    <span
      className={`text-[10px] tabular-nums flex-shrink-0 ${className}`}
      aria-label={`${formatHours(hours)} this week${ariaSuffix}`}
      title={`${formatHours(hours)} this week${ariaSuffix}`}
    >
      {formatHours(hours)}
    </span>
  )
}


export default function StaffingClient({ defaultLocationId, employees, shifts, sections, houseModel, schedulingStyle, fohRoles, bohRoles }: Props) {
  const isUnified = houseModel === 'unified'
  const isByRole = schedulingStyle === 'by_role'
  const [locationId] = useState(defaultLocationId ?? '')
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()))
  // In unified mode, `house` is pinned to 'foh' as the sole storage bucket and
  // the toggle is never rendered — the user sees a single-team experience.
  const [house, setHouse] = useState<'foh' | 'boh'>('foh')
  const activeHouse: 'foh' | 'boh' = isUnified ? 'foh' : house
  // Drawer modes drive every cross-cutting workflow on this page.
  // Centralized as a discriminated union so adding a new flow is
  // one entry here + one render branch at the bottom — no scattered
  // useState() flags and no risk of two drawers opening at once.
  type DrawerState =
    | { mode: 'edit'; shift: Shift }
    | { mode: 'add-employee'; house: 'foh' | 'boh' }
    | { mode: 'edit-employee'; employee: Employee; house: 'foh' | 'boh' }
    | { mode: 'add-block'; defaultArea: 'foh' | 'boh' }
    | { mode: 'edit-block'; section: Section; shiftCount: number }
    | { mode: 'add-shift'
        defaultDay: string | null
        defaultSectionId?: string | null
        defaultStartHour?: number | null
        defaultEndHour?: number | null
      }
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const weekDays = getWeekDays(weekStart)
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7)

  // Bucket employees strictly by the roles each house has configured.
  // In unified mode, every employee and every section belongs to the one team.
  const fohSet = new Set(fohRoles.map((r) => r.toLowerCase()))
  const bohSet = new Set(bohRoles.map((r) => r.toLowerCase()))
  const isFohRole = (role: string) => {
    const r = role.toLowerCase()
    if (fohSet.has(r)) return true
    if (bohSet.has(r)) return false
    return true
  }
  const locEmployees = employees.filter((e) => e.primaryLocationId === locationId)
  const houseEmployees = isUnified
    ? locEmployees
    : locEmployees.filter((e) => activeHouse === 'foh' ? isFohRole(e.role) : !isFohRole(e.role))
  const houseSections = isUnified ? sections : sections.filter((s) => s.area === activeHouse)
  const weekShifts = shifts.filter((s) => s.locationId === locationId && new Date(s.startTime) >= weekStart && new Date(s.startTime) < weekEnd)

  const weekLabel = `${weekDays[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${weekDays[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  const handleDrop = (e: DragEvent, dayIdx: number, sectionId: string) => {
    e.preventDefault(); setDragOver(null)
    const empId = e.dataTransfer.getData('text/plain')
    if (!empId) return
    const dayIso = weekDays[dayIdx].toISOString()
    startTransition(async () => { await quickAssignShift(empId, sectionId, dayIso) })
  }

  // Unified mode reuses the blue accent but never exposes the FOH/BOH toggle.
  // `color` keys the only intentional theming axis on the page — blue for
  // FOH/unified, amber for BOH. Every other surface is gray-scale so the
  // board never tips into a "rainbow scheduler" feel.
  const color: 'blue' | 'amber' = isUnified ? 'blue' : (activeHouse === 'foh' ? 'blue' : 'amber')

  // Tiny tone-tokens so the same identity colors apply consistently
  // across the board (today header, drop hover, shift-card accent,
  // bench dot, group eyebrow). Defining once means a future palette
  // change is one edit — and every branch sees the same swap.
  const tone = {
    soft:        color === 'blue' ? 'bg-blue-50/70'           : 'bg-amber-50/70',
    softerHover: color === 'blue' ? 'bg-blue-50'              : 'bg-amber-50',
    text:        color === 'blue' ? 'text-blue-700'           : 'text-amber-700',
    dot:         color === 'blue' ? 'bg-blue-500'             : 'bg-amber-500',
    accentBar:   color === 'blue' ? 'bg-blue-500'             : 'bg-amber-500',
    todayText:   color === 'blue' ? 'text-blue-600'           : 'text-amber-600',
    countChip:   color === 'blue' ? 'bg-blue-50 text-blue-700': 'bg-amber-50 text-amber-700',
  }

  const totalShiftsThisWeek = weekShifts.filter(
    (s) => houseSections.some((sec) => sec.id === s.sectionId)
  ).length

  // ----------------------------------------------------------------
  // Weekly scheduled hours per employee, computed from the shifts
  // currently visible on the board (the active week + location).
  // Lives at the StaffingClient level so every branch — FOH/BOH,
  // unified, prep/service, by_role/by_team — reads from the same
  // map. The bench card consumes it to surface a per-person hours
  // tier so managers can spot anyone approaching or exceeding the
  // 40-hour threshold without leaving the schedule view.
  // ----------------------------------------------------------------
  const hoursByEmployee = new Map<string, number>()
  for (const s of weekShifts) {
    const start = new Date(s.startTime).getTime()
    const end = new Date(s.endTime).getTime()
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const hrs = (end - start) / (1000 * 60 * 60)
      hoursByEmployee.set(s.employeeId, (hoursByEmployee.get(s.employeeId) ?? 0) + hrs)
    }
  }

  // ----------------------------------------------------------------
  // Shifts-per-section — used by the edit-block drawer to warn the
  // manager before deleting a block ("12 shifts will move to the
  // Custom lane"). Counted across the full shifts list, not just
  // the visible week, since deletes affect every shift under the
  // section regardless of week.
  // ----------------------------------------------------------------
  const shiftsBySection = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of shifts) {
      if (!s.sectionId) continue
      m.set(s.sectionId, (m.get(s.sectionId) ?? 0) + 1)
    }
    return m
  }, [shifts])

  // ----------------------------------------------------------------
  // Custom shifts = shifts whose section_id is NULL. They surface
  // on a dedicated "Custom" lane below the regular blocks. In split
  // mode we filter by role to keep custom shifts inside the active
  // house view; unified shows all of them.
  // ----------------------------------------------------------------
  const customShifts = weekShifts.filter((s) => {
    if (s.sectionId !== null) return false
    if (isUnified) return true
    return activeHouse === 'foh' ? isFohRole(s.role) : !isFohRole(s.role)
  })
  const subtitle = isUnified
    ? "This week's schedule and assignments."
    : 'Plan shifts by house · drag from the bench onto the board.'

  return (
    <div className="max-w-[1400px]">

      {/* ================================================================ */}
      {/* 1. HEADER BAND — title + one-line subtitle. Controls live on the  */}
      {/*    strip below so they read as a unified workflow row instead of  */}
      {/*    being torn between top-right and a separate house line.       */}
      {/* ================================================================ */}
      <div className="mb-5">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">Staffing</h1>
        <p className="mt-1.5 text-sm text-gray-500">{subtitle}</p>
      </div>

      {/* ================================================================ */}
      {/* 2. CONTROL STRIP — every page-context control on one horizontal   */}
      {/*    level: house switch (split only) on the left, week navigation */}
      {/*    + add buttons on the right. Wraps cleanly on narrow widths.   */}
      {/*    Branch behavior: the strip itself is shared, only the house   */}
      {/*    switch arm renders conditionally.                              */}
      {/* ================================================================ */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center">
          {!isUnified && (
            // Segmented switch — black active tab pattern, matches
            // the rest of the product's primary toggle language.
            // Only the switch itself is monochrome; the schedule
            // board / bench / shift cards keep their FOH (blue) and
            // BOH (amber) identity accents elsewhere on the page.
            <div className="inline-flex rounded-lg border border-gray-200/80 bg-white p-0.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
              <button
                type="button"
                onClick={() => setHouse('foh')}
                className={`inline-flex items-center px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  house === 'foh'
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Front of House
              </button>
              <button
                type="button"
                onClick={() => setHouse('boh')}
                className={`inline-flex items-center px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  house === 'boh'
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Back of House
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Week navigation */}
          <div className="inline-flex rounded-lg border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
            <button
              type="button"
              onClick={() => setWeekStart((p) => { const d = new Date(p); d.setDate(d.getDate() - 7); return d })}
              className="px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
              aria-label="Previous week"
            >‹</button>
            <button
              type="button"
              onClick={() => setWeekStart(getMonday(new Date()))}
              className="px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 border-x border-gray-200/80 transition-colors"
            >Today</button>
            <button
              type="button"
              onClick={() => setWeekStart((p) => { const d = new Date(p); d.setDate(d.getDate() + 7); return d })}
              className="px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
              aria-label="Next week"
            >›</button>
          </div>

          {/* Workflow actions — three operational entry points, in
              order of how often a manager reaches for them: assign a
              one-off shift > add a recurring block > onboard a person. */}
          <button
            type="button"
            onClick={() => setDrawer({ mode: 'add-shift', defaultDay: null })}
            className="inline-flex items-center rounded-lg border border-gray-200/80 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors"
          >
            + Shift
          </button>
          <button
            type="button"
            onClick={() => setDrawer({ mode: 'add-block', defaultArea: activeHouse })}
            className="inline-flex items-center rounded-lg border border-gray-200/80 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors"
          >
            + Block
          </button>
          <button
            type="button"
            onClick={() => setDrawer({ mode: 'add-employee', house: activeHouse })}
            className="inline-flex items-center rounded-lg border border-gray-200/80 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors"
          >
            + Employee
          </button>
        </div>
      </div>

      {/* ================================================================ */}
      {/* 3. SCHEDULE BOARD — the hero. Standard card shell so it shares    */}
      {/*    visual language with Finance / POS / Sales / Analytics, plus  */}
      {/*    a header band that announces the surface and surfaces the     */}
      {/*    week label + shift count without crowding the top toolbar.    */}
      {/* ================================================================ */}
      <section className="mb-5 rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
        {/* Header band */}
        <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">Schedule</p>
            <p className="mt-0.5 text-xs text-gray-500 truncate">{weekLabel}</p>
          </div>
          <span className={`flex-shrink-0 inline-flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full ${tone.countChip}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
            {totalShiftsThisWeek} shift{totalShiftsThisWeek === 1 ? '' : 's'}
          </span>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-[110px_repeat(7,1fr)] border-b border-gray-100 bg-gray-50/40">
          <div className="px-3 py-2.5 border-r border-gray-100">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-400">Block</p>
          </div>
          {weekDays.map((day, i) => {
            const isToday = sameDay(day, new Date())
            return (
              <div
                key={i}
                className={`px-1 py-2.5 text-center border-l border-gray-100 ${isToday ? tone.soft : ''}`}
              >
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">{DAYS[i]}</p>
                <p className={`text-sm font-semibold tabular-nums ${isToday ? tone.todayText : 'text-gray-900'}`}>{day.getDate()}</p>
              </div>
            )
          })}
        </div>

        {/* Shift block rows */}
        {houseSections.length === 0 && (
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-gray-700">No shift blocks defined yet</p>
            <p className="mx-auto mt-1.5 max-w-sm text-xs text-gray-500 leading-relaxed">
              {isUnified
                ? 'Define a few starter blocks to begin scheduling — Opening, Mid, Closing.'
                : 'Define starter blocks for this house to begin scheduling — they show up as drop targets here.'}
            </p>
          </div>
        )}

        {(() => {
          // ----------------------------------------------------------------
          // Single shift-block row — the shared rendering primitive every
          // branch (by_team / by_role, FOH / BOH / unified) flows through.
          // Polish here lands everywhere; branching above only decides how
          // these rows are grouped.
          // ----------------------------------------------------------------
          const renderSectionRow = (section: Section) => (
            <div key={section.id} className="grid grid-cols-[110px_repeat(7,1fr)] border-b border-gray-100 last:border-b-0">
              {/* Lane label — clickable to open the edit-block drawer.
                  Affordance is hover-only by design: at rest the
                  cell is clean and uncluttered. On hover the cell
                  picks up a clearly-interactive treatment — a
                  visibly stronger bg fill plus a 1px inset ring
                  for a crisp pressed-pill feel — so the action
                  reads as obviously editable the moment the manager
                  arrives, while the resting state stays calm. */}
              <button
                type="button"
                onClick={() => setDrawer({
                  mode: 'edit-block',
                  section,
                  shiftCount: shiftsBySection.get(section.id) ?? 0,
                })}
                className="text-left px-3 py-3 flex flex-col justify-center border-r border-gray-100 cursor-pointer transition-all hover:bg-gray-100 hover:ring-1 hover:ring-inset hover:ring-gray-400"
                aria-label={`Edit block ${section.name}`}
              >
                <p className="text-xs font-semibold text-gray-900 leading-tight truncate">{section.name}</p>
                <p className="text-[10px] text-gray-400 mt-0.5 tabular-nums">
                  {hL(section.defaultStartHour)}–{hL(section.defaultEndHour)}
                </p>
              </button>
              {weekDays.map((day, dayIdx) => {
                const cellKey = `${section.id}-${dayIdx}`
                const cellShifts = weekShifts.filter((s) => s.sectionId === section.id && sameDay(new Date(s.startTime), day))
                const isOver = dragOver === cellKey
                return (
                  <div
                    key={dayIdx}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(cellKey) }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={(e) => handleDrop(e, dayIdx, section.id)}
                    // Strict vertical stack so cards always sit on a
                    // shared baseline: items-stretch makes every card
                    // fill the cell width, justify-start pins the
                    // first card to the top, gap-1 owns the spacing
                    // (no per-card mb-* drift). min-h keeps empty
                    // cells visually consistent with one-card cells.
                    className={`min-h-[56px] p-1.5 flex flex-col items-stretch justify-start gap-1 border-l border-gray-100 transition-colors ${
                      isOver ? tone.softerHover : ''
                    }`}
                  >
                    {cellShifts.map((shift) => (
                      <button
                        key={shift.id}
                        type="button"
                        onClick={() => setDrawer({ mode: 'edit', shift })}
                        // Strict, deterministic card layout so cells
                        // in the same row line up pixel-for-pixel:
                        //   • h-[44px] — fixed height (not min-h),
                        //     so every card occupies exactly the
                        //     same footprint regardless of content.
                        //   • flex flex-col justify-center — content
                        //     centers within that footprint.
                        //   • gap-[2px] — controlled spacing between
                        //     the two lines, no child margins.
                        //   • pl-3 reserves room for the 2px stripe.
                        className="w-full text-left rounded-md h-[44px] flex flex-col justify-center gap-[2px] bg-white border border-gray-200/90 pl-3 pr-2 py-0 cursor-pointer transition-all hover:border-gray-300 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04)] relative overflow-hidden"
                      >
                        {/* Identity accent bar — a 2px stripe on the
                            left edge carries the FOH/BOH cue without
                            flooding the card with color. */}
                        <span className={`absolute left-0 top-0 bottom-0 w-[2px] ${tone.accentBar}`} aria-hidden />
                        {/* <span> with block + explicit pixel
                            line-height so the text row is exactly
                            14px tall on every render — no inherited
                            leading variance to shift centering. */}
                        <span className="block text-[12px] font-semibold text-gray-900 leading-[14px] truncate">
                          {shift.employeeName}
                        </span>
                        {/* The role+time row is also pinned to a
                            12px line-height. min-w-0 lets role
                            truncate inside the flex; flex-shrink-0
                            on the separator and time keeps them at
                            full width when role gets long. */}
                        <span className="flex items-center gap-1.5 leading-[12px] min-w-0">
                          <span className={`text-[10px] font-medium truncate ${tone.text}`}>{shift.role}</span>
                          <span className="text-gray-300 text-[10px] flex-shrink-0">·</span>
                          <span className="text-[10px] text-gray-500 tabular-nums whitespace-nowrap flex-shrink-0">
                            {fmt(shift.startTime)}–{fmt(shift.endTime)}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          )

          // Team-based: flat list of shift-block rows, no role grouping.
          if (!isByRole) return houseSections.map(renderSectionRow)

          // Role-based: group rows by their role so the manager sees
          //   Manager
          //     Opening
          //     Closing
          //   Cashier
          //     Opening
          //     Closing
          // The group header is an eyebrow band, restrained to match
          // the section/eyebrow language from Finance.
          const groups = new Map<string, Section[]>()
          for (const s of houseSections) {
            const key = s.role || 'General'
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key)!.push(s)
          }
          return [...groups.entries()].map(([role, group]) => (
            <div key={role}>
              <div className="bg-gray-50/80 border-b border-gray-100 px-3 py-2 flex items-center gap-2">
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                <p className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${tone.text}`}>{role}</p>
                <p className="text-[10px] text-gray-400">·</p>
                <p className="text-[10px] text-gray-500">{group.length} block{group.length === 1 ? '' : 's'}</p>
              </div>
              {group.map(renderSectionRow)}
            </div>
          ))
        })()}

        {/* ============================================================ */}
        {/* CUSTOM LANE — surfaces shifts whose section_id is NULL.       */}
        {/* These are one-offs created via "+ Shift", or shifts that      */}
        {/* used to live under a block the manager has since deleted     */}
        {/* (ON DELETE SET NULL preserves them). Renders only when        */}
        {/* there's something to show, so it never adds visual noise to  */}
        {/* a schedule that's strictly using default blocks.             */}
        {/* Branch behavior: customShifts is already filtered by house   */}
        {/* via the role-bucket lookup, so FOH/BOH/unified all see the   */}
        {/* right subset.                                                 */}
        {/* ============================================================ */}
        {customShifts.length > 0 && (
          <div className="grid grid-cols-[110px_repeat(7,1fr)] border-t border-gray-100">
            <div className="px-3 py-3 flex flex-col justify-center border-r border-gray-100 bg-gray-50/40">
              <p className="text-xs font-semibold text-gray-700 leading-tight">Custom</p>
              <p className="text-[10px] text-gray-400 mt-0.5">One-off shifts</p>
            </div>
            {weekDays.map((day, dayIdx) => {
              const cellShifts = customShifts.filter((s) => sameDay(new Date(s.startTime), day))
              return (
                <div
                  key={dayIdx}
                  className="min-h-[56px] p-1.5 flex flex-col items-stretch justify-start gap-1 border-l border-gray-100"
                >
                  {cellShifts.map((shift) => (
                    <button
                      key={shift.id}
                      type="button"
                      onClick={() => setDrawer({ mode: 'edit', shift })}
                      className="w-full text-left rounded-md h-[44px] flex flex-col justify-center gap-[2px] bg-white border border-gray-200/90 pl-3 pr-2 py-0 cursor-pointer transition-all hover:border-gray-300 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04)] relative overflow-hidden"
                    >
                      <span className={`absolute left-0 top-0 bottom-0 w-[2px] ${tone.accentBar}`} aria-hidden />
                      <span className="block text-[12px] font-semibold text-gray-900 leading-[14px] truncate">
                        {shift.employeeName}
                      </span>
                      <span className="flex items-center gap-1.5 leading-[12px] min-w-0">
                        <span className={`text-[10px] font-medium truncate ${tone.text}`}>{shift.role}</span>
                        <span className="text-gray-300 text-[10px] flex-shrink-0">·</span>
                        <span className="text-[10px] text-gray-500 tabular-nums whitespace-nowrap flex-shrink-0">
                          {fmt(shift.startTime)}–{fmt(shift.endTime)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ================================================================ */}
      {/* 4. STAFF BENCH — assignment-zone card. Same shell as the board    */}
      {/*    so the eye reads board + bench as one operational unit.       */}
      {/*    Identity color stays restrained: a small dot in the header,   */}
      {/*    a 2px accent bar on each chip — never a full color wash.      */}
      {/* ================================================================ */}
      <section className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
        <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">
              {isUnified ? 'Bench' : (activeHouse === 'foh' ? 'Bench · Front of House' : 'Bench · Back of House')}
            </p>
            <span className="text-gray-300">·</span>
            <p className="text-xs text-gray-500">Drag onto a shift block to assign</p>
          </div>
          <span className={`flex-shrink-0 inline-flex items-center text-[10px] font-semibold px-2.5 py-1 rounded-full ${tone.countChip}`}>
            {houseEmployees.length} available
          </span>
        </div>

        <div className="p-5">
          {houseEmployees.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/40 px-4 py-8 text-center">
              <p className="text-sm font-medium text-gray-700">
                No {isUnified ? 'team members' : (activeHouse === 'foh' ? 'FOH team members' : 'BOH team members')} yet
              </p>
              <p className="mx-auto mt-1.5 max-w-sm text-xs text-gray-500 leading-relaxed">
                Add staff to the bench, then drag them onto the board to schedule shifts.
              </p>
              <button
                type="button"
                onClick={() => setDrawer({ mode: 'add-employee', house: activeHouse })}
                className={`mt-3 inline-flex items-center text-xs font-semibold ${tone.text} hover:underline`}
              >
                + Add your first {isUnified ? 'team member' : (activeHouse === 'foh' ? 'FOH team member' : 'BOH team member')}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {houseEmployees.map((emp) => {
                const weekHours = hoursByEmployee.get(emp.id) ?? 0
                const tier = hoursTier(weekHours)
                const hoursLabel = formatHours(weekHours)
                return (
                  <BenchCard
                    key={emp.id}
                    employee={emp}
                    hoursLabel={hoursLabel}
                    weekHours={weekHours}
                    tier={tier}
                    toneAccentBar={tone.accentBar}
                    toneText={tone.text}
                    onClick={() => setDrawer({
                      mode: 'edit-employee',
                      employee: emp,
                      house: activeHouse,
                    })}
                  />
                )
              })}
            </div>
          )}
        </div>
      </section>

      {/* ---- DRAWERS ----
          Every page-level workflow funnels into one of these drawers.
          The drawer state union at the top of StaffingClient keeps
          this list exhaustive — adding a new flow is a one-line
          render branch here. */}
      {drawer?.mode === 'edit' && (
        <EditDrawer shift={drawer.shift} employees={locEmployees} sections={sections} onClose={() => setDrawer(null)} />
      )}
      {drawer?.mode === 'add-employee' && (
        <AddEmployeeDrawer locationId={locationId} house={drawer.house} isUnified={isUnified}
          roles={isUnified ? fohRoles : (drawer.house === 'foh' ? fohRoles : bohRoles)}
          onClose={() => setDrawer(null)} />
      )}
      {drawer?.mode === 'edit-employee' && (
        <EditEmployeeDrawer
          employee={drawer.employee}
          isUnified={isUnified}
          house={drawer.house}
          roles={isUnified ? fohRoles : (drawer.house === 'foh' ? fohRoles : bohRoles)}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer?.mode === 'add-block' && (
        <AddBlockDrawer
          isUnified={isUnified}
          defaultArea={drawer.defaultArea}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer?.mode === 'edit-block' && (
        <EditBlockDrawer
          section={drawer.section}
          shiftCount={drawer.shiftCount}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer?.mode === 'add-shift' && (
        <AddCustomShiftDrawer
          locationId={locationId}
          employees={locEmployees}
          sections={houseSections}
          defaultDay={drawer.defaultDay}
          defaultSectionId={drawer.defaultSectionId ?? null}
          defaultStartHour={drawer.defaultStartHour ?? null}
          defaultEndHour={drawer.defaultEndHour ?? null}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  )
}

// ----------------------------------------------------------------
function EditDrawer({ shift, employees, sections, onClose }: {
  shift: Shift; employees: Employee[]; sections: Section[]; onClose: () => void
}) {
  const [eState, eAction, ePending] = useActionState(updateShift, null)
  const [dState, dAction, dPending] = useActionState(deleteShift, null)

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-sm bg-white border-l border-gray-200 shadow-xl z-50 overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-gray-900">Edit shift</h2>
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <form action={eAction} className="space-y-4">
            <input type="hidden" name="shift_id" value={shift.id} />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Employee</label>
              <select name="employee_id" required defaultValue={shift.employeeId}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {employees.map((e) => <option key={e.id} value={e.id}>{e.name} · {e.role}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start</label>
              <input name="start_time" type="datetime-local" required defaultValue={toLocal(new Date(shift.startTime))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End</label>
              <input name="end_time" type="datetime-local" required defaultValue={toLocal(new Date(shift.endTime))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
              <input name="notes" type="text" defaultValue={shift.notes ?? ''}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            {eState?.error && <p className="text-sm text-red-600">{eState.error}</p>}
            <button type="submit" disabled={ePending}
              className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-60">
              {ePending ? 'Saving…' : 'Save changes'}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-gray-100">
            <form action={dAction}><input type="hidden" name="shift_id" value={shift.id} />
              <button type="submit" disabled={dPending} className="text-xs text-red-500 hover:text-red-600 disabled:opacity-60">
                {dPending ? 'Removing…' : 'Remove this shift'}
              </button>
            </form>
            {dState?.error && <p className="text-xs text-red-500 mt-2">{dState.error}</p>}
          </div>
        </div>
      </div>
    </>
  )
}

// ----------------------------------------------------------------
// AddEmployeeDrawer
//
// Uses the shared DrawerShell + Field pattern. Two notable
// behaviors:
//
//   1. Empty-role state — when the active house has zero roles
//      defined, the Role field renders as an inline amber callout
//      with the role-add UI built in. The submit-employee button
//      stays disabled until a role exists. No more dangling
//      "Missing a role?" link below the form.
//
//   2. Add-another-role mid-flow — when roles exist, a small
//      "+ Add a new role" affordance under the select reveals the
//      same role-add UI inline. The role <form> is rendered as a
//      sibling of the create-employee <form> (HTML disallows
//      nesting), and bound via the `form` attribute on its inputs
//      and submit button.
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// BenchCard — single bench employee chip.
//
// Drag and click both work:
//   • drag: native HTML5 dragstart fires when the user holds and
//     moves the mouse. Browsers don't fire `click` on a successful
//     drag, so the two interactions don't fight. We still gate the
//     click behind a dragging ref to suppress the rare "jiggle drag
//     then release without movement" edge case where some browsers
//     fire click after dragend.
//   • click: opens the quick-manage drawer for this employee.
//
// Rendering is unchanged from the previous inline version — just
// extracted so the hover / drag / click logic lives in one place
// and so every staffing branch consumes the same component.
// ----------------------------------------------------------------
function BenchCard({
  employee, hoursLabel, weekHours, tier, toneAccentBar, toneText, onClick,
}: {
  employee: Employee
  hoursLabel: string
  weekHours: number
  tier: HoursTier
  toneAccentBar: string
  toneText: string
  onClick: () => void
}) {
  const draggingRef = useRef(false)

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', employee.id)
        e.dataTransfer.effectAllowed = 'copy'
        draggingRef.current = true
      }}
      onDragEnd={() => {
        // Reset on next tick so a click event triggered after a
        // drag-release-without-movement is suppressed.
        setTimeout(() => { draggingRef.current = false }, 0)
      }}
      onClick={() => {
        if (draggingRef.current) return
        onClick()
      }}
      title={`${employee.name} (${employee.role}) · ${hoursLabel} this week — drag onto a shift, or click to manage`}
      className="group relative min-w-[170px] rounded-lg border border-gray-200/90 bg-white pl-3 pr-3 py-2 cursor-grab active:cursor-grabbing select-none transition-all hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-[0_2px_4px_rgba(15,23,42,0.05)] overflow-hidden"
    >
      {/* Same 2px identity bar pattern as assigned shift cards. */}
      <span className={`absolute left-0 top-0 bottom-0 w-[2px] ${toneAccentBar}`} aria-hidden />
      {/* Top row: name on the left, weekly-hours indicator on the
          right. The HoursIndicator carries its own tier styling so
          high-hour staff stand out without cluttering the card. */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-gray-900 leading-tight truncate">{employee.name}</p>
        <HoursIndicator hours={weekHours} tier={tier} />
      </div>
      <p className={`text-[10px] mt-0.5 truncate ${toneText}`}>{employee.role}</p>
    </div>
  )
}

// ----------------------------------------------------------------
// EditEmployeeDrawer — quick-manage drawer opened from a bench
// click. Uses the same shared shell + Field rhythm as the other
// staffing drawers so it feels like one system.
//
// Surface: edit name, change role (constrained to the active
// house's role list), edit hourly rate. Archive lives in the
// footer as a destructive secondary action — soft delete only;
// historical shifts stay intact.
// ----------------------------------------------------------------
function EditEmployeeDrawer({ employee, isUnified, house, roles, onClose }: {
  employee: Employee
  isUnified: boolean
  house: 'foh' | 'boh'
  roles: string[]
  onClose: () => void
}) {
  const [state, action, pending] = useActionState(updateEmployee, null)
  const [archState, archAction, archPending] = useActionState(archiveEmployee, null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  useAutoCloseOnSuccess(pending, state, onClose)
  useAutoCloseOnSuccess(archPending, archState, onClose)

  const eyebrow = isUnified ? 'Team' : (house === 'foh' ? 'Front of House' : 'Back of House')

  // The role select needs to include the employee's CURRENT role
  // even if it's no longer in the active house's role list (e.g.
  // the manager removed that role from staffing config). Otherwise
  // the dropdown would silently change the role on save.
  const roleOptions = roles.includes(employee.role)
    ? roles
    : [employee.role, ...roles]

  // Hourly rate isn't sent back from the page (Employee type omits
  // it for size), so we leave the field empty and treat empty-on-
  // submit as "no change" via the optional handling on the action.
  // To make the UX honest, the placeholder hints at the unknown.

  return (
    <DrawerShell
      eyebrow={eyebrow}
      title={`Manage ${employee.name}`}
      subtitle="Edit details, change role, or archive."
      onClose={onClose}
    >
      <form action={action} className="flex-1 flex flex-col min-h-0">
        <input type="hidden" name="employee_id" value={employee.id} />
        <DrawerBody>
          <Field label="Name" htmlFor="ee-name">
            <input
              id="ee-name"
              name="name"
              type="text"
              required
              defaultValue={employee.name}
              className={fieldInputClass}
            />
          </Field>

          <Field label="Role" htmlFor="ee-role">
            {roles.length === 0 ? (
              <p className="text-xs text-amber-700">
                No roles defined for this house yet. Add one from Add employee first.
              </p>
            ) : (
              <select
                id="ee-role"
                name="role"
                required
                defaultValue={employee.role}
                className={fieldInputClass}
              >
                {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            )}
          </Field>

          <Field
            label="Hourly rate"
            htmlFor="ee-rate"
            optional
            hint="Leave blank to clear. Drives scheduled-labor estimates in Finance."
          >
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
              <input
                id="ee-rate"
                name="hourly_rate"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                className={`${fieldInputClass} pl-7`}
              />
            </div>
          </Field>

          {/* Inline archive confirm — same pattern the EditBlock
              drawer uses, lives in the body so the consequence has
              room to breathe. */}
          {confirmArchive && (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50/60 p-3">
              <p className="text-xs font-semibold text-red-900">Archive {employee.name}?</p>
              <p className="mt-0.5 text-[11px] text-red-700/90 leading-relaxed">
                They&apos;ll be removed from the bench. Historical shifts stay intact and
                can&apos;t be edited until the employee is restored.
              </p>
              {/* Sibling form keeps us out of nested-form territory;
                  the confirm button binds via `form="..."`. */}
              <form id="staffing-archive-employee" action={archAction}>
                <input type="hidden" name="employee_id" value={employee.id} />
              </form>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  form="staffing-archive-employee"
                  type="submit"
                  disabled={archPending}
                  className="h-9 rounded-md border border-red-300 bg-white px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60 transition-colors"
                >
                  {archPending ? 'Archiving…' : 'Confirm archive'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmArchive(false)}
                  className="text-[11px] text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
              {archState?.error && (
                <p className="mt-1.5 text-[11px] text-red-700">{archState.error}</p>
              )}
            </div>
          )}

          {state?.error && (
            <p className="text-xs text-red-600">{state.error}</p>
          )}
        </DrawerBody>

        <DrawerFooter>
          <div className="flex items-center justify-between gap-3">
            {!confirmArchive ? (
              <button
                type="button"
                onClick={() => setConfirmArchive(true)}
                className="text-xs font-medium text-red-600 hover:text-red-700"
              >
                Archive employee
              </button>
            ) : (
              <span className="text-[11px] text-gray-400">Confirm above</span>
            )}
            <button
              type="submit"
              disabled={pending}
              className="h-10 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {pending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </DrawerFooter>
      </form>
    </DrawerShell>
  )
}

function AddEmployeeDrawer({ locationId, house, isUnified, roles, onClose }: {
  locationId: string; house: 'foh' | 'boh'; isUnified: boolean; roles: string[]; onClose: () => void
}) {
  const [state, action, pending] = useActionState(createEmployee, null)
  const [roleState, roleAction, rolePending] = useActionState(addStaffingRole, null)
  const [showAddRole, setShowAddRole] = useState(false)
  useAutoCloseOnSuccess(pending, state, onClose)

  const houseLabel = isUnified ? 'your team' : (house === 'foh' ? 'Front of House' : 'Back of House')
  const eyebrow = isUnified ? 'Team' : (house === 'foh' ? 'Front of House' : 'Back of House')
  const hasRoles = roles.length > 0
  // Re-collapse the inline add-role affordance after a successful
  // role add so the manager lands back on the populated select.
  useEffect(() => {
    if (!rolePending && hasRoles && showAddRole) {
      const errored = !!roleState && 'error' in roleState && !!roleState.error
      if (!errored) setShowAddRole(false)
    }
  }, [rolePending, roleState, hasRoles, showAddRole])

  // Embedded role-add form. Lives as a sibling to the create-employee
  // form because HTML forbids nested <form> elements; the role
  // inputs/button below bind to it via the `form` attribute.
  const roleFormId = 'staffing-add-role-form'

  return (
    <DrawerShell
      eyebrow={eyebrow}
      title="Add employee"
      subtitle="Name, role, and an hourly rate if you have one."
      onClose={onClose}
    >
      {/* Sibling form for adding roles — rendered hidden so it has a
          DOM presence the bound inputs can submit to. */}
      <form id={roleFormId} action={roleAction} className="hidden" />

      <form action={action} className="flex-1 flex flex-col min-h-0">
        <input type="hidden" name="primary_location_id" value={locationId} />
        <DrawerBody>
          <Field label="Name" htmlFor="ae-name">
            <input
              id="ae-name"
              name="name"
              type="text"
              required
              autoFocus
              placeholder="Jane Smith"
              className={fieldInputClass}
            />
          </Field>

          <Field label="Role" htmlFor={hasRoles ? 'ae-role' : 'ae-new-role'}>
            {!hasRoles ? (
              // Inline empty-role callout — guided, not broken. The
              // role <input> + submit button bind to the sibling
              // role form via `form="..."`.
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                <p className="text-xs font-semibold text-amber-900">
                  No roles for {houseLabel} yet
                </p>
                <p className="mt-0.5 text-[11px] text-amber-700/90 leading-relaxed">
                  Add one to continue. New roles appear here right away.
                </p>
                <div className="mt-2.5 flex gap-2">
                  <input
                    id="ae-new-role"
                    form={roleFormId}
                    name="role"
                    type="text"
                    required
                    placeholder="e.g. Server, Cook"
                    className="flex-1 h-9 rounded-md border border-amber-300 bg-white px-2.5 text-xs text-gray-900 placeholder:text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
                  />
                  <input form={roleFormId} type="hidden" name="area" value={house} />
                  <button
                    form={roleFormId}
                    type="submit"
                    disabled={rolePending}
                    className="h-9 rounded-md bg-gray-900 hover:bg-gray-800 px-3 text-xs font-semibold text-white disabled:opacity-60 transition-colors"
                  >
                    {rolePending ? 'Adding…' : 'Add role'}
                  </button>
                </div>
                {roleState?.error && (
                  <p className="mt-2 text-[11px] text-red-700">{roleState.error}</p>
                )}
              </div>
            ) : (
              <>
                <select
                  id="ae-role"
                  name="role"
                  required
                  defaultValue=""
                  className={fieldInputClass}
                >
                  <option value="" disabled>Select…</option>
                  {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                {!showAddRole ? (
                  <button
                    type="button"
                    onClick={() => setShowAddRole(true)}
                    className="mt-1.5 text-[11px] text-gray-500 hover:text-gray-700"
                  >
                    + Add a new role
                  </button>
                ) : (
                  <div className="mt-2 rounded-md border border-gray-200 bg-gray-50/60 p-2.5">
                    <div className="flex gap-2">
                      <input
                        form={roleFormId}
                        name="role"
                        type="text"
                        required
                        autoFocus
                        placeholder="e.g. Sommelier"
                        className="flex-1 h-9 rounded-md border border-gray-200 bg-white px-2.5 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
                      />
                      <input form={roleFormId} type="hidden" name="area" value={house} />
                      <button
                        form={roleFormId}
                        type="submit"
                        disabled={rolePending}
                        className="h-9 rounded-md bg-gray-900 hover:bg-gray-800 px-3 text-xs font-semibold text-white disabled:opacity-60 transition-colors"
                      >
                        {rolePending ? 'Adding…' : 'Add'}
                      </button>
                    </div>
                    {roleState?.error && (
                      <p className="mt-1.5 text-[11px] text-red-600">{roleState.error}</p>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowAddRole(false)}
                      className="mt-1 text-[10px] text-gray-400 hover:text-gray-600"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </>
            )}
          </Field>

          <Field label="Hourly rate" htmlFor="ae-rate" optional>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
              <input
                id="ae-rate"
                name="hourly_rate"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                className={`${fieldInputClass} pl-7`}
              />
            </div>
          </Field>

          {state?.error && (
            <p className="text-xs text-red-600">{state.error}</p>
          )}
        </DrawerBody>

        <DrawerFooter>
          <button
            type="submit"
            disabled={pending || !hasRoles}
            className="h-10 w-full rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {pending ? 'Adding…' : 'Add employee'}
          </button>
        </DrawerFooter>
      </form>
    </DrawerShell>
  )
}

// ----------------------------------------------------------------
// Drawer shell — shared chrome used by every workflow drawer on
// this page. Locked product pattern:
//   • small eyebrow label (context: which house, which surface)
//   • strong title (the action)
//   • one short subtitle line (operational, not how-to)
//   • flex-column body so consumers can push a sticky footer
//
// Keeps backdrop, side-sheet, header, and close button consistent
// so all four drawers feel like one coherent system.
// ----------------------------------------------------------------
function DrawerShell({ eyebrow, title, subtitle, onClose, children }: {
  eyebrow?: string
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <aside
        className="fixed right-0 top-0 bottom-0 w-full max-w-sm bg-white border-l border-gray-200 shadow-xl z-50 flex flex-col"
        aria-label={title}
      >
        <header className="flex-shrink-0 border-b border-gray-100 px-6 py-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {eyebrow && (
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">
                {eyebrow}
              </p>
            )}
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-gray-900 leading-tight">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-1 text-xs text-gray-500 leading-relaxed">
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 text-gray-400 hover:text-gray-600 p-1 -mt-0.5"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>
        {children}
      </aside>
    </>
  )
}

// ----------------------------------------------------------------
// Drawer body primitives — used inside every drawer to keep
// spacing, label tone, and input chrome identical across the four
// staffing flows.
//
// Pattern:
//   <DrawerShell ...>
//     <DrawerBody>
//       <Field label="...">[ input ]</Field>
//       ...
//     </DrawerBody>
//     <DrawerFooter>[ primary action ]</DrawerFooter>
//   </DrawerShell>
//
// The form wrapping these (when needed) sits between DrawerShell
// and DrawerBody, with `flex-1 flex flex-col min-h-0` so its body
// scrolls and its footer stays anchored at the bottom of the
// drawer.
// ----------------------------------------------------------------
function DrawerBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3.5">
      {children}
    </div>
  )
}

function DrawerFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-shrink-0 border-t border-gray-100 px-6 py-3.5 bg-white">
      {children}
    </div>
  )
}

function Field({ label, htmlFor, optional, hint, children }: {
  label: string
  htmlFor?: string
  optional?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-gray-700"
      >
        {label}
        {optional && <span className="text-gray-400 font-normal">· optional</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[10.5px] text-gray-400 leading-relaxed">{hint}</p>}
    </div>
  )
}

// Standard input/select chrome — h-10, neutral border, 40%-alpha
// focus ring matching Finance's form rhythm. Compose with extra
// classes via `extra` for amount-prefix or compact variants.
const fieldInputClass =
  'h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition'

// useAutoCloseOnSuccess — drawer convention used throughout this
// page. createX server actions return null on success and { error }
// on failure; useActionState gives us no explicit "ok" event, so
// we detect the pending → done transition and close iff state lacks
// an error. Without this every drawer needs the same boilerplate.
function useAutoCloseOnSuccess(
  pending: boolean,
  state: { error: string } | null,
  onClose: () => void,
) {
  const wasPendingRef = useRef(false)
  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      const errored = !!state && 'error' in state && !!state.error
      if (!errored) onClose()
    }
    wasPendingRef.current = pending
  }, [pending, state, onClose])
}

// ----------------------------------------------------------------
// AddBlockDrawer — create a new shift block (lane row).
//
// In split mode, the manager picks the area (FOH/BOH); the
// dropdown defaults to whatever house was active when "+ Block"
// was clicked. In unified mode the area is locked to 'foh' (the
// single bucket the staffing client treats as the unified team).
// Times are 0–24 hour integers — same as the schema columns.
// ----------------------------------------------------------------
function AddBlockDrawer({ isUnified, defaultArea, onClose }: {
  isUnified: boolean; defaultArea: 'foh' | 'boh'; onClose: () => void
}) {
  const [state, action, pending] = useActionState(createShiftSection, null)
  useAutoCloseOnSuccess(pending, state, onClose)

  return (
    <DrawerShell
      eyebrow="Block"
      title="Add shift block"
      subtitle="A reusable lane on the schedule. Drop staff onto it any day."
      onClose={onClose}
    >
      <form action={action} className="flex-1 flex flex-col min-h-0">
        <DrawerBody>
          {/* Area is hidden + locked in unified mode. In split mode
              it renders as an explicit field so the manager knows
              which house the new block belongs to. */}
          {isUnified ? (
            <input type="hidden" name="area" value="foh" />
          ) : (
            <Field label="House" htmlFor="ab-area">
              <select
                id="ab-area"
                name="area"
                required
                defaultValue={defaultArea}
                className={fieldInputClass}
              >
                <option value="foh">Front of House</option>
                <option value="boh">Back of House</option>
              </select>
            </Field>
          )}

          <Field label="Block name" htmlFor="ab-name">
            <input
              id="ab-name"
              name="name"
              type="text"
              required
              autoFocus
              placeholder="e.g. Brunch, Late, Event"
              className={fieldInputClass}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Start hour" htmlFor="ab-start">
              <input
                id="ab-start"
                name="default_start_hour"
                type="number"
                min={0}
                max={24}
                step={1}
                required
                defaultValue={9}
                className={`${fieldInputClass} tabular-nums`}
              />
            </Field>
            <Field label="End hour" htmlFor="ab-end">
              <input
                id="ab-end"
                name="default_end_hour"
                type="number"
                min={0}
                max={24}
                step={1}
                required
                defaultValue={17}
                className={`${fieldInputClass} tabular-nums`}
              />
            </Field>
          </div>
          <p className="text-[10.5px] text-gray-400 leading-relaxed">
            24-hour format. These pre-fill drag-drop assignments — times can be tweaked per shift.
          </p>

          {state?.error && (
            <p className="text-xs text-red-600">{state.error}</p>
          )}
        </DrawerBody>

        <DrawerFooter>
          <button
            type="submit"
            disabled={pending}
            className="h-10 w-full rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {pending ? 'Creating…' : 'Create block'}
          </button>
        </DrawerFooter>
      </form>
    </DrawerShell>
  )
}

// ----------------------------------------------------------------
// EditBlockDrawer — rename / change times / delete a block.
//
// Footer carries both actions: primary "Save changes" on the right,
// secondary "Delete" link on the left. Delete reveals an inline
// confirm row that surfaces the shift count under the block, since
// deletion cascades shifts to NULL section_id (they reappear on
// the Custom lane, not lost) — making the consequence visible
// without needing a heavier modal.
// ----------------------------------------------------------------
function EditBlockDrawer({ section, shiftCount, onClose }: {
  section: Section; shiftCount: number; onClose: () => void
}) {
  const [state, action, pending] = useActionState(updateShiftSection, null)
  const [delState, delAction, delPending] = useActionState(deleteShiftSection, null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useAutoCloseOnSuccess(pending, state, onClose)
  useAutoCloseOnSuccess(delPending, delState, onClose)

  const areaLabel = section.area === 'foh' ? 'Front of House' : 'Back of House'

  return (
    <DrawerShell
      eyebrow={`Block · ${areaLabel}`}
      title={`Edit ${section.name}`}
      subtitle="Rename, retime, or delete this block."
      onClose={onClose}
    >
      <form action={action} className="flex-1 flex flex-col min-h-0">
        <input type="hidden" name="section_id" value={section.id} />
        <DrawerBody>
          <Field label="Block name" htmlFor="eb-name">
            <input
              id="eb-name"
              name="name"
              type="text"
              required
              defaultValue={section.name}
              className={fieldInputClass}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Start hour" htmlFor="eb-start">
              <input
                id="eb-start"
                name="default_start_hour"
                type="number"
                min={0}
                max={24}
                step={1}
                required
                defaultValue={section.defaultStartHour}
                className={`${fieldInputClass} tabular-nums`}
              />
            </Field>
            <Field label="End hour" htmlFor="eb-end">
              <input
                id="eb-end"
                name="default_end_hour"
                type="number"
                min={0}
                max={24}
                step={1}
                required
                defaultValue={section.defaultEndHour}
                className={`${fieldInputClass} tabular-nums`}
              />
            </Field>
          </div>

          {/* Inline delete confirmation lives in the body, not the
              footer, so the consequence text has space to breathe. */}
          {confirmDelete && (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50/60 p-3">
              <p className="text-xs font-semibold text-red-900">
                {shiftCount === 0
                  ? 'Delete this block?'
                  : `Move ${shiftCount} shift${shiftCount === 1 ? '' : 's'} to the Custom lane?`}
              </p>
              <p className="mt-0.5 text-[11px] text-red-700/90 leading-relaxed">
                {shiftCount === 0
                  ? 'No shifts are using this block.'
                  : `Shifts won't be deleted — they'll surface on the Custom lane.`}
              </p>
              {/* Sibling form for the delete action; submit button
                  binds to it via `form="..."` to keep us out of
                  nested-form territory. */}
              <form id="staffing-delete-block" action={delAction}>
                <input type="hidden" name="section_id" value={section.id} />
              </form>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  form="staffing-delete-block"
                  type="submit"
                  disabled={delPending}
                  className="h-9 rounded-md border border-red-300 bg-white px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60 transition-colors"
                >
                  {delPending ? 'Deleting…' : 'Confirm delete'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-[11px] text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
              {delState?.error && (
                <p className="mt-1.5 text-[11px] text-red-700">{delState.error}</p>
              )}
            </div>
          )}

          {state?.error && (
            <p className="text-xs text-red-600">{state.error}</p>
          )}
        </DrawerBody>

        <DrawerFooter>
          <div className="flex items-center justify-between gap-3">
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-xs font-medium text-red-600 hover:text-red-700"
              >
                Delete block
              </button>
            ) : (
              <span className="text-[11px] text-gray-400">Confirm above</span>
            )}
            <button
              type="submit"
              disabled={pending}
              className="h-10 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {pending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </DrawerFooter>
      </form>
    </DrawerShell>
  )
}

// ----------------------------------------------------------------
// AddCustomShiftDrawer — create a one-off shift not tied to the
// regular block grid.
//
// Used when reality doesn't fit a default block: an extra server
// for one Friday, a special prep shift, an event coverage block.
// section_id is optional — if the manager picks a block, the new
// shift slots into that lane on the board; otherwise it shows up
// on the Custom lane.
//
// Contextual prefills:
//   • defaultDay           — preselects the date (e.g. "this Friday")
//   • defaultSectionId     — preselects a block, which auto-fills
//                            start/end times from that block
//   • defaultStartHour /
//     defaultEndHour       — explicit time prefills, overriding the
//                            block-derived defaults
//
// The drawer composes start_time / end_time from separate date +
// time inputs into hidden datetime-local fields the server reads.
// ----------------------------------------------------------------
function AddCustomShiftDrawer({
  locationId, employees, sections,
  defaultDay, defaultSectionId, defaultStartHour, defaultEndHour,
  onClose,
}: {
  locationId: string
  employees: Employee[]
  sections: Section[]
  defaultDay: string | null
  defaultSectionId?: string | null
  defaultStartHour?: number | null
  defaultEndHour?: number | null
  onClose: () => void
}) {
  const [state, action, pending] = useActionState(createShift, null)
  useAutoCloseOnSuccess(pending, state, onClose)

  // Resolve the initial section. If the caller passed an id, use
  // it; otherwise unbind ('' = Custom lane). Used both for the
  // dropdown defaultValue and to seed the time inputs below.
  const initialSection = useMemo(() => {
    if (!defaultSectionId) return null
    return sections.find((s) => s.id === defaultSectionId) ?? null
  }, [defaultSectionId, sections])
  const [sectionId, setSectionId] = useState(initialSection?.id ?? '')

  // Date input (YYYY-MM-DD). Defaults to today unless the caller
  // passed a specific day (e.g. clicked an empty day cell).
  const today = new Date()
  const initialDate = defaultDay ?? toLocal(today).split('T')[0]
  const [date, setDate] = useState(initialDate)

  // Time inputs (HH:MM). Source priority:
  //   1. explicit defaultStartHour/defaultEndHour from the caller
  //   2. block defaults if a section was preselected
  //   3. 09:00–17:00 fallback
  const hhmm = (h: number | null | undefined, fallback: string) =>
    typeof h === 'number' && h >= 0 && h <= 24
      ? `${String(h).padStart(2, '0')}:00`
      : fallback
  const [startTime, setStartTime] = useState(
    hhmm(defaultStartHour ?? initialSection?.defaultStartHour, '09:00')
  )
  const [endTime, setEndTime] = useState(
    hhmm(defaultEndHour ?? initialSection?.defaultEndHour, '17:00')
  )

  // When the manager picks a different block, auto-fill the time
  // inputs from that block's defaults. Keeps the "contextual feel"
  // of the drawer alive without forcing the manager to retype.
  const handleSectionChange = (id: string) => {
    setSectionId(id)
    if (!id) return
    const next = sections.find((s) => s.id === id)
    if (next) {
      setStartTime(hhmm(next.defaultStartHour, startTime))
      setEndTime(hhmm(next.defaultEndHour, endTime))
    }
  }

  // datetime-local format the server expects: YYYY-MM-DDTHH:MM
  const composedStart = `${date}T${startTime}`
  const composedEnd = `${date}T${endTime}`

  return (
    <DrawerShell
      eyebrow="Shift"
      title="Add shift"
      subtitle="One-off or block-aligned. Pick a person, a day, and a time."
      onClose={onClose}
    >
      {employees.length === 0 ? (
        // Empty state — no people on the bench yet, so no shift can
        // be created. Stays inside the body region so the drawer
        // height feels intentional, not collapsed.
        <DrawerBody>
          <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/40 p-5 text-center">
            <p className="text-sm font-medium text-gray-700">No employees yet</p>
            <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">
              Add at least one employee before scheduling shifts.
            </p>
          </div>
        </DrawerBody>
      ) : (
        <form action={action} className="flex-1 flex flex-col min-h-0">
          <input type="hidden" name="location_id" value={locationId} />
          {/* Composed datetime-local strings the server consumes. */}
          <input type="hidden" name="start_time" value={composedStart} />
          <input type="hidden" name="end_time" value={composedEnd} />
          {/* section_id is sent as the picker's current value (empty
              string for the Custom lane). */}
          <input type="hidden" name="section_id" value={sectionId} />

          <DrawerBody>
            <Field label="Employee" htmlFor="cs-emp">
              <select
                id="cs-emp"
                name="employee_id"
                required
                defaultValue=""
                className={fieldInputClass}
              >
                <option value="" disabled>Select…</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.name} · {e.role}</option>
                ))}
              </select>
            </Field>

            <Field
              label="Block"
              htmlFor="cs-section"
              optional
              hint="Pick a block to slot into its lane. Leave on Custom for a one-off."
            >
              <select
                id="cs-section"
                value={sectionId}
                onChange={(e) => handleSectionChange(e.target.value)}
                className={fieldInputClass}
              >
                <option value="">— Custom (no block) —</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({hL(s.defaultStartHour)}–{hL(s.defaultEndHour)})
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Date" htmlFor="cs-date">
              <input
                id="cs-date"
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={`${fieldInputClass} tabular-nums`}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Start" htmlFor="cs-start">
                <input
                  id="cs-start"
                  type="time"
                  required
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className={`${fieldInputClass} tabular-nums`}
                />
              </Field>
              <Field label="End" htmlFor="cs-end">
                <input
                  id="cs-end"
                  type="time"
                  required
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className={`${fieldInputClass} tabular-nums`}
                />
              </Field>
            </div>

            <Field label="Notes" htmlFor="cs-notes" optional>
              <input
                id="cs-notes"
                name="notes"
                type="text"
                placeholder="e.g. Event coverage"
                className={fieldInputClass}
              />
            </Field>

            {state?.error && (
              <p className="text-xs text-red-600">{state.error}</p>
            )}
          </DrawerBody>

          <DrawerFooter>
            <button
              type="submit"
              disabled={pending}
              className="h-10 w-full rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {pending ? 'Adding…' : 'Add shift'}
            </button>
          </DrawerFooter>
        </form>
      )}
    </DrawerShell>
  )
}
