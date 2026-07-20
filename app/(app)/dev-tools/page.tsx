// ----------------------------------------------------------------
// Developer Toolbox  →  /dev-tools
//
// Internal-only surface for setup overrides, sandbox imports,
// resets, diagnostics, and test data. Mounts the existing
// `DevTools` component (setup overrides + pillar overrides + reset
// + raw external-POS connect + CSV/JSON imports + Stripe test
// keys), the `ReadinessPanel` with `isDev=true` (operating-mode
// switcher + pillar grid with DEV markers), the data-maintenance
// `CleanupButton`, and dev-mode mounts of `CloverCard` and
// `BankCard` so the dev-only Clover test-order + diagnose controls
// and the full Plaid panel remain reachable.
//
// Access:
//   • Gated server-side via `isDevEmail(user.email)`.
//   • Non-dev viewers get redirected to /settings.
//   • Not in the main sidebar nav for regular users — reached by
//     direct URL or by the sidebar's dev-flagged item when isDev.
// ----------------------------------------------------------------

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { computeReadiness } from '@/lib/readiness'
import { isDevEmail } from '@/lib/dev'

import ReadinessPanel from '../settings/readiness-panel'
import DevTools from '../settings/dev-tools'
import CleanupButton from '../settings/cleanup-button'
import CloverCard from '../settings/clover-card'
import BankCard from '../settings/bank-card'
import FinanceSandboxCard from './finance-sandbox-card'
import FinanceBankResetCard from './finance-bank-reset-card'
import MenuImportPanel from '../menu/import-panel'
import { getLang } from '@/lib/i18n-server'
import SeedSwitcherCard, { type ConceptRow } from './seed-switcher-card'
import { SEED_CONCEPTS, PLANNED_CONCEPTS } from '@/lib/seed-concepts'
import InviteCodesCard from './invite-codes-card'
import { listInviteCodes } from '@/app/actions/invites'
import DemoLeadsCard from './demo-leads-card'
import { listDemoLeads } from '@/app/actions/demo-leads'

