import { createClient } from '@/lib/supabase/server'
import CloverClient from './clover-client'

// ----------------------------------------------------------------
// CloverCard — owner-only Settings section for the Clover external
// POS integration. Mirrors the SquareCard pattern. This Server
// Component owns the read-only data load + visual chrome, and
// delegates all interactive surfaces (form / test / sync /
// disconnect) to a Client Component that uses the corresponding
// server actions.
//
// Security: identical to SquareCard — the parent Settings page
// gates the section on `isOwner`, and the Clover api_token is
// never forwarded to the Client Component. The client only sees a
// "stored / not stored" indicator.
// ----------------------------------------------------------------

interface ConnectionRow {
  location_id: string
  provider_credentials: {
    merchant_id?: string
    environment?: 'sandbox' | 'production'
    api_token?: string
  } | null
  external_store_id: string | null
  active: boolean
  last_menu_sync_at: string | null
  last_orders_sync_at: string | null
  last_error: string | null
}

export default async function CloverCard({ restaurantId }: { restaurantId: string }) {
  const supabase = await createClient()

  // V1: target the restaurant's default/first location, same shape
  // as the Square card. Multi-location card list is out of scope.
  const { data: firstLoc } = await supabase
    .from('locations')
    .select('id, name')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!firstLoc) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-gray-900">Clover integration</h3>
        <p className="mt-2 text-xs text-gray-500 leading-relaxed">
          Add a location to your restaurant before configuring Clover.
        </p>
      </div>
    )
  }

  const { data: row } = await supabase
    .from('external_pos_connections')
    .select('location_id, provider_credentials, external_store_id, active, last_menu_sync_at, last_orders_sync_at, last_error')
    .eq('restaurant_id', restaurantId)
    .eq('location_id', firstLoc.id)
    .eq('provider', 'clover')
    .maybeSingle()

  const connection = row as ConnectionRow | null
  const isConfigured = !!connection && connection.active

  const { data: pendingRows } = isConfigured
    ? await supabase
        .from('menu_items')
        .select('id, name, current_price, category_id, menu_categories ( name, source )')
        .eq('restaurant_id', restaurantId)
        .eq('external_provider', 'clover')
        .eq('active', false)
        .order('name', { ascending: true })
        .limit(50)
    : { data: null }

  // category.source = 'imported' → auto-created from a Clover name
  // that didn't match any existing local category. These items
  // need real homes via the Phase B menu drawer.
  // category.source anything else → an existing user category that
  // the ingest adopted by name match. Item already sits in the
  // right home; just needs recipe + activate.
  const pendingItems = (pendingRows ?? []).map((r) => {
    const cat = r.menu_categories as unknown as { name: string; source: string | null } | null
    return {
      id: r.id as string,
      name: r.name as string,
      price: Number(r.current_price ?? 0),
      categoryName: cat?.name ?? 'Uncategorized',
      needsAssignment: cat?.source === 'imported',
    }
  })

  const creds = connection?.provider_credentials ?? null
  const initialState = isConfigured
    ? {
        configured: true as const,
        environment: (creds?.environment === 'production' ? 'production' : 'sandbox') as
          | 'sandbox'
          | 'production',
        merchantId: creds?.merchant_id ?? connection?.external_store_id ?? '',
        hasApiToken: typeof creds?.api_token === 'string' && creds.api_token.length > 0,
        lastMenuSyncAt: connection?.last_menu_sync_at ?? null,
        lastOrdersSyncAt: connection?.last_orders_sync_at ?? null,
        lastError: connection?.last_error ?? null,
      }
    : { configured: false as const }

  const statusVariant: 'configured' | 'untested' | 'idle' = !isConfigured
    ? 'idle'
    : connection?.last_menu_sync_at || connection?.last_orders_sync_at
      ? 'configured'
      : 'untested'
  const statusLabel =
    statusVariant === 'idle'
      ? 'Not connected'
      : statusVariant === 'untested'
        ? 'Configured · not yet imported'
        : 'Configured · imports active'
  const statusPill =
    statusVariant === 'idle'
      ? 'bg-gray-100 text-gray-600'
      : statusVariant === 'untested'
        ? 'bg-blue-50 text-blue-700'
        : 'bg-emerald-50 text-emerald-700'
  const statusDot =
    statusVariant === 'idle'
      ? 'bg-gray-400'
      : statusVariant === 'untested'
        ? 'bg-blue-500'
        : 'bg-emerald-500'

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-gray-900">Clover integration</h3>
            <span
              className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${statusPill}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${statusDot}`} aria-hidden="true" />
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500 leading-relaxed max-w-prose">
            External POS source. Sandbox is the default for development; production
            should wait for go-live. API tokens stay server-side — managers cannot view
            or change them. Saving credentials does{' '}
            <span className="font-semibold">not</span> import menu or sales; that&apos;s
            a separate step.
          </p>
        </div>
      </div>

      <CloverClient
        locationId={firstLoc.id}
        locationName={firstLoc.name}
        initial={initialState}
        pendingItems={pendingItems}
      />
    </div>
  )
}
