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
import { makeT, type Lang } from '@/lib/i18n'

type Step = 0 | 1 | 2 | 3 | 4 | 5
type T = (en: string, es?: string) => string

const BIZ_TYPES: BusinessType[] = ['full_service', 'quick_service', 'food_truck', 'cafe', 'bar']
const TEAMS: TeamModel[] = ['foh_boh', 'unified', 'prep_service']
const SCHEDS: SchedulingStyle[] = ['by_role', 'by_shift_block']

const BIZ_LABELS_ES: Record<BusinessType, string> = {
  full_service: 'Restaurante con servicio completo',
  quick_service: 'Servicio rápido / Comida rápida',
  food_truck: 'Food truck',
  cafe: 'Café / Cafetería',
  bar: 'Bar / Cantina',
}

const TEAM_LABELS_ES: Record<TeamModel, string> = {
  foh_boh: 'Salón + Cocina',
  unified: 'Equipo unificado',
  prep_service: 'Prep + Servicio',
}

const SCHED_LABELS_ES: Record<SchedulingStyle, string> = {
  by_role: 'Por rol',
  by_shift_block: 'Por bloque de turno',
}

const BIZ_SUBTITLES_EN: Record<BusinessType, string> = {
  full_service: 'Dine-in with full table service',
  quick_service: 'Counter service, fast turnaround',
  food_truck: 'Mobile, compact menu',
  cafe: 'Coffee-forward, light food',
  bar: 'Drinks-first, food secondary',
}

const BIZ_SUBTITLES_ES: Record<BusinessType, string> = {
  full_service: 'Para comer en el local con servicio en mesa',
  quick_service: 'Servicio de mostrador, rotación rápida',
  food_truck: 'Móvil, menú compacto',
  cafe: 'Centrado en café, comida ligera',
  bar: 'Bebidas primero, comida secundaria',
}

const TEAM_SUBTITLES_EN: Record<TeamModel, string> = {
  foh_boh: 'Separate front and kitchen teams',
  unified: 'Everyone shares the same pool',
  prep_service: 'Split by prep work vs customer-facing',
}

const TEAM_SUBTITLES_ES: Record<TeamModel, string> = {
  foh_boh: 'Equipos separados de salón y cocina',
  unified: 'Todos comparten el mismo grupo',
  prep_service: 'Dividido entre preparación y atención al cliente',
}

const SCHED_SUBTITLES_EN: Record<SchedulingStyle, string> = {
  by_role: 'Each role gets its own row on the board',
  by_shift_block: 'Opening / Closing blocks with roles inside',
}

const SCHED_SUBTITLES_ES: Record<SchedulingStyle, string> = {
  by_role: 'Cada rol tiene su propia fila en el tablero',
  by_shift_block: 'Bloques de apertura / cierre con roles dentro',
}

