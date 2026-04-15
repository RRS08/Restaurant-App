'use client'

import { useState, useActionState, useEffect, useRef } from 'react'
import { completeStaffingSetup } from '@/app/actions/staffing'

const FOH_ROLES = ['Server', 'Busser', 'Host', 'Bartender', 'Cashier', 'Food Runner', 'Expo / To-Go', 'FOH Manager']
const BOH_ROLES = ['Cook', 'Line Cook', 'Prep Cook', 'Dishwasher', 'Assembler', 'Kitchen Lead', 'Expo', 'BOH Manager']
const UNIFIED_ROLES = ['Cashier', 'Server', 'Host', 'Busser', 'Bartender', 'Cook', 'Prep', 'Dishwasher', 'Assembler', 'Runner', 'Manager']

// Minutes from midnight — 15-min increments
interface ShiftBlock { name: string; startMin: number; endMin: number }
interface Section { name: string; role: string; area: 'foh' | 'boh'; start: number; end: number }

// Format minutes to "9:30 AM"
function fmtMin(m: number) {
  const h = Math.floor(m / 60) % 24
  const min = m % 60
  const suffix = h >= 12 ? 'PM' : 'AM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:${min.toString().padStart(2, '0')} ${suffix}`
}

const PRESETS: Record<number, ShiftBlock[]> = {
  1: [{ name: 'Full day', startMin: 540, endMin: 1260 }],       // 9a–9p
  2: [{ name: 'Opening', startMin: 540, endMin: 900 }, { name: 'Closing', startMin: 900, endMin: 1320 }], // 9a–3p, 3p–10p
  3: [{ name: 'Opening', startMin: 480, endMin: 840 }, { name: 'Mid', startMin: 840, endMin: 1080 }, { name: 'Closing', startMin: 1080, endMin: 1380 }],
}

const TEAM_PRESETS: ShiftBlock[] = [
  { name: 'Morning', startMin: 420, endMin: 900 },   // 7a–3p
  { name: 'Night', startMin: 900, endMin: 1380 },     // 3p–11p
]

type HouseModel = 'split' | 'unified'
type SchedStyle = 'by_role' | 'by_team'

