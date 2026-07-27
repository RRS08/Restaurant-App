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

  // Actions — parent wraps server calls + revalidation. Return
  // shape is deliberately wide so the callsite can return any
  // action result verbatim; the component only ever reads
  // `.error` and `.copied` off successful results.
  onOpenEditShift: (shift: CalShift) => void
  onAssignToDay: (employeeId: string, dayIso: string, startHour?: number, endHour?: number) => Promise<ActionResult>
  onSetShiftTime: (shiftId: string, startIso: string, endIso: string) => Promise<ActionResult>
  onRemoveShift: (shiftId: string) => Promise<ActionResult>
  onRepeatLastWeekForDay: (dayIso: string) => Promise<ActionResult>
  onClearDay: (dayIso: string) => Promise<ActionResult>
  onCopyLastWeek: () => Promise<ActionResult>
  onPrevWeek: () => void
  onNextWeek: () => void
  onToday: () => void
  onSave: () => void  // no-op label today; becomes Publish later
  // Role legend actions — the color slug is one of ROLE_TONES's
  // keys (see below). Passing null clears the override so the
  // role falls back to the auto-color regex.
  // Role editing lives in a parent-owned drawer. Chip click →
  // onEditRole(role); "+" button → onOpenAddRole(). The old
  // inline color popover + wage form + inline add input have
  // been retired in favor of the drawer's single editor surface.
  onEditRole: (role: string) => void
  onOpenAddRole: () => void
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
    lang, weekStart, weekDays, shifts, bench, weeklyHoursByEmployee, roleColors,
    onOpenEditShift, onAssignToDay, onSetShiftTime, onRemoveShift,
    onRepeatLastWeekForDay, onClearDay, onCopyLastWeek,
    onPrevWeek, onNextWeek, onToday, onSave,
    onEditRole, onOpenAddRole,
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
  const [savedFlash, setSavedFlash] = useState(false)
  const [copyMsg, setCopyMsg] = useState<string | null>(null)
  // Role editing moved to a parent-owned drawer — no legend-local
  // state needed anymore.

  // ---- Time axis — dynamic min/max ± 1.5h padding, capped 0–24 --
  const axis = useMemo(() => {
    let minH = 24, maxH = 0
    for (const s of shifts) {
      const sh = new Date(s.startTime).getHours() + new Date(s.startTime).getMinutes() / 60
      const eh = new Date(s.endTime).getHours() + new Date(s.endTime).getMinutes() / 60
      if (sh < minH) minH = sh
      if (eh > maxH) maxH = eh
    }
    if (minH >= maxH) { minH = 10; maxH = 22 }
    minH = Math.max(0, Math.floor(minH - 1.5))
    maxH = Math.min(24, Math.ceil(maxH + 1.5))
    const T0 = minH * 60
    const SPAN = (maxH - minH) * 60
    return { T0, SPAN, minH, maxH }
  }, [shifts])

  const pct = (minutes: number) => ((minutes - axis.T0) / axis.SPAN) * 100
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

  // Day-inferred open range (earliest start → latest end for that day).
  // Falls back to null (Closed) when no shifts scheduled.
  const openRangeForDay = (dayIdx: number): { startPct: number; widthPct: number } | null => {
    const list = shiftsByDay.get(dayIdx) ?? []
    if (list.length === 0) return null
    const startMin = Math.min(...list.map((s) => minutesInDay(s.startTime)))
    const endMin = Math.max(...list.map((s) => minutesInDay(s.endTime)))
    return { startPct: pct(startMin), widthPct: pct(endMin) - pct(startMin) }
  }

  const weekLabel = `${weekDays[0].toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })} – ${weekDays[6].toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: 'numeric' })}`
  const totalShifts = shifts.length
  const totalHours = shifts.reduce((n, s) => n + hoursBetween(s.startTime, s.endTime), 0)

  const day = weekDays[dayIndex]
  const dayShifts = shiftsByDay.get(dayIndex) ?? []
  const dayOpen = openRangeForDay(dayIndex)
  const dayTotalH = dayShifts.reduce((n, s) => n + hoursBetween(s.startTime, s.endTime), 0)
  const dayLongLabel = day.toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' })

  const benchWithAssigned = useMemo(
    () => bench.map((p) => ({ ...p, assigned: dayShifts.some((s) => s.employeeId === p.id) })),
    [bench, dayShifts],
  )

  // ---- Handlers -------------------------------------------------
  const handleDayDrop = (idx: number) => {
    if (!dragging) return
    const emp = dragging
    setDragging(null); setDragOverDay(null)
    startTransition(() => {
      onAssignToDay(emp.id, weekDays[idx].toISOString())
    })
  }
  const handleSetShiftTime = (shift: CalShift) => {
    // Default set = fill the day's inferred open hours, or 9–5 if empty.
    const open = openRangeForDay(dayIndex)
    let startMin: number, endMin: number
    if (open) {
      startMin = axis.T0 + (open.startPct / 100) * axis.SPAN
      endMin = axis.T0 + ((open.startPct + open.widthPct) / 100) * axis.SPAN
    } else {
      startMin = 9 * 60; endMin = 17 * 60
    }
    const startDate = new Date(day); startDate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0)
    const endDate = new Date(day); endDate.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0)
    startTransition(() => {
      onSetShiftTime(shift.id, startDate.toISOString(), endDate.toISOString())
    })
  }
  const handleRemove = (shift: CalShift) => {
    startTransition(() => { onRemoveShift(shift.id) })
  }
  const handleRepeat = () => {
    startTransition(() => { onRepeatLastWeekForDay(day.toISOString()) })
  }
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
  const handleSave = () => {
    onSave()
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1500)
  }

  // ---- Styles ---------------------------------------------------
  const tab = (active: boolean, first: boolean): React.CSSProperties => ({
    border: 0,
    borderLeft: first ? undefined : `1px solid ${LINE}`,
    background: active ? INK : '#fff',
    color: active ? PAPER : '#52525B',
    padding: '5px 11px',
    font: 'inherit', fontSize: 11, fontWeight: active ? 600 : 500,
    cursor: 'pointer',
  })
  const ghostBtn: React.CSSProperties = {
    border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8,
    padding: '6px 12px', font: 'inherit', fontSize: 12, fontWeight: 500,
    color: '#3F3F46', cursor: 'pointer',
  }

  const openBand = (open: { startPct: number; widthPct: number } | null, today?: boolean) =>
    open ? (
      <div style={{
        position: 'absolute',
        left: `${open.startPct}%`, width: `${open.widthPct}%`,
        top: 0, bottom: 0,
        background: today ? '#EFF6FF' : SURFACE,
        borderLeft: `1px solid ${today ? '#DBEAFE' : LINE}`,
        borderRight: `1px solid ${today ? '#DBEAFE' : LINE}`,
      }} />
    ) : null

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
        onClick={() => onOpenEditShift(s)}
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, color: INK, fontFamily: "'Geist', system-ui, sans-serif" }}>
      {/* Board */}
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '5px 14px', borderBottom: `1px solid ${LINE}`,
          background: '#fff', position: 'sticky', top: 0, zIndex: 3, flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', border: `1px solid ${LINE}`, borderRadius: 8, overflow: 'hidden' }}>
            <button onClick={onPrevWeek} style={{ border: 0, background: '#fff', padding: '5px 10px', font: 'inherit', fontSize: 13, color: '#52525B', cursor: 'pointer' }}>‹</button>
            <button onClick={onToday} style={{ border: 0, borderLeft: `1px solid ${LINE}`, borderRight: `1px solid ${LINE}`, background: '#fff', padding: '5px 12px', font: 'inherit', fontSize: 12, fontWeight: 500, color: '#3F3F46', cursor: 'pointer' }}>{t('Today', 'Hoy')}</button>
            <button onClick={onNextWeek} style={{ border: 0, background: '#fff', padding: '5px 10px', font: 'inherit', fontSize: 13, color: '#52525B', cursor: 'pointer' }}>›</button>
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
            {view === 'day' ? dayLongLabel : weekLabel}
          </span>
          <span style={{ width: 1, height: 16, background: LINE }} />
          <span style={{ fontFamily: MONO, fontSize: 11, color: '#3F3F46', whiteSpace: 'nowrap' }}>
            {view === 'day' ? `${dayShifts.length} ${t('on staff', 'en el equipo')}` : `${totalShifts} ${totalShifts === 1 ? t('shift', 'turno') : t('shifts', 'turnos')}`}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: '#3F3F46' }}>
            {fmtH(view === 'day' ? dayTotalH : totalHours)}
          </span>
          {copyMsg && (
            <span style={{ fontSize: 11, color: SIGNAL }}>{copyMsg}</span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={handleCopyLastWeek} style={ghostBtn}>{t('Copy last week', 'Copiar semana pasada')}</button>
            <button
              onClick={handleSave}
              style={{
                border: 0, background: savedFlash ? '#059669' : INK, color: PAPER,
                borderRadius: 8, padding: '6px 14px', font: 'inherit', fontSize: 12,
                fontWeight: 600, cursor: 'pointer', transition: 'background 200ms',
              }}
            >
              {savedFlash ? t('Saved ✓', 'Guardado ✓') : t('Save', 'Guardar')}
            </button>
            <div style={{ display: 'flex', border: `1px solid ${LINE}`, borderRadius: 8, overflow: 'hidden' }}>
              <button style={tab(view === 'day', true)} onClick={() => setView('day')}>{t('Day', 'Día')}</button>
              <button style={tab(view === 'week', false)} onClick={() => setView('week')}>{t('Week', 'Semana')}</button>
            </div>
          </div>
        </div>

        {view === 'week' ? (
          <div style={{ minWidth: 900 }}>
            {/* Hour ruler */}
            <div style={{ display: 'flex', borderBottom: `1px solid ${LINE}`, background: SURFACE, position: 'sticky', top: 41, zIndex: 2 }}>
              <div style={{ width: 132, flex: '0 0 132px', borderRight: `1px solid ${LINE}` }} />
              <div style={{ position: 'relative', height: 18, flex: 1, minWidth: 0 }}>
                {TICKS.map((tick) => (
                  <span key={tick.hour} style={{ position: 'absolute', left: `${tick.left}%`, top: 4, fontFamily: MONO, fontSize: 9, color: MUTED }}>
                    {fmtHourShort(tick.hour)}
                  </span>
                ))}
              </div>
            </div>

            {/* Day rows */}
            {weekDays.map((d, idx) => {
              const list = shiftsByDay.get(idx) ?? []
              const isToday = sameDay(d, new Date())
              const open = openRangeForDay(idx)
              const dayHours = list.reduce((n, s) => n + hoursBetween(s.startTime, s.endTime), 0)
              const isOver = dragOverDay === idx
              if (list.length === 0) {
                return (
                  <div
                    key={idx}
                    onDragOver={(e) => { e.preventDefault(); setDragOverDay(idx) }}
                    onDragLeave={() => setDragOverDay(null)}
                    onDrop={() => handleDayDrop(idx)}
                    style={{
                      display: 'flex', borderBottom: `1px solid ${LINE}`,
                      background: isOver ? '#EFF6FF' : SURFACE,
                    }}
                  >
                    <div style={{ width: 132, flex: '0 0 132px', borderRight: `1px solid ${LINE}`, padding: '3px 12px' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: isToday ? SIGNAL : FAINT }}>
                        {d.toLocaleDateString(dateLocale, { weekday: 'short' })} {d.getDate()}
                      </span>
                    </div>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', paddingLeft: 12, height: 18 }}>
                      <span style={{ fontSize: 11, color: isOver ? SIGNAL : FAINT }}>
                        {isOver ? t('Drop to schedule', 'Suelta para programar') : t('No shifts scheduled', 'Sin turnos programados')}
                      </span>
                    </div>
                  </div>
                )
              }
              // Consistent day-row footprint. Every day gets at least
              // WEEK_DAY_MIN_H so a light day doesn't look cramped
              // against a stacked one. Rows expand naturally when the
              // day's shifts exceed that floor.
              const barH = 22
              const barGap = 4
              const contentH = list.length * barH + Math.max(0, list.length - 1) * barGap
              const WEEK_DAY_MIN_H = 84
              const dayRowH = Math.max(WEEK_DAY_MIN_H, contentH + 16)
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
                  <div style={{
                    width: 132, flex: '0 0 132px', borderRight: `1px solid ${LINE}`,
                    padding: '10px 12px',
                    borderLeft: isToday ? `3px solid ${SIGNAL}` : undefined,
                    marginLeft: isToday ? -3 : undefined,
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: isToday ? SIGNAL : INK }}>
                      {d.toLocaleDateString(dateLocale, { weekday: 'short' })} {d.getDate()}
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 10, color: isToday ? SIGNAL : MUTED, whiteSpace: 'nowrap', marginTop: 2 }}>
                      {list.length} {list.length === 1 ? t('shift', 'turno') : t('shifts', 'turnos')}
                      <span style={{ color: FAINT, margin: '0 4px' }}>·</span>
                      {fmtH(dayHours).toUpperCase()}
                    </div>
                  </div>
                  <div style={{ position: 'relative', flex: 1, minWidth: 0, padding: '8px 0' }}>
                    {openBand(open, isToday)}
                    {list.map((s, i) => (
                      <div
                        key={s.id}
                        style={{
                          position: 'relative',
                          height: barH,
                          marginBottom: i === list.length - 1 ? 0 : barGap,
                        }}
                      >
                        {renderShiftBar(s, barH)}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}

            {/* Roles legend — clickable chips. Click a role to open
                a color palette + settings popover; click "+ Add role"
                to inline-add. Bigger than the prior legend so it
                doubles as the management surface for role identity. */}
            {(() => {
              // Roles in the legend = union of (bench roles + scheduled
              // roles). Bench roles ensure a newly-added role shows
              // even before it's scheduled anywhere.
              const seen = new Set<string>()
              const roles: string[] = []
              for (const src of [bench.map((p) => p.role), shifts.map((s) => s.role)]) {
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
                      return (
                        <button
                          key={r}
                          type="button"
                          onClick={() => onEditRole(r)}
                          title={t('Edit role', 'Editar puesto')}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 8,
                            border: `1px solid ${LINE}`,
                            borderRadius: 8, padding: '6px 12px',
                            background: '#fff', font: 'inherit', fontSize: 12, fontWeight: 500,
                            color: '#3F3F46', cursor: 'pointer',
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
                  </div>
                </div>
              )
            })()}
          </div>
        ) : (
          <>
            {/* Day pills */}
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${LINE}`, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {weekDays.map((d, i) => {
                const active = i === dayIndex
                const hasShifts = (shiftsByDay.get(i) ?? []).length > 0
                return (
                  <button
                    key={i}
                    onClick={() => setDayIndex(i)}
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 6,
                      border: `1px solid ${active ? INK : LINE}`,
                      background: active ? INK : hasShifts ? '#fff' : SURFACE,
                      color: active ? PAPER : hasShifts ? '#3F3F46' : FAINT,
                      borderRadius: 8, padding: '6px 11px', font: 'inherit', cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontSize: 11 }}>{d.toLocaleDateString(dateLocale, { weekday: 'short' })}</span>
                    <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>{d.getDate()}</span>
                  </button>
                )
              })}
            </div>

            <div style={{ padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 10, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.02em' }}>{dayLongLabel}</div>
                  <div style={{ fontFamily: MONO, fontSize: 11, color: MUTED, marginTop: 2 }}>
                    {dayShifts.length > 0
                      ? `${dayShifts.length} ${t('ON STAFF', 'EN EL EQUIPO')} · ${fmtH(dayTotalH).toUpperCase()}`
                      : t('NO SHIFTS YET', 'SIN TURNOS AÚN')}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 7 }}>
                  <button style={ghostBtn} onClick={handleRepeat}>{t('Repeat last week', 'Repetir semana pasada')}</button>
                  {dayShifts.length > 0 && (
                    <button style={ghostBtn} onClick={handleClear}>{t('Clear day', 'Vaciar día')}</button>
                  )}
                </div>
              </div>

              <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
                {/* Ruler */}
                <div style={{ display: 'flex', background: SURFACE, borderBottom: `1px solid ${LINE}` }}>
                  <div style={{ width: 150, flex: '0 0 150px', borderRight: `1px solid ${LINE}`, padding: '6px 12px', display: 'flex', alignItems: 'center' }}>
                    <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: MUTED }}>{t('STAFF', 'EQUIPO')}</span>
                  </div>
                  <div style={{ position: 'relative', flex: 1, minWidth: 0, height: 24 }}>
                    {TICKS.map((tick) => (
                      <span key={tick.hour} style={{ position: 'absolute', left: `${tick.left}%`, top: 5, fontFamily: MONO, fontSize: 10, color: MUTED }}>
                        {fmtHourShort(tick.hour)}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Staff lanes */}
                {dayShifts.map((s) => {
                  const tone = roleToneFor(s.role, roleColors)
                  const dur = hoursBetween(s.startTime, s.endTime)
                  const isPlaceholder = dur === 0
                  return (
                    <div key={s.id} style={{ display: 'flex', borderBottom: `1px solid ${LINE_SOFT}`, alignItems: 'stretch' }}>
                      <div style={{ width: 150, flex: '0 0 150px', borderRight: `1px solid ${LINE}`, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {s.employeeName}
                          </div>
                          <div style={{ fontSize: 11, color: tone.text, whiteSpace: 'nowrap' }}>{s.role}</div>
                        </div>
                        <button
                          onClick={() => handleRemove(s)}
                          style={{ border: 0, background: 'transparent', color: '#D6D5D1', font: 'inherit', fontSize: 14, lineHeight: 1, cursor: 'pointer', padding: 2 }}
                          aria-label={t('Remove', 'Quitar')}
                        >
                          ×
                        </button>
                      </div>
                      <div style={{ position: 'relative', flex: 1, minWidth: 0, padding: '5px 0' }}>
                        {openBand(dayOpen)}
                        {hourLines}
                        <div style={{ position: 'relative', height: 34 }}>
                          {!isPlaceholder ? (
                            renderShiftBar(s, 34, false)
                          ) : (
                            <button
                              onClick={() => handleSetShiftTime(s)}
                              style={{
                                position: 'absolute',
                                left: dayOpen ? `${dayOpen.startPct}%` : '0%',
                                width: dayOpen ? `${dayOpen.widthPct}%` : '100%',
                                height: 34, borderRadius: 7,
                                border: `1px dashed ${tone.accent}66`,
                                background: 'transparent', display: 'flex', alignItems: 'center',
                                justifyContent: 'center', gap: 8, font: 'inherit',
                                cursor: 'pointer', color: MUTED,
                              }}
                            >
                              <span style={{ fontSize: 11, fontWeight: 500 }}>{t('Set shift time', 'Definir horario')}</span>
                              <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{t('tap to fill open hours', 'toca para llenar horas de servicio')}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}

                {/* Drop zone */}
                <div style={{ display: 'flex', alignItems: 'stretch', background: '#FCFCFB' }}>
                  <div style={{ width: 150, flex: '0 0 150px', borderRight: `1px solid ${LINE}`, padding: '6px 12px', display: 'flex', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: FAINT }}>{dayShifts.length ? t('Add someone', 'Añadir alguien') : t('No one yet', 'Nadie aún')}</span>
                  </div>
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOverDay(dayIndex) }}
                    onDragLeave={() => setDragOverDay(null)}
                    onDrop={() => handleDayDrop(dayIndex)}
                    style={{
                      position: 'relative', flex: 1, minWidth: 0, padding: '5px 0',
                      background: dragOverDay === dayIndex ? '#EFF6FF' : undefined,
                      outline: dragOverDay === dayIndex ? '2px dashed #93C5FD' : undefined,
                      outlineOffset: -4,
                    }}
                  >
                    {openBand(dayOpen)}
                    {hourLines}
                    {dayShifts.length ? (
                      <div style={{ position: 'relative', height: 34, display: 'flex', alignItems: 'center', padding: '0 10px' }}>
                        <span style={{ fontSize: 11, color: FAINT }}>
                          {t('Drop another name from the bench to add them to the staff', 'Suelta otro nombre desde la plantilla para añadirlo al equipo')}
                        </span>
                      </div>
                    ) : (
                      <div style={{ position: 'relative', height: 120, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#52525B' }}>{t('Nobody on staff for this day yet', 'Nadie en el equipo para este día aún')}</span>
                        <span style={{ fontSize: 12, color: FAINT }}>
                          {t('Drag people from the bench to build the day’s staff — then set each shift’s time.', 'Arrastra personas desde la plantilla para construir el equipo del día — luego define el horario de cada turno.')}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Bench */}
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 14px', borderBottom: `1px solid ${LINE}` }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('Bench', 'Plantilla')}</div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>
              {t('Available staff — drag onto a day to schedule.', 'Personal disponible — arrastra a un día para programar.')}
            </div>
          </div>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: '#EFF6FF', color: SIGNAL, borderRadius: 999,
            padding: '3px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: SIGNAL }} />
            {benchWithAssigned.filter((p) => !p.assigned).length} {t('available', 'disponible')}
          </span>
        </div>
        <div style={{ padding: '12px 14px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {benchWithAssigned.length === 0 ? (
            <p style={{ fontSize: 12, color: FAINT, margin: '6px 0' }}>
              {t('No employees yet — add one from the toolbar above.', 'Sin empleados aún — añade uno desde la barra superior.')}
            </p>
          ) : benchWithAssigned.map((p) => {
            const tone = roleToneFor(p.role, roleColors)
            const hrs = weeklyHoursByEmployee.get(p.id) ?? 0
            return (
              <div
                key={p.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', p.id)
                  setDragging(p)
                }}
                onDragEnd={() => { setDragging(null); setDragOverDay(null) }}
                onClick={() => {
                  // Click on bench in day view = add to today (day view's dayIndex)
                  if (view === 'day') {
                    startTransition(() => {
                      onAssignToDay(p.id, day.toISOString())
                    })
                  }
                }}
                style={{
                  minWidth: 172,
                  border: `1px solid ${LINE}`,
                  borderLeft: `3px solid ${tone.accent}`,
                  borderRadius: 8, padding: '7px 10px',
                  background: p.assigned && view === 'day' ? SURFACE : '#fff',
                  opacity: p.assigned && view === 'day' ? 0.6 : 1,
                  cursor: 'grab',
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
        </div>
      </div>
    </div>
  )
}
