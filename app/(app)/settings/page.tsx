// ----------------------------------------------------------------
// Settings  →  /settings
//
// Owner / manager-facing surface. Four calm sections only:
//
//   1. Business     — restaurant + location + signed-in user + role
//   2. Operations   — Sales mode + Inventory / Staffing / Finance /
//                     Analytics in plain language
//   3. Integrations — Payments (Stripe), Bank Sync (Plaid),
//                     External POS (Clover) when the mode supports it
//   4. System Status — readiness checklist for the major areas
//
// All developer / testing / admin tools (setup bypass, pillar
// overrides, raw external-POS connect, CSV/JSON imports, Stripe
// test keys, Clover test orders, data maintenance) live on a
// separate internal page at /dev-tools — see
// app/(app)/dev-tools/page.tsx. That page is NOT in the sidebar.
//
// A small dev-only footer link from this page provides access for
// allowlisted accounts; non-dev users never see it.
// ----------------------------------------------------------------

import PageShell from '@/components/page-shell'
import { createClient } from '@/lib/supabase/server'
import { computeReadiness, getOperatingMode, type ReadinessSnapshot } from '@/lib/readiness'
import { isDevEmail } from '@/lib/dev'
import { isPlaidConfigured } from '@/lib/plaid/client'

import BusinessCard from './business-card'
import OperationsCard from './operations-card'
import IntegrationsCard from './integrations-card'
import SystemStatusCard from './system-status-card'
import TeamCard from './team-card'
import AccessCodesCard from './access-codes-card'
import LanguageCard from './language-card'
import { getLang } from '@/lib/i18n-server'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const lang = await getLang()

  let readiness: ReadinessSnapshot | null = null
  let isDev = false
  let isOwner = false
  let restaurantId: string | null = null
  let operatingMode: 'native_pos' | 'external_pos' | null = null

  // Business identity context.
  let businessName: string | null = null
  let primaryLocationName: string | null = null
  let role: 'owner' | 'manager' | 'staff' | null = null

  // Summary-card payloads. Fetched at the page level so the cards
  // stay pure presentation. Defaults render as "Not connected" /
  // empty for users without integrations.
  // Access codes (passcode kiosk gate) — owner-only.
  let accessOwnerSet = false
  let accessStaffSet = false

  let bankConnected = false
  let bankConnectionCount = 0
  let bankLatestSyncAt: string | null = null
  let posConnected = false
  let posEnvironment: 'sandbox' | 'production' | null = null
  let posLastMenuSyncAt: string | null = null
  let posLastOrdersSyncAt: string | null = null
  let posPendingReviewCount = 0
  // Team management payload — only fetched for owners (renders the
  // invite UI). RLS would also filter for non-owners but we skip the
  // query entirely to keep the page fast.
  let teamLocations: Array<{ id: string; name: string }> = []
  let teamInvitations: Array<{
    id: string
    email: string
    role: 'manager' | 'staff'
    status: 'pending' | 'accepted' | 'canceled' | 'expired'
    location_name: string | null
    created_at: string
  }> = []
  const userDisplayName =
    (user?.user_metadata as { full_name?: string; name?: string } | undefined)?.full_name ??
    (user?.user_metadata as { full_name?: string; name?: string } | undefined)?.name ??
    null
  const userEmail = user?.email ?? null

  if (user) {
    isDev = isDevEmail(user.email)
    const { data: roleRow } = await supabase
      .from('user_roles')
      .select('restaurant_id, role')
      .eq('user_id', user.id)
      .single()
    if (roleRow?.restaurant_id) {
      const rid: string = roleRow.restaurant_id
      restaurantId = rid
      role = roleRow.role as 'owner' | 'manager' | 'staff'
      isOwner = role === 'owner'

      const [
        { data: restaurant },
        { data: firstLoc },
        readinessSnap,
        mode,
        { data: bankAccounts },
        { data: cloverConn },
        { count: pendingCount },
      ] = await Promise.all([
        supabase.from('restaurants').select('name, owner_passcode_hash, staff_passcode_hash').eq('id', rid).maybeSingle(),
        supabase
          .from('locations')
          .select('id, name')
          .eq('restaurant_id', rid)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle(),
        computeReadiness(supabase, rid),
        getOperatingMode(supabase, rid),
        // Summary-card data: distinct Plaid connections + latest sync.
        // We only need the per-row provider_item_id + last_synced_at;
        // grouping happens client-side below.
        supabase
          .from('connected_bank_accounts')
          .select('provider_item_id, last_synced_at')
          .eq('restaurant_id', rid)
          .eq('provider', 'plaid')
          .eq('active', true),
        // Clover connection snapshot for the first location.
        supabase
          .from('external_pos_connections')
          .select('provider_credentials, active, last_menu_sync_at, last_orders_sync_at')
          .eq('restaurant_id', rid)
          .eq('provider', 'clover')
          .eq('active', true)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle(),
        // Count of pending review items (Clover-imported, inactive).
        supabase
          .from('menu_items')
          .select('id', { count: 'exact', head: true })
          .eq('restaurant_id', rid)
          .eq('external_provider', 'clover')
          .eq('active', false),
      ])
      businessName = restaurant?.name ?? null
      accessOwnerSet = !!(restaurant as { owner_passcode_hash?: string | null } | null)?.owner_passcode_hash
      accessStaffSet = !!(restaurant as { staff_passcode_hash?: string | null } | null)?.staff_passcode_hash
      primaryLocationName = firstLoc?.name ?? null
      readiness = readinessSnap
      operatingMode = mode

      // Bank sync summary — distinct Plaid Items + max(last_synced_at).
      const rows = (bankAccounts ?? []) as Array<{
        provider_item_id: string | null; last_synced_at: string | null
      }>
      const items = new Set<string>()
      let maxSync: number | null = null
      for (const r of rows) {
        if (r.provider_item_id) items.add(r.provider_item_id)
        if (r.last_synced_at) {
          const t = new Date(r.last_synced_at).getTime()
          if (maxSync === null || t > maxSync) maxSync = t
        }
      }
      bankConnectionCount = items.size
      bankConnected = items.size > 0
      bankLatestSyncAt = maxSync !== null ? new Date(maxSync).toISOString() : null

      // External POS (Clover) summary.
      const conn = cloverConn as {
        provider_credentials: { environment?: 'sandbox' | 'production' } | null
        active: boolean
        last_menu_sync_at: string | null
        last_orders_sync_at: string | null
      } | null
      posConnected = !!conn && conn.active
      posEnvironment = conn?.provider_credentials?.environment ?? null
      posLastMenuSyncAt = conn?.last_menu_sync_at ?? null
      posLastOrdersSyncAt = conn?.last_orders_sync_at ?? null
      posPendingReviewCount = Number(pendingCount ?? 0)

      // Team-management fetches — owner-only since the card is
      // hidden for everyone else.
      if (isOwner) {
        const [{ data: locs }, { data: invs }] = await Promise.all([
          supabase
            .from('locations')
            .select('id, name')
            .eq('restaurant_id', rid)
            .order('created_at', { ascending: true }),
          supabase
            .from('team_invitations')
            .select(`
              id, email, role, status, created_at,
              location:locations ( name )
            `)
            .eq('restaurant_id', rid)
            .order('created_at', { ascending: false }),
        ])
        teamLocations = (locs ?? []).map((l) => ({ id: l.id as string, name: l.name as string }))
        teamInvitations = (invs ?? []).map((row) => {
          const loc = Array.isArray(row.location) ? row.location[0] : row.location
          return {
            id: row.id as string,
            email: row.email as string,
            role: row.role as 'manager' | 'staff',
            status: row.status as 'pending' | 'accepted' | 'canceled' | 'expired',
            location_name: loc?.name ?? null,
            created_at: row.created_at as string,
          }
        })
      }
    }
  }

  // External POS card visibility — owner-only AND mode-gated.
  // Native-POS restaurants don't connect a third-party POS, so we
  // hide the card entirely. Dev accounts override the gate so the
  // testing workflow can hit both flows.
  const showExternalPosCard = !!isOwner && !!restaurantId && (isDev || operatingMode === 'external_pos')

  return (
    <PageShell
      title="Settings"
      description="Manage your restaurant configuration and connected systems."
    >
      {/* COMPACT LAYOUT
            Row 1: Business + Operations (2-col on desktop)
            Row 2: Integrations (full width)
            Row 3: System Status (full width)
            Mobile: stacks naturally via grid-cols-1.
          Single dev link lives in the Integrations card header
          (top-right) for dev accounts; the sidebar Dev Toolbox item
          is the always-on entry point. */}
      <div className="max-w-4xl space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <BusinessCard
            businessName={businessName}
            locationName={primaryLocationName}
            userDisplayName={userDisplayName}
            userEmail={userEmail}
            role={role}
          />
          {readiness && <OperationsCard readiness={readiness} />}
        </div>

        {(isOwner && restaurantId) && (
          <IntegrationsCard
            bankConfigured={isPlaidConfigured()}
            bankConnected={bankConnected}
            bankConnectionCount={bankConnectionCount}
            bankLatestSyncAt={bankLatestSyncAt}
            showExternalPos={showExternalPosCard}
            posConnected={posConnected}
            posProvider="Clover"
            posEnvironment={posEnvironment}
            posLastMenuSyncAt={posLastMenuSyncAt}
            posLastOrdersSyncAt={posLastOrdersSyncAt}
            posPendingReviewCount={posPendingReviewCount}
            isDev={isDev}
          />
        )}

        {/* Access codes — owner-only. Kiosk passcodes (owner + staff)
            that gate the system, distinct from the per-user team
            model used for payroll/auth. */}
        {(isOwner && restaurantId) && (
          <AccessCodesCard ownerSet={accessOwnerSet} staffSet={accessStaffSet} />
        )}

        {/* Language — device-level preference (same cookie as the
            marketing site). Visible to everyone with access to
            Settings; not gated on role since changing language is
            personal preference, not a configuration change. */}
        <LanguageCard currentLang={lang} />

        {/* Team management — owner-only. Lets the owner invite a
            manager (location-scoped) or staff via email. */}
        {(isOwner && restaurantId) && (
          <TeamCard locations={teamLocations} invitations={teamInvitations} />
        )}

        {readiness && <SystemStatusCard readiness={readiness} />}
      </div>
    </PageShell>
  )
}
