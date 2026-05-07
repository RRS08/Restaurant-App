'use client'

// ----------------------------------------------------------------
// Onboarding wizard — 6-step workflow personalization.
//
// Visually aligned with the main app's design language (rounded-xl
// cards, gray-200 borders, blue-600 accents, uppercase section
// headers, consistent spacing). Timezone is auto-inferred from the
// browser and not shown to the user — it can be changed later in
// Settings.
// ----------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { completeOnboarding } from '@/app/actions/onboarding'
import {
  BUSINESS_TYPE_LABEL,
  TEAM_MODEL_LABEL,
  SCHEDULING_STYLE_LABEL,
  type BusinessType,
  type OnboardingAnswers,
  type SchedulingStyle,
  type TeamModel,
} from '@/lib/onboarding/types'
import {
  RECOMMENDED_TEAM_MODEL,
  RECOMMENDED_SCHEDULING,
  getRoleMatrix,
  isRoleSelectionValid,
} from '@/lib/onboarding/defaults'

type Step = 0 | 1 | 2 | 3 | 4 | 5

const BIZ_TYPES: BusinessType[] = ['full_service', 'quick_service', 'food_truck', 'cafe', 'bar']
const TEAMS: TeamModel[] = ['foh_boh', 'unified', 'prep_service']
const SCHEDS: SchedulingStyle[] = ['by_role', 'by_shift_block']

const BIZ_SUBTITLES: Record<BusinessType, string> = {
  full_service: 'Dine-in with full table service',
  quick_service: 'Counter service, fast turnaround',
  food_truck: 'Mobile, compact menu',
  cafe: 'Coffee-forward, light food',
  bar: 'Drinks-first, food secondary',
}

const TEAM_SUBTITLES: Record<TeamModel, string> = {
  foh_boh: 'Separate front and kitchen teams',
  unified: 'Everyone shares the same pool',
  prep_service: 'Split by prep work vs customer-facing',
}

const SCHED_SUBTITLES: Record<SchedulingStyle, string> = {
  by_role: 'Each role gets its own row on the board',
  by_shift_block: 'Opening / Closing blocks with roles inside',
}

