'use client'

// ----------------------------------------------------------------
// StaffingCalendar — week timeline + day editor + bench.
//
// Rewired from a design shipped by Claude Design; adapted to our
// data shapes (Shift/Employee/Section from the app's server layer),
// our role-color system (roleTone + roleColors), and our server
// actions. Every mutation calls back to the parent client component
// via props so revalidation stays centralized.
//
// Inline styles are intentional here — mirrors the design's
// spec-for-spec palette (INK / PAPER / LINE / MUTED / SIGNAL) and
// keeps the file portable if the surrounding design system shifts.
// Not a Tailwind conversion candidate for the near term.
// ----------------------------------------------------------------

import { useMemo, useState, useTransition } from 'react'
import type { Lang } from '@/lib/i18n'
import { makeT } from '@/lib/i18n'
import ScheduleHeader, { type DayConfig } from './schedule-header'

// ---- Palette (matches marketing site + app shell) --------------
const INK = '#18181B'
const PAPER = '#FAF9F6'
const LINE = '#E7E6E2'
const LINE_SOFT = '#F0EFEB'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const SURFACE = '#FAFAF9'
const SIGNAL = '#2563EB'
const MONO = "'Geist Mono', ui-monospace, monospace"

// Percent inset baked into pct() so the axis endpoints don't sit
// flush against the container edges. Padding on the parent DOESN'T
// naturally inset absolutely-positioned children (they still
// position against the padding-box origin), so we compensate in
// the pct() math instead — every consumer (ticks, shift bars,
// hour lines, shading bands) shifts together and stays aligned
// without any extra per-container padding.
const TICK_INSET_PCT = 3
// STAFF / DAY·HOURS gutter width — matches the ScheduleHeader's
// gutter prop so the day strip cells sit above the same columns
// as the ruler ticks below.
const GUTTER_WIDTH = 150

// ---- Domain shapes (imported at the callsite) ------------------
export interface CalShift {
  id: string
  employeeId: string
  employeeName: string
  role: string
  startTime: string // ISO
  endTime: string   // ISO
}
export interface CalEmployee {
  id: string
  name: string
  role: string
  // Mon..Sun booleans. Optional so pre-migration adapter code
  // doesn't need to be updated in lock-step. Day-view bench
  // hides anyone flagged false for the visible day.
  availability?: boolean[]
  // Extra roles the person is trained on. Bench card shows them
  // as "Owner · also Barista"; drawer's Working-as pill row uses
  // primary + trained too.
  trainedRoles?: string[]
}

// ---- Role tone helper (mirrors client.tsx's roleTone) ----------
// Local copy so this file doesn't reach into client.tsx internals.
// The palette is kept short intentionally — matches ROLE_MAP in
// client.tsx; extras fall through to gray.
type Tone = { accent: string; bg: string; text: string }
const ROLE_GRAY: Tone = { accent: '#3F3F46', bg: '#F4F4F5', text: '#52525B' }
export const ROLE_TONES: Record<string, Tone> = {
  purple: { accent: '#A855F7', bg: '#FAF5FF', text: '#7E22CE' },
  teal:   { accent: '#14B8A6', bg: '#F0FDFA', text: '#0F766E' },
  rose:   { accent: '#F43F5E', bg: '#FFF1F2', text: '#BE123C' },
  slate:  { accent: '#64748B', bg: '#F1F5F9', text: '#334155' },
  emerald:{ accent: '#10B981', bg: '#ECFDF5', text: '#047857' },
  zinc:   { accent: '#52525B', bg: '#F4F4F5', text: '#27272A' },
  stone:  { accent: '#78716C', bg: '#F5F5F4', text: '#44403C' },
  red:    { accent: '#EF4444', bg: '#FEF2F2', text: '#B91C1C' },
  lime:   { accent: '#84CC16', bg: '#F7FEE7', text: '#4D7C0F' },
  violet: { accent: '#8B5CF6', bg: '#F5F3FF', text: '#6D28D9' },
  amber:  { accent: '#F59E0B', bg: '#FFFBEB', text: '#B45309' },
  sky:    { accent: '#0EA5E9', bg: '#F0F9FF', text: '#0369A1' },
  gray:   ROLE_GRAY,
}
const ROLE_AUTO_RULES: Array<{ test: RegExp; tone: keyof typeof ROLE_TONES }> = [
  { test: /server|wait/,           tone: 'purple'  },
  { test: /host/,                  tone: 'teal'    },
  { test: /bartender|bar(\s|$)/,   tone: 'rose'    },
  { test: /busser/,                tone: 'slate'   },
  { test: /runner/,                tone: 'emerald' },
  { test: /manager|lead|supervis/, tone: 'zinc'    },
  { test: /prep/,                  tone: 'stone'   },
  { test: /line|cook|chef|grill/,  tone: 'red'     },
  { test: /dish/,                  tone: 'lime'    },
  { test: /expo|pass/,             tone: 'violet'  },
]
function roleToneFor(role: string, overrides: Record<string, string>): Tone {
  const slug = resolveRoleToneSlug(role, overrides)
  return ROLE_TONES[slug] ?? ROLE_GRAY
}

// resolveRoleToneSlug — the tone selection logic, exposed as a
// slug (not a Tone) so the role-editor drawer can build a
// "which color does every OTHER role effectively use" map for
// the clash warning. Owner overrides win → auto-rule match →
// 'gray' fallback.
export function resolveRoleToneSlug(role: string, overrides: Record<string, string>): string {
  const r = (role ?? '').toLowerCase().trim()
  if (!r) return 'gray'
  const overrideSlug = overrides[r]
  if (overrideSlug && ROLE_TONES[overrideSlug]) return overrideSlug
  for (const rule of ROLE_AUTO_RULES) {
    if (rule.test.test(r)) return rule.tone as string
  }
  return 'gray'
}

