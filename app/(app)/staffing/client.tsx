'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState, useActionState, useTransition, type DragEvent } from 'react'
import { useRouter } from 'next/navigation'
import {
  quickAssignShift,
  copyPreviousWeek,
  updateShiftTimes,
  deleteShiftById,
  createEmployee,
  updateEmployee,
  archiveEmployee,
  createShift,
  updateShift,
  deleteShift,
  addStaffingRole,
  setRoleColor,
  createShiftSection,
  updateShiftSection,
  deleteShiftSection,
} from '@/app/actions/staffing'
import { normalizeNameKey } from '@/lib/strings/names'
import { makeT, type Lang } from '@/lib/i18n'
import StaffingCalendar, { type CalShift, type CalEmployee } from './staffing-calendar'

type T = (en: string, es?: string) => string

// Localized day-of-week short labels (Mon→Lun, etc.). Indexed
// Mon=0 … Sun=6 to match the existing DAYS array shape.
function localizedDays(t: T): string[] {
  return [
    t('Mon', 'Lun'),
    t('Tue', 'Mar'),
    t('Wed', 'Mié'),
    t('Thu', 'Jue'),
    t('Fri', 'Vie'),
    t('Sat', 'Sáb'),
    t('Sun', 'Dom'),
  ]
}

interface Employee { id: string; name: string; role: string; primaryLocationId: string }
interface Section { id: string; name: string; role: string; area: 'foh' | 'boh'; defaultStartHour: number; defaultEndHour: number; sortOrder: number }
interface Shift {
  id: string; locationId: string; employeeId: string; sectionId: string | null
  employeeName: string; role: string; startTime: string; endTime: string; notes: string | null
}
interface Props {
  lang: Lang
  defaultLocationId: string | null; employees: Employee[]; shifts: Shift[]; sections: Section[]
  houseModel: 'split' | 'unified'
  schedulingStyle: 'by_role' | 'by_team'
  fohRoles: string[]; bohRoles: string[]
  /** Owner-picked color overrides per role. Keys are normalized
   *  role names (lowercase, trimmed), values are color slugs from
   *  ROLE_COLOR_PALETTE. Consulted by roleTone() before the auto-
   *  color regex. Empty object when no overrides exist yet. */
  roleColors: Record<string, string>
}

function getMonday(d: Date) { const date = new Date(d); const day = date.getDay(); date.setDate(date.getDate() - (day === 0 ? 6 : day - 1)); date.setHours(0,0,0,0); return date }
function getWeekDays(mon: Date) { return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d }) }
function sameDay(a: Date, b: Date) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() }
function fmt(d: string) { return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }
function fmtMonthDay(d: string | Date, lang: Lang = 'en') {
  return new Date(d).toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', { month: 'short', day: 'numeric' })
}
// Human-readable hour label for block times. Blocks store hours
// as 0-24 integers; this renders them with an AM/PM suffix so
// the schedule column header and drawer subtitles read the way
// people talk about shifts ("9AM–5PM"). No space between the
// number and AM/PM — the schedule row uses `font-mono` and a
// regular space renders as a full monospace character width,
// leaving a visually large gap.
function hL(h: number) {
  if (h === 0 || h === 24) return '12AM'
  if (h === 12) return '12PM'
  return h < 12 ? `${h}AM` : `${h - 12}PM`
}
// 24-hour options for the block start/end pickers. Rendered as
// AM/PM labels but the underlying value stays a 0-24 int so the
// server action + DB column don't need to change.
const HOUR_OPTIONS: Array<{ value: number; label: string }> =
  Array.from({ length: 25 }, (_, h) => ({ value: h, label: hL(h) }))
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