export default function OnboardingWizard() {
  const router = useRouter()
  const [step, setStep] = useState<Step>(0)
  const [error, setError] = useState<string | null>(null)
  const [isPending, start] = useTransition()

  // Step 0 — timezone auto-inferred, never shown
  const [restName, setRestName] = useState('')
  const [locName, setLocName] = useState('')
  const [locAddr, setLocAddr] = useState('')
  const locTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'

  // Step 1
  const [biz, setBiz] = useState<BusinessType | null>(null)

  // Step 2
  const [team, setTeam] = useState<TeamModel | null>(null)
  const [teamTouched, setTeamTouched] = useState(false)

  // Step 3
  const [sched, setSched] = useState<SchedulingStyle | null>(null)
  const [schedTouched, setSchedTouched] = useState(false)

  // Step 4
  const [rolesA, setRolesA] = useState<string[]>([])
  const [rolesB, setRolesB] = useState<string[]>([])
  const [rolesKey, setRolesKey] = useState<string | null>(null)

  // Step 5
  const [extPos, setExtPos] = useState<boolean | null>(null)

  // Recommendations
  const recTeam = biz ? RECOMMENDED_TEAM_MODEL[biz] : null
  const recSched = biz ? RECOMMENDED_SCHEDULING[biz] : null
  const effTeam: TeamModel | null = teamTouched ? team : (team ?? recTeam)
  const effSched: SchedulingStyle | null = schedTouched ? sched : (sched ?? recSched)

  // Role matrix
  const matrix = useMemo(() => {
    if (!biz || !effTeam) return null
    return getRoleMatrix(biz, effTeam)
  }, [biz, effTeam])

  const mKey = biz && effTeam ? `${biz}:${effTeam}` : null
  const prevMKey = useRef<string | null>(null)
  useEffect(() => {
    if (matrix && mKey && mKey !== prevMKey.current) {
      prevMKey.current = mKey
      setRolesA(matrix.groupA.recommended)
      setRolesB(matrix.groupB?.recommended ?? [])
      setRolesKey(mKey)
    }
  }, [matrix, mKey])

  const ok = (() => {
    switch (step) {
      case 0: return restName.trim().length > 0 && locName.trim().length > 0
      case 1: return biz !== null
      case 2: return effTeam !== null
      case 3: return effSched !== null
      case 4: return effTeam !== null && isRoleSelectionValid(effTeam, rolesA, rolesB)
      case 5: return extPos !== null
    }
  })()

  const next = () => {
    if (!ok) return
    setError(null)
    if (step === 2 && !teamTouched && recTeam && !team) setTeam(recTeam)
    if (step === 3 && !schedTouched && recSched && !sched) setSched(recSched)
    setStep((s) => (s < 5 ? ((s + 1) as Step) : s))
  }
  const back = () => { setError(null); setStep((s) => (s > 0 ? ((s - 1) as Step) : s)) }

  const submit = () => {
    if (!biz || !effTeam || !effSched || extPos === null) return
    const payload: OnboardingAnswers = {
      restaurantName: restName.trim(),
      locationName: locName.trim(),
      locationAddress: locAddr.trim() || null,
      locationTimezone: locTz,
      businessType: biz,
      teamModel: effTeam,
      schedulingStyle: effSched,
      rolesGroupA: rolesA,
      rolesGroupB: rolesB,
      usesExternalPos: extPos,
    }
    start(async () => {
      const fd = new FormData()
      fd.set('answers_json', JSON.stringify(payload))
      const res = await completeOnboarding(null, fd)
      if ('error' in res) { setError(res.error); return }
      router.push('/onboarding/preview-inventory')
    })
  }

  const TITLES: Record<Step, [string, string]> = {
    0: ['Let\u2019s set up your restaurant', 'We\u2019ll personalize the system from your answers.'],
    1: ['What type of food service are you running?', 'This shapes your menu sections, staffing defaults, and setup flow.'],
    2: ['How is your team organized?', 'Determines how the staffing board is structured.'],
    3: ['How do you plan to schedule?', 'You can change this later once you see the board.'],
    4: [effSched === 'by_role' ? 'Which roles do you schedule separately?' : 'Which roles does your restaurant use?', 'Recommended roles are preselected. Uncheck what you don\u2019t need.'],
    5: ['Are you already using another POS?', 'This sets up native sales or import from your existing system.'],
  }

  // Step progress
  const progress = ((step + 1) / 6) * 100

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        {/* Logo + progress */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600" />
            <span className="text-sm font-semibold text-gray-900">Setup</span>
          </div>
          <span className="text-xs text-gray-400">Step {step + 1} of 6</span>
        </div>

        {/* Progress bar */}
        <div className="mb-6 h-1 rounded-full bg-gray-200">
          <div className="h-1 rounded-full bg-blue-600 transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>

        {/* Card */}
        <div className="rounded-xl border border-gray-200 bg-white p-8">
          <h1 className="text-xl font-bold text-gray-900">{TITLES[step][0]}</h1>
          <p className="mt-1.5 text-sm text-gray-500">{TITLES[step][1]}</p>

          <div className="mt-8">
            {step === 0 && <StepBasics restName={restName} setRestName={setRestName} locName={locName} setLocName={setLocName} locAddr={locAddr} setLocAddr={setLocAddr} />}
            {step === 1 && <OptionGrid items={BIZ_TYPES.map(v => ({ v, label: BUSINESS_TYPE_LABEL[v], sub: BIZ_SUBTITLES[v] }))} value={biz} onPick={setBiz} cols={3} />}
            {step === 2 && <OptionGrid items={TEAMS.map(v => ({ v, label: TEAM_MODEL_LABEL[v], sub: TEAM_SUBTITLES[v], rec: v === recTeam }))} value={effTeam} onPick={(v) => { setTeam(v as TeamModel); setTeamTouched(true) }} cols={3} />}
            {step === 3 && <OptionGrid items={SCHEDS.map(v => ({ v, label: SCHEDULING_STYLE_LABEL[v], sub: SCHED_SUBTITLES[v], rec: v === recSched }))} value={effSched} onPick={(v) => { setSched(v as SchedulingStyle); setSchedTouched(true) }} cols={2} />}
            {step === 4 && matrix && effTeam && <StepRoles matrix={matrix} tm={effTeam} a={rolesA} b={rolesB} setA={setRolesA} setB={setRolesB} />}
            {step === 5 && <StepPos value={extPos} onChange={setExtPos} />}
          </div>

          {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

          <div className="mt-8 flex items-center justify-between border-t border-gray-100 pt-6">
            <button type="button" onClick={back} disabled={step === 0 || isPending}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-30">
              &larr; Back
            </button>
            {step < 5
              ? <button type="button" onClick={next} disabled={!ok || isPending}
                  className="px-5 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50">
                  Continue
                </button>
              : <button type="button" onClick={submit} disabled={!ok || isPending}
                  className="px-5 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50">
                  {isPending ? 'Setting up\u2026' : 'Finish setup'}
                </button>
            }
          </div>
        </div>
      </div>
    </div>
  )
}

// ================================================================
// Option grid — business type, team model, scheduling style
// ================================================================
function OptionGrid<T extends string>({ items, value, onPick, cols }: {
  items: { v: T; label: string; sub: string; rec?: boolean }[]
  value: T | null; onPick: (v: T) => void; cols: number
}) {
  return (
    <div className={`grid gap-3 ${cols === 3 ? 'sm:grid-cols-3' : cols === 2 ? 'sm:grid-cols-2' : ''}`}>
      {items.map(i => (
        <button key={i.v} type="button" onClick={() => onPick(i.v)}
          className={`group text-left rounded-xl border p-4 transition-all ${
            value === i.v
              ? 'border-blue-600 bg-blue-50/50 shadow-sm'
              : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
          }`}>
          <div className="flex items-start justify-between gap-1.5">
            <p className={`text-sm font-semibold ${value === i.v ? 'text-blue-700' : 'text-gray-900'}`}>{i.label}</p>
            {i.rec && (
              <span className="flex-shrink-0 text-[9px] font-bold uppercase tracking-widest text-blue-600 bg-blue-100 px-1.5 py-0.5 rounded">
                Rec
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-500">{i.sub}</p>
        </button>
      ))}
    </div>
  )
}

// ================================================================
// Step 0 — Basics (timezone auto-inferred, not shown)
// ================================================================
function FieldInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</span>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="mt-1.5 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-colors" />
    </label>
  )
}

function StepBasics({ restName, setRestName, locName, setLocName, locAddr, setLocAddr }: {
  restName: string; setRestName: (v: string) => void
  locName: string; setLocName: (v: string) => void
  locAddr: string; setLocAddr: (v: string) => void
}) {
  return (
    <div className="space-y-5">
      <FieldInput label="Restaurant name" value={restName} onChange={setRestName} placeholder="e.g. Sunset Grille" />
      <FieldInput label="First location name" value={locName} onChange={setLocName} placeholder="e.g. Main Street" />
      <FieldInput label="Address (optional)" value={locAddr} onChange={setLocAddr} placeholder="123 Main St" />
    </div>
  )
}

// ================================================================
// Step 4 — Role selection
// ================================================================
function StepRoles({ matrix, tm, a, b, setA, setB }: {
  matrix: ReturnType<typeof getRoleMatrix>; tm: TeamModel
  a: string[]; b: string[]; setA: (v: string[]) => void; setB: (v: string[]) => void
}) {
  const toggle = (grp: 'A' | 'B', role: string) => {
    const c = grp === 'A' ? a : b
    const s = grp === 'A' ? setA : setB
    s(c.includes(role) ? c.filter(r => r !== role) : [...c, role])
  }
  return (
    <div className="space-y-6">
      <RoleBucket label={matrix.groupALabel} bucket={matrix.groupA} sel={a} onToggle={r => toggle('A', r)} />
      {matrix.groupB && matrix.groupBLabel && tm !== 'unified' && (
        <RoleBucket label={matrix.groupBLabel} bucket={matrix.groupB} sel={b} onToggle={r => toggle('B', r)} />
      )}
      <p className="text-xs text-gray-400">{tm === 'unified' ? 'Pick at least one role.' : 'Pick at least one role in each section.'}</p>
    </div>
  )
}

function RoleBucket({ label, bucket, sel, onToggle }: {
  label: string; bucket: { recommended: string[]; extras: string[] }; sel: string[]; onToggle: (r: string) => void
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">{label}</p>
      <div className="flex flex-wrap gap-2">
        {bucket.recommended.map(r => <RoleChip key={r} role={r} on={sel.includes(r)} onToggle={() => onToggle(r)} />)}
      </div>
      {bucket.extras.length > 0 && (
        <>
          <div className="my-3 border-t border-gray-200" />
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Optional</p>
          <div className="flex flex-wrap gap-2">
            {bucket.extras.map(r => <RoleChip key={r} role={r} on={sel.includes(r)} onToggle={() => onToggle(r)} faint />)}
          </div>
        </>
      )}
    </div>
  )
}

function RoleChip({ role, on, onToggle, faint = false }: { role: string; on: boolean; onToggle: () => void; faint?: boolean }) {
  return (
    <button type="button" onClick={onToggle}
      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
        on
          ? 'border-blue-600 bg-blue-600 text-white shadow-sm'
          : faint
            ? 'border-gray-200 bg-white text-gray-400 hover:border-gray-300 hover:text-gray-600'
            : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
      }`}>
      {role}
    </button>
  )
}

// ================================================================
// Step 5 — POS
// ================================================================
function StepPos({ value, onChange }: { value: boolean | null; onChange: (v: boolean) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[
        { v: true, title: 'Yes, I use another POS', sub: 'We\u2019ll route you to import your menu and sales from your existing system.' },
        { v: false, title: 'No, start fresh', sub: 'We\u2019ll set you up with our native POS and menu builder.' },
      ].map(opt => (
        <button key={String(opt.v)} type="button" onClick={() => onChange(opt.v)}
          className={`text-left rounded-xl border p-5 transition-all ${
            value === opt.v
              ? 'border-blue-600 bg-blue-50/50 shadow-sm'
              : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
          }`}>
          <p className={`text-sm font-semibold ${value === opt.v ? 'text-blue-700' : 'text-gray-900'}`}>{opt.title}</p>
          <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">{opt.sub}</p>
        </button>
      ))}
    </div>
  )
}