export default async function DevToolboxPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Hard gate. Non-dev users never see this page. We redirect rather
  // than render a "not authorized" surface — the page shouldn't even
  // exist to them; the URL is a private affordance.
  if (!user || !isDevEmail(user.email)) {
    redirect('/settings')
  }

  // Lookup role + restaurant; required to compute readiness +
  // surface DevTools, which expects a real snapshot.
  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id, role')
    .eq('user_id', user.id)
    .single()

  if (!role?.restaurant_id) {
    return (
      <ToolboxShell>
        <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] p-5">
          <p className="text-sm text-gray-600">
            No restaurant found for this account. Dev tools require a linked restaurant.
          </p>
        </div>
      </ToolboxShell>
    )
  }

  const restaurantId = role.restaurant_id
  const isOwner = role.role === 'owner'
  const readiness = await computeReadiness(supabase, restaurantId)

  // The existing DevTools component needs locations + per-location
  // POS connections to drive the dev External-POS connect form.
  const [{ data: locs }, { data: conns }] = await Promise.all([
    supabase.from('locations').select('id, name').order('created_at', { ascending: true }),
    supabase
      .from('external_pos_connections')
      .select('id, location_id, provider, active, external_store_id, last_orders_sync_at, last_menu_sync_at, last_error')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: true }),
  ])
  const locations = locs ?? []
  const posConnections = conns ?? []

  // Reshape POS connections for MenuImportPanel — same camelCase
  // mapping the menu page used to use. Kept co-located with the
  // reshape rather than exported so the panel's prop shape stays a
  // hidden implementation detail of its callers.
  const externalConnectionsForPanel = (posConnections ?? []).map((c) => ({
    id: c.id as string,
    locationId: c.location_id as string,
    provider: c.provider as string,
    active: c.active as boolean,
    externalStoreId: (c.external_store_id as string | null) ?? null,
    lastMenuSyncAt: (c.last_menu_sync_at as string | null) ?? null,
    lastError: (c.last_error as string | null) ?? null,
  }))

  const lang = await getLang()

  // ---- Seed switcher data ----
  // Read the active seed + per-concept install counts so the card
  // can render its current state. Per-concept count uses a tiny
  // exact head select; the indexed (restaurant_id, concept_key)
  // column makes each query effectively constant-time.
  const { data: restaurantRow } = await supabase
    .from('restaurants')
    .select('active_seed_concept')
    .eq('id', restaurantId)
    .maybeSingle()
  const activeSeed = (restaurantRow as { active_seed_concept?: string | null } | null)
    ?.active_seed_concept ?? null

  const seedConceptRows: ConceptRow[] = await Promise.all(
    SEED_CONCEPTS.map(async (c) => {
      const { count } = await supabase
        .from('menu_items')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId)
        .eq('concept_key', c.key)
      const itemCount = count ?? 0
      return {
        key: c.key,
        labelEn: c.labelEn,
        labelEs: c.labelEs,
        installed: itemCount > 0,
        itemCount,
      }
    }),
  )

  // Surface test_seed (the ad-hoc bucket the "Tag current data"
  // button writes into) whenever there's anything tagged with it,
  // so the user can Activate it back if they tagged and lost
  // visibility of their menu. We treat it like an installed
  // concept but mark it adHoc=true so the UI skips Install /
  // Uninstall buttons — there's nothing to install, and deleting
  // would nuke the user's own pre-seed test data.
  const { count: testSeedCount } = await supabase
    .from('menu_items')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
    .eq('concept_key', 'test_seed')
  if ((testSeedCount ?? 0) > 0) {
    seedConceptRows.unshift({
      key: 'test_seed',
      labelEn: 'Test Seed',
      labelEs: 'Datos de prueba',
      installed: true,
      itemCount: testSeedCount ?? 0,
      adHoc: true,
    })
  }

  // Invite codes — the signup gate. Pre-fetched here so the card
  // hydrates with the existing list; the card itself refreshes
  // via the server action after a mint/revoke.
  const { codes: inviteCodes } = await listInviteCodes()

  // Demo leads — recent "Book a demo" submissions, including any
  // honeypot/rate-limit/turnstile rejections so we can see scale
  // of bot attempts.
  const { leads: demoLeads } = await listDemoLeads()

  return (
    <ToolboxShell>
      {/* 0. INVITE CODES --------------------------------------------
          The gate on /signup. One code per pilot. Mint here, hand
          it to the prospect after they agree to pilot pricing, watch
          it consume on signup. */}
      <DevSection
        eyebrow="Invite Codes"
        title="Gate /signup with a per-pilot code"
        body="No one signs up without a code. Generate one per pilot, send by text/email, revoke if needed."
      >
        <InviteCodesCard initialCodes={inviteCodes} />
      </DevSection>

      {/* 0.5 DEMO LEADS --------------------------------------------
          Recent submissions from the marketing "Book a demo" form,
          including honeypot/rate-limit rejections so we can see
          spam scale. Read-only — manage from Supabase if needed. */}
      <DevSection
        eyebrow="Demo Leads"
        title="Who reached out from the marketing site"
        body="Submissions to the Book-a-demo form. Bot attempts the honeypot caught show up flagged red."
      >
        <DemoLeadsCard leads={demoLeads} />
      </DevSection>

      {/* 1. DEMO SEED SWITCHER -------------------------------------
          Sales-call workflow: switch the visible menu + inventory
          to match the lead's concept (taqueria, bakery, …) without
          deleting any data. See app/actions/seed.ts + the
          lib/seed-concepts.ts dataset for what each concept loads. */}
      <DevSection
        eyebrow="Demo Seeds"
        title="Shape the demo to the lead"
        body="Install, activate, or hide concept-themed datasets. Only the active concept renders in POS, Menu, and Inventory; the others stay parked in the DB."
      >
        <SeedSwitcherCard
          activeSeed={activeSeed}
          installedConcepts={seedConceptRows}
          plannedConcepts={PLANNED_CONCEPTS.map((c) => ({ key: c.key, labelEn: c.labelEn }))}
        />
      </DevSection>

      {/* 1. SETUP & READINESS OVERRIDES ----------------------------
          The dev-gated pillar grid + operating-mode switcher + the
          full setup-override surface (bypass, per-pillar overrides,
          reset, external-POS raw connect, CSV/JSON imports, Stripe
          test keys). The internal DevTools component bundles many
          sub-cards; we frame it under one Setup eyebrow rather than
          splitting at this level. */}
      <DevSection
        eyebrow="Setup & Readiness"
        title="Pillar readiness + manual state"
        body="Operating-mode switcher, per-pillar overrides, bypass, reset, plus raw POS / CSV / JSON / Stripe controls."
      >
        <ReadinessPanel readiness={readiness} isDev={true} />
        <div className="mt-4">
          <DevTools
            readiness={readiness}
            locations={locations}
            posConnections={posConnections}
          />
        </div>
      </DevSection>

      {/* 2. EXTERNAL POS DEV CONTROLS ------------------------------
          Full CloverCard with isDev=true. Regular Settings now shows
          a summary-only ExternalPosSummaryCard; every interactive
          control (form / connect / sync / disconnect / reset / test
          order / diagnose) lives here. */}
      {isOwner && (
        <DevSection
          eyebrow="External POS · Clover"
          title="Connection, sync, test, diagnostics"
          body="Connect, sync, test the connection, reset imported data, create a test order, or diagnose orders fetch."
        >
          <CloverCard restaurantId={restaurantId} isDev={true} />
        </DevSection>
      )}

      {/* 2.5 EXTERNAL POS MENU IMPORT PANEL -----------------------
          The customer-facing "connect / sync / disconnect" panel
          used to live at the top of /menu. Hidden from there while
          we finalize the pilot pitch — parked here so dev testing
          of the connect + sync flow still has a UI to reach. Will
          return to /menu when the integration is ready to sell as a
          first-class feature. */}
      {isOwner && (
        <DevSection
          eyebrow="External POS · Menu Import Panel"
          title="Customer-facing connect / sync / disconnect UI"
          body="The panel that used to greet external-POS customers on their Menu page. Still functional, just parked in Dev Toolbox for now."
        >
          <MenuImportPanel
            locations={locations}
            connections={externalConnectionsForPanel}
            isDev={true}
            lang={lang}
          />
        </DevSection>
      )}

      {/* 3. BANK SYNC / PLAID CONTROLS -----------------------------
          Full BankCard. Regular Settings now shows a summary-only
          BankSyncSummaryCard; per-account list + connect / sync /
          disconnect live here. */}
      {isOwner && (
        <DevSection
          eyebrow="Bank Sync · Plaid"
          title="Connections, accounts, sync"
          body="Per-institution connection blocks with connect, sync, and disconnect."
        >
          <BankCard restaurantId={restaurantId} />
        </DevSection>
      )}

      {/* 4. FINANCE BANK SANDBOX RESET -----------------------------
          Full reset for Finance verification testing. Wipes every
          bank_transactions row (Plaid-imported + sandbox-seeded) for
          this restaurant, clears the attached Bank Review state
          columns, and resets the per-account sync cursor so the
          next sync walks from the beginning. Keeps the Plaid
          connection itself + all operational data (sales, inventory,
          staffing, menu, employees, business setup). Used to start
          Finance engine tests from a clean controlled state. */}
      <DevSection
        eyebrow="Finance Bank Testing"
        title="Reset Finance Bank Sandbox"
        body="Wipe all imported bank transactions and Bank Review test state so you can exercise the Finance verification engine from a clean slate. Keeps sales, inventory, staffing, menu, employees, and the bank connection itself."
        destructive
      >
        <FinanceBankResetCard />
      </DevSection>

      {/* 5. FINANCE SETTLEMENT SANDBOX -----------------------------
          Deterministic seeded bank_transactions rows for testing
          the Bank Review settlement workflow. Real Plaid sandbox
          data is unreliable for end-to-end review testing — these
          seeds give QA known surfaces (Stripe payout, Sysco order,
          ADP payroll, rent payment, personal CVS charge, etc.).
          All seeded rows carry provider_transaction_id starting
          with 'sandbox_' and provider_metadata.sandbox=true so the
          per-card clear action scopes cleanup safely. */}
      <DevSection
        eyebrow="Finance Settlement Sandbox"
        title="Seed Bank Review test scenarios"
        body="Seed controlled bank activity to test payout, inventory, payroll, operating, personal, and unmatched review flows. Requires a sandbox bank connection (Plaid Sandbox connect above)."
      >
        <FinanceSandboxCard />
      </DevSection>

      {/* 6. DATA MAINTENANCE ---------------------------------------
          Inventory-merge / integrity / clear-employees / reset-
          staffing. These are admin/testing operations — never owner-
          facing in pilot. The destructive items inside are styled
          with red outlines by CleanupButton itself, so the section
          itself can stay calm. */}
      <DevSection
        eyebrow="Data maintenance"
        title="Merge, integrity, reset"
        body="Resolve duplicates, scan for orphans, clear employees, or reset staffing setup. Destructive — use with care."
        destructive
      >
        <CleanupButton />
      </DevSection>
    </ToolboxShell>
  )
}