// ----------------------------------------------------------------
// Role color system.
//
// Maps role-name substrings to a small, calm color token set so the
// bench + schedule scan well at scale. Role identity uses a tiny
// colored dot + tinted role text + a 2px left accent stripe on
// cards — never a full background wash.
//
// House colors are RESERVED and never reused as role colors:
//   • Front of House → blue / sky    (reserved)
//   • Back of House  → amber / yellow / orange (reserved)
// The role palette below is built from the remaining color families
// so the manager can never confuse "house identity" with "role
// identity" when both are visible at once.
//
// Matching is by substring + lowercase so user-typed variants
// resolve cleanly: "Server", "head server", "waitstaff" all hit the
// same token. Unknown roles default to gray.
// ----------------------------------------------------------------
type RoleTone = {
  text: string
  chip: string
  dot: string
}
const ROLE_GRAY: RoleTone = {
  text: 'text-gray-600',
  chip: 'bg-gray-100 text-gray-700',
  dot: 'bg-gray-400',
}
const ROLE_MAP: Array<{ test: RegExp; tone: RoleTone }> = [
  // FOH-adjacent — purple / teal / rose, never blue.
  { test: /server|wait/,           tone: { text: 'text-purple-700',  chip: 'bg-purple-50 text-purple-700',   dot: 'bg-purple-500'  } },
  { test: /host/,                  tone: { text: 'text-teal-700',    chip: 'bg-teal-50 text-teal-700',       dot: 'bg-teal-500'    } },
  { test: /bartender|bar(\s|$)/,   tone: { text: 'text-rose-700',    chip: 'bg-rose-50 text-rose-700',       dot: 'bg-rose-500'    } },
  // Busser / Runner split — slate (gray-blue) vs emerald, both off
  // the FOH blue axis.
  { test: /busser/,                tone: { text: 'text-slate-700',   chip: 'bg-slate-100 text-slate-700',    dot: 'bg-slate-500'   } },
  { test: /runner/,                tone: { text: 'text-emerald-700', chip: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' } },
  // Manager — zinc reads as a deliberate neutral-dark identity,
  // distinct from busser's slate and from the default gray.
  { test: /manager|lead|supervis/, tone: { text: 'text-zinc-800',    chip: 'bg-zinc-100 text-zinc-800',      dot: 'bg-zinc-700'    } },
  // BOH-adjacent — stone / red / lime, never amber/yellow/orange.
  { test: /prep/,                  tone: { text: 'text-stone-700',   chip: 'bg-stone-100 text-stone-700',    dot: 'bg-stone-500'   } },
  { test: /line|cook|chef|grill/,  tone: { text: 'text-red-700',     chip: 'bg-red-50 text-red-700',         dot: 'bg-red-500'     } },
  { test: /dish/,                  tone: { text: 'text-lime-700',    chip: 'bg-lime-50 text-lime-700',       dot: 'bg-lime-500'    } },
  // Expo — violet, distinct from server's purple by tone bias.
  { test: /expo|pass/,             tone: { text: 'text-violet-700',  chip: 'bg-violet-50 text-violet-700',   dot: 'bg-violet-500'  } },
]
// Owner-picked palette. Slugs here MUST match the VALID_ROLE_COLORS
// set in app/actions/staffing.ts — they're the storage form. When
// changing this list, update both sides.
const ROLE_COLOR_PALETTE = [
  'purple', 'teal', 'rose', 'slate', 'emerald',
  'zinc', 'stone', 'red', 'lime', 'violet',
  'amber', 'sky', 'gray',
] as const
type RoleColorSlug = typeof ROLE_COLOR_PALETTE[number]

const COLOR_TONES: Record<RoleColorSlug, RoleTone> = {
  purple:  { text: 'text-purple-700',  chip: 'bg-purple-50 text-purple-700',   dot: 'bg-purple-500'  },
  teal:    { text: 'text-teal-700',    chip: 'bg-teal-50 text-teal-700',       dot: 'bg-teal-500'    },
  rose:    { text: 'text-rose-700',    chip: 'bg-rose-50 text-rose-700',       dot: 'bg-rose-500'    },
  slate:   { text: 'text-slate-700',   chip: 'bg-slate-100 text-slate-700',    dot: 'bg-slate-500'   },
  emerald: { text: 'text-emerald-700', chip: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  zinc:    { text: 'text-zinc-800',    chip: 'bg-zinc-100 text-zinc-800',      dot: 'bg-zinc-700'    },
  stone:   { text: 'text-stone-700',   chip: 'bg-stone-100 text-stone-700',    dot: 'bg-stone-500'   },
  red:     { text: 'text-red-700',     chip: 'bg-red-50 text-red-700',         dot: 'bg-red-500'     },
  lime:    { text: 'text-lime-700',    chip: 'bg-lime-50 text-lime-700',       dot: 'bg-lime-500'    },
  violet:  { text: 'text-violet-700',  chip: 'bg-violet-50 text-violet-700',   dot: 'bg-violet-500'  },
  amber:   { text: 'text-amber-800',   chip: 'bg-amber-50 text-amber-800',     dot: 'bg-amber-500'   },
  sky:     { text: 'text-sky-700',     chip: 'bg-sky-50 text-sky-700',         dot: 'bg-sky-500'     },
  gray:    { text: 'text-gray-600',    chip: 'bg-gray-100 text-gray-700',      dot: 'bg-gray-400'    },
}

// Human-readable label for each color, for the palette picker.
const COLOR_LABELS: Record<RoleColorSlug, { en: string; es: string }> = {
  purple:  { en: 'Purple',  es: 'Morado'  },
  teal:    { en: 'Teal',    es: 'Turquesa'},
  rose:    { en: 'Rose',    es: 'Rosa'    },
  slate:   { en: 'Slate',   es: 'Pizarra' },
  emerald: { en: 'Emerald', es: 'Esmeralda'},
  zinc:    { en: 'Charcoal',es: 'Carbón'  },
  stone:   { en: 'Stone',   es: 'Piedra'  },
  red:     { en: 'Red',     es: 'Rojo'    },
  lime:    { en: 'Lime',    es: 'Lima'    },
  violet:  { en: 'Violet',  es: 'Violeta' },
  amber:   { en: 'Amber',   es: 'Ámbar'   },
  sky:     { en: 'Sky',     es: 'Cielo'   },
  gray:    { en: 'Gray',    es: 'Gris'    },
}

// Context carries the owner's saved role→color map so any component
// rendering a role chip can pick up the override without prop-drilling
// through 5+ layers. Default is empty (regex fallback for everyone).
const RoleColorsContext = createContext<Record<string, string>>({})

/** Resolve a role's visual tone.
 *
 *  Precedence:
 *    1. Owner override (RoleColorsContext / passed map)
 *    2. Auto-color regex (ROLE_MAP)
 *    3. Gray fallback
 *
 *  The colorMap param is optional so this stays callable from
 *  non-React contexts if needed. React components normally read
 *  the context via useContext(RoleColorsContext) and pass it in. */
function roleTone(role: string, colorMap?: Record<string, string>): RoleTone {
  const key = normalizeNameKey(role ?? '')
  if (!key) return ROLE_GRAY
  if (colorMap && colorMap[key]) {
    const t = COLOR_TONES[colorMap[key] as RoleColorSlug]
    if (t) return t
  }
  const r = (role ?? '').toLowerCase().trim()
  for (const m of ROLE_MAP) {
    if (m.test.test(r)) return m.tone
  }
  return ROLE_GRAY
}

// ----------------------------------------------------------------
// Role ordering for the bench + per-cell shift sort.
//
// The bench stays one continuous grid — no section headers — but
// employees are sorted so people of the same role naturally line
// up next to each other (Host, Host, Host, Server, Server, …).
// Within a role, sort by name. Unknown roles drop to the end.
//
// FOH order: Manager → Host → Server → Bartender → Runner →
//            Busser → Expo → other.
// BOH order: Manager → Prep Cook → Line Cook → Cook → Dishwasher →
//            other.
// Unified houses use FOH order as the canonical ordering.
// ----------------------------------------------------------------
function roleSortIndex(role: string, house: 'foh' | 'boh'): number {
  const r = (role ?? '').toLowerCase().trim()
  if (house === 'boh') {
    if (/manager|lead|supervis/.test(r))   return 1
    if (/prep/.test(r))                    return 2
    if (/line/.test(r))                    return 3
    if (/cook|chef|grill/.test(r))         return 4
    if (/dish/.test(r))                    return 5
    return 99
  }
  // FOH (and unified) ordering.
  if (/manager|lead|supervis/.test(r))     return 1
  if (/host/.test(r))                      return 2
  if (/server|wait/.test(r))               return 3
  if (/bartender|bar(\s|$)/.test(r))       return 4
  if (/runner/.test(r))                    return 5
  if (/busser/.test(r))                    return 6
  if (/expo|pass/.test(r))                 return 7
  return 99
}

// HoursIndicator — restrained per-tier text label + optional pill.
// • normal/caution: text-only color so low-signal cases stay quiet.
// • near/over: a soft pill so 40+ hour employees pop at a glance.
// Always font-mono tabular-nums so digit columns don't dance between cards.
// HoursIndicator — restrained per-tier label. Per the status-
// signaling rule, no tier relies on lightness alone:
//   • 0h        → text-gray-600 "Unscheduled" pill (visible, calm)
//                 — managers need to spot people without shifts;
//                 faint gray-300 made them disappear.
//   • normal    → text-gray-700 plain text (quiet, not faint)
//   • caution   → text-amber-700 plain text (soft warning)
//   • near (40) → amber pill (text-amber-800, bg-amber-100)
//   • over (>40)→ red pill (text-red-700, bg-red-50)
// Always font-mono tabular-nums so digit columns line up across cards.
function HoursIndicator({ hours, tier, t }: { hours: number; tier: HoursTier; t: T }) {
  if (hours <= 0) {
    return (
      <span
        className="text-[10px] font-medium font-mono tabular-nums text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded flex-shrink-0"
        aria-label={t('No shifts scheduled this week', 'Sin turnos programados esta semana')}
        title={t('No shifts scheduled this week', 'Sin turnos programados esta semana')}
      >
        {t('Unscheduled', 'Sin programar')}
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
    ? t(' — over 40 hours, overtime risk', ' — más de 40 horas, riesgo de tiempo extra')
    : tier === 'near'
      ? t(' — at 40-hour limit', ' — en el límite de 40 horas')
      : tier === 'caution'
        ? t(' — approaching full time', ' — acercándose a tiempo completo')
        : ''
  const thisWeek = t(' this week', ' esta semana')
  return (
    <span
      className={`text-[10px] font-mono tabular-nums flex-shrink-0 ${className}`}
      aria-label={`${formatHours(hours)}${thisWeek}${ariaSuffix}`}
      title={`${formatHours(hours)}${thisWeek}${ariaSuffix}`}
    >
      {formatHours(hours)}
    </span>
  )
}


// ----------------------------------------------------------------
// RoleColorPalette — compact strip that lists every role currently
// configured for the visible house and lets the owner assign a
// display color to each. Sits above the bench so the manager can
// eyeball the current mapping and change it without opening any
// drawer.
//
// Each chip shows the role name, a dot in the current color, and
// opens a small popover with the full palette when clicked. Auto
// (regex) color falls back to a gray dot with a subtle border so
// it reads as "no override set."
// ----------------------------------------------------------------
function RoleColorPalette({ roles, t }: { roles: string[]; t: T }) {
  const roleColors = useContext(RoleColorsContext)
  const [openRole, setOpenRole] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const containerRef = useRef<HTMLDivElement>(null)

  // Click-outside handler — close the open popover whenever the
  // user taps outside the palette container.
  useEffect(() => {
    if (!openRole) return
    const onDoc = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpenRole(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [openRole])

  if (roles.length === 0) return null

  const pick = (role: string, slug: RoleColorSlug | '') => {
    const fd = new FormData()
    fd.set('role', role)
    fd.set('color', slug)
    startTransition(async () => {
      await setRoleColor(fd)
      setOpenRole(null)
    })
  }

  return (
    <div
      ref={containerRef}
      className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2 mb-3 flex items-center gap-3 flex-wrap"
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 flex-shrink-0">
        {t('Role colors', 'Colores de puesto')}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {roles.map((role) => {
          const key = normalizeNameKey(role)
          const currentSlug = roleColors[key] as RoleColorSlug | undefined
          const tone = roleTone(role, roleColors)
          const isOpen = openRole === role
          return (
            <div key={role} className="relative">
              <button
                type="button"
                onClick={() => setOpenRole(isOpen ? null : role)}
                disabled={pending}
                className={`inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-medium hover:border-gray-300 transition-colors disabled:opacity-60 ${tone.text}`}
                aria-label={t(`Change color for ${role}`, `Cambiar color para ${role}`)}
                aria-haspopup="true"
                aria-expanded={isOpen}
              >
                <span className={`w-2 h-2 rounded-full ${tone.dot}`} />
                {role}
              </button>
              {isOpen && (
                <div
                  className="absolute z-30 mt-1 left-0 min-w-[220px] rounded-lg border border-gray-200 bg-white shadow-lg p-2"
                  role="listbox"
                  aria-label={t(`Colors for ${role}`, `Colores para ${role}`)}
                >
                  <div className="grid grid-cols-6 gap-1.5">
                    {ROLE_COLOR_PALETTE.map((slug) => {
                      const active = currentSlug === slug
                      const swatchTone = COLOR_TONES[slug]
                      return (
                        <button
                          key={slug}
                          type="button"
                          onClick={() => pick(role, slug)}
                          disabled={pending}
                          title={COLOR_LABELS[slug].en}
                          aria-label={COLOR_LABELS[slug].en}
                          aria-selected={active}
                          className={`h-6 w-6 rounded-full flex items-center justify-center transition-transform hover:scale-110 disabled:opacity-60 ${active ? 'ring-2 ring-offset-1 ring-gray-900' : ''}`}
                        >
                          <span className={`h-4 w-4 rounded-full ${swatchTone.dot}`} />
                        </button>
                      )
                    })}
                  </div>
                  {currentSlug && (
                    <button
                      type="button"
                      onClick={() => pick(role, '')}
                      disabled={pending}
                      className="mt-2 w-full text-[10px] font-medium text-gray-500 hover:text-gray-900 py-1 disabled:opacity-60"
                    >
                      {t('Reset to auto', 'Restablecer a auto')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function StaffingClient({ lang, defaultLocationId, employees, shifts, sections, houseModel, schedulingStyle, fohRoles, bohRoles, roleColors }: Props) {
  const t = makeT(lang)
  const DAYS = localizedDays(t)
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
  const router = useRouter()

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
  const houseEmployeesRaw = isUnified
    ? locEmployees
    : locEmployees.filter((e) => activeHouse === 'foh' ? isFohRole(e.role) : !isFohRole(e.role))
  // Bench display order — by role priority, then by employee name.
  // No grouped sections; the bench stays one continuous grid but
  // people of the same role naturally line up next to each other.
  const houseEmployees = [...houseEmployeesRaw].sort((a, b) => {
    const aIdx = roleSortIndex(a.role, activeHouse)
    const bIdx = roleSortIndex(b.role, activeHouse)
    if (aIdx !== bIdx) return aIdx - bIdx
    // Tie-break by exact role string so two roles that share an
    // index (e.g. "Server" and "Head Server") still cluster.
    if (a.role.toLowerCase() !== b.role.toLowerCase()) {
      return a.role.localeCompare(b.role)
    }
    return a.name.localeCompare(b.name)
  })
  const houseSections = isUnified ? sections : sections.filter((s) => s.area === activeHouse)
  const weekShifts = shifts.filter((s) => s.locationId === locationId && new Date(s.startTime) >= weekStart && new Date(s.startTime) < weekEnd)

  const dateLocale = lang === 'es' ? 'es-ES' : 'en-US'
  const weekLabel = `${weekDays[0].toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })} – ${weekDays[6].toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: 'numeric' })}`

  const handleDrop = (e: DragEvent, dayIdx: number, sectionId: string) => {
    e.preventDefault(); setDragOver(null)
    const empId = e.dataTransfer.getData('text/plain')
    if (!empId) return
    const dayIso = weekDays[dayIdx].toISOString()
    startTransition(async () => { await quickAssignShift(empId, sectionId, dayIso) })
  }

  // Timeline positioning helpers + drop handler retired with the
  // in-file timeline board — StaffingCalendar (a sibling client
  // component) now owns time-axis math, hour ticks, and drag/drop.
  //
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
    // Column tint — extra faint so it can wash a full vertical
    // stripe through the grid without overwhelming the shift cards.
    columnTint:  color === 'blue' ? 'bg-blue-50/30'           : 'bg-amber-50/30',
    softerHover: color === 'blue' ? 'bg-blue-50'              : 'bg-amber-50',
    text:        color === 'blue' ? 'text-blue-700'           : 'text-amber-700',
    dot:         color === 'blue' ? 'bg-blue-500'             : 'bg-amber-500',
    accentBar:   color === 'blue' ? 'bg-blue-500'             : 'bg-amber-500',
    todayText:   color === 'blue' ? 'text-blue-600'           : 'text-amber-600',
    // Thin top accent on the selected day header, so the active
    // column reads as deliberate without a heavy fill.
    todayTop:    color === 'blue' ? 'border-t-2 border-blue-500'  : 'border-t-2 border-amber-500',
    // Drop-target ring — used when a bench card is dragged over
    // an empty schedule cell. Inset so it doesn't push layout.
    dropRing:    color === 'blue' ? 'ring-1 ring-inset ring-blue-300' : 'ring-1 ring-inset ring-amber-300',
    dropHint:    color === 'blue' ? 'text-blue-600'           : 'text-amber-600',
    countChip:   color === 'blue' ? 'bg-blue-50 text-blue-700': 'bg-amber-50 text-amber-700',
  }

  const houseWeekShifts = weekShifts.filter(
    (s) => houseSections.some((sec) => sec.id === s.sectionId)
  )
  const totalShiftsThisWeek = houseWeekShifts.length
  // Weekly total hours for the active house (block-aligned shifts).
  // Lightweight derived value — surfaced next to the shift count in
  // the schedule header pill so a manager can read coverage at a
  // glance ("6 shifts · 48h") without leaving the board.
  const totalHoursThisWeek = houseWeekShifts.reduce((sum, s) => {
    const start = new Date(s.startTime).getTime()
    const end = new Date(s.endTime).getTime()
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? sum + (end - start) / (1000 * 60 * 60)
      : sum
  }, 0)
  // Covered-days count — distinct calendar days that have at least
  // one block-aligned shift this week. Surfaces operational context
  // ("48h, but only Tue + Wed?") that raw shift count can't.
  const coveredDays = new Set(
    houseWeekShifts.map((s) => {
      const d = new Date(s.startTime)
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    }),
  ).size

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

  // ---- Adapter shapes for StaffingCalendar --------------------
  // The new calendar takes a narrower, presentation-focused type.
  // We filter to the active house (respect FOH/BOH split) and map
  // to the calendar's expected fields. Bench includes only
  // employees in the active house.
  const houseEmployeeIds = new Set(houseEmployees.map((e) => e.id))
  const calShifts: CalShift[] = weekShifts
    .filter((s) => houseEmployeeIds.has(s.employeeId))
    .map((s) => ({
      id: s.id,
      employeeId: s.employeeId,
      employeeName: s.employeeName,
      role: s.role,
      startTime: s.startTime,
      endTime: s.endTime,
    }))
  const calBench: CalEmployee[] = houseEmployees.map((e) => ({
    id: e.id,
    name: e.name,
    role: e.role,
  }))

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

  // Custom-shifts lane was removed with the block-grid layout. The
  // timeline board positions every shift by its start/end time, so
  // section_id=null shifts (one-offs or orphans from a deleted
  // block) render alongside the rest — no separate lane needed.
  const subtitle = isUnified
    ? t('Plan the week and track labor coverage.', 'Planifica la semana y monitorea la cobertura de personal.')
    : t('Plan the week by house — drag from the bench to assign.', 'Planifica la semana por área — arrastra desde la plantilla para asignar.')

  return (
    <RoleColorsContext.Provider value={roleColors}>
    <div className="max-w-[1400px]">

      {/* ================================================================ */}
      {/* 1. HEADER BAND — title + one-line subtitle. Controls live on the  */}
      {/*    strip below so they read as a unified workflow row instead of  */}
      {/*    being torn between top-right and a separate house line.       */}
      {/* ================================================================ */}
      <div className="mb-5">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">{t('Staffing', 'Personal')}</h1>
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
                {t('Front of House', 'Salón')}
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
                {t('Back of House', 'Cocina')}
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
              aria-label={t('Previous week', 'Semana anterior')}
            >‹</button>
            <button
              type="button"
              onClick={() => setWeekStart(getMonday(new Date()))}
              className="px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 border-x border-gray-200/80 transition-colors"
            >{t('Today', 'Hoy')}</button>
            <button
              type="button"
              onClick={() => setWeekStart((p) => { const d = new Date(p); d.setDate(d.getDate() + 7); return d })}
              className="px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
              aria-label={t('Next week', 'Próxima semana')}
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
            {t('+ Shift', '+ Turno')}
          </button>
          {/* + Block button retired — blocks (shift sections) are no
              longer a visible concept on the calendar. Existing
              sections stay in the DB and still surface in the
              add-shift drawer as a "template" picker, but managers
              no longer create/edit blocks through this page. */}
          <button
            type="button"
            onClick={() => setDrawer({ mode: 'add-employee', house: activeHouse })}
            className="inline-flex items-center rounded-lg border border-gray-200/80 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors"
          >
            {t('+ Employee', '+ Empleado')}
          </button>
        </div>
      </div>

      {/* ================================================================ */}
      {/* 3. STAFFING CALENDAR — week timeline + day editor + bench.        */}
      {/*                                                                    */}
      {/* Replaces the previous timeline+bench pair. This component owns    */}
      {/* the entire "look at the week / edit a day / drag from bench"      */}
      {/* workflow; the outer page keeps the header, house toggle, week     */}
      {/* nav, and drawers. Every mutation calls back into a handler       */}
      {/* below that wraps a real server action + router.refresh().        */}
      {/* ================================================================ */}
      <StaffingCalendar
        lang={lang}
        weekStart={weekStart}
        weekDays={weekDays}
        activeHouse={activeHouse}
        isUnified={isUnified}
        shifts={calShifts}
        bench={calBench}
        weeklyHoursByEmployee={hoursByEmployee}
        roleColors={roleColors}
        onOpenEditShift={(cs) => {
          const full = weekShifts.find((s) => s.id === cs.id)
          if (full) setDrawer({ mode: 'edit', shift: full })
        }}
        onAssignToDay={async (employeeId, dayIso) => {
          const r = await quickAssignShift(employeeId, null, dayIso)
          router.refresh()
          return r
        }}
        onSetShiftTime={async (shiftId, startIso, endIso) => {
          const r = await updateShiftTimes(shiftId, startIso, endIso)
          router.refresh()
          return r
        }}
        onRemoveShift={async (shiftId) => {
          const r = await deleteShiftById(shiftId)
          router.refresh()
          return r
        }}
        onRepeatLastWeekForDay={async (dayIso) => {
          // Reuse copyPreviousWeek scoped to whole week; day-specific
          // filter is a future refinement. For now this repeats the
          // previous week's shifts for the whole week (which includes
          // the requested day). Idempotent — existing rows are skipped.
          const _ = dayIso
          const r = await copyPreviousWeek(weekStart.toISOString())
          router.refresh()
          return r
        }}
        onClearDay={async (dayIso) => {
          // Delete every shift for the given day + active-house scope.
          const dayDate = new Date(dayIso)
          const toDelete = weekShifts.filter((s) =>
            sameDay(new Date(s.startTime), dayDate),
          )
          for (const s of toDelete) {
            const r = await deleteShiftById(s.id)
            if (r && 'error' in r && r.error) return r
          }
          router.refresh()
          return null
        }}
        onCopyLastWeek={async () => {
          const r = await copyPreviousWeek(weekStart.toISOString())
          router.refresh()
          return r
        }}
        onPrevWeek={() =>
          setWeekStart((p) => { const d = new Date(p); d.setDate(d.getDate() - 7); return d })
        }
        onNextWeek={() =>
          setWeekStart((p) => { const d = new Date(p); d.setDate(d.getDate() + 7); return d })
        }
        onToday={() => setWeekStart(getMonday(new Date()))}
        onSave={() => { router.refresh() }}
        onSetRoleColor={async (role, colorSlug) => {
          const fd = new FormData()
          fd.set('role', role)
          fd.set('color', colorSlug ?? '')
          const r = await setRoleColor(fd)
          router.refresh()
          return r
        }}
        onAddRole={async (name) => {
          const fd = new FormData()
          fd.set('area', activeHouse)
          fd.set('role', name)
          const r = await addStaffingRole(null, fd)
          router.refresh()
          return r
        }}
      />


      {/* ---- DRAWERS ----
          Every page-level workflow funnels into one of these drawers.
          The drawer state union at the top of StaffingClient keeps
          this list exhaustive — adding a new flow is a one-line
          render branch here. */}
      {drawer?.mode === 'edit' && (
        <EditDrawer lang={lang} shift={drawer.shift} employees={locEmployees} sections={sections} onClose={() => setDrawer(null)} />
      )}
      {drawer?.mode === 'add-employee' && (
        <AddEmployeeDrawer lang={lang} locationId={locationId} house={drawer.house} isUnified={isUnified}
          roles={isUnified ? fohRoles : (drawer.house === 'foh' ? fohRoles : bohRoles)}
          onClose={() => setDrawer(null)} />
      )}
      {drawer?.mode === 'edit-employee' && (
        <EditEmployeeDrawer
          lang={lang}
          employee={drawer.employee}
          isUnified={isUnified}
          house={drawer.house}
          roles={isUnified ? fohRoles : (drawer.house === 'foh' ? fohRoles : bohRoles)}
          weekHours={hoursByEmployee.get(drawer.employee.id) ?? 0}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer?.mode === 'add-block' && (
        <AddBlockDrawer
          lang={lang}
          isUnified={isUnified}
          defaultArea={drawer.defaultArea}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer?.mode === 'edit-block' && (
        <EditBlockDrawer
          lang={lang}
          section={drawer.section}
          shiftCount={drawer.shiftCount}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer?.mode === 'add-shift' && (
        <AddCustomShiftDrawer
          lang={lang}
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
    </RoleColorsContext.Provider>
  )
}

// ----------------------------------------------------------------
// EditDrawer — the shift-edit drawer opened by clicking any shift
// card on the schedule board. Uses the shared DrawerShell pattern
// so it visually matches the rest of the staffing drawers (Employee,
// Block, Custom shift). Save action lives in the footer; Remove
// shift is a quiet destructive secondary at the bottom.
// ----------------------------------------------------------------
function EditDrawer({ lang, shift, employees, sections: _sections, onClose }: {
  lang: Lang; shift: Shift; employees: Employee[]; sections: Section[]; onClose: () => void
}) {
  const t = makeT(lang)
  const roleColors = useContext(RoleColorsContext)
  const [eState, eAction, ePending] = useActionState(updateShift, null)
  const [dState, dAction, dPending] = useActionState(deleteShift, null)
  useAutoCloseOnSuccess(ePending, eState, onClose)
  useAutoCloseOnSuccess(dPending, dState, onClose)

  return (
    <DrawerShell
      eyebrow={t('Shift', 'Turno')}
      title={t(`Edit ${shift.employeeName}`, `Editar ${shift.employeeName}`)}
      subtitle={`${shift.role} · ${fmt(shift.startTime)}–${fmt(shift.endTime)}`}
      onClose={onClose}
      closeLabel={t('Close', 'Cerrar')}
    >
      {/* Sibling delete form — lives OUTSIDE the edit form so we
          don't nest <form> elements (HTML disallows it and React
          warns about hydration). The "Remove shift" button below
          binds to this form by id via `form="staffing-delete-shift"`,
          matching the pattern EditBlockDrawer uses for its delete. */}
      <form id="staffing-delete-shift" action={dAction}>
        <input type="hidden" name="shift_id" value={shift.id} />
      </form>

      <form action={eAction} className="flex-1 flex flex-col min-h-0">
        <input type="hidden" name="shift_id" value={shift.id} />
        <DrawerBody>
          {(() => {
            const role = roleTone(shift.role, roleColors)
            const startMs = new Date(shift.startTime).getTime()
            const endMs = new Date(shift.endTime).getTime()
            const hrs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
              ? (endMs - startMs) / (1000 * 60 * 60)
              : 0
            return (
              <PreviewCard
                eyebrow={t('Shift', 'Turno')}
                toneDot={role.dot}
                title={`${shift.employeeName} · ${shift.role}`}
                meta={[
                  `${fmtMonthDay(shift.startTime, lang)} · ${fmt(shift.startTime)}–${fmt(shift.endTime)}`,
                  `${formatHours(hrs)} ${t('scheduled', 'programadas')}`,
                ]}
              />
            )
          })()}

          <Field label={t('Employee', 'Empleado')} htmlFor="es-employee" t={t}>
            <select
              id="es-employee"
              name="employee_id"
              required
              defaultValue={shift.employeeId}
              className={fieldInputClass}
            >
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name} · {e.role}</option>)}
            </select>
          </Field>

          <Field label={t('Start', 'Inicio')} htmlFor="es-start" t={t}>
            <input
              id="es-start"
              name="start_time"
              type="datetime-local"
              required
              defaultValue={toLocal(new Date(shift.startTime))}
              className={fieldInputClass}
            />
          </Field>

          <Field label={t('End', 'Fin')} htmlFor="es-end" t={t}>
            <input
              id="es-end"
              name="end_time"
              type="datetime-local"
              required
              defaultValue={toLocal(new Date(shift.endTime))}
              className={fieldInputClass}
            />
          </Field>

          <Field label={t('Notes', 'Notas')} htmlFor="es-notes" optional t={t}>
            <input
              id="es-notes"
              name="notes"
              type="text"
              defaultValue={shift.notes ?? ''}
              placeholder={t('Anything worth flagging', 'Cualquier cosa que valga la pena señalar')}
              className={fieldInputClass}
            />
          </Field>

          {eState?.error && <p className="text-xs text-red-600">{eState.error}</p>}
        </DrawerBody>

        <DrawerFooter>
          <div className="flex items-center justify-between gap-3">
            {/* Bound to the sibling delete form above via form=""
                so this button doesn't need to live inside its own
                nested <form> (which would re-introduce the
                hydration error). */}
            <button
              form="staffing-delete-shift"
              type="submit"
              disabled={dPending}
              className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-60"
            >
              {dPending ? t('Removing…', 'Eliminando…') : t('Remove shift', 'Eliminar turno')}
            </button>
            <button
              type="submit"
              disabled={ePending}
              className="h-10 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {ePending ? t('Saving…', 'Guardando…') : t('Save changes', 'Guardar cambios')}
            </button>
          </div>
          {dState?.error && <p className="mt-2 text-xs text-red-500">{dState.error}</p>}
        </DrawerFooter>
      </form>
    </DrawerShell>
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
  employee, hoursLabel, weekHours, tier, t, onClick,
}: {
  employee: Employee
  hoursLabel: string
  weekHours: number
  tier: HoursTier
  t: T
  onClick: () => void
}) {
  const draggingRef = useRef(false)
  const roleColors = useContext(RoleColorsContext)
  const role = roleTone(employee.role, roleColors)

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', employee.id)
        e.dataTransfer.effectAllowed = 'copy'
        draggingRef.current = true
      }}
      onDragEnd={() => {
        setTimeout(() => { draggingRef.current = false }, 0)
      }}
      onClick={() => {
        if (draggingRef.current) return
        onClick()
      }}
      title={t(
        `${employee.name} (${employee.role}) · ${hoursLabel} this week — drag onto a shift, or click to manage`,
        `${employee.name} (${employee.role}) · ${hoursLabel} esta semana — arrastra a un turno, o haz clic para administrar`
      )}
      className="group relative min-w-[170px] rounded-lg border border-gray-200/90 bg-white pl-3 pr-3 py-2 cursor-grab active:cursor-grabbing select-none transition-all hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-[0_2px_4px_rgba(15,23,42,0.05)] overflow-hidden"
    >
      {/* Role identity — thin left accent bar in the role color. The
          card body stays white so the bench reads as a neutral
          surface; the role tone is the *signal*, not the *fill*. */}
      <span className={`absolute left-0 top-0 bottom-0 w-[2px] ${role.dot}`} aria-hidden />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-gray-900 leading-tight truncate">{employee.name}</p>
        <HoursIndicator hours={weekHours} tier={tier} t={t} />
      </div>
      {/* Role label — role-toned text, no leading dot. The left
          accent bar already anchors the role color, so the dot read
          as redundant signal. */}
      <p className={`text-[10px] font-medium mt-0.5 truncate ${role.text}`}>
        {employee.role}
      </p>
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
function EditEmployeeDrawer({ lang, employee, isUnified, house, roles, weekHours, onClose }: {
  lang: Lang
  employee: Employee
  isUnified: boolean
  house: 'foh' | 'boh'
  roles: string[]
  weekHours: number
  onClose: () => void
}) {
  const t = makeT(lang)
  const roleColors = useContext(RoleColorsContext)
  const [state, action, pending] = useActionState(updateEmployee, null)
  const [archState, archAction, archPending] = useActionState(archiveEmployee, null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  useAutoCloseOnSuccess(pending, state, onClose)
  useAutoCloseOnSuccess(archPending, archState, onClose)

  const eyebrow = isUnified ? t('Team', 'Equipo') : (house === 'foh' ? t('Front of House', 'Salón') : t('Back of House', 'Cocina'))
  const role = roleTone(employee.role, roleColors)

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
      title={t(`Manage ${employee.name}`, `Administrar ${employee.name}`)}
      subtitle={t('Edit role, pay, and employee status.', 'Editar puesto, pago y estado del empleado.')}
      onClose={onClose}
      closeLabel={t('Close', 'Cerrar')}
    >
      <form action={action} className="flex-1 flex flex-col min-h-0">
        <input type="hidden" name="employee_id" value={employee.id} />
        <DrawerBody>
          {/* Top summary — quick context strip so the drawer reads as
              "this person's record" before any field. Role uses the
              shared role tone; hours come from the schedule view the
              parent maintains. */}
          <SummaryCard
            entries={[
              { label: t('Role', 'Puesto'), value: (
                <span className="inline-flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${role.dot}`} aria-hidden />
                  <span className={role.text}>{employee.role}</span>
                </span>
              ) },
              { label: t('Scheduled', 'Programado'), value: formatHours(weekHours) + t(' this week', ' esta semana') },
              { label: t('House', 'Área'), value: isUnified ? t('Team', 'Equipo') : (house === 'foh' ? t('Front of House', 'Salón') : t('Back of House', 'Cocina')) },
              { label: t('Status', 'Estado'), value: t('Active', 'Activo') },
            ]}
          />

          <SectionLabel>{t('Profile', 'Perfil')}</SectionLabel>

          <Field label={t('Name', 'Nombre')} htmlFor="ee-name" t={t}>
            <input
              id="ee-name"
              name="name"
              type="text"
              required
              defaultValue={employee.name}
              className={fieldInputClass}
            />
          </Field>

          <Field label={t('Role', 'Puesto')} htmlFor="ee-role" t={t}>
            {roles.length === 0 ? (
              <p className="text-xs text-amber-700">
                {t('No roles defined for this house yet. Add one from Add employee first.', 'Aún no hay puestos definidos para esta área. Agrega uno desde Agregar empleado primero.')}
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
            label={t('Hourly rate', 'Tarifa por hora')}
            htmlFor="ee-rate"
            optional
            t={t}
            hint={t('Leave blank to clear. Drives scheduled-labor estimates in Finance.', 'Deja en blanco para borrar. Determina los estimados de mano de obra programada en Finanzas.')}
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
              <p className="text-xs font-semibold text-red-900">{t(`Archive ${employee.name}?`, `¿Archivar a ${employee.name}?`)}</p>
              <p className="mt-0.5 text-[11px] text-red-700/90 leading-relaxed">
                {t(
                  "They'll be removed from the bench. Historical shifts stay intact and can't be edited until the employee is restored.",
                  "Será removido de la plantilla. Los turnos históricos permanecen intactos y no se pueden editar hasta que el empleado sea restaurado."
                )}
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
                  {archPending ? t('Archiving…', 'Archivando…') : t('Confirm archive', 'Confirmar archivar')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmArchive(false)}
                  className="text-[11px] text-gray-500 hover:text-gray-700"
                >
                  {t('Cancel', 'Cancelar')}
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
                {t('Archive employee', 'Archivar empleado')}
              </button>
            ) : (
              <span className="text-[11px] text-gray-400">{t('Confirm above', 'Confirma arriba')}</span>
            )}
            <button
              type="submit"
              disabled={pending}
              className="h-10 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {pending ? t('Saving…', 'Guardando…') : t('Save changes', 'Guardar cambios')}
            </button>
          </div>
        </DrawerFooter>
      </form>
    </DrawerShell>
  )
}

function AddEmployeeDrawer({ lang, locationId, house, isUnified, roles, onClose }: {
  lang: Lang; locationId: string; house: 'foh' | 'boh'; isUnified: boolean; roles: string[]; onClose: () => void
}) {
  const t = makeT(lang)
  const [state, action, pending] = useActionState(createEmployee, null)
  const [roleState, roleAction, rolePending] = useActionState(addStaffingRole, null)
  const [showAddRole, setShowAddRole] = useState(false)
  useAutoCloseOnSuccess(pending, state, onClose)

  const houseLabel = isUnified ? t('your team', 'tu equipo') : (house === 'foh' ? t('Front of House', 'Salón') : t('Back of House', 'Cocina'))
  const eyebrow = isUnified ? t('Team', 'Equipo') : (house === 'foh' ? t('Front of House', 'Salón') : t('Back of House', 'Cocina'))
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
      title={t('Add employee', 'Agregar empleado')}
      subtitle={t('Name, role, and an hourly rate if you have one.', 'Nombre, puesto y una tarifa por hora si tienes una.')}
      onClose={onClose}
      closeLabel={t('Close', 'Cerrar')}
    >
      {/* Sibling form for adding roles — rendered hidden so it has a
          DOM presence the bound inputs can submit to. */}
      <form id={roleFormId} action={roleAction} className="hidden" />

      <form action={action} className="flex-1 flex flex-col min-h-0">
        <input type="hidden" name="primary_location_id" value={locationId} />
        <DrawerBody>
          <PreviewCard
            eyebrow={eyebrow}
            toneDot={isUnified || house === 'foh' ? 'bg-blue-500' : 'bg-amber-500'}
            title={t('New employee', 'Nuevo empleado')}
            meta={[t(`Will appear on the ${houseLabel} bench after creation.`, `Aparecerá en la plantilla de ${houseLabel} después de la creación.`)]}
            footer={t('Role and hourly rate can be changed later.', 'El puesto y la tarifa por hora se pueden cambiar después.')}
          />

          <Field label={t('Name', 'Nombre')} htmlFor="ae-name" t={t}>
            <input
              id="ae-name"
              name="name"
              type="text"
              required
              autoFocus
              placeholder={t('Jane Smith', 'Juana Pérez')}
              className={fieldInputClass}
            />
          </Field>

          <Field label={t('Role', 'Puesto')} htmlFor={hasRoles ? 'ae-role' : 'ae-new-role'} t={t}>
            {!hasRoles ? (
              // Inline empty-role callout — guided, not broken. The
              // role <input> + submit button bind to the sibling
              // role form via `form="..."`.
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                <p className="text-xs font-semibold text-amber-900">
                  {t(`No roles for ${houseLabel} yet`, `Aún no hay puestos para ${houseLabel}`)}
                </p>
                <p className="mt-0.5 text-[11px] text-amber-700/90 leading-relaxed">
                  {t('Add one to continue. New roles appear here right away.', 'Agrega uno para continuar. Los nuevos puestos aparecen aquí de inmediato.')}
                </p>
                <div className="mt-2.5 flex gap-2">
                  <input
                    id="ae-new-role"
                    form={roleFormId}
                    name="role"
                    type="text"
                    required
                    placeholder={t('e.g. Server, Cook', 'p.ej. Mesero, Cocinero')}
                    className="flex-1 h-9 rounded-md border border-amber-300 bg-white px-2.5 text-xs text-gray-900 placeholder:text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
                  />
                  <input form={roleFormId} type="hidden" name="area" value={house} />
                  <button
                    form={roleFormId}
                    type="submit"
                    disabled={rolePending}
                    className="h-9 rounded-md bg-gray-900 hover:bg-gray-800 px-3 text-xs font-semibold text-white disabled:opacity-60 transition-colors"
                  >
                    {rolePending ? t('Adding…', 'Agregando…') : t('Add role', 'Agregar puesto')}
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
                  <option value="" disabled>{t('Select…', 'Seleccionar…')}</option>
                  {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                {!showAddRole ? (
                  <button
                    type="button"
                    onClick={() => setShowAddRole(true)}
                    className="mt-1.5 text-[11px] text-gray-500 hover:text-gray-700"
                  >
                    {t('+ Add a new role', '+ Agregar un nuevo puesto')}
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
                        placeholder={t('e.g. Sommelier', 'p.ej. Sommelier')}
                        className="flex-1 h-9 rounded-md border border-gray-200 bg-white px-2.5 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
                      />
                      <input form={roleFormId} type="hidden" name="area" value={house} />
                      <button
                        form={roleFormId}
                        type="submit"
                        disabled={rolePending}
                        className="h-9 rounded-md bg-gray-900 hover:bg-gray-800 px-3 text-xs font-semibold text-white disabled:opacity-60 transition-colors"
                      >
                        {rolePending ? t('Adding…', 'Agregando…') : t('Add', 'Agregar')}
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
                      {t('Cancel', 'Cancelar')}
                    </button>
                  </div>
                )}
              </>
            )}
          </Field>

          <Field label={t('Hourly rate', 'Tarifa por hora')} htmlFor="ae-rate" optional t={t}>
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
            {pending ? t('Adding…', 'Agregando…') : t('Add employee', 'Agregar empleado')}
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
function DrawerShell({ eyebrow, title, subtitle, onClose, closeLabel, children }: {
  eyebrow?: string
  title: string
  subtitle?: string
  onClose: () => void
  closeLabel?: string
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
            aria-label={closeLabel ?? 'Close'}
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

function Field({ label, htmlFor, optional, hint, t, children }: {
  label: string
  htmlFor?: string
  optional?: boolean
  hint?: string
  t?: T
  children: React.ReactNode
}) {
  const optLabel = t ? t('· optional', '· opcional') : '· optional'
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-gray-700"
      >
        {label}
        {optional && <span className="text-gray-400 font-normal">{optLabel}</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[10.5px] text-gray-400 leading-relaxed">{hint}</p>}
    </div>
  )
}

// SectionLabel — small uppercase eyebrow that groups Field rows
// inside a DrawerBody into named bands ("Profile", "Pay", "Time").
// Used to break up otherwise blank-looking drawer forms.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 mb-0.5 text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
      {children}
    </p>
  )
}

// PreviewCard — small contextual card used at the top of every
// staffing add/edit drawer so the drawer doesn't read as a blank
// quick-action form. Title + 0..N meta lines + optional footer
// note. Eyebrow + tiny tone dot (e.g. house blue/amber) keep the
// card visually attached to the active context.
function PreviewCard({
  eyebrow,
  toneDot,
  title,
  meta,
  footer,
}: {
  eyebrow?: string
  toneDot?: string
  title: React.ReactNode
  meta?: React.ReactNode[]
  footer?: string
}) {
  return (
    <div className="rounded-lg border border-gray-200/80 bg-gray-50/40 px-3.5 py-3">
      {eyebrow && (
        <div className="flex items-center gap-1.5">
          {toneDot && <span className={`w-1.5 h-1.5 rounded-full ${toneDot}`} aria-hidden />}
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
            {eyebrow}
          </p>
        </div>
      )}
      <p className={`text-xs font-semibold text-gray-900 leading-tight truncate ${eyebrow ? 'mt-1' : ''}`}>
        {title}
      </p>
      {meta && meta.length > 0 && (
        <div className="mt-0.5 space-y-0.5">
          {meta.map((m, i) => (
            <p key={i} className="text-[11px] text-gray-500 leading-snug font-mono tabular-nums">{m}</p>
          ))}
        </div>
      )}
      {footer && (
        <p className="mt-1.5 text-[10px] text-gray-400 leading-relaxed">{footer}</p>
      )}
    </div>
  )
}

// SummaryCard — context strip shown at the top of edit drawers so
// the drawer reads as "this thing, here's what it looks like" before
// the manager hits the fields. Two-column key/value grid; cells stay
// quiet (gray-400 label, gray-900 value) to avoid competing with the
// form below.
function SummaryCard({ entries }: { entries: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <div className="rounded-lg border border-gray-200/80 bg-gray-50/40 px-3.5 py-3">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        {entries.map((e) => (
          <div key={e.label} className="min-w-0">
            <dt className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">{e.label}</dt>
            <dd className="mt-0.5 text-xs text-gray-900 truncate">{e.value}</dd>
          </div>
        ))}
      </dl>
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
function AddBlockDrawer({ lang, isUnified, defaultArea, onClose }: {
  lang: Lang; isUnified: boolean; defaultArea: 'foh' | 'boh'; onClose: () => void
}) {
  const t = makeT(lang)
  const [state, action, pending] = useActionState(createShiftSection, null)
  useAutoCloseOnSuccess(pending, state, onClose)

  // Controlled state for the live preview card. Inputs were
  // uncontrolled before; keeping the field UX identical and just
  // wiring state through `value` + `onChange` lets the preview
  // update as the manager types.
  const [name, setName] = useState('')
  const [area, setArea] = useState<'foh' | 'boh'>(isUnified ? 'foh' : defaultArea)
  const [startHour, setStartHour] = useState(9)
  const [endHour, setEndHour] = useState(17)

  const areaLabel = area === 'foh' ? t('Front of House', 'Salón') : t('Back of House', 'Cocina')

  return (
    <DrawerShell
      eyebrow={t('Block', 'Bloque')}
      title={t('Add shift block', 'Agregar bloque de turno')}
      subtitle={t('A reusable lane on the schedule. Drop staff onto it any day.', 'Una vía reutilizable en el horario. Suelta personal en ella cualquier día.')}
      onClose={onClose}
      closeLabel={t('Close', 'Cerrar')}
    >
      <form action={action} className="flex-1 flex flex-col min-h-0">
        <DrawerBody>
          <PreviewCard
            eyebrow={isUnified ? t('Block', 'Bloque') : `${t('Block', 'Bloque')} · ${areaLabel}`}
            toneDot={area === 'foh' ? 'bg-blue-500' : 'bg-amber-500'}
            title={name.trim() || t('New block', 'Nuevo bloque')}
            meta={[`${hL(startHour)}–${hL(endHour)} · ${areaLabel}`]}
            footer={t('Reusable schedule lane', 'Vía de horario reutilizable')}
          />

          {/* Area is hidden + locked in unified mode. In split mode
              it renders as an explicit field so the manager knows
              which house the new block belongs to. */}
          {isUnified ? (
            <input type="hidden" name="area" value="foh" />
          ) : (
            <Field label={t('House', 'Área')} htmlFor="ab-area" t={t}>
              <select
                id="ab-area"
                name="area"
                required
                value={area}
                onChange={(e) => setArea(e.target.value as 'foh' | 'boh')}
                className={fieldInputClass}
              >
                <option value="foh">{t('Front of House', 'Salón')}</option>
                <option value="boh">{t('Back of House', 'Cocina')}</option>
              </select>
            </Field>
          )}

          <Field label={t('Block name', 'Nombre del bloque')} htmlFor="ab-name" t={t}>
            <input
              id="ab-name"
              name="name"
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('e.g. Brunch, Late, Event', 'p.ej. Brunch, Tarde, Evento')}
              className={fieldInputClass}
            />
          </Field>
          <p className="text-[10.5px] text-gray-400 leading-relaxed">
            {t('Examples: Opening, Mid, Closing, Brunch, Prep, Service.', 'Ejemplos: Apertura, Medio, Cierre, Brunch, Preparación, Servicio.')}
          </p>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Start hour', 'Hora de inicio')} htmlFor="ab-start" t={t}>
              <select
                id="ab-start"
                name="default_start_hour"
                required
                value={startHour}
                onChange={(e) => setStartHour(Number(e.target.value))}
                className={`${fieldInputClass} font-mono tabular-nums`}
              >
                {HOUR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label={t('End hour', 'Hora de fin')} htmlFor="ab-end" t={t}>
              <select
                id="ab-end"
                name="default_end_hour"
                required
                value={endHour}
                onChange={(e) => setEndHour(Number(e.target.value))}
                className={`${fieldInputClass} font-mono tabular-nums`}
              >
                {HOUR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
          </div>
          <p className="text-[10.5px] text-gray-400 leading-relaxed">
            {t('These pre-fill drag-drop assignments — times can be tweaked per shift.', 'Estos pre-rellenan las asignaciones de arrastrar y soltar — los tiempos se pueden ajustar por turno.')}
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
            {pending ? t('Creating…', 'Creando…') : t('Create block', 'Crear bloque')}
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
function EditBlockDrawer({ lang, section, shiftCount, onClose }: {
  lang: Lang; section: Section; shiftCount: number; onClose: () => void
}) {
  const t = makeT(lang)
  const [state, action, pending] = useActionState(updateShiftSection, null)
  const [delState, delAction, delPending] = useActionState(deleteShiftSection, null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useAutoCloseOnSuccess(pending, state, onClose)
  useAutoCloseOnSuccess(delPending, delState, onClose)

  const areaLabel = section.area === 'foh' ? t('Front of House', 'Salón') : t('Back of House', 'Cocina')

  return (
    <DrawerShell
      eyebrow={`${t('Block', 'Bloque')} · ${areaLabel}`}
      title={t(`Edit ${section.name}`, `Editar ${section.name}`)}
      subtitle={t('Rename, retime, or delete this block.', 'Renombra, cambia el horario o elimina este bloque.')}
      onClose={onClose}
      closeLabel={t('Close', 'Cerrar')}
    >
      {/* Sibling delete form — lives OUTSIDE the edit form so we
          don't nest <form> elements (HTML disallows it and React
          warns about hydration). The Confirm-delete button below
          binds to this form by id via `form="staffing-delete-block"`,
          which keeps the delete action wired without nesting. */}
      <form id="staffing-delete-block" action={delAction}>
        <input type="hidden" name="section_id" value={section.id} />
      </form>

      <form action={action} className="flex-1 flex flex-col min-h-0">
        <input type="hidden" name="section_id" value={section.id} />
        <DrawerBody>
          <PreviewCard
            eyebrow={`${t('Block', 'Bloque')} · ${areaLabel}`}
            toneDot={section.area === 'foh' ? 'bg-blue-500' : 'bg-amber-500'}
            title={section.name}
            meta={[
              `${hL(section.defaultStartHour)}–${hL(section.defaultEndHour)} · ${areaLabel}`,
              shiftCount === 0
                ? t('No shifts using this block yet', 'Aún no hay turnos usando este bloque')
                : (shiftCount === 1
                  ? t(`${shiftCount} shift uses this block`, `${shiftCount} turno usa este bloque`)
                  : t(`${shiftCount} shifts use this block`, `${shiftCount} turnos usan este bloque`)),
            ]}
            footer={t('Reusable lane on the weekly schedule', 'Vía reutilizable en el horario semanal')}
          />

          <Field label={t('Block name', 'Nombre del bloque')} htmlFor="eb-name" t={t}>
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
            <Field label={t('Start hour', 'Hora de inicio')} htmlFor="eb-start" t={t}>
              <select
                id="eb-start"
                name="default_start_hour"
                required
                defaultValue={section.defaultStartHour}
                className={`${fieldInputClass} font-mono tabular-nums`}
              >
                {HOUR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label={t('End hour', 'Hora de fin')} htmlFor="eb-end" t={t}>
              <select
                id="eb-end"
                name="default_end_hour"
                required
                defaultValue={section.defaultEndHour}
                className={`${fieldInputClass} font-mono tabular-nums`}
              >
                {HOUR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
          </div>

          {/* Inline delete confirmation lives in the body, not the
              footer, so the consequence text has space to breathe. */}
          {confirmDelete && (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50/60 p-3">
              <p className="text-xs font-semibold text-red-900">
                {shiftCount === 0
                  ? t('Delete this block?', '¿Eliminar este bloque?')
                  : (shiftCount === 1
                    ? t(`Move ${shiftCount} shift to the Custom lane?`, `¿Mover ${shiftCount} turno a la vía Personalizada?`)
                    : t(`Move ${shiftCount} shifts to the Custom lane?`, `¿Mover ${shiftCount} turnos a la vía Personalizada?`))}
              </p>
              <p className="mt-0.5 text-[11px] text-red-700/90 leading-relaxed">
                {shiftCount === 0
                  ? t('No shifts are using this block.', 'Ningún turno está usando este bloque.')
                  : t("Shifts won't be deleted — they'll surface on the Custom lane.", "Los turnos no se eliminarán — aparecerán en la vía Personalizada.")}
              </p>
              {/* Submit button binds to the sibling delete form
                  defined above the edit form, via `form="..."` —
                  keeps us out of nested-form territory. */}
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  form="staffing-delete-block"
                  type="submit"
                  disabled={delPending}
                  className="h-9 rounded-md border border-red-300 bg-white px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60 transition-colors"
                >
                  {delPending ? t('Deleting…', 'Eliminando…') : t('Confirm delete', 'Confirmar eliminación')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-[11px] text-gray-500 hover:text-gray-700"
                >
                  {t('Cancel', 'Cancelar')}
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
                {t('Delete block', 'Eliminar bloque')}
              </button>
            ) : (
              <span className="text-[11px] text-gray-400">{t('Confirm above', 'Confirma arriba')}</span>
            )}
            <button
              type="submit"
              disabled={pending}
              className="h-10 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {pending ? t('Saving…', 'Guardando…') : t('Save changes', 'Guardar cambios')}
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
  lang, locationId, employees, sections,
  defaultDay, defaultSectionId, defaultStartHour, defaultEndHour,
  onClose,
}: {
  lang: Lang
  locationId: string
  employees: Employee[]
  sections: Section[]
  defaultDay: string | null
  defaultSectionId?: string | null
  defaultStartHour?: number | null
  defaultEndHour?: number | null
  onClose: () => void
}) {
  const t = makeT(lang)
  const roleColors = useContext(RoleColorsContext)
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

  // Employee selection — controlled so the preview card above the
  // form can update in real time as the cashier picks a person.
  const [employeeId, setEmployeeId] = useState('')
  const selectedEmployee = useMemo(
    () => employees.find((e) => e.id === employeeId) ?? null,
    [employees, employeeId],
  )
  const selectedSection = useMemo(
    () => sections.find((s) => s.id === sectionId) ?? null,
    [sections, sectionId],
  )

  // datetime-local format the server expects: YYYY-MM-DDTHH:MM
  const composedStart = `${date}T${startTime}`
  const composedEnd = `${date}T${endTime}`
  // Preview duration — computed from composed start/end so the
  // preview card stays in lockstep with the form fields.
  const previewMs = new Date(composedEnd).getTime() - new Date(composedStart).getTime()
  const previewHrs = Number.isFinite(previewMs) && previewMs > 0 ? previewMs / (1000 * 60 * 60) : 0
  const previewRole = selectedEmployee ? roleTone(selectedEmployee.role, roleColors) : null

  return (
    <DrawerShell
      eyebrow={t('Shift', 'Turno')}
      title={t('Add shift', 'Agregar turno')}
      subtitle={t('One-off or block-aligned. Pick a person, a day, and a time.', 'Único o alineado a un bloque. Elige una persona, un día y una hora.')}
      onClose={onClose}
      closeLabel={t('Close', 'Cerrar')}
    >
      {employees.length === 0 ? (
        // Empty state — no people on the bench yet, so no shift can
        // be created. Stays inside the body region so the drawer
        // height feels intentional, not collapsed.
        <DrawerBody>
          <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/40 p-5 text-center">
            <p className="text-sm font-medium text-gray-700">{t('No employees yet', 'Sin empleados aún')}</p>
            <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">
              {t('Add at least one employee before scheduling shifts.', 'Agrega al menos un empleado antes de programar turnos.')}
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
            <PreviewCard
              eyebrow={t('Shift', 'Turno')}
              toneDot={previewRole?.dot}
              title={
                selectedEmployee
                  ? `${selectedEmployee.name} · ${selectedEmployee.role}`
                  : t('Unassigned', 'Sin asignar')
              }
              meta={[
                `${fmtMonthDay(composedStart, lang)} · ${fmt(composedStart)}–${fmt(composedEnd)}`,
                `${formatHours(previewHrs)} ${t('scheduled', 'programadas')}`,
                ...(selectedSection ? [`${t('Block', 'Bloque')}: ${selectedSection.name}`] : []),
              ]}
            />

            <Field label={t('Employee', 'Empleado')} htmlFor="cs-emp" t={t}>
              <select
                id="cs-emp"
                name="employee_id"
                required
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className={fieldInputClass}
              >
                <option value="" disabled>{t('Select…', 'Seleccionar…')}</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.name} · {e.role}</option>
                ))}
              </select>
            </Field>

            <Field
              label={t('Block', 'Bloque')}
              htmlFor="cs-section"
              optional
              t={t}
              hint={t('Pick a block to slot into its lane. Leave on Custom for a one-off.', 'Elige un bloque para insertarlo en su vía. Deja en Personalizado para un turno único.')}
            >
              <select
                id="cs-section"
                value={sectionId}
                onChange={(e) => handleSectionChange(e.target.value)}
                className={fieldInputClass}
              >
                <option value="">{t('— Custom (no block) —', '— Personalizado (sin bloque) —')}</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({hL(s.defaultStartHour)}–{hL(s.defaultEndHour)})
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t('Date', 'Fecha')} htmlFor="cs-date" t={t}>
              <input
                id="cs-date"
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={`${fieldInputClass} font-mono tabular-nums`}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label={t('Start', 'Inicio')} htmlFor="cs-start" t={t}>
                <input
                  id="cs-start"
                  type="time"
                  required
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className={`${fieldInputClass} font-mono tabular-nums`}
                />
              </Field>
              <Field label={t('End', 'Fin')} htmlFor="cs-end" t={t}>
                <input
                  id="cs-end"
                  type="time"
                  required
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className={`${fieldInputClass} font-mono tabular-nums`}
                />
              </Field>
            </div>

            <Field label={t('Notes', 'Notas')} htmlFor="cs-notes" optional t={t}>
              <input
                id="cs-notes"
                name="notes"
                type="text"
                placeholder={t('e.g. Event coverage', 'p.ej. Cobertura de evento')}
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
              {pending ? t('Adding…', 'Agregando…') : t('Add shift', 'Agregar turno')}
            </button>
          </DrawerFooter>
        </form>
      )}
    </DrawerShell>
  )
}