// ---- Time helpers ----------------------------------------------
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function minutesInDay(iso: string): number {
  const d = new Date(iso); return d.getHours() * 60 + d.getMinutes()
}
function fmtTime(iso: string): string {
  const d = new Date(iso)
  let h = d.getHours(), m = d.getMinutes()
  const ap = h >= 12 ? 'p' : 'a'
  h = h % 12; if (h === 0) h = 12
  return m === 0 ? `${h}:00${ap}` : `${h}:${String(m).padStart(2, '0')}${ap}`
}
function fmtHourShort(h: number): string {
  if (h === 0 || h === 24) return '12a'
  if (h === 12) return '12p'
  return h < 12 ? `${h}a` : `${h - 12}p`
}
// Compact hours from a minutes-from-midnight value: 720 → "12p",
// 1290 → "9:30p". Drops ":00" and uses a single-letter meridiem.
// Used by the day cell's hours line ("12p–10p").
function fmtHourShortMin(m: number): string {
  const h24 = Math.floor(m / 60) % 24
  const mm = m % 60
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h}${mm ? ':' + String(mm).padStart(2, '0') : ''}${h24 < 12 ? 'a' : 'p'}`
}
function hoursBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000
}
function fmtH(n: number): string { return (n % 1 ? n.toFixed(1) : String(n)) + 'h' }

// ---- Component -------------------------------------------------
export interface StaffingCalendarProps {
  lang: Lang
  weekStart: Date
  weekDays: Date[]
  activeHouse: 'foh' | 'boh'
  isUnified: boolean
  shifts: CalShift[]              // shifts already filtered to activeHouse + week
  bench: CalEmployee[]            // employees already filtered to activeHouse
  weeklyHoursByEmployee: Map<string, number>  // for bench card labels
  roleColors: Record<string, string>          // slug map from staffing_config
  // Every configured role for the active house, from staffing_config.
  // Used as the primary legend source so roles show up even before
  // anyone's assigned — without this, phantom roles from the
  // onboarding seed stay invisible until someone's tagged with them.
  houseRoles: string[]

  // Actions — parent wraps server calls + revalidation. Return
  // shape is deliberately wide so the callsite can return any
  // action result verbatim; the component only ever reads
  // `.error` and `.copied` off successful results.
  onOpenEditShift: (shift: CalShift) => void
  // Bench card dropped onto a day (open days only) → parent
  // opens the shift drawer in "create-locked" mode with the
  // person pre-filled. Was the instant-create path; now hands
  // off to the drawer for explicit confirmation.
  onDropOnDay: (employeeId: string, dayIso: string) => void
  // "+ Add shift" ghost clicked on an open day → parent opens
  // the drawer in "create-blank" mode (person picker shown).
  onAddShiftForDay: (dayIso: string) => void
  // onSetShiftTime — retired with the "Set shift time" placeholder
  // path. Kept in the prop shape for one release so callers can
  // migrate; parent may pass a no-op. Will be removed next pass.
  onSetShiftTime?: (shiftId: string, startIso: string, endIso: string) => Promise<ActionResult>
  onRemoveShift: (shiftId: string) => Promise<ActionResult>
  // Retired 2026-07-26: the per-day "Repeat last week" button
  // was redundant with the header's Copy last week (covers the
  // whole week anyway). Prop signature preserved as optional so
  // any lingering caller doesn't 500.
  onRepeatLastWeekForDay?: (dayIso: string) => Promise<ActionResult>
  onClearDay: (dayIso: string) => Promise<ActionResult>
  onCopyLastWeek: () => Promise<ActionResult>
  // Week navigation is now driven by the ScheduleHeader (swipe +
  // month picker); parent supplies onWeekChange to setWeekStart.
  // Legacy ‹ Today › callbacks retired.
  onWeekChange: (newWeekStart: Date) => void
  // onPublish — cosmetic today (everything auto-saves). Wired for
  // a future staged-changes flow. Parent typically passes a
  // router.refresh so the button "does something."
  onPublish: () => void
  // Role legend actions — the color slug is one of ROLE_TONES's
  // keys (see below). Passing null clears the override so the
  // role falls back to the auto-color regex.
  // Role editing lives in a parent-owned drawer. Chip click →
  // onEditRole(role); "+" button → onOpenAddRole(). The old
  // inline color popover + wage form + inline add input have
  // been retired in favor of the drawer's single editor surface.
  onEditRole: (role: string) => void
  onOpenAddRole: () => void
  // Bench card click → open that employee's drawer (used to be
  // a "click = assign to today" gesture; the drawer wins because
  // drag-drop already covers the assign case and the drawer is
  // where every other employee action lives).
  onOpenEmployee: (employeeId: string) => void
  // Bench footer "+ Add employee" affordance — parent opens the
  // add-employee drawer, mirrors onOpenAddRole for the roles
  // legend.
  onOpenAddEmployee: () => void
  // Manual reorder — same drag gesture as scheduling; the drop
  // target decides intent (day = schedule, bench card = reorder,
  // role chip = reorder). Parent handles persistence + refresh.
  onReorderBench: (orderedIds: string[]) => Promise<ActionResult>
  onReorderRoles: (orderedRoles: string[]) => Promise<ActionResult>
  // ---- 2026-07-26 business hours ----
  // Per-visible-week hours (Mon..Sun, length 7). Drives the time
  // axis + per-row open/setup shading + the day cell's hours line.
  dayHours: CalDayHours[]
  // Tap a day's left cell → parent opens the hours drawer.
  onEditDayHours: (dayIndex: number) => void
}

// Merged per-day hours passed in from the parent. Times are
// minutes-from-midnight; `override` = true when the day pulled
// from hours_override (drives the amber "· one-off" hint).
export interface CalDayHours {
  closed: boolean
  openMin: number
  closeMin: number
  override: boolean
}

type ActionResult =
  | null
  | void
  | { error?: string; copied?: number; skipped?: number; ok?: true }

// Public list of picker options — one per ROLE_TONES entry.
export const ROLE_TONE_SLUGS: Array<keyof typeof ROLE_TONES> = [
  'purple', 'teal', 'rose', 'slate', 'emerald', 'zinc',
  'stone', 'red', 'lime', 'violet', 'amber', 'sky', 'gray',
]

export default function StaffingCalendar(props: StaffingCalendarProps) {
  const {
    lang, weekStart, weekDays, shifts, bench, weeklyHoursByEmployee, roleColors, houseRoles,
    onOpenEditShift, onDropOnDay, onAddShiftForDay, onRemoveShift,
    onClearDay, onCopyLastWeek,
    onWeekChange, onPublish,
    onEditRole, onOpenAddRole, onOpenEmployee, onOpenAddEmployee,
    onReorderBench, onReorderRoles,
    dayHours, onEditDayHours,
  } = props
  const t = makeT(lang)
  const dateLocale = lang === 'es' ? 'es-ES' : 'en-US'

  const [view, setView] = useState<'week' | 'day'>('week')
  const [dayIndex, setDayIndex] = useState(() => {
    // Default day view = today if in this week, else Monday.
    const now = new Date()
    const idx = weekDays.findIndex((d) => sameDay(d, now))
    return idx >= 0 ? idx : 0
  })
  const [dragging, setDragging] = useState<CalEmployee | null>(null)
  const [dragOverDay, setDragOverDay] = useState<number | null>(null)
  const [, startTransition] = useTransition()
  const [copyMsg, setCopyMsg] = useState<string | null>(null)
  // Role editing moved to a parent-owned drawer — no legend-local
  // state needed anymore.

  // Reorder state — one drag source at a time. `benchDragId` is
  // the employee id being dragged (nulled on drop / dragend);
  // `roleDrag` is the role name. Kept in local state (not refs)
  // so the source card can dim while the drag is in flight.
  const [benchDragId, setBenchDragId] = useState<string | null>(null)
  const [benchDropTargetId, setBenchDropTargetId] = useState<string | null>(null)
  const [roleDrag, setRoleDrag] = useState<string | null>(null)
  const [roleDropTarget, setRoleDropTarget] = useState<string | null>(null)
  // Which day is showing the "+ Add shift" ghost right now.
  // Set on mouse-enter of an open day's track; cleared on
  // mouse-leave. Bench drag also lights it up so the manager
  // sees exactly where the drop will land.
  const [hoverAddDay, setHoverAddDay] = useState<number | null>(null)
  // Day-view timeline hover — when true (or a drag is in
  // flight), the Add row expands into view. When idle with
  // shifts already placed, the row collapses so the calendar
  // reads tight; discovered again on hover or drag.
  const [dayTimelineHover, setDayTimelineHover] = useState(false)

  // ---- Time axis — driven by business hours + 90m PRE/POST -----
  // Previously we derived from min/max shift time; now the hours
  // set on each day drive the ruler so the axis stays stable
  // (adding a shift doesn't reshape the columns). Fallback to
  // 10a–10p when every day is closed / uninitialized so the empty
  // state still renders a sensible ruler.
  // Wiggle room around trading hours, in minutes. 60m each side
  // per the manager's ask — was 90m; 60m keeps the axis tight to
  // the actual open/close so shift bars have more room.
  const AXIS_PRE = 60
  const AXIS_POST = 60
  const axis = useMemo(() => {
    const openDays = dayHours.filter((h) => !h.closed)
    let minMin: number, maxMin: number
    if (openDays.length === 0) {
      minMin = 10 * 60
      maxMin = 22 * 60
    } else {
      minMin = Math.min(...openDays.map((h) => h.openMin)) - AXIS_PRE
      maxMin = Math.max(...openDays.map((h) => h.closeMin)) + AXIS_POST
    }
    // Round to hour boundaries so ruler ticks land clean.
    const T0 = Math.max(0, Math.floor(minMin / 60) * 60)
    const T1 = Math.min(24 * 60, Math.ceil(maxMin / 60) * 60)
    const SPAN = Math.max(60, T1 - T0)
    return { T0, SPAN, minH: T0 / 60, maxH: T1 / 60 }
  }, [dayHours])

  // Baked-in horizontal inset so the axis endpoints aren't flush
  // against the container's borders. Everything that uses pct()
  // (ticks, shift bars, hourLines, openBand) shifts together and
  // stays aligned.
  const pct = (minutes: number) =>
    TICK_INSET_PCT + ((minutes - axis.T0) / axis.SPAN) * (100 - 2 * TICK_INSET_PCT)
  const TICKS = useMemo(() => {
    const arr: Array<{ hour: number; left: number }> = []
    for (let h = axis.minH; h <= axis.maxH; h++) arr.push({ hour: h, left: pct(h * 60) })
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis])

  // Group shifts by day for the week view.
  const shiftsByDay = useMemo(() => {
    const map = new Map<number, CalShift[]>()
    for (let i = 0; i < weekDays.length; i++) map.set(i, [])
    for (const s of shifts) {
      const start = new Date(s.startTime)
      for (let i = 0; i < weekDays.length; i++) {
        if (sameDay(weekDays[i], start)) {
          map.get(i)!.push(s)
          break
        }
      }
    }
    // Sort each day's shifts by start.
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    }
    return map
  }, [shifts, weekDays])

  // Business-hours bands per day. `openBand` shades trading hours
  // (solid); `setupBand` shades the ±90m setup/close-down window
  // (dashed, wider than openBand). Both null when the day is
  // closed or unset — the row renders empty like before.
  const openRangeForDay = (dayIdx: number): { startPct: number; widthPct: number } | null => {
    const h = dayHours[dayIdx]
    if (!h || h.closed) return null
    return { startPct: pct(h.openMin), widthPct: pct(h.closeMin) - pct(h.openMin) }
  }
  const setupRangeForDay = (dayIdx: number): { startPct: number; widthPct: number } | null => {
    const h = dayHours[dayIdx]
    if (!h || h.closed) return null
    const s = Math.max(axis.T0, h.openMin - AXIS_PRE)
    const e = Math.min(axis.T0 + axis.SPAN, h.closeMin + AXIS_POST)
    return { startPct: pct(s), widthPct: pct(e) - pct(s) }
  }

  // weekLabel + dayLongLabel retired — ScheduleHeader carries
  // the date/range now. totalShifts + totalHours stay because
  // the header uses them for its stats line via headerDays.
  const totalShifts = shifts.length
  const totalHours = shifts.reduce((n, s) => n + hoursBetween(s.startTime, s.endTime), 0)

  const day = weekDays[dayIndex]
  const dayShifts = shiftsByDay.get(dayIndex) ?? []
  const dayOpen = openRangeForDay(dayIndex)
  const daySetup = setupRangeForDay(dayIndex)
  const dayTotalH = dayShifts.reduce((n, s) => n + hoursBetween(s.startTime, s.endTime), 0)

  // benchWithAssigned drives what shows in the bench card grid.
  // In Day view we additionally hide anyone marked unavailable
  // for the selected day — the server would reject them anyway
  // and showing them just baits a rejected drop. Week view
  // keeps everyone so a manager can plan across the week.
  const benchWithAssigned = useMemo(() => {
    const jsDow = day.getDay()
    const monIdx = jsDow === 0 ? 6 : jsDow - 1
    return bench
      .filter((p) => {
        if (view !== 'day') return true
        const av = p.availability
        if (!Array.isArray(av) || av.length !== 7) return true
        return av[monIdx] !== false
      })
      .map((p) => ({ ...p, assigned: dayShifts.some((s) => s.employeeId === p.id) }))
  }, [bench, dayShifts, view, day])

  // ---- Handlers -------------------------------------------------
  // Bench-drop no longer creates instantly — hand off to the
  // parent which opens the shift drawer with the person locked
  // and times pre-set to the day's open→close. Closed days
  // silently refuse the drop; the drawer would just error later.
  const handleDayDrop = (idx: number) => {
    if (!dragging) return
    const emp = dragging
    setDragging(null); setDragOverDay(null); setHoverAddDay(null)
    const h = dayHours[idx]
    if (!h || h.closed) return
    onDropOnDay(emp.id, weekDays[idx].toISOString())
  }
  // handleRemove retired — the shift edit drawer owns the
  // Remove action now via its own button + onRemoveShift call.
  const handleClear = () => {
    startTransition(() => { onClearDay(day.toISOString()) })
  }
  const handleCopyLastWeek = () => {
    setCopyMsg(null)
    startTransition(async () => {
      const r = await onCopyLastWeek()
      if (r && 'error' in r && r.error) setCopyMsg(r.error)
      else if (r && 'copied' in r) setCopyMsg(`${r.copied} shift${r.copied === 1 ? '' : 's'} copied`)
      setTimeout(() => setCopyMsg(null), 3000)
    })
  }
  // handleSave / savedFlash retired — the redesigned header owns
  // the Publish button and its states. Kept the copyMsg toast
  // (still shown as a small line near Copy last week's response).

  // ---- Styles ---------------------------------------------------
  // `tab` retired — ScheduleHeader owns the Day/Week toggle
  // via its own segmented control.
  const ghostBtn: React.CSSProperties = {
    border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8,
    padding: '6px 12px', font: 'inherit', fontSize: 12, fontWeight: 500,
    color: '#3F3F46', cursor: 'pointer',
  }

  // Single continuous shaded band per day row — spans the whole
  // shift-assignable window (open − 60m through close + 60m).
  // Lighter fill + dotted side borders per manager's ask, so the
  // shift bars pop against a calm background instead of a solid
  // gray slab.
  const openBand = (
    open: { startPct: number; widthPct: number } | null,
    setup?: { startPct: number; widthPct: number } | null,
    today?: boolean,
  ) => {
    const band = setup ?? open
    if (!band) return null
    return (
      <div style={{
        position: 'absolute',
        left: `${band.startPct}%`, width: `${band.widthPct}%`,
        top: 0, bottom: 0,
        background: today ? '#F6FAFF' : '#FAFAF8',
        borderLeft: `1px dotted ${today ? '#DBEAFE' : '#D6D5D1'}`,
        borderRight: `1px dotted ${today ? '#DBEAFE' : '#D6D5D1'}`,
      }} />
    )
  }

  const hourLines = TICKS.map((tick) => (
    <span key={tick.hour} style={{
      position: 'absolute', left: `${tick.left}%`, top: 0, bottom: 0,
      width: 1, background: LINE_SOFT,
    }} />
  ))

  const renderShiftBar = (s: CalShift, height = 16, showName = true) => {
    const tone = roleToneFor(s.role, roleColors)
    const startMin = minutesInDay(s.startTime)
    const endMin = minutesInDay(s.endTime)
    const left = pct(startMin)
    const width = pct(endMin) - left
    return (
      <button
        type="button"
        onClick={(e) => {
          // Stop the click from bubbling to the day-row track,
          // which would fire onAddShiftForDay and open a NEW-
          // shift drawer on top of the edit intent.
          e.stopPropagation()
          onOpenEditShift(s)
        }}
        style={{
          position: 'absolute', left: `${left}%`, width: `${width}%`, height,
          borderRadius: height > 20 ? 7 : 4,
          background: tone.bg,
          border: height > 20 ? `1px solid ${tone.accent}33` : undefined,
          borderLeft: `${height > 20 ? 4 : 3}px solid ${tone.accent}`,
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px',
          overflow: 'hidden', cursor: 'pointer', textAlign: 'left', font: 'inherit',
        }}
      >
        {showName && (
          <span style={{ fontSize: 10, fontWeight: 600, lineHeight: 1, whiteSpace: 'nowrap' }}>
            {s.employeeName}
          </span>
        )}
        {height > 20 && (
          <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: '#27272A', marginLeft: 8, whiteSpace: 'nowrap' }}>
            {fmtTime(s.startTime)} – {fmtTime(s.endTime)}
          </span>
        )}
        <span style={{
          fontFamily: MONO, fontSize: height > 20 ? 11 : 9, color: '#71717A',
          marginLeft: 'auto', lineHeight: 1, whiteSpace: 'nowrap',
        }}>
          {height > 20
            ? fmtH(hoursBetween(s.startTime, s.endTime))
            : `${fmtTime(s.startTime)}–${fmtTime(s.endTime)}`}
        </span>
      </button>
    )
  }

  // Adapt our per-day merged-hours + shift counts to the header's
  // DayConfig shape. `shifts` here counts visible-on-axis rows so
  // stale off-hours shifts don't inflate the day-strip badge.
  const headerDays: DayConfig[] = weekDays.map((_d, i) => {
    const h = dayHours[i]
    const open: [number, number] | null = h && !h.closed ? [h.openMin, h.closeMin] : null
    const list = shiftsByDay.get(i) ?? []
    const visible = h && !h.closed
      ? list.filter((s) => {
          const sMin = minutesInDay(s.startTime)
          const eMin = minutesInDay(s.endTime)
          return eMin > axis.T0 && sMin < axis.T0 + axis.SPAN
        }).length
      : 0
    return { open, shifts: visible }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, color: INK, fontFamily: "'Geist', system-ui, sans-serif" }}>
      {/* Board — position:relative + overflow:hidden. The month
          picker escapes via a portal (schedule-header.tsx) so
          overflow:hidden here doesn't clip it. Children can leak
          to the corners without visual smear. */}
      <div style={{ position: 'relative', border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
        <ScheduleHeader
          lang={lang}
          view={view}
          onViewChange={setView}
          dayIndex={dayIndex}
          onDayChange={setDayIndex}
          weekStart={weekStart}
          onWeekStartChange={onWeekChange}
          today={new Date()}
          days={headerDays}
          dirty={false}
          onPublish={onPublish}
          onCopyLastWeek={handleCopyLastWeek}
          dayHours={fmtH(dayTotalH)}
          weekHours={fmtH(totalHours)}
          weekShifts={totalShifts}
          gutter={GUTTER_WIDTH}
        />
        {copyMsg && (
          <div style={{ padding: '0 16px 8px', fontSize: 11, color: SIGNAL }}>{copyMsg}</div>
        )}

        {view === 'week' ? (
          <div style={{ minWidth: 900 }}>
            {/* Hour ruler — gutter carries a DAY · HOURS eyebrow
                to match the Day-view STAFF label. Explicit borderTop
                so the ruler reads as its own strip separated from
                the header above (was blending into the header
                because both were surface-toned). */}
            <div style={{
              display: 'flex',
              borderTop: `1px solid ${LINE}`,
              borderBottom: `1px solid ${LINE}`,
              background: SURFACE, position: 'sticky', top: 41, zIndex: 2,
            }}>
              <div style={{
                width: GUTTER_WIDTH, flex: `0 0 ${GUTTER_WIDTH}px`, borderRight: `1px solid ${LINE}`,
                padding: '0 12px', display: 'flex', alignItems: 'center',
              }}>
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: MUTED }}>
                  {t('DAY · HOURS', 'DÍA · HORAS')}
                </span>
              </div>
              <div style={{
                position: 'relative', height: 18, flex: 1, minWidth: 0,
              }}>
                {TICKS.map((tick) => (
                  <span
                    key={tick.hour}
                    style={{
                      position: 'absolute',
                      left: `${tick.left}%`,
                      top: 4,
                      // Every label centered on its tick position.
                      // Container padding gives the outer labels room
                      // to breathe without shifting the intervals —
                      // gaps between every pair of labels are equal.
                      transform: 'translateX(-50%)',
                      fontFamily: MONO, fontSize: 9, color: MUTED,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {fmtHourShort(tick.hour)}
                  </span>
                ))}
              </div>
            </div>

            {/* Day rows */}
            {weekDays.map((d, idx) => {
              // Closed days render as empty regardless of whether
              // stale shifts exist in the DB for that date — a
              // closed day shouldn't expand to fit invisible bars
              // and shouldn't hide the "Closed — tap the day to
              // change" hint. `renderedList` is what the track
              // paints; `list` still counts real shifts (unused
              // when the row is treated as empty).
              const list = shiftsByDay.get(idx) ?? []
              const isToday = sameDay(d, new Date())
              const open = openRangeForDay(idx)
              const setup = setupRangeForDay(idx)
              const hoursForDay = dayHours[idx] ?? { closed: true, openMin: 720, closeMin: 1260, override: false }
              // Filter to shifts that actually intersect the
              // visible axis window. Off-axis stale bars (e.g. a
              // 6a shift left over from before the day's hours
              // were set) would otherwise expand the row height
              // even though nothing renders — the exact "row is
              // taller for no visible reason" bug we hit on today.
              const visibleList = hoursForDay.closed
                ? []
                : list.filter((s) => {
                    const sMin = minutesInDay(s.startTime)
                    const eMin = minutesInDay(s.endTime)
                    return eMin > axis.T0 && sMin < axis.T0 + axis.SPAN
                  })
              const renderedList = visibleList
              const isOver = dragOverDay === idx
              // Uniform row footprint across empty + closed days
              // so the week reads as a consistent grid. Populated
              // rows expand to fit stacked bars.
              const barH = 22
              const barGap = 4
              const contentH = renderedList.length * barH + Math.max(0, renderedList.length - 1) * barGap
              // Empty rows keep a comfortable 52px so the "no
              // shifts scheduled" text has room. Non-empty rows
              // hug their content (no 84px floor) — that floor
              // was leaving a permanent gap below the shift bar
              // per the manager's ask.
              const WEEK_DAY_MIN_H = renderedList.length === 0 ? 52 : 36
              const dayRowH = Math.max(WEEK_DAY_MIN_H, contentH + 16)
              // Hours-line copy: "12p–10p", "Closed", "12p–10p · one-off".
              // Overrides paint amber to signal an exception.
              const hoursLine = hoursForDay.closed
                ? t('Closed', 'Cerrado')
                : `${fmtHourShortMin(hoursForDay.openMin)}–${fmtHourShortMin(hoursForDay.closeMin)}${hoursForDay.override ? ` · ${t('one-off', 'único')}` : ''}`
              const hoursLineColor = hoursForDay.closed
                ? FAINT
                : hoursForDay.override
                  ? '#B45309'
                  : MUTED
              return (
                <div
                  key={idx}
                  onDragOver={(e) => { e.preventDefault(); setDragOverDay(idx) }}
                  onDragLeave={() => setDragOverDay(null)}
                  onDrop={() => handleDayDrop(idx)}
                  style={{
                    display: 'flex',
                    borderBottom: `1px solid ${LINE}`,
                    background: isOver ? '#EFF6FF' : isToday ? '#F7FAFF' : undefined,
                    minHeight: dayRowH,
                  }}
                >
                  {/* Left cell = button opening the hours drawer.
                      Date + tiny "Edit" affordance on the top line;
                      hours line ("12p–10p" / "Closed") underneath. */}
                  <button
                    type="button"
                    onClick={() => onEditDayHours(idx)}
                    title={t('Set opening hours', 'Definir horario de apertura')}
                    style={{
                      width: GUTTER_WIDTH, flex: `0 0 ${GUTTER_WIDTH}px`,
                      borderRight: `1px solid ${LINE}`,
                      borderTop: 0, borderBottom: 0, borderLeft: 0,
                      // Today marker paints as an inset shadow on
                      // the left — no layout impact so the cell's
                      // content sits at exactly the same X as every
                      // other day.
                      boxShadow: isToday ? `inset 3px 0 0 ${SIGNAL}` : 'none',
                      background: 'transparent',
                      color: hoursForDay.closed ? FAINT : INK,
                      padding: '10px 12px',
                      display: 'flex', flexDirection: 'column',
                      alignItems: 'flex-start', gap: 2,
                      font: 'inherit', textAlign: 'left', cursor: 'pointer',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: isToday ? SIGNAL : (hoursForDay.closed ? FAINT : INK) }}>
                        {d.toLocaleDateString(dateLocale, { weekday: 'short' })} {d.getDate()}
                      </span>
                      <span style={{ fontSize: 10, color: '#C4C4C7' }}>{t('Edit', 'Editar')}</span>
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: hoursLineColor, whiteSpace: 'nowrap' }}>
                      {hoursLine}
                    </span>
                  </button>
                  <div
                    onMouseEnter={() => {
                      // Only open days invite an "+ Add shift" gesture.
                      // Closed days ignore hover so the empty copy
                      // stays the primary CTA (tap to change hours).
                      if (!hoursForDay.closed) setHoverAddDay(idx)
                    }}
                    onMouseLeave={() => {
                      // Don't clear during a bench drag — the ghost
                      // should stay lit while the drop preview shows.
                      if (!benchDragId && !dragging) setHoverAddDay((v) => (v === idx ? null : v))
                    }}
                    onClick={() => {
                      // Click on the track (not on a placed shift)
                      // opens the drawer in create-blank mode with
                      // start/end pre-set to the day's open→close.
                      if (hoursForDay.closed) return
                      onAddShiftForDay(weekDays[idx].toISOString())
                    }}
                    style={{
                      position: 'relative', flex: 1, minWidth: 0,
                      // Flex column centered vertically so a single
                      // shift bar sits in the middle of a tall row
                      // (the day cell's two-line "Day · Hours"
                      // makes the row taller than the bar).
                      // Additional shifts stack naturally and push
                      // the whole stack outward from center.
                      display: 'flex', flexDirection: 'column', justifyContent: 'center',
                      paddingTop: renderedList.length === 0 ? 0 : 6,
                      paddingBottom: renderedList.length === 0 ? 0 : 6,
                      // Clip anything positioned outside the axis so
                      // stray off-hours bars can't push the row edge
                      // past the vertical divider (which is what was
                      // making Sat/Sun look wider than Mon–Fri).
                      overflow: 'hidden',
                      cursor: hoursForDay.closed ? 'default' : (dragging ? 'copy' : 'pointer'),
                    }}
                  >
                    {openBand(open, setup, isToday)}
                    {renderedList.length === 0 && !(hoverAddDay === idx || (dragging && dragOverDay === idx)) && (
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', paddingLeft: 12, minHeight: 26 }}>
                        <span style={{ fontSize: 11, color: isOver ? SIGNAL : FAINT }}>
                          {isOver
                            ? t('Drop to schedule', 'Suelta para programar')
                            : hoursForDay.closed
                              ? t('Closed — tap the day to change', 'Cerrado — toca el día para cambiar')
                              : t('No shifts scheduled', 'Sin turnos programados')}
                        </span>
                      </div>
                    )}
                    {renderedList.map((s, i) => (
                      <div
                        key={s.id}
                        style={{
                          position: 'relative',
                          height: barH,
                          marginBottom: i === renderedList.length - 1 ? 0 : barGap,
                        }}
                      >
                        {renderShiftBar(s, barH)}
                      </div>
                    ))}

                    {/* + Add shift ghost — flow-positioned so it
                        pushes existing shifts UP as it expands the
                        row. Previously it was absolute-positioned
                        at bottom-8, which visually overlapped the
                        last shift bar. */}
                    {open && !hoursForDay.closed && (hoverAddDay === idx || (dragging && dragOverDay === idx)) && (
                      <div
                        style={{
                          position: 'relative',
                          height: barH,
                          marginTop: renderedList.length > 0 ? barGap : 0,
                        }}
                      >
                        <div style={{
                          position: 'absolute',
                          left: `${open.startPct}%`, width: `${open.widthPct}%`,
                          top: 0, bottom: 0, borderRadius: 6,
                          background: '#EFF6FF', border: '1px dashed #93C5FD',
                          display: 'flex', alignItems: 'center', padding: '0 9px',
                          pointerEvents: 'none',
                        }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#1D4ED8', whiteSpace: 'nowrap' }}>
                            {dragging
                              ? `${t('Drop', 'Soltar')} ${dragging.name.split(' ')[0]} ${t('here', 'aquí')}`
                              : `+ ${t('Add shift', 'Añadir turno')}`}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            {/* Roles legend was here — extracted below the ternary
                so both Day and Week render it in the same spot. */}
          </div>
        ) : (
          <>
            {/* Day pills retired — the ScheduleHeader now renders
                the aligned day strip (badges + hours + selection)
                directly under the title. */}

            <div style={{ padding: 14 }}>
              {/* Old day-view heading retired — ScheduleHeader now
                  carries the date + stats. The per-day "Repeat
                  last week" button was redundant with the header's
                  own Copy last week (which covers the whole week);
                  only Clear day remains, and only when there's
                  something to clear. */}
              {dayShifts.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7, marginBottom: 10, flexWrap: 'wrap' }}>
                  <button style={ghostBtn} onClick={handleClear}>{t('Clear day', 'Vaciar día')}</button>
                </div>
              )}

              {(dayHours[dayIndex]?.closed ?? true) ? (
                // Closed-day panel — tappable to open the hours
                // drawer for this day, matching the Week view's
                // day-cell gesture. No more "go to Week view first"
                // detour: click here and set hours in place.
                <button
                  type="button"
                  onClick={() => onEditDayHours(dayIndex)}
                  style={{
                    width: '100%',
                    border: `1px dashed ${LINE}`, borderRadius: 10,
                    padding: 28, textAlign: 'center', background: SURFACE,
                    font: 'inherit', cursor: 'pointer',
                    transition: 'background 120ms, border-color 120ms',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#F4F4F2'
                    e.currentTarget.style.borderColor = '#D6D5D1'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = SURFACE
                    e.currentTarget.style.borderColor = LINE
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: MUTED }}>{t('Closed', 'Cerrado')}</div>
                  <div style={{ fontSize: 12, color: FAINT, marginTop: 2 }}>
                    {t('No trading hours yet — tap to set opening hours.', 'Sin horas de servicio aún — toca para definir el horario.')}
                  </div>
                </button>
              ) : (
                <div
                  onMouseEnter={() => setDayTimelineHover(true)}
                  onMouseLeave={() => setDayTimelineHover(false)}
                  style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', background: '#fff' }}
                >
                  {/* Ruler */}
                  <div style={{ display: 'flex', background: SURFACE, borderBottom: `1px solid ${LINE}` }}>
                    <div style={{ width: GUTTER_WIDTH, flex: `0 0 ${GUTTER_WIDTH}px`, borderRight: `1px solid ${LINE}`, padding: '6px 12px', display: 'flex', alignItems: 'center' }}>
                      <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: MUTED }}>{t('STAFF', 'EQUIPO')}</span>
                    </div>
                    <div style={{
                      position: 'relative', flex: 1, minWidth: 0, height: 24,
                    }}>
                      {TICKS.map((tick) => (
                        <span
                          key={tick.hour}
                          style={{
                            position: 'absolute', left: `${tick.left}%`, top: 5,
                            transform: 'translateX(-50%)',
                            fontFamily: MONO, fontSize: 10, color: MUTED, whiteSpace: 'nowrap',
                          }}
                        >
                          {fmtHourShort(tick.hour)}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* One lane per placed shift. Bar shows time +
                      break; click routes through onOpenEditShift
                      to the unified ShiftDrawer. */}
                  {(() => {
                    // Filter to shifts that actually land on the
                    // visible axis, same as Week view. Stale off-
                    // hours rows are hidden so the lane doesn't
                    // render an empty row for an invisible bar.
                    const visibleShifts = dayShifts.filter((s) => {
                      const sMin = minutesInDay(s.startTime)
                      const eMin = minutesInDay(s.endTime)
                      return eMin > axis.T0 && sMin < axis.T0 + axis.SPAN
                    })
                    return visibleShifts.map((s) => {
                      const tone = roleToneFor(s.role, roleColors)
                      const dur = hoursBetween(s.startTime, s.endTime)
                      const brk = 'breakMinutes' in s ? (s as unknown as { breakMinutes: number }).breakMinutes : 0
                      return (
                        <div key={s.id} style={{ display: 'flex', borderBottom: `1px solid ${LINE_SOFT}`, alignItems: 'stretch' }}>
                          <div style={{ width: GUTTER_WIDTH, flex: `0 0 ${GUTTER_WIDTH}px`, borderRight: `1px solid ${LINE}`, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 2, flex: '0 0 auto', background: tone.accent }} />
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {s.employeeName}
                              </div>
                              <div style={{ fontSize: 11, color: tone.text, whiteSpace: 'nowrap' }}>{s.role}</div>
                            </div>
                            <span style={{ fontFamily: MONO, fontSize: 11, color: '#71717A' }}>
                              {fmtH(Math.max(0, dur - brk / 60))}
                            </span>
                          </div>
                          <div style={{
                            position: 'relative', flex: 1, minWidth: 0,
                            paddingTop: 5, paddingBottom: 5,
                            overflow: 'hidden',
                          }}>
                            {openBand(dayOpen, daySetup)}
                            {hourLines}
                            <div style={{ position: 'relative', height: 30 }}>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onOpenEditShift(s) }}
                                style={{
                                  position: 'absolute',
                                  left: `${pct(minutesInDay(s.startTime))}%`,
                                  width: `${pct(minutesInDay(s.endTime)) - pct(minutesInDay(s.startTime))}%`,
                                  height: 30, borderRadius: 7,
                                  background: `${tone.accent}1A`,
                                  border: `1px solid ${tone.accent}33`,
                                  borderLeft: `4px solid ${tone.accent}`,
                                  display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
                                  overflow: 'hidden', cursor: 'pointer', textAlign: 'left', font: 'inherit',
                                }}
                              >
                                <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: '#27272A', whiteSpace: 'nowrap' }}>
                                  {fmtTime(s.startTime)} – {fmtTime(s.endTime)}
                                </span>
                                <span style={{ fontFamily: MONO, fontSize: 10, color: '#71717A', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                                  {brk > 0 ? `${brk}m ${t('break', 'descanso')}` : t('no break', 'sin descanso')}
                                </span>
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })
                  })()}

                  {/* Add row — "+ Add shift" affordance lives in the
                      STAFF column (per manager's ask); the track
                      stays a plain drop target with just the shading.
                      Drop still opens the drawer in create-locked
                      mode; button click opens it blank.
                      Collapse rule (manager's ask): if the day has
                      visible shifts and nothing's hovering/dragging,
                      hide the row so the calendar reads tight. On
                      hover of the timeline card OR during a drag,
                      the row reappears. Empty days always show it
                      as the primary "add someone" CTA. */}
                  {(() => {
                    const hasVisibleShifts = dayShifts.some((s) => {
                      const sMin = minutesInDay(s.startTime)
                      const eMin = minutesInDay(s.endTime)
                      return eMin > axis.T0 && sMin < axis.T0 + axis.SPAN
                    })
                    const showAddRow = !hasVisibleShifts || dayTimelineHover || !!dragging
                    if (!showAddRow) return null
                    return (
                  <div
                    onDragOver={(e) => {
                      if (!dragging) return
                      e.preventDefault(); setDragOverDay(dayIndex)
                    }}
                    onDragLeave={() => { if (dragOverDay === dayIndex) setDragOverDay(null) }}
                    onDrop={() => handleDayDrop(dayIndex)}
                    style={{ display: 'flex', alignItems: 'stretch', background: '#FCFCFB' }}
                  >
                    <div
                      onMouseEnter={() => setHoverAddDay(dayIndex)}
                      onMouseLeave={() => { if (!dragging) setHoverAddDay((v) => (v === dayIndex ? null : v)) }}
                      style={{ width: GUTTER_WIDTH, flex: `0 0 ${GUTTER_WIDTH}px`, borderRight: `1px solid ${LINE}`, padding: '7px 12px', display: 'flex', alignItems: 'center' }}
                    >
                      {(() => {
                        // Match the Week-view ghost's blue vocabulary
                        // when the button is hovered or a bench card
                        // is being dragged — reads as one gesture
                        // across views instead of two similar-but-off
                        // affordances.
                        const lit = hoverAddDay === dayIndex || !!dragging
                        return (
                          <button
                            type="button"
                            onClick={() => onAddShiftForDay(day.toISOString())}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 6,
                              border: `1px dashed ${lit ? '#93C5FD' : LINE}`,
                              borderRadius: 8, padding: '6px 10px',
                              background: lit ? '#EFF6FF' : 'transparent',
                              font: 'inherit', fontSize: 12, fontWeight: lit ? 600 : 500,
                              color: lit ? '#1D4ED8' : MUTED,
                              cursor: 'pointer', width: '100%',
                              justifyContent: 'flex-start',
                              transition: 'background 120ms, border-color 120ms, color 120ms',
                            }}
                          >
                            + {t('Add shift', 'Añadir turno')}
                          </button>
                        )
                      })()}
                    </div>
                    <div style={{
                      position: 'relative', flex: 1, minWidth: 0,
                      paddingTop: 5, paddingBottom: 5,
                      background: dragOverDay === dayIndex ? '#EFF6FF' : undefined,
                    }}>
                      {openBand(dayOpen, daySetup)}
                      {hourLines}
                      {(() => {
                        const anyVisible = dayShifts.some((s) => {
                          const sMin = minutesInDay(s.startTime)
                          const eMin = minutesInDay(s.endTime)
                          return eMin > axis.T0 && sMin < axis.T0 + axis.SPAN
                        })
                        if (dragging) {
                          return (
                            <div style={{ position: 'relative', height: 30, display: 'flex', alignItems: 'center', paddingLeft: 12 }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color: '#1D4ED8' }}>
                                {t('Drop', 'Soltar')} {dragging.name.split(' ')[0]} {t('here', 'aquí')}
                              </span>
                            </div>
                          )
                        }
                        if (!anyVisible) {
                          return (
                            <div style={{ position: 'relative', height: 96, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, textAlign: 'center', padding: '0 16px' }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: '#52525B' }}>
                                {t('Nobody on staff for this day yet', 'Nadie en el equipo para este día aún')}
                              </span>
                              <span style={{ fontSize: 12, color: FAINT }}>
                                {t('Drag someone from the bench, or use + Add shift to start one.', 'Arrastra a alguien desde la plantilla, o usa + Añadir turno para empezar uno.')}
                              </span>
                            </div>
                          )
                        }
                        return (
                          <div style={{ position: 'relative', height: 30, display: 'flex', alignItems: 'center', paddingLeft: 12 }}>
                            <span style={{ fontSize: 11, color: FAINT }}>
                              {t('Drop another name from the bench to add them to the staff', 'Suelta otro nombre desde la plantilla para añadirlo al equipo')}
                            </span>
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                    )
                  })()}
                </div>
              )}
            </div>
          </>
        )}

        {/* Roles legend — shared across Day + Week views. Clickable
            chips; drag to reorder; "+ Add role" opens the drawer.
            Kept inside the calendar card so it sits between the
            timeline and the bench regardless of which view is
            active. */}
        {(() => {
          const seen = new Set<string>()
          const roles: string[] = []
          for (const src of [houseRoles, bench.map((p) => p.role), shifts.map((s) => s.role)]) {
            for (const r of src) {
              const k = r.toLowerCase().trim()
              if (!k || seen.has(k)) continue
              seen.add(k); roles.push(r)
            }
          }
          return (
            <div style={{ padding: '10px 14px', background: SURFACE, borderTop: `1px solid ${LINE}` }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: MUTED, whiteSpace: 'nowrap' }}>
                  {t('ROLES', 'PUESTOS')}
                </span>
                {roles.map((r) => {
                  const tone = roleToneFor(r, roleColors)
                  const key = r.toLowerCase().trim()
                  const isDragging = roleDrag?.toLowerCase().trim() === key
                  const isDropTarget = roleDropTarget?.toLowerCase().trim() === key
                    && roleDrag !== null
                    && roleDrag.toLowerCase().trim() !== key
                  return (
                    <button
                      key={r}
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', r)
                        setRoleDrag(r)
                      }}
                      onDragEnd={() => { setRoleDrag(null); setRoleDropTarget(null) }}
                      onDragOver={(e) => {
                        if (!roleDrag || roleDrag.toLowerCase().trim() === key) return
                        e.preventDefault()
                        e.stopPropagation()
                        setRoleDropTarget(r)
                      }}
                      onDragLeave={(e) => {
                        if (e.currentTarget.contains(e.relatedTarget as Node)) return
                        if (roleDropTarget?.toLowerCase().trim() === key) setRoleDropTarget(null)
                      }}
                      onDrop={(e) => {
                        if (!roleDrag || roleDrag.toLowerCase().trim() === key) return
                        e.preventDefault()
                        e.stopPropagation()
                        const configured = houseRoles
                        const fromIdx = configured.findIndex((x) => x.toLowerCase().trim() === roleDrag.toLowerCase().trim())
                        const toIdx = configured.findIndex((x) => x.toLowerCase().trim() === key)
                        if (fromIdx < 0 || toIdx < 0) {
                          setRoleDrag(null); setRoleDropTarget(null)
                          return
                        }
                        const next = [...configured]
                        const [moved] = next.splice(fromIdx, 1)
                        next.splice(toIdx, 0, moved)
                        setRoleDrag(null); setRoleDropTarget(null)
                        startTransition(() => { onReorderRoles(next) })
                      }}
                      onClick={() => {
                        if (roleDrag) return
                        onEditRole(r)
                      }}
                      title={t('Edit role · drag to reorder', 'Editar puesto · arrastra para reordenar')}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 8,
                        border: `1px solid ${isDropTarget ? INK : LINE}`,
                        borderRadius: 8, padding: '6px 12px',
                        background: isDropTarget ? '#EFF6FF' : '#fff',
                        font: 'inherit', fontSize: 12, fontWeight: 500,
                        color: '#3F3F46', cursor: 'grab',
                        opacity: isDragging ? 0.4 : 1,
                        transition: 'background 120ms, border-color 120ms',
                      }}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: tone.accent }} />
                      {r}
                    </button>
                  )
                })}

                <button
                  type="button"
                  onClick={onOpenAddRole}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    border: `1px dashed ${LINE}`, borderRadius: 8, padding: '6px 12px',
                    background: 'transparent', font: 'inherit', fontSize: 12, fontWeight: 500,
                    color: MUTED, cursor: 'pointer',
                  }}
                >
                  + {t('Add role', 'Añadir puesto')}
                </button>
                {/* Shading swatches retired — the two-band system
                    (trading vs setup) merged into one continuous
                    shaded region, so a legend explaining the split
                    would be misleading. */}
              </div>
            </div>
          )
        })()}
      </div>

      {/* Bench */}
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 14px', borderBottom: `1px solid ${LINE}` }}>
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('Bench', 'Plantilla')}</div>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: '#EFF6FF', color: SIGNAL, borderRadius: 999,
            padding: '3px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: SIGNAL }} />
            {benchWithAssigned.filter((p) => !p.assigned).length} {t('available', 'disponible')}
          </span>
        </div>
        <div style={{ padding: '12px 14px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {benchWithAssigned.map((p) => {
            const tone = roleToneFor(p.role, roleColors)
            const hrs = weeklyHoursByEmployee.get(p.id) ?? 0
            const isDragging = benchDragId === p.id
            const isDropTarget = benchDropTargetId === p.id && benchDragId !== null && benchDragId !== p.id
            const fadedAssigned = p.assigned && view === 'day'
            return (
              <div
                key={p.id}
                draggable
                onDragStart={(e) => {
                  // Same drag serves two intents: dropped on a day
                  // = schedule; dropped on another bench card =
                  // reorder. The drop target decides.
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', p.id)
                  setDragging(p)
                  setBenchDragId(p.id)
                }}
                onDragEnd={() => {
                  setDragging(null); setDragOverDay(null)
                  setBenchDragId(null); setBenchDropTargetId(null)
                }}
                onDragOver={(e) => {
                  if (!benchDragId || benchDragId === p.id) return
                  e.preventDefault()
                  e.stopPropagation()
                  setBenchDropTargetId(p.id)
                }}
                onDragLeave={(e) => {
                  // Only clear when the cursor actually leaves the
                  // card (not just when it enters a child element).
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return
                  if (benchDropTargetId === p.id) setBenchDropTargetId(null)
                }}
                onDrop={(e) => {
                  if (!benchDragId || benchDragId === p.id) return
                  e.preventDefault()
                  e.stopPropagation()
                  // Compute the new order: remove the dragged id
                  // and splice it in before the target's index.
                  const currentIds = benchWithAssigned.map((x) => x.id)
                  const fromIdx = currentIds.indexOf(benchDragId)
                  const toIdx = currentIds.indexOf(p.id)
                  if (fromIdx < 0 || toIdx < 0) return
                  const next = [...currentIds]
                  const [moved] = next.splice(fromIdx, 1)
                  const insertAt = fromIdx < toIdx ? toIdx : toIdx
                  next.splice(insertAt, 0, moved)
                  setBenchDragId(null); setBenchDropTargetId(null); setDragging(null)
                  startTransition(() => { onReorderBench(next) })
                }}
                onClick={() => onOpenEmployee(p.id)}
                title={t('Open employee · drag to reorder or schedule', 'Abrir empleado · arrastra para reordenar o programar')}
                style={{
                  minWidth: 172,
                  border: `1px solid ${isDropTarget ? INK : LINE}`,
                  borderLeft: `3px solid ${tone.accent}`,
                  borderRadius: 8, padding: '7px 10px',
                  background: isDropTarget ? '#EFF6FF' : (fadedAssigned ? SURFACE : '#fff'),
                  opacity: isDragging ? 0.4 : (fadedAssigned ? 0.6 : 1),
                  cursor: 'grab',
                  transition: 'background 120ms, border-color 120ms',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>{p.name}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: '#71717A', marginLeft: 'auto' }}>{fmtH(hrs)}</span>
                </div>
                <div style={{ fontSize: 11, color: tone.text, marginTop: 1 }}>{p.role}</div>
              </div>
            )
          })}

          {/* + Add employee — mirrors the "+ Add role" affordance in
              the roles legend. Empty state fallback: when there's
              no one on the bench yet, this is the only thing shown
              so the manager has an obvious next step. */}
          <button
            type="button"
            onClick={onOpenAddEmployee}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              border: `1px dashed ${LINE}`, borderRadius: 8, padding: '7px 12px',
              background: 'transparent', font: 'inherit', fontSize: 12, fontWeight: 500,
              color: MUTED, cursor: 'pointer',
            }}
          >
            + {t('Add employee', 'Añadir empleado')}
          </button>
        </div>
      </div>
    </div>
  )
}