export default function StaffingSetup() {
  const [step, setStep] = useState(1)
  const [houseModel, setHouseModel] = useState<HouseModel | null>(null)
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set())
  const [schedStyle, setSchedStyle] = useState<SchedStyle | null>(null)
  const [roleShifts, setRoleShifts] = useState<Map<string, ShiftBlock[]>>(new Map())
  const [currentRoleIdx, setCurrentRoleIdx] = useState(0)
  const [teamBlocks, setTeamBlocks] = useState<ShiftBlock[]>([...TEAM_PRESETS])
  // Tracks block start times the user manually overrode; adjacent-sync skips these.
  // Key: `r:<role>:<idx>` for by_role, `t:<idx>` for by_team.
  const [manualStarts, setManualStarts] = useState<Set<string>>(new Set())
  const [state, action, pending] = useActionState(completeStaffingSetup, null)
  // Lightweight "answer accepted" feedback — a short, dismissible pill.
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showFlash = (msg: string) => {
    setFlash(msg)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 1100)
  }
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

  const roles = [...selectedRoles]
  const currentRole = roles[currentRoleIdx]
  const isLastRole = currentRoleIdx === roles.length - 1
  const totalSteps = 4

  const toggleRole = (r: string) => setSelectedRoles((p) => { const n = new Set(p); n.has(r) ? n.delete(r) : n.add(r); return n })

  const addRoleBlock = () => {
    if (!currentRole) return
    setRoleShifts((p) => {
      const n = new Map(p)
      const blocks = [...(n.get(currentRole) ?? [])]
      const prevEnd = blocks.length ? blocks[blocks.length - 1].endMin : 540
      blocks.push({ name: '', startMin: prevEnd, endMin: Math.min(prevEnd + 240, 1439) })
      n.set(currentRole, blocks)
      return n
    })
  }

  const removeRoleBlock = (idx: number) => {
    if (!currentRole) return
    setRoleShifts((p) => {
      const n = new Map(p)
      const blocks = (n.get(currentRole) ?? []).filter((_, j) => j !== idx)
      n.set(currentRole, blocks)
      return n
    })
    setManualStarts((p) => {
      const n = new Set<string>()
      for (const k of p) if (k !== `r:${currentRole}:${idx}`) n.add(k)
      return n
    })
  }

  const updateRoleBlock = (idx: number, field: keyof ShiftBlock, val: string | number) => {
    if (!currentRole) return
    // Mark start edits as manual so adjacent-sync won't overwrite them later.
    if (field === 'startMin') {
      setManualStarts((p) => { const n = new Set(p); n.add(`r:${currentRole}:${idx}`); return n })
    }
    setRoleShifts((p) => {
      const n = new Map(p)
      const blocks = [...(n.get(currentRole) ?? [])]
      blocks[idx] = { ...blocks[idx], [field]: val }
      // Adjacent sync: when a block's end time changes, the next block's start
      // inherits it — unless the user has manually overridden that next start.
      if (field === 'endMin' && idx + 1 < blocks.length && !manualStarts.has(`r:${currentRole}:${idx + 1}`)) {
        blocks[idx + 1] = { ...blocks[idx + 1], startMin: val as number }
      }
      n.set(currentRole, blocks)
      return n
    })
  }

  const goStep4 = () => {
    if (!schedStyle) return
    if (schedStyle === 'by_role') {
      const m = new Map<string, ShiftBlock[]>()
      for (const r of roles) m.set(r, [...PRESETS[2]])
      setRoleShifts(m)
      setCurrentRoleIdx(0)
    }
    setStep(4)
  }

  const buildSections = (): Section[] => {
    const result: Section[] = []
    const getArea = (role: string): 'foh' | 'boh' => houseModel === 'unified' ? 'foh' : (FOH_ROLES.includes(role) ? 'foh' : 'boh')

    if (schedStyle === 'by_role') {
      for (const [role, blocks] of roleShifts) {
        for (const b of blocks) {
          result.push({ name: b.name, role, area: getArea(role), start: Math.floor(b.startMin / 60), end: Math.floor(b.endMin / 60) })
        }
      }
    } else {
      // Team-based: in a split house model, every team block must be generated
      // for BOTH areas so FOH and BOH each receive their own shift blocks.
      const areas: ('foh' | 'boh')[] = houseModel === 'split' ? ['foh', 'boh'] : ['foh']
      for (const area of areas) {
        for (const b of teamBlocks) {
          result.push({ name: b.name, role: 'Any', area, start: Math.floor(b.startMin / 60), end: Math.floor(b.endMin / 60) })
        }
      }
    }
    return result
  }

  const confirmTexts = [
    '',
    houseModel === 'split' ? 'We\'ll organize around Front + Back of House.' : 'We\'ll build a unified schedule.',
    `${selectedRoles.size} role${selectedRoles.size !== 1 ? 's' : ''} selected — your team is taking shape.`,
    schedStyle === 'by_role' ? 'We\'ll set up shifts for each role.' : 'We\'ll organize around team shift blocks.',
    '',
  ]

  // Re-mount key for step content — changing it re-runs the slideFade keyframe
  // so every transition (new step OR new role) has a visible acknowledgment.
  const contentKey = `${step}:${step === 4 && schedStyle === 'by_role' ? currentRoleIdx : 'x'}`

  return (
    <div className="max-w-xl mx-auto py-8 relative">
      <style>{`
        @keyframes staffSlideFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes staffFlashIn   { 0% { opacity: 0; transform: translate(-50%, -8px) scale(.96); }
                                    20% { opacity: 1; transform: translate(-50%, 0) scale(1); }
                                    80% { opacity: 1; transform: translate(-50%, 0) scale(1); }
                                    100% { opacity: 0; transform: translate(-50%, -4px) scale(.98); } }
        @keyframes staffSelectPulse { 0% { box-shadow: 0 0 0 0 rgba(37, 99, 235, .35); }
                                      100% { box-shadow: 0 0 0 10px rgba(37, 99, 235, 0); } }
        .staff-anim-content { animation: staffSlideFade .32s cubic-bezier(.2,.7,.2,1) both; }
        .staff-anim-flash   { animation: staffFlashIn 1.1s ease both; }
        .staff-anim-pulse   { animation: staffSelectPulse .55s ease-out; }
      `}</style>

      {/* Flash pill — "answer accepted" acknowledgment */}
      {flash && (
        <div className="staff-anim-flash pointer-events-none fixed top-6 left-1/2 z-50">
          <div className="flex items-center gap-2 rounded-full bg-gray-900 text-white text-xs font-medium px-4 py-2 shadow-lg">
            <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            {flash}
          </div>
        </div>
      )}

      {/* Progress */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-gray-500">
            Step {step} of {totalSteps}
            {step === 4 && schedStyle === 'by_role' && roles.length > 1 && (
              <span className="ml-2 text-gray-400">· {currentRoleIdx + 1} / {roles.length} roles</span>
            )}
          </p>
          <p className="text-xs text-gray-400">{Math.round((step / totalSteps) * 100)}%</p>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-600 rounded-full transition-all duration-500" style={{ width: `${(step / totalSteps) * 100}%` }} />
        </div>
      </div>

      {step > 1 && confirmTexts[step - 1] && (
        <div key={`confirm-${step}`} className="staff-anim-content bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 mb-6">
          <p className="text-sm text-blue-700">{confirmTexts[step - 1]}</p>
        </div>
      )}

      <div key={contentKey} className="staff-anim-content">

      {/* STEP 1 */}
      {step === 1 && (
        <div>
          <StepHeader title="How is your operation organized?" sub="This shapes your scheduling board." />
          <div className="grid gap-4 sm:grid-cols-2 mb-8">
            <ChoiceCard selected={houseModel === 'split'} onClick={() => setHouseModel('split')} title="Front + Back of House" desc="Separate FOH (servers, hosts) and BOH (cooks, dish)" />
            <ChoiceCard selected={houseModel === 'unified'} onClick={() => setHouseModel('unified')} title="Unified team" desc="One team, one schedule — no FOH/BOH split" />
          </div>
          <NavButton onClick={() => { if (houseModel) { showFlash(houseModel === 'split' ? 'Two-house model locked in' : 'Unified team locked in'); setStep(2) } }} disabled={!houseModel}>Continue</NavButton>
        </div>
      )}

      {/* STEP 2 */}
      {step === 2 && (
        <div>
          <StepHeader title="Who's on your team?" sub="Select the roles your restaurant uses." />
          {houseModel === 'split' ? (
            <><RoleGrid label="Front of House" color="blue" roles={FOH_ROLES} selected={selectedRoles} onToggle={toggleRole} />
              <RoleGrid label="Back of House" color="amber" roles={BOH_ROLES} selected={selectedRoles} onToggle={toggleRole} /></>
          ) : (
            <RoleGrid label="Team roles" color="blue" roles={UNIFIED_ROLES} selected={selectedRoles} onToggle={toggleRole} />
          )}
          <div className="flex gap-3 mt-8">
            <BackButton onClick={() => setStep(1)} />
            <NavButton onClick={() => { if (selectedRoles.size) { showFlash(`${selectedRoles.size} role${selectedRoles.size !== 1 ? 's' : ''} saved`); setStep(3) } }} disabled={!selectedRoles.size} className="flex-1">
              Continue · {selectedRoles.size} selected
            </NavButton>
          </div>
        </div>
      )}

      {/* STEP 3 */}
      {step === 3 && (
        <div>
          <StepHeader title="How do you build your schedule?" sub="This determines your shift board structure." />
          <div className="grid gap-4 sm:grid-cols-2 mb-8">
            <ChoiceCard selected={schedStyle === 'by_role'} onClick={() => setSchedStyle('by_role')} title="By role" desc="Each role has its own shift structure" />
            <ChoiceCard selected={schedStyle === 'by_team'} onClick={() => setSchedStyle('by_team')} title="By team / shift group" desc="Everyone shares the same shift blocks" />
          </div>
          <div className="flex gap-3">
            <BackButton onClick={() => setStep(2)} />
            <NavButton onClick={() => { if (schedStyle) { showFlash(schedStyle === 'by_role' ? 'Role-based scheduling locked in' : 'Team scheduling locked in'); goStep4() } }} disabled={!schedStyle} className="flex-1">Continue</NavButton>
          </div>
        </div>
      )}

      {/* STEP 4A — Role-based */}
      {step === 4 && schedStyle === 'by_role' && currentRole && (
        <div>
          <div className="text-center mb-6">
            <p className="text-[10px] font-semibold text-blue-600 uppercase tracking-widest mb-1">{currentRoleIdx + 1} of {roles.length}</p>
            <h1 className="text-2xl font-bold text-gray-900">{currentRole}</h1>
            <p className="mt-2 text-sm text-gray-500">Here&apos;s a likely setup — just adjust it.</p>
          </div>

          <div className="space-y-3 mb-3">
            {(roleShifts.get(currentRole) ?? []).map((block, i) => (
              <ShiftCard key={i} block={block} removable
                onNameChange={(v) => updateRoleBlock(i, 'name', v)}
                onStartChange={(v) => updateRoleBlock(i, 'startMin', v)}
                onEndChange={(v) => updateRoleBlock(i, 'endMin', v)}
                onRemove={() => removeRoleBlock(i)} />
            ))}
          </div>

          <button type="button" onClick={addRoleBlock}
            className="text-xs text-blue-600 hover:text-blue-500 mb-8 block">+ Add shift</button>

          <div className="flex gap-3">
            <BackButton onClick={() => currentRoleIdx > 0 ? setCurrentRoleIdx((i) => i - 1) : setStep(3)} />
            {!isLastRole ? (
              <NavButton onClick={() => { showFlash(`${currentRole} saved · next up ${roles[currentRoleIdx + 1]}`); setCurrentRoleIdx((i) => i + 1) }} className="flex-1">Next role →</NavButton>
            ) : (
              <SubmitForm action={action} pending={pending} houseModel={houseModel!} schedStyle={schedStyle} sections={buildSections()} fohRoles={houseModel === 'unified' ? [...selectedRoles] : [...selectedRoles].filter((r) => FOH_ROLES.includes(r))} bohRoles={houseModel === 'unified' ? [] : [...selectedRoles].filter((r) => BOH_ROLES.includes(r))} error={state?.error} />
            )}
          </div>
        </div>
      )}

      {/* STEP 4B — Team-based */}
      {step === 4 && schedStyle === 'by_team' && (
        <div>
          <StepHeader title="Define your team shifts" sub="What shift blocks does your team work?" />

          <div className="space-y-3 mb-4">
            {teamBlocks.map((b, i) => (
              <ShiftCard key={i} block={b} removable
                onNameChange={(v) => setTeamBlocks((p) => p.map((x, j) => j === i ? { ...x, name: v } : x))}
                onStartChange={(v) => {
                  setManualStarts((p) => { const n = new Set(p); n.add(`t:${i}`); return n })
                  setTeamBlocks((p) => p.map((x, j) => j === i ? { ...x, startMin: v } : x))
                }}
                onEndChange={(v) => setTeamBlocks((p) => {
                  const next = [...p]
                  next[i] = { ...next[i], endMin: v }
                  // Adjacent sync: next block inherits this end as its start
                  // unless the user has manually overridden it.
                  if (i + 1 < next.length && !manualStarts.has(`t:${i + 1}`)) {
                    next[i + 1] = { ...next[i + 1], startMin: v }
                  }
                  return next
                })}
                onRemove={() => setTeamBlocks((p) => p.filter((_, j) => j !== i))} />
            ))}
          </div>

          <button type="button" onClick={() => setTeamBlocks((p) => [...p, { name: '', startMin: 540, endMin: 1020 }])}
            className="text-xs text-blue-600 hover:text-blue-500 mb-8 block">+ Add shift block</button>

          <div className="flex gap-3">
            <BackButton onClick={() => setStep(3)} />
            <SubmitForm action={action} pending={pending} houseModel={houseModel!} schedStyle={schedStyle!} sections={buildSections()} fohRoles={houseModel === 'unified' ? [...selectedRoles] : [...selectedRoles].filter((r) => FOH_ROLES.includes(r))} bohRoles={houseModel === 'unified' ? [] : [...selectedRoles].filter((r) => BOH_ROLES.includes(r))} error={state?.error} />
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

// ================================================================
// Shared components
// ================================================================

function StepHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="text-center mb-8">
      <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
      <p className="mt-2 text-sm text-gray-500">{sub}</p>
    </div>
  )
}

function NavButton({ onClick, disabled, children, className = '' }: { onClick: () => void; disabled?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40 transition-colors ${className}`}>
      {children}
    </button>
  )
}

function BackButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} className="px-6 py-3 rounded-xl border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50">Back</button>
}

function ChoiceCard({ selected, onClick, title, desc }: { selected: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button type="button" onClick={onClick}
      className={`relative rounded-xl border-2 p-5 text-left transition-all duration-200 active:scale-[.98] ${
        selected ? 'border-blue-500 bg-blue-50 shadow-sm staff-anim-pulse scale-[1.01]' : 'border-gray-200 bg-white hover:border-gray-300'
      }`}>
      <p className={`text-sm font-semibold ${selected ? 'text-blue-700' : 'text-gray-900'}`}>{title}</p>
      <p className="text-xs text-gray-500 mt-1">{desc}</p>
      {selected && (
        <span className="absolute top-3 right-3 flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 text-white">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </span>
      )}
    </button>
  )
}

function RoleGrid({ label, color, roles, selected, onToggle }: {
  label: string; color: 'blue' | 'amber'; roles: string[]; selected: Set<string>; onToggle: (r: string) => void
}) {
  return (
    <div className="mb-6">
      <p className={`text-xs font-semibold uppercase tracking-widest mb-3 ${color === 'blue' ? 'text-blue-600' : 'text-amber-600'}`}>{label}</p>
      <div className="flex flex-wrap gap-2">
        {roles.map((r) => (
          <button key={r} type="button" onClick={() => onToggle(r)}
            className={`px-3.5 py-2 rounded-xl text-sm font-medium border-2 transition-all ${
              selected.has(r) ? (color === 'blue' ? 'bg-blue-50 border-blue-400 text-blue-700' : 'bg-amber-50 border-amber-400 text-amber-700') : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>{r}</button>
        ))}
      </div>
    </div>
  )
}

