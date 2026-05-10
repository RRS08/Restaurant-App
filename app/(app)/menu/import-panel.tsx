'use client'

// ----------------------------------------------------------------
// MenuImportPanel
//
// Non-dev import surface for the external_pos branch of the locked
// onboarding rule. A restaurant that answered "Yes, I use another
// POS" lands on Menu and sees this panel as the canonical starting
// point — Menu acknowledges that they already have a menu in their
// existing POS and gives them a real (not dev-tools-only) path to
// connect, sync, and review imported items.
//
// Two modes:
//   • No active connection — minimal Connect form (location +
//     provider + credentials JSON). Reuses `connectExternalPos`,
//     which is owner-gated at the action layer (no dev gate), so
//     this is safe to expose in production.
//   • One or more active connections — Sync menu now / disconnect
//     controls + last-sync provenance. Reuses `syncExternalPosMenu`.
//
// Native_pos restaurants never see this panel. Dev users still have
// the richer DevTools path in Settings (CSV / JSON import, mock
// adapter, per-pillar overrides, etc.) — this is purely an
// additional surface, not a replacement.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import {
  connectExternalPos,
  disconnectExternalPos,
  syncExternalPosMenu,
} from '@/app/actions/pos-import'

interface Connection {
  id: string
  locationId: string
  provider: string
  active: boolean
  externalStoreId: string | null
  lastMenuSyncAt: string | null
  lastError: string | null
}

interface Props {
  locations: { id: string; name: string }[]
  connections: Connection[]
  isDev?: boolean
}

const PROVIDER_LABEL: Record<string, string> = {
  toast: 'Toast',
  clover: 'Clover',
  square: 'Square',
  mock: 'Mock (testing)',
}

const CREDENTIALS_PLACEHOLDER =
  'Credentials JSON (API providers).\n' +
  'Toast:  { "client_id": "...", "client_secret": "...", "restaurant_guid": "...", "base_url": "https://ws-sandbox-api.eng.toasttab.com" }\n' +
  'Clover: { "api_token": "...", "merchant_id": "...", "base_url": "https://apisandbox.dev.clover.com" }\n' +
  'Square: { "access_token": "...", "location_id": "...", "base_url": "https://connect.squareupsandbox.com" }'

export default function MenuImportPanel({ locations, connections, isDev = false }: Props) {
  const activeConnections = connections.filter((c) => c.active)
  const hasConnection = activeConnections.length > 0

  return (
    <section className="mb-8 rounded-xl border border-indigo-200 bg-indigo-50/40 p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-indigo-700">External POS</p>
          <h2 className="text-sm font-semibold text-gray-900 mt-0.5">Import your menu from your connected POS</h2>
          <p className="text-xs text-gray-600 mt-1 leading-relaxed max-w-xl">
            Your restaurant is set up to use an external POS. Connect your provider and we&rsquo;ll import
            categories and items for you. You can still add or tweak items below — imported items are
            tagged so you can tell them apart.
          </p>
        </div>
        {isDev && (
          <span className="flex-shrink-0 text-[9px] font-bold uppercase tracking-widest text-amber-700 bg-amber-100 px-2 py-0.5 rounded">
            Dev tools available in Settings
          </span>
        )}
      </div>

      {hasConnection ? (
        <ActiveConnections connections={activeConnections} locations={locations} />
      ) : (
        <ConnectForm locations={locations} />
      )}
    </section>
  )
}

// ================================================================
// ConnectForm — first-time setup
// ================================================================
function ConnectForm({ locations }: { locations: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(connectExternalPos, null)

  if (locations.length === 0) {
    return (
      <p className="text-xs text-red-600">
        No locations found. Set up a location in onboarding before connecting a POS.
      </p>
    )
  }

  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Location</span>
          <select name="location_id" required defaultValue={locations.length === 1 ? locations[0].id : ''}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
            {locations.length > 1 && <option value="" disabled>Select location…</option>}
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>{loc.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Provider</span>
          <select name="provider" defaultValue="toast"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="toast">Toast</option>
            <option value="clover">Clover</option>
            <option value="square">Square</option>
            <option value="mock">Mock (testing)</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">External store id (optional)</span>
          <input name="external_store_id" type="text" placeholder="e.g. store_123"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </label>
      </div>
      <label className="block">
        <span className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">Credentials JSON</span>
        <textarea name="credentials" rows={4}
          placeholder={CREDENTIALS_PLACEHOLDER}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[11px] font-mono placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </label>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] text-gray-500 leading-relaxed">
          Credentials stay server-side. After connecting, click Sync menu to pull categories and items.
        </p>
        <button type="submit" disabled={pending}
          className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white hover:bg-gray-800 shadow-sm disabled:opacity-60 transition-colors">
          {pending ? 'Connecting…' : 'Connect POS'}
        </button>
      </div>
      {state && 'ok' in state && <p className="text-[11px] text-green-700">{state.message}</p>}
      {state && 'error' in state && <p className="text-[11px] text-red-600">{state.error}</p>}
    </form>
  )
}

// ================================================================
// ActiveConnections — sync + disconnect for existing rows
// ================================================================
function ActiveConnections({
  connections,
  locations,
}: {
  connections: Connection[]
  locations: { id: string; name: string }[]
}) {
  const [syncState, syncAction, syncPending] = useActionState(syncExternalPosMenu, null)
  const [discState, discAction, discPending] = useActionState(disconnectExternalPos, null)

  return (
    <div className="space-y-3">
      <ul className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-50 overflow-hidden">
        {connections.map((conn) => {
          const loc = locations.find((l) => l.id === conn.locationId)
          const providerLabel = PROVIDER_LABEL[conn.provider] ?? conn.provider
          return (
            <li key={conn.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-gray-900">
                  {loc?.name ?? '—'} <span className="text-gray-400">·</span>{' '}
                  <span className="text-indigo-700">{providerLabel}</span>
                  {conn.externalStoreId && (
                    <span className="text-gray-400 font-normal"> · {conn.externalStoreId}</span>
                  )}
                </p>
                <p className="text-[10px] text-gray-500 mt-0.5">
                  {conn.lastMenuSyncAt
                    ? <>Last menu sync {new Date(conn.lastMenuSyncAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</>
                    : <>Not synced yet — click Sync menu to import</>}
                  {conn.lastError && <span className="text-red-500"> · {conn.lastError}</span>}
                </p>
              </div>
              <form action={discAction}>
                <input type="hidden" name="location_id" value={conn.locationId} />
                <button type="submit" disabled={discPending}
                  className="text-[10px] font-semibold text-gray-400 hover:text-red-600 px-2 py-1 rounded border border-gray-200 hover:border-red-200 hover:bg-red-50 transition-colors">
                  Disconnect
                </button>
              </form>
            </li>
          )
        })}
      </ul>

      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] text-gray-500 leading-relaxed">
          Menu sync pulls categories + items from every active connection. Run it whenever your provider menu changes.
        </div>
        <form action={syncAction}>
          <button type="submit" disabled={syncPending}
            className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white hover:bg-gray-800 shadow-sm disabled:opacity-60 transition-colors">
            {syncPending ? 'Syncing menu…' : 'Sync menu now'}
          </button>
        </form>
      </div>

      {syncState && 'ok' in syncState && <p className="text-[11px] text-green-700">{syncState.message}</p>}
      {syncState && 'error' in syncState && <p className="text-[11px] text-red-600">{syncState.error}</p>}
      {discState && 'ok' in discState && <p className="text-[11px] text-gray-500">{discState.message}</p>}
      {discState && 'error' in discState && <p className="text-[11px] text-red-600">{discState.error}</p>}
    </div>
  )
}
