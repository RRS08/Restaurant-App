import PageShell from '@/components/page-shell'
import CleanupButton from './cleanup-button'
import ReadinessPanel from './readiness-panel'
import DevTools from './dev-tools'
import BankCard from './bank-card'
// Square integration deliberately not mounted in this pivot —
// `square-card.tsx`, `square-client.tsx`, and `app/actions/square.ts`
// remain in the repo and can be re-mounted by re-adding this import
// + the corresponding section below. Clover is the active sandbox
// surface for the current testing phase.
import CloverCard from './clover-card'
import { createClient } from '@/lib/supabase/server'
import { computeReadiness, type ReadinessSnapshot } from '@/lib/readiness'
import { isDevEmail } from '@/lib/dev'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  let readiness: ReadinessSnapshot | null = null
  let isDev = false
  let isOwner = false
  let restaurantId: string | null = null
  let locations: { id: string; name: string }[] = []
  let posConnections: Array<{
    id: string; location_id: string; provider: string; active: boolean
    external_store_id: string | null; last_orders_sync_at: string | null
    last_menu_sync_at: string | null; last_error: string | null
  }> = []

  if (user) {
    isDev = isDevEmail(user.email)
    const { data: role } = await supabase
      .from('user_roles')
      .select('restaurant_id, role')
      .eq('user_id', user.id)
      .single()
    if (role?.restaurant_id) {
      restaurantId = role.restaurant_id
      isOwner = role.role === 'owner'
      readiness = await computeReadiness(supabase, role.restaurant_id)

      if (isDev) {
        const [{ data: locs }, { data: conns }] = await Promise.all([
          supabase.from('locations').select('id, name').order('created_at', { ascending: true }),
          supabase.from('external_pos_connections')
            .select('id, location_id, provider, active, external_store_id, last_orders_sync_at, last_menu_sync_at, last_error')
            .eq('restaurant_id', role.restaurant_id)
            .order('created_at', { ascending: true }),
        ])
        locations = locs ?? []
        posConnections = conns ?? []
      }
    }
  }

  return (
    <PageShell
      title="Settings"
      description="Manage your restaurant profile, locations, and account preferences."
    >
      {readiness && (
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
            Pillar readiness
          </h2>
          <ReadinessPanel readiness={readiness} isDev={isDev} />
        </section>
      )}

      {isDev && readiness && (
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-xs font-semibold text-amber-600 uppercase tracking-widest">
              Developer tools
            </h2>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 uppercase tracking-widest">
              Internal testing only
            </span>
          </div>
          <DevTools readiness={readiness} locations={locations} posConnections={posConnections} />
        </section>
      )}

      {isOwner && restaurantId && (
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
            Bank sync
          </h2>
          <BankCard restaurantId={restaurantId} />
        </section>
      )}

      {/* External POS integrations — owner-only. Currently testing
          against Clover sandbox (stronger sandbox + cleaner catalog
          API than Square). Square is staged in the repo and can be
          re-mounted as a sibling card when needed. */}
      {isOwner && restaurantId && (
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
            External POS integrations
          </h2>
          <CloverCard restaurantId={restaurantId} />
        </section>
      )}

      <section>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
          Data maintenance
        </h2>
        <CleanupButton />
      </section>
    </PageShell>
  )
}
