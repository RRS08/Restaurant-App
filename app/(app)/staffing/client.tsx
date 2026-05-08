'use client'

import { useEffect, useRef, useState, useActionState, useTransition, type DragEvent } from 'react'
import { quickAssignShift, createEmployee, updateShift, deleteShift, addStaffingRole } from '@/app/actions/staffing'

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


export default function StaffingClient({ defaultLocationId, employees, shifts, sections, houseModel, schedulingStyle, fohRoles, bohRoles }: Props) {
  const isUnified = houseModel === 'unified'
  const isByRole = schedulingStyle === 'by_role'
  const [locationId] = useState(defaultLocationId ?? '')
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()))
  // In unified mode, `house` is pinned to 'foh' as the sole storage bucket and
  // the toggle is never rendered — the user sees a single-team experience.
  const [house, setHouse] = useState<'foh' | 'boh'>('foh')
  const activeHouse: 'foh' | 'boh' = isUnified ? 'foh' : house
  const [drawer, setDrawer] = useState<{ mode: 'edit'; shift: Shift } | { mode: 'add-employee'; house: 'foh' | 'boh' } | null>(null)
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
  const color = isUnified ? 'blue' : (activeHouse === 'foh' ? 'blue' : 'amber')

  return (
    <div className="max-w-[1200px]">

      {/* ---- TOP BAR ---- */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Staffing</h1>
          <p className="text-sm text-gray-500">{weekLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border border-gray-200 rounded-lg overflow-hidden">
            <button type="button" onClick={() => setWeekStart((p) => { const d = new Date(p); d.setDate(d.getDate() - 7); return d })} className="px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50">&larr;</button>
            <button type="button" onClick={() => setWeekStart(getMonday(new Date()))} className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 border-x border-gray-200">Today</button>
            <button type="button" onClick={() => setWeekStart((p) => { const d = new Date(p); d.setDate(d.getDate() + 7); return d })} className="px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50">&rarr;</button>
          </div>
          <button type="button" onClick={() => setDrawer({ mode: 'add-employee', house: activeHouse })}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">+ Employee</button>
        </div>
      </div>

      {/* ---- FOH / BOH TOGGLE (hidden in unified mode) ---- */}
      {!isUnified && (
        <div className="flex mb-5">
          <button type="button" onClick={() => setHouse('foh')}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-l-xl border transition-colors ${
              house === 'foh' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
            }`}>Front of House</button>
          <button type="button" onClick={() => setHouse('boh')}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-r-xl border-y border-r transition-colors ${
              house === 'boh' ? 'bg-amber-600 text-white border-amber-600' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
            }`}>Back of House</button>
        </div>
      )}

      {/* ---- SHIFT BOARD ---- */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
        {/* Day headers */}
        <div className="grid grid-cols-[90px_repeat(7,1fr)] border-b border-gray-100">
          <div className="px-3 py-2" />
          {weekDays.map((day, i) => {
            const isToday = sameDay(day, new Date())
            return (
              <div key={i} className={`px-1 py-2 text-center border-l border-gray-100 ${isToday ? `${color === 'blue' ? 'bg-blue-50' : 'bg-amber-50'}` : ''}`}>
                <p className="text-[10px] font-semibold text-gray-500">{DAYS[i]}</p>
                <p className={`text-sm font-bold ${isToday ? (color === 'blue' ? 'text-blue-600' : 'text-amber-600') : 'text-gray-900'}`}>{day.getDate()}</p>
              </div>
            )
          })}
        </div>

        {/* Shift block rows */}
        {houseSections.length === 0 && (
          <div className="p-8 text-center"><p className="text-sm text-gray-400">{isUnified ? 'No shift blocks defined.' : 'No shift blocks defined for this house.'}</p></div>
        )}

        {(() => {
          // A single shift-block row: the label column + 7 day cells.
          const renderSectionRow = (section: Section) => (
            <div key={section.id} className="grid grid-cols-[90px_repeat(7,1fr)] border-b border-gray-50 last:border-b-0">
              <div className="px-3 py-2 flex flex-col justify-center border-r border-gray-100">
                <p className="text-xs font-semibold text-gray-800">{section.name}</p>
                <p className="text-[10px] text-gray-400">{hL(section.defaultStartHour)}–{hL(section.defaultEndHour)}</p>
              </div>
              {weekDays.map((day, dayIdx) => {
                const cellKey = `${section.id}-${dayIdx}`
                const cellShifts = weekShifts.filter((s) => s.sectionId === section.id && sameDay(new Date(s.startTime), day))
                const isOver = dragOver === cellKey
                return (
                  <div key={dayIdx}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(cellKey) }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={(e) => handleDrop(e, dayIdx, section.id)}
                    className={`min-h-[44px] p-1 border-l border-gray-100 transition-colors ${
                      isOver ? (color === 'blue' ? 'bg-blue-50' : 'bg-amber-50') : ''
                    }`}>
                    {cellShifts.map((shift) => (
                      <button key={shift.id} type="button" onClick={() => setDrawer({ mode: 'edit', shift })}
                        className={`w-full text-left rounded px-1.5 py-1 mb-0.5 border cursor-pointer transition-colors ${
                          color === 'blue' ? 'bg-blue-50 border-blue-100 hover:bg-blue-100' : 'bg-amber-50 border-amber-100 hover:bg-amber-100'
                        }`}>
                        <p className={`text-[11px] font-bold leading-tight truncate ${color === 'blue' ? 'text-blue-800' : 'text-amber-800'}`}>{shift.role}</p>
                        <p className="text-[10px] text-gray-700 truncate leading-tight">{shift.employeeName}</p>
                        <p className="text-[9px] text-gray-400 leading-tight">{fmt(shift.startTime)}–{fmt(shift.endTime)}</p>
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
          const groups = new Map<string, Section[]>()
          for (const s of houseSections) {
            const key = s.role || 'General'
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key)!.push(s)
          }
          return [...groups.entries()].map(([role, group]) => (
            <div key={role}>
              <div className="grid grid-cols-[90px_repeat(7,1fr)] bg-gray-50/80 border-b border-gray-100">
                <div className="col-span-8 px-3 py-1.5 flex items-center gap-2">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${color === 'blue' ? 'bg-blue-500' : 'bg-amber-500'}`} />
                  <p className={`text-[10px] font-bold uppercase tracking-widest ${color === 'blue' ? 'text-blue-700' : 'text-amber-700'}`}>
                    {role}
                  </p>
                  <p className="text-[10px] text-gray-400 ml-1">{group.length} shift{group.length === 1 ? '' : 's'}</p>
                </div>
              </div>
              {group.map(renderSectionRow)}
            </div>
          ))
        })()}
      </div>

      <p className="text-[10px] text-gray-400 mb-5 text-right">
        {weekShifts.filter((s) => houseSections.some((sec) => sec.id === s.sectionId)).length} shifts · Drop team members into a slot to assign
      </p>

      {/* ---- STAFF BENCH (horizontal staging area, matches current house) ---- */}
      <div className={`rounded-2xl border-2 border-dashed p-4 transition-colors ${
        color === 'blue' ? 'border-blue-200 bg-blue-50/40' : 'border-amber-200 bg-amber-50/40'
      }`}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className={`text-[11px] font-bold uppercase tracking-widest ${color === 'blue' ? 'text-blue-700' : 'text-amber-700'}`}>
              {isUnified ? 'Team Bench' : (activeHouse === 'foh' ? 'Front of House Bench' : 'Back of House Bench')}
            </p>
            <p className="text-[10px] text-gray-500 mt-0.5">Drag a team member up into a shift block to assign them</p>
          </div>
          <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full ${
            color === 'blue' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
          }`}>
            {houseEmployees.length} available
          </span>
        </div>

        {houseEmployees.length === 0 ? (
          <div className="rounded-xl bg-white/60 border border-dashed border-gray-200 px-4 py-6 text-center">
            <p className="text-xs text-gray-500">
              No {isUnified ? 'team members' : (activeHouse === 'foh' ? 'FOH team members' : 'BOH team members')} yet.
            </p>
            <button type="button" onClick={() => setDrawer({ mode: 'add-employee', house: activeHouse })}
              className={`mt-2 text-xs font-semibold ${color === 'blue' ? 'text-blue-600 hover:text-blue-700' : 'text-amber-600 hover:text-amber-700'}`}>
              + Add your first {isUnified ? 'team member' : (activeHouse === 'foh' ? 'FOH team member' : 'BOH team member')}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {houseEmployees.map((emp) => (
              <div key={emp.id} draggable
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', emp.id); e.dataTransfer.effectAllowed = 'copy' }}
                title={`Drag ${emp.name} (${emp.role}) onto a shift`}
                className={`min-w-[120px] rounded-xl bg-white border px-3 py-2 cursor-grab active:cursor-grabbing select-none shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${
                  color === 'blue' ? 'border-blue-100 hover:border-blue-300' : 'border-amber-100 hover:border-amber-300'
                }`}>
                <p className={`text-xs font-bold uppercase tracking-wide leading-tight truncate ${
                  color === 'blue' ? 'text-blue-800' : 'text-amber-800'
                }`}>{emp.role}</p>
                <p className="text-[11px] font-medium text-gray-800 truncate leading-tight mt-0.5">{emp.name}</p>
                <p className="text-[9px] text-gray-400 leading-tight mt-0.5">Unassigned</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- DRAWERS ---- */}
      {drawer?.mode === 'edit' && (
        <EditDrawer shift={drawer.shift} employees={locEmployees} sections={sections} onClose={() => setDrawer(null)} />
      )}
      {drawer?.mode === 'add-employee' && (
        <AddEmployeeDrawer locationId={locationId} house={drawer.house} isUnified={isUnified}
          roles={isUnified ? fohRoles : (drawer.house === 'foh' ? fohRoles : bohRoles)}
          onClose={() => setDrawer(null)} />
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
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
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
function AddEmployeeDrawer({ locationId, house, isUnified, roles, onClose }: {
  locationId: string; house: 'foh' | 'boh'; isUnified: boolean; roles: string[]; onClose: () => void
}) {
  const [state, action, pending] = useActionState(createEmployee, null)
  const [roleState, roleAction, rolePending] = useActionState(addStaffingRole, null)
  const [showAddRole, setShowAddRole] = useState(false)
  const houseLabel = isUnified ? 'your team' : (house === 'foh' ? 'Front of House' : 'Back of House')

  // Auto-close on a successful submit.
  // createEmployee returns null on success and { error } on failure.
  // useActionState gives us no explicit "success" event, so we
  // detect the pending → done transition and close iff state lacks
  // an error. Without this the drawer stays open with the same
  // form values after a successful add, the new employee appears
  // hidden behind it, and the user assumes the click did nothing.
  const wasPendingRef = useRef(false)
  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      const errored = !!state && 'error' in state && !!state.error
      if (!errored) onClose()
    }
    wasPendingRef.current = pending
  }, [pending, state, onClose])

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-sm bg-white border-l border-gray-200 shadow-xl z-50 overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-gray-900">Add employee</h2>
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <form action={action} className="space-y-4">
            <input type="hidden" name="primary_location_id" value={locationId} />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input name="name" type="text" required autoFocus placeholder="Jane Smith"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
              {roles.length === 0 ? (
                <p className="text-xs text-gray-400 italic mb-2">No {houseLabel} roles configured yet. Add one below.</p>
              ) : (
                <select name="role" required defaultValue=""
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="" disabled>Select…</option>
                  {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              )}
              <p className="text-[10px] text-gray-400 mt-1">Only {houseLabel} roles from your staffing setup.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Hourly rate <span className="text-gray-400 font-normal">(optional)</span></label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
                <input name="hourly_rate" type="number" min="0" step="0.01" placeholder="0.00"
                  className="w-full rounded-lg border border-gray-300 pl-7 pr-3 py-2.5 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
            <button type="submit" disabled={pending || roles.length === 0}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
              {pending ? 'Adding…' : 'Add employee'}
            </button>
          </form>

          {/* Secondary fallback: manager forgot a role during onboarding */}
          <div className="mt-6 pt-4 border-t border-gray-100">
            {!showAddRole ? (
              <button type="button" onClick={() => setShowAddRole(true)}
                className="text-xs text-gray-500 hover:text-gray-700 underline decoration-dotted underline-offset-2">
                Missing a role for {houseLabel}?
              </button>
            ) : (
              <form action={roleAction} className="space-y-2">
                <p className="text-[11px] text-gray-500">
                  Add a new {houseLabel} role. It will appear in the dropdown above.
                </p>
                <input type="hidden" name="area" value={house} />
                <div className="flex gap-2">
                  <input name="role" type="text" required autoFocus placeholder="e.g. Sommelier"
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <button type="submit" disabled={rolePending}
                    className="rounded-lg bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60">
                    {rolePending ? 'Adding…' : 'Add'}
                  </button>
                </div>
                {roleState?.error && <p className="text-[11px] text-red-500">{roleState.error}</p>}
                <button type="button" onClick={() => setShowAddRole(false)}
                  className="text-[10px] text-gray-400 hover:text-gray-600">Cancel</button>
              </form>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