// ----------------------------------------------------------------
// ToolboxShell — page-level chrome for /dev-tools. Replaces the
// shared PageShell so the page can carry a family-standard 28px
// title and an internal-only badge in the top-right, plus the
// amber warning banner directly underneath. Self-contained so we
// don't have to alter the shared PageShell that other pages use.
// ----------------------------------------------------------------
function ToolboxShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[1400px]">
      {/* Family-standard page header. The "Internal · Dev only"
          chip on the right is the same family pattern Sales /
          Settings use for the data-origin / status badge. */}
      <div className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">
            Developer Toolbox
          </h1>
          <p className="mt-1.5 text-sm text-gray-500">Internal testing only.</p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200/80">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          Internal · Dev only
        </span>
      </div>

      {/* Calm warning banner. Slimmer than the prior heavy 2px
          border treatment; the page title already signals "dev" via
          the badge above, so the banner just adds the operational
          warning without restating identity. */}
      <div className="mb-8 rounded-xl border border-amber-200 bg-amber-50/40 px-4 py-3">
        <p className="text-xs text-amber-800 leading-relaxed">
          <span className="font-semibold">Heads up.</span> These actions can alter setup state, imported data, or test records.
          Don&apos;t run them against production data unless you mean it.
        </p>
      </div>

      {children}
    </div>
  )
}

// ----------------------------------------------------------------
// DevSection — consistent eyebrow / title / body grouping above
// each dev block. Amber eyebrow signals the dev-section identity
// without flooding the section with color.
//
// `destructive` adds a subtle red-tinted top accent so sections
// with destructive actions inside stand apart from the safe sections
// above them.
// ----------------------------------------------------------------
function DevSection({
  eyebrow,
  title,
  body,
  children,
  destructive = false,
}: {
  eyebrow: string
  title: string
  body: string
  children: React.ReactNode
  destructive?: boolean
}) {
  return (
    <section className={`mb-10 ${destructive ? 'pt-4 border-t-2 border-t-red-200/60' : ''}`}>
      <div className="mb-3">
        <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${destructive ? 'text-red-700' : 'text-amber-700'}`}>
          {eyebrow}
          {destructive && <span className="ml-1.5 text-red-600/80">· destructive</span>}
        </p>
        <h2 className="mt-0.5 text-sm font-semibold text-gray-900">{title}</h2>
        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed max-w-prose">
          {body}
        </p>
      </div>
      {children}
    </section>
  )
}