export default function OnboardingWizard({ lang }: { lang: Lang }) {
  const t = makeT(lang)
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

  const bizLabel = (v: BusinessType) => lang === 'es' ? BIZ_LABELS_ES[v] : BUSINESS_TYPE_LABEL[v]
  const teamLabel = (v: TeamModel) => lang === 'es' ? TEAM_LABELS_ES[v] : TEAM_MODEL_LABEL[v]
  const schedLabel = (v: SchedulingStyle) => lang === 'es' ? SCHED_LABELS_ES[v] : SCHEDULING_STYLE_LABEL[v]
  const bizSub = (v: BusinessType) => lang === 'es' ? BIZ_SUBTITLES_ES[v] : BIZ_SUBTITLES_EN[v]
  const teamSub = (v: TeamModel) => lang === 'es' ? TEAM_SUBTITLES_ES[v] : TEAM_SUBTITLES_EN[v]
  const schedSub = (v: SchedulingStyle) => lang === 'es' ? SCHED_SUBTITLES_ES[v] : SCHED_SUBTITLES_EN[v]

  const TITLES: Record<Step, [string, string]> = {
    0: [
      t('Let’s set up your restaurant', 'Vamos a configurar tu restaurante'),
      t('We’ll personalize the system from your answers.', 'Personalizaremos el sistema con tus respuestas.'),
    ],
    1: [
      t('What type of food service are you running?', '¿Qué tipo de servicio gastronómico operas?'),
      t('This shapes your menu sections, staffing defaults, and setup flow.', 'Esto define las secciones del menú, los valores por defecto del personal y el flujo de configuración.'),
    ],
    2: [
      t('How is your team organized?', '¿Cómo se organiza tu equipo?'),
      t('Determines how the staffing board is structured.', 'Determina cómo se estructura el tablero de personal.'),
    ],
    3: [
      t('How do you plan to schedule?', '¿Cómo planeas programar los turnos?'),
      t('You can change this later once you see the board.', 'Puedes cambiarlo después una vez que veas el tablero.'),
    ],
    4: [
      effSched === 'by_role'
        ? t('Which roles do you schedule separately?', '¿Qué roles programas por separado?')
        : t('Which roles does your restaurant use?', '¿Qué roles usa tu restaurante?'),
      t('Recommended roles are preselected. Uncheck what you don’t need.', 'Los roles recomendados están preseleccionados. Desmarca los que no necesites.'),
    ],
    5: [
      t('Are you already using another POS?', '¿Ya usas otro POS?'),
      t('This sets up native sales or import from your existing system.', 'Esto configura ventas nativas o la importación desde tu sistema actual.'),
    ],
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
            <span className="text-sm font-semibold text-gray-900">{t('Setup', 'Configuración')}</span>
          </div>
          <span className="text-xs text-gray-400">
            {t('Step', 'Paso')} {step + 1} {t('of', 'de')} 6
          </span>
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
            {step === 0 && <StepBasics t={t} restName={restName} setRestName={setRestName} locName={locName} setLocName={setLocName} locAddr={locAddr} setLocAddr={setLocAddr} />}
            {step === 1 && <OptionGrid t={t} items={BIZ_TYPES.map(v => ({ v, label: bizLabel(v), sub: bizSub(v) }))} value={biz} onPick={setBiz} cols={3} />}
            {step === 2 && <OptionGrid t={t} items={TEAMS.map(v => ({ v, label: teamLabel(v), sub: teamSub(v), rec: v === recTeam }))} value={effTeam} onPick={(v) => { setTeam(v as TeamModel); setTeamTouched(true) }} cols={3} />}
            {step === 3 && <OptionGrid t={t} items={SCHEDS.map(v => ({ v, label: schedLabel(v), sub: schedSub(v), rec: v === recSched }))} value={effSched} onPick={(v) => { setSched(v as SchedulingStyle); setSchedTouched(true) }} cols={2} />}
            {step === 4 && matrix && effTeam && <StepRoles t={t} matrix={matrix} tm={effTeam} a={rolesA} b={rolesB} setA={setRolesA} setB={setRolesB} />}
            {step === 5 && <StepPos t={t} value={extPos} onChange={setExtPos} />}
          </div>

          {error && <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

          <div className="mt-8 flex items-center justify-between border-t border-gray-100 pt-6">
            <button type="button" onClick={back} disabled={step === 0 || isPending}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-30">
              &larr; {t('Back', 'Atrás')}
            </button>
            {step < 5
              ? <button type="button" onClick={next} disabled={!ok || isPending}
                  className="px-5 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors disabled:opacity-50">
                  {t('Continue', 'Continuar')}
                </button>
              : <button type="button" onClick={submit} disabled={!ok || isPending}
                  className="px-5 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors disabled:opacity-50">
                  {isPending ? t('Setting up…', 'Configurando…') : t('Finish setup', 'Finalizar configuración')}
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
function OptionGrid<T2 extends string>({ t, items, value, onPick, cols }: {
  t: T
  items: { v: T2; label: string; sub: string; rec?: boolean }[]
  value: T2 | null; onPick: (v: T2) => void; cols: number
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
                {t('Rec', 'Rec.')}
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

function StepBasics({ t, restName, setRestName, locName, setLocName, locAddr, setLocAddr }: {
  t: T
  restName: string; setRestName: (v: string) => void
  locName: string; setLocName: (v: string) => void
  locAddr: string; setLocAddr: (v: string) => void
}) {
  return (
    <div className="space-y-5">
      <FieldInput
        label={t('Restaurant name', 'Nombre del restaurante')}
        value={restName}
        onChange={setRestName}
        placeholder={t('e.g. Sunset Grille', 'p. ej. Sunset Grille')}
      />
      <FieldInput
        label={t('First location name', 'Nombre del primer local')}
        value={locName}
        onChange={setLocName}
        placeholder={t('e.g. Main Street', 'p. ej. Calle Principal')}
      />
      <FieldInput
        label={t('Address (optional)', 'Dirección (opcional)')}
        value={locAddr}
        onChange={setLocAddr}
        placeholder={t('123 Main St', 'Calle Principal 123')}
      />
    </div>
  )
}

// ================================================================
// Step 4 — Role selection
// ================================================================
function StepRoles({ t, matrix, tm, a, b, setA, setB }: {
  t: T
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
      <RoleBucket t={t} label={matrix.groupALabel} bucket={matrix.groupA} sel={a} onToggle={r => toggle('A', r)} />
      {matrix.groupB && matrix.groupBLabel && tm !== 'unified' && (
        <RoleBucket t={t} label={matrix.groupBLabel} bucket={matrix.groupB} sel={b} onToggle={r => toggle('B', r)} />
      )}
      <p className="text-xs text-gray-400">
        {tm === 'unified'
          ? t('Pick at least one role.', 'Elige al menos un rol.')
          : t('Pick at least one role in each section.', 'Elige al menos un rol en cada sección.')}
      </p>
    </div>
  )
}

function RoleBucket({ t, label, bucket, sel, onToggle }: {
  t: T
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
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">{t('Optional', 'Opcional')}</p>
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
function StepPos({ t, value, onChange }: { t: T; value: boolean | null; onChange: (v: boolean) => void }) {
  // This single answer branches the entire product experience. It sets
  // operating_mode for the restaurant and is intentionally hard to flip
  // post-setup (Settings exposes the switch only to dev accounts), so
  // the copy spells out what each branch actually turns on.
  const options: Array<{ v: boolean; title: string; sub: string; bullets: string[] }> = [
    {
      v: true,
      title: t('Yes — I use another POS', 'Sí — uso otro POS'),
      sub: t(
        'Toast, Clover, Square, or similar. We import from there.',
        'Toast, Clover, Square o similar. Importamos desde allí.'
      ),
      bullets: [
        t('Sales come in from your existing POS', 'Las ventas entran desde tu POS actual'),
        t('Menu can be imported from your provider', 'El menú se puede importar desde tu proveedor'),
        t(
          'Sales page becomes a review ledger of imported orders',
          'La página de ventas se convierte en un libro de revisión de pedidos importados'
        ),
      ],
    },
    {
      v: false,
      title: t('No — set me up fresh', 'No — configúralo desde cero'),
      sub: t(
        'No external POS. We’ll run sales natively in-app.',
        'Sin POS externo. Ejecutaremos las ventas de forma nativa en la app.'
      ),
      bullets: [
        t('Built-in POS for ringing up sales', 'POS integrado para registrar ventas'),
        t('Native menu builder', 'Constructor de menú nativo'),
        t('Sales page is the live ledger of native sales', 'La página de ventas es el libro en vivo de ventas nativas'),
      ],
    },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {options.map(opt => (
        <button key={String(opt.v)} type="button" onClick={() => onChange(opt.v)}
          className={`text-left rounded-xl border p-5 transition-all ${
            value === opt.v
              ? 'border-blue-600 bg-blue-50/50 shadow-sm'
              : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
          }`}>
          <p className={`text-sm font-semibold ${value === opt.v ? 'text-blue-700' : 'text-gray-900'}`}>{opt.title}</p>
          <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">{opt.sub}</p>
          <ul className="mt-3 space-y-1.5">
            {opt.bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-gray-600 leading-relaxed">
                <span className={`mt-1 h-1 w-1 flex-shrink-0 rounded-full ${value === opt.v ? 'bg-blue-500' : 'bg-gray-400'}`} />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </button>
      ))}
    </div>
  )
}