// Card-style shift block with 15-min time pickers
function ShiftCard({ block, removable, onNameChange, onStartChange, onEndChange, onRemove }: {
  block: ShiftBlock; removable?: boolean
  onNameChange: (v: string) => void; onStartChange: (v: number) => void; onEndChange: (v: number) => void
  onRemove?: () => void
}) {
  return (
    <div className="bg-white rounded-2xl border-2 border-gray-100 p-4 shadow-sm hover:border-blue-200 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <input type="text" value={block.name} onChange={(e) => onNameChange(e.target.value)} placeholder="Shift name"
          className="text-sm font-semibold text-gray-900 bg-transparent focus:outline-none placeholder:text-gray-300 w-full" />
        {removable && onRemove && (
          <button type="button" onClick={onRemove} className="text-gray-300 hover:text-red-400 ml-2 flex-shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      <div className="flex items-center gap-3">
        <TimePicker value={block.startMin} onChange={onStartChange} />
        <span className="text-xs text-gray-400 font-medium">to</span>
        <TimePicker value={block.endMin} onChange={onEndChange} />
        <span className="text-[10px] text-gray-300 ml-auto">
          {(() => {
            const dur = block.endMin > block.startMin ? block.endMin - block.startMin : (1440 - block.startMin + block.endMin)
            const h = Math.floor(dur / 60)
            const m = dur % 60
            return `${h}h${m ? ` ${m}m` : ''}`
          })()}
        </span>
      </div>
    </div>
  )
}

// Compact time picker using native <input type="time">
// Converts between minutes-from-midnight and HH:MM string
function TimePicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const h = Math.floor((value % 1440) / 60)
  const m = value % 60
  const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`

  const handleChange = (val: string) => {
    const [hh, mm] = val.split(':').map(Number)
    if (!isNaN(hh) && !isNaN(mm)) {
      // Snap to nearest 15 minutes
      const snapped = Math.round(mm / 15) * 15
      onChange(hh * 60 + (snapped >= 60 ? 0 : snapped))
    }
  }

  return (
    <input type="time" value={timeStr} step={900}
      onChange={(e) => handleChange(e.target.value)}
      className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm font-medium text-gray-700
                 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                 hover:bg-gray-100 transition-colors w-[105px]" />
  )
}

function SubmitForm({ action, pending, houseModel, schedStyle, sections, fohRoles, bohRoles, error }: {
  action: (fd: FormData) => void; pending: boolean; houseModel: string; schedStyle: string
  sections: Section[]; fohRoles: string[]; bohRoles: string[]; error?: string
}) {
  return (
    <form action={action} className="flex-1">
      <input type="hidden" name="house_model" value={houseModel} />
      <input type="hidden" name="scheduling_style" value={schedStyle} />
      <input type="hidden" name="sections_json" value={JSON.stringify(sections)} />
      <input type="hidden" name="foh_roles_json" value={JSON.stringify(fohRoles)} />
      <input type="hidden" name="boh_roles_json" value={JSON.stringify(bohRoles)} />
      <button type="submit" disabled={pending || sections.length === 0}
        className="w-full rounded-xl bg-green-600 px-6 py-3 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-60 transition-colors">
        {pending ? 'Building your schedule…' : '✓ Create my schedule'}
      </button>
      {error && <p className="text-sm text-red-600 mt-3 text-center">{error}</p>}
    </form>
  )
}
