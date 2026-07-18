'use client'

// ----------------------------------------------------------------
// Developer-only Settings UI.
//
// Three sections:
//   1. Global access              — full-system bypass toggle
//   2. Pillar readiness overrides — per-pillar manual state
//   3. Reset controls             — wipe setup/override state
//
// Only rendered by app/(app)/settings/page.tsx when the viewer is
// on the DEV_EMAILS allowlist. The underlying server actions also
// check `requireDev`, so this UI is safe even if someone reaches it
// via HTML hacking.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import {
  setDevBypass,
  setPillarOverride,
  resetReadiness,
  resetPillarOverrides,
} from '@/app/actions/dev'
import { setPaymentProviderConfig } from '@/app/actions/payments'
import {
  connectExternalPos,
  syncExternalPosMenu,
  syncExternalPosOrders,
  disconnectExternalPos,
  importCsvMenu,
  importCsvOrders,
  importGodaddyCsvOrders,
  importCustomJsonMenu,
  importCustomJsonOrders,
} from '@/app/actions/pos-import'
import { resetExternalPosData } from '@/app/actions/external-pos-reset'
import {
  PILLAR_KEYS,
  VALID_PILLAR_STATES,
  type PillarKey,
  type PillarState,
  type ReadinessSnapshot,
} from '@/lib/readiness'

const PILLAR_LABELS: Record<PillarKey, string> = {
  sales: 'Sales',
  menu: 'Menu',
  mapping: 'Mapping',
  inventory: 'Inventory',
  staffing: 'Staffing',
  finance: 'Finance',
  bankSync: 'Bank sync',
  dashboard: 'Dashboard',
  analytics: 'Analytics',
}

const STATE_LABELS: Record<PillarState, string> = {
  not_started: 'Not started',
  setup_in_progress: 'Setup',
  ready: 'Ready',
  active: 'Active',
  active_with_limitations: 'Active·lim',
}

const STATE_TONES: Record<PillarState, string> = {
  not_started: 'bg-gray-100 text-gray-600',
  setup_in_progress: 'bg-blue-50 text-blue-700',
  ready: 'bg-amber-50 text-amber-700',
  active: 'bg-green-50 text-green-700',
  active_with_limitations: 'bg-amber-50 text-amber-700',
}

interface PosConnectionSummary {
  id: string
  location_id: string
  provider: string
  active: boolean
  external_store_id: string | null
  last_orders_sync_at: string | null
  last_menu_sync_at: string | null
  last_error: string | null
}

export default function DevTools({
  readiness,
  locations,
  posConnections,
}: {
  readiness: ReadinessSnapshot
  locations: { id: string; name: string }[]
  posConnections: PosConnectionSummary[]
}) {
  const [bypassState, bypassAction, bypassPending] = useActionState(setDevBypass, null)
  const [overrideState, overrideAction, overridePending] = useActionState(setPillarOverride, null)
  const [resetAllState, resetAllAction, resetAllPending] = useActionState(resetReadiness, null)
  const [resetOverridesState, resetOverridesAction, resetOverridesPending] = useActionState(resetPillarOverrides, null)
  const [connectState, connectAction, connectPending]           = useActionState(connectExternalPos, null)
  const [disconnectState, disconnectAction, disconnectPending]  = useActionState(disconnectExternalPos, null)
  const [menuSyncState, menuSyncAction, menuSyncPending]        = useActionState(syncExternalPosMenu, null)
  const [ordersSyncState, ordersSyncAction, ordersSyncPending]  = useActionState(syncExternalPosOrders, null)
  const [resetState, resetAction, resetPending]                 = useActionState(resetExternalPosData, null)
  const [csvMenuState, csvMenuAction, csvMenuPending]           = useActionState(importCsvMenu, null)
  const [csvOrdersState, csvOrdersAction, csvOrdersPending]     = useActionState(importCsvOrders, null)
  const [gdCsvState, gdCsvAction, gdCsvPending]                 = useActionState(importGodaddyCsvOrders, null)
  const [jsonMenuState, jsonMenuAction, jsonMenuPending]        = useActionState(importCustomJsonMenu, null)
  const [jsonOrdersState, jsonOrdersAction, jsonOrdersPending]  = useActionState(importCustomJsonOrders, null)

  const bypassOn = readiness.devBypassAll

  return (
    <div className="space-y-4 rounded-xl border-2 border-amber-200 bg-amber-50/30 p-4">

      {/* ------------- 1. Global access ------------- */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">Global access</p>
            <h3 className="text-sm font-semibold text-gray-900 mt-0.5">Bypass all setup gating</h3>
            <p className="text-[11px] text-gray-500 mt-1 leading-relaxed max-w-md">
              When enabled, every pillar is forced to <span className="font-semibold">active</span> and Analytics
              unlocks immediately. Real readiness logic is left intact — only the gate is bypassed.
            </p>
          </div>
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${
            bypassOn ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
          }`}>
            {bypassOn ? 'On' : 'Off'}
          </span>
        </div>
        <form action={bypassAction}>
          <input type="hidden" name="enabled" value={bypassOn ? 'false' : 'true'} />
          <button
            type="submit"
            disabled={bypassPending}
            className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white hover:bg-gray-800 shadow-sm transition-colors disabled:opacity-60"
          >
            {bypassPending ? 'Saving…' : bypassOn ? 'Disable bypass' : 'Enable bypass'}
          </button>
          {bypassState?.error && <p className="mt-2 text-[11px] text-red-600">{bypassState.error}</p>}
        </form>
      </div>

      {/* ------------- 2. Per-pillar overrides ------------- */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-3">
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">Readiness overrides</p>
          <h3 className="text-sm font-semibold text-gray-900 mt-0.5">Per-pillar manual state</h3>
          <p className="text-[11px] text-gray-500 mt-1 leading-relaxed max-w-md">
            Pin a pillar to a specific state for onboarding/setup testing. Clear an override with the × button
            to let the real computed state surface again.
          </p>
        </div>

        <div className="rounded-lg border border-gray-100 divide-y divide-gray-50">
          {PILLAR_KEYS.map((pillar) => {
            const override = readiness.devPillarOverrides[pillar]
            const current = readiness.pillars[pillar]
            return (
              <div key={pillar} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-900">{PILLAR_LABELS[pillar]}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      Current:{' '}
                      <span className={`inline-flex px-1.5 py-0.5 rounded-full font-semibold ${STATE_TONES[current]}`}>
                        {STATE_LABELS[current]}
                      </span>
                      {override && (
                        <span className="ml-1 text-[9px] font-bold uppercase tracking-widest text-amber-700">
                          DEV OVERRIDE
                        </span>
                      )}
                    </p>
                  </div>
                  {override && (
                    <form action={overrideAction}>
                      <input type="hidden" name="pillar" value={pillar} />
                      <input type="hidden" name="clear" value="true" />
                      <button
                        type="submit"
                        disabled={overridePending}
                        aria-label="Clear override"
                        className="text-gray-400 hover:text-gray-700 text-xs px-2 py-0.5 rounded border border-gray-200 hover:bg-gray-50"
                      >
                        × Clear
                      </button>
                    </form>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {VALID_PILLAR_STATES.map((state) => {
                    const active = override === state
                    return (
                      <form key={state} action={overrideAction}>
                        <input type="hidden" name="pillar" value={pillar} />
                        <input type="hidden" name="state" value={state} />
                        <button
                          type="submit"
                          disabled={overridePending}
                          className={`text-[10px] font-semibold px-2 py-1 rounded transition-colors ${
                            active
                              ? 'bg-gray-900 text-white shadow-sm'
                              : 'text-gray-600 hover:bg-gray-100 border border-gray-200'
                          }`}
                        >
                          {STATE_LABELS[state]}
                        </button>
                      </form>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        {overrideState?.error && <p className="mt-2 text-[11px] text-red-600">{overrideState.error}</p>}
      </div>

      {/* ------------- 3. Reset controls ------------- */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-3">
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">Reset controls</p>
          <h3 className="text-sm font-semibold text-gray-900 mt-0.5">Wipe setup / override state</h3>
          <p className="text-[11px] text-gray-500 mt-1 leading-relaxed max-w-md">
            These reset only the setup/activation state. Operational data (menu, sales, inventory, employees,
            expenses) is never touched — use the Data maintenance section below for that.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form action={resetOverridesAction}>
            <button
              type="submit"
              disabled={resetOverridesPending}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors"
            >
              {resetOverridesPending ? 'Resetting…' : 'Clear all pillar overrides'}
            </button>
            {resetOverridesState?.error && <p className="mt-1 text-[11px] text-red-600">{resetOverridesState.error}</p>}
          </form>

          <form action={resetAllAction}>
            <button
              type="submit"
              disabled={resetAllPending}
              className="rounded-lg bg-red-50 border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 transition-colors"
            >
              {resetAllPending ? 'Resetting…' : 'Reset all onboarding / setup progress'}
            </button>
            {resetAllState?.error && <p className="mt-1 text-[11px] text-red-600">{resetAllState.error}</p>}
          </form>
        </div>
      </div>

      {/* ------------- 4. External POS sync (Pilot V1, multi-location) ------------- */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-3">
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">External POS</p>
          <h3 className="text-sm font-semibold text-gray-900 mt-0.5">Pilot V1 import · per location</h3>
          <p className="text-[11px] text-gray-500 mt-1 leading-relaxed max-w-md">
            Connect a POS provider to each location that uses one. Sync buttons walk every active
            connection. Real cron runs orders at 1&nbsp;min and menu at 1&nbsp;hour.
          </p>
        </div>

        {/* Connect a new or existing location */}
        <form action={connectAction} className="space-y-2 mb-3">
          <div className="flex flex-wrap items-center gap-2">
            <select name="location_id" required
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="" disabled>Select location…</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>{loc.name}</option>
              ))}
            </select>
            <select name="provider" defaultValue="mock"
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="mock">Mock</option>
              <option value="clover">Clover</option>
              <option value="toast">Toast</option>
              <option value="square">Square</option>
              <option value="godaddy_pos">GoDaddy POS</option>
              <option value="godaddy_online">GoDaddy Online Store</option>
              <option value="csv" disabled>CSV (use the CSV import panel below)</option>
              <option value="custom_json" disabled>Custom JSON (use the JSON import panel below)</option>
            </select>
            <input name="external_store_id" type="text" placeholder="External store id (opt.)"
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs w-40 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <button type="submit" disabled={connectPending}
              className="rounded-lg bg-gray-900 text-white text-xs font-semibold px-3 py-1.5 hover:bg-gray-800 disabled:opacity-60 transition-colors">
              {connectPending ? 'Connecting…' : 'Connect / reactivate'}
            </button>
          </div>
          <textarea name="credentials" rows={3}
            placeholder={
              'Credentials JSON (API adapters only).\n' +
              'Clover: { "api_token": "xxxx", "merchant_id": "ABC123", "base_url": "https://apisandbox.dev.clover.com" }\n' +
              'Toast:  { "client_id": "xxxx", "client_secret": "yyyy", "restaurant_guid": "ZZZZ", "base_url": "https://ws-sandbox-api.eng.toasttab.com" }\n' +
              'Square: { "access_token": "EAAA...", "location_id": "LXXX", "base_url": "https://connect.squareupsandbox.com" }\n' +
              'GoDaddy: { "store_id": "STORE123", "client_id": "xxxx", "client_secret": "yyyy" }  (or "access_token" instead of client_id/secret)'
            }
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-mono placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          {connectState && 'ok' in connectState && <span className="text-[11px] text-green-700">{connectState.message}</span>}
          {connectState && 'error' in connectState && <span className="text-[11px] text-red-600">{connectState.error}</span>}
        </form>

        {/* Current connections */}
        {posConnections.length > 0 && (
          <div className="rounded-lg border border-gray-100 divide-y divide-gray-50 mb-3">
            {posConnections.map((conn) => {
              const loc = locations.find((l) => l.id === conn.location_id)
              return (
                <div key={conn.id} className="flex items-center justify-between px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-900">
                      {loc?.name ?? '—'} · <span className="capitalize">{conn.provider}</span>
                      {conn.external_store_id && <span className="text-gray-400 font-normal"> · {conn.external_store_id}</span>}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {conn.active ? 'Active' : 'Inactive'}
                      {conn.last_orders_sync_at && <> · orders {new Date(conn.last_orders_sync_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</>}
                      {conn.last_menu_sync_at && <> · menu {new Date(conn.last_menu_sync_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</>}
                      {conn.last_error && <span className="text-red-500"> · {conn.last_error}</span>}
                    </p>
                  </div>
                  {conn.active && (
                    <form action={disconnectAction}>
                      <input type="hidden" name="location_id" value={conn.location_id} />
                      <button type="submit" disabled={disconnectPending}
                        className="text-[10px] font-semibold text-gray-400 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:bg-gray-50">
                        Disconnect
                      </button>
                    </form>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Sync buttons — walk all active connections */}
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <form action={menuSyncAction}>
            <button type="submit" disabled={menuSyncPending || posConnections.filter((c) => c.active).length === 0}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors">
              {menuSyncPending ? 'Syncing menu…' : 'Sync menu now'}
            </button>
          </form>
          <form action={ordersSyncAction}>
            <button type="submit" disabled={ordersSyncPending || posConnections.filter((c) => c.active).length === 0}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors">
              {ordersSyncPending ? 'Syncing orders…' : 'Sync orders now'}
            </button>
          </form>
        </div>

        {/* Status feedback */}
        <div className="space-y-1">
          {menuSyncState && 'ok' in menuSyncState && <p className="text-[11px] text-green-700">{menuSyncState.message}</p>}
          {menuSyncState && 'error' in menuSyncState && <p className="text-[11px] text-red-600">Menu: {menuSyncState.error}</p>}
          {ordersSyncState && 'ok' in ordersSyncState && <p className="text-[11px] text-green-700">{ordersSyncState.message}</p>}
          {ordersSyncState && 'error' in ordersSyncState && <p className="text-[11px] text-red-600">Orders: {ordersSyncState.error}</p>}
          {disconnectState && 'ok' in disconnectState && <p className="text-[11px] text-gray-500">{disconnectState.message}</p>}
          {disconnectState && 'error' in disconnectState && <p className="text-[11px] text-red-600">{disconnectState.error}</p>}
        </div>

        {/* ------------- Reset imported data (any provider) -------------
            For wiping leftover data from a provider whose Settings card
            isn't currently mounted (e.g., legacy Square data after the
            Clover pivot), or for clean-slating any provider before a
            fresh test run. Same action that powers the Clover card's
            Reset button, just provider-picker driven so the same lever
            works for square / toast / mock / csv / custom_json too.

            Adopted user categories are unbound rather than deleted —
            their rows survive even if you reset the provider that
            adopted them. Historical inventory_transactions are kept. */}
        <div className="mt-4 pt-4 border-t border-gray-100">
          <p className="text-[11px] font-semibold text-gray-700 mb-1">Reset imported data</p>
          <p className="text-[10px] text-gray-500 leading-relaxed mb-2 max-w-md">
            Wipes connection rows + imported categories + imported items + imported
            orders for the chosen provider. Adopted categories are unbound rather than
            deleted. Not reversible. Useful for clearing leftover Square data after the
            Clover pivot.
          </p>
          <form action={resetAction} className="flex flex-wrap items-center gap-2">
            <select
              name="provider"
              defaultValue="square"
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-[11px] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="square">square</option>
              <option value="clover">clover</option>
              <option value="toast">toast</option>
              <option value="godaddy_pos">godaddy_pos</option>
              <option value="godaddy_online">godaddy_online</option>
              <option value="mock">mock</option>
              <option value="csv">csv</option>
              <option value="custom_json">custom_json</option>
            </select>
            <button
              type="submit"
              disabled={resetPending}
              className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60 transition-colors"
            >
              {resetPending ? 'Resetting…' : 'Reset selected provider'}
            </button>
          </form>
          {resetState && 'ok' in resetState && (
            <p className="mt-1.5 text-[11px] text-emerald-700 leading-relaxed">{resetState.message}</p>
          )}
          {resetState && 'error' in resetState && (
            <p className="mt-1.5 text-[11px] text-red-600">{resetState.error}</p>
          )}
        </div>
      </div>

      {/* ------------- 5. CSV import (Pilot V1, one-shot) ------------- */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-3">
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">CSV import</p>
          <h3 className="text-sm font-semibold text-gray-900 mt-0.5">One-shot menu / orders CSV</h3>
          <p className="text-[11px] text-gray-500 mt-1 leading-relaxed max-w-md">
            Paste raw CSV below. Imports use the same shared ingest pipeline as every other source,
            so safety rules (placeholder creation, inventory gate, dedupe) still apply. Source is
            tagged <code className="text-gray-600">csv</code> for re-import dedupe.
          </p>
        </div>

        {/* Shared location selector for both CSV forms */}
        {locations.length === 0 ? (
          <p className="text-[11px] text-red-600">No locations found for this restaurant.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {/* --- Menu CSV --- */}
            <form action={csvMenuAction} className="rounded-lg border border-gray-100 p-3">
              <p className="text-[11px] font-semibold text-gray-700 mb-1">Menu CSV</p>
              <p className="text-[10px] text-gray-400 mb-2 leading-relaxed">
                Required columns: <code>item_name</code>, <code>price</code>. Optional:{' '}
                <code>category_name</code>, <code>active</code>, <code>external_id</code>,{' '}
                <code>external_category_id</code>.
              </p>
              <select name="location_id" required
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="" disabled>Select location…</option>
                {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
              </select>
              <textarea name="input" rows={6} required
                placeholder={
                  `category_name,item_name,price,active
Appetizers,Crispy Fries,5.50,true
Appetizers,Buffalo Wings,9.00,true
Mains,House Burger,14.00,
,Daily Special,18.00,true`
                }
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-mono placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2" />
              <button type="submit" disabled={csvMenuPending}
                className="rounded-lg bg-gray-900 text-white text-xs font-semibold px-3 py-1.5 hover:bg-gray-800 disabled:opacity-60 transition-colors">
                {csvMenuPending ? 'Importing…' : 'Import menu CSV'}
              </button>
              {csvMenuState && 'ok' in csvMenuState && <p className="text-[11px] text-green-700 mt-2">{csvMenuState.message}</p>}
              {csvMenuState && 'error' in csvMenuState && <p className="text-[11px] text-red-600 mt-2">{csvMenuState.error}</p>}
            </form>

            {/* --- Orders CSV --- */}
            <form action={csvOrdersAction} className="rounded-lg border border-gray-100 p-3">
              <p className="text-[11px] font-semibold text-gray-700 mb-1">Orders CSV</p>
              <p className="text-[10px] text-gray-400 mb-2 leading-relaxed">
                Required: <code>order_id</code>, <code>posted_at</code>, <code>quantity</code>,{' '}
                <code>unit_price</code>, <code>total_price</code>, and one of <code>item_id</code> /{' '}
                <code>item_name</code>. Optional: <code>total_amount</code>, <code>payment_type</code>,{' '}
                <code>status</code>. Rows sharing an <code>order_id</code> group into one order.
              </p>
              <select name="location_id" required
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="" disabled>Select location…</option>
                {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
              </select>
              <textarea name="input" rows={6} required
                placeholder={
                  `order_id,posted_at,total_amount,payment_type,status,item_id,item_name,quantity,unit_price,total_price
ord_0001,2026-04-12T13:00:00Z,19.50,card,completed,itm_burger,House Burger,1,14.00,14.00
ord_0001,2026-04-12T13:00:00Z,19.50,card,completed,itm_fries,Crispy Fries,1,5.50,5.50
ord_0002,2026-04-12T14:00:00Z,12.50,cash,completed,itm_wings,Buffalo Wings,1,9.00,9.00`
                }
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-mono placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2" />
              <button type="submit" disabled={csvOrdersPending}
                className="rounded-lg bg-gray-900 text-white text-xs font-semibold px-3 py-1.5 hover:bg-gray-800 disabled:opacity-60 transition-colors">
                {csvOrdersPending ? 'Importing…' : 'Import orders CSV'}
              </button>
              {csvOrdersState && 'ok' in csvOrdersState && <p className="text-[11px] text-green-700 mt-2">{csvOrdersState.message}</p>}
              {csvOrdersState && 'error' in csvOrdersState && <p className="text-[11px] text-red-600 mt-2">{csvOrdersState.error}</p>}
            </form>
          </div>
        )}
      </div>

      {/* ------------- 5b. GoDaddy sales CSV (while API access is pending) ------------- */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-3">
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">GoDaddy sales CSV</p>
          <h3 className="text-sm font-semibold text-gray-900 mt-0.5">Import GoDaddy sales from a dashboard export</h3>
          <p className="text-[11px] text-gray-500 mt-1 leading-relaxed max-w-xl">
            Start capturing GoDaddy sales now, before the API/developer account is live. Export a
            sales/orders report from the GoDaddy Commerce dashboard (POS or online store) and upload
            it here. Columns are auto-detected and messy exports (currency symbols, refunds, split
            date/time) are handled. Rows are tagged <code className="text-gray-600">godaddy_pos</code> /{' '}
            <code className="text-gray-600">godaddy_online</code> so they merge cleanly with the live
            API sync later. Re-uploading the same export is safe — duplicates are skipped.
          </p>
        </div>

        {locations.length === 0 ? (
          <p className="text-[11px] text-red-600">No locations found for this restaurant.</p>
        ) : (
          <form action={gdCsvAction} className="rounded-lg border border-gray-100 p-3">
            <p className="text-[11px] font-semibold text-gray-700 mb-1">Sales / orders CSV</p>
            <p className="text-[10px] text-gray-400 mb-2 leading-relaxed">
              Auto-detected columns (any reasonable header works): an order/transaction id and a date
              are required. Item name/id + quantity + price are used when present (one row per item);
              otherwise each row is treated as a whole sale. Optional: total, tax, tip, discount,
              payment method, status. <span className="text-amber-600">Column names are PROVISIONAL</span> —
              tell me the real export headers if any column isn&apos;t picked up.
            </p>
            <div className="flex flex-wrap gap-2 mb-2">
              <select name="channel" defaultValue="pos"
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="pos">POS (in-store)</option>
                <option value="online">Online store</option>
              </select>
              <select name="location_id" required defaultValue=""
                className="flex-1 min-w-[10rem] rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="" disabled>Select location…</option>
                {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
              </select>
            </div>
            <textarea name="input" rows={6} required
              placeholder={
                `Order ID,Date,Item,Qty,Unit Price,Line Total,Payment Method,Status
1001,2026-07-15 13:04,House Burger,1,$14.00,$14.00,Visa,Paid
1001,2026-07-15 13:04,Fries,2,$3.50,$7.00,Visa,Paid
1002,7/15/2026 2:11 PM,,,,"$12.50",Cash,Paid
1003,2026-07-15,Cola,1,$3.00,($3.00),Card,Refunded`
              }
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-mono placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2" />
            <button type="submit" disabled={gdCsvPending}
              className="rounded-lg bg-gray-900 text-white text-xs font-semibold px-3 py-1.5 hover:bg-gray-800 disabled:opacity-60 transition-colors">
              {gdCsvPending ? 'Importing…' : 'Import GoDaddy sales CSV'}
            </button>
            {gdCsvState && 'ok' in gdCsvState && <p className="text-[11px] text-green-700 mt-2">{gdCsvState.message}</p>}
            {gdCsvState && 'error' in gdCsvState && <p className="text-[11px] text-red-600 mt-2">{gdCsvState.error}</p>}
          </form>
        )}
      </div>

      {/* ------------- 6. Custom JSON import (Pilot V1, one-shot) ------------- */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-3">
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">Custom JSON import</p>
          <h3 className="text-sm font-semibold text-gray-900 mt-0.5">Homemade / custom feed</h3>
          <p className="text-[11px] text-gray-500 mt-1 leading-relaxed max-w-md">
            Paste a JSON payload from a homemade POS or a custom export. Uses the same shared ingest
            pipeline — safety rules, dedupe, and the inventory gate all still apply. Source is tagged
            <code className="text-gray-600 ml-1">custom_json</code>.
          </p>
        </div>

        {locations.length === 0 ? (
          <p className="text-[11px] text-red-600">No locations found for this restaurant.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">

            {/* --- Menu JSON --- */}
            <form action={jsonMenuAction} className="rounded-lg border border-gray-100 p-3">
              <p className="text-[11px] font-semibold text-gray-700 mb-1">Menu JSON</p>
              <p className="text-[10px] text-gray-400 mb-2 leading-relaxed">
                Top-level object with an <code>items</code> array. Each item needs <code>id</code>,{' '}
                <code>name</code>, <code>price</code>. Optional: <code>categoryId</code>,{' '}
                <code>active</code>. <code>categories</code> array is optional.
              </p>
              <select name="location_id" required
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="" disabled>Select location…</option>
                {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
              </select>
              <textarea name="input" rows={10} required
                placeholder={
`{
  "categories": [
    { "id": "cat_apps", "name": "Appetizers", "sortOrder": 1 },
    { "id": "cat_mains", "name": "Mains", "sortOrder": 2 }
  ],
  "items": [
    { "id": "itm_fries",  "name": "Crispy Fries", "price": 5.50, "categoryId": "cat_apps" },
    { "id": "itm_burger", "name": "House Burger", "price": 14.00, "categoryId": "cat_mains" }
  ]
}`
                }
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-mono placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2" />
              <button type="submit" disabled={jsonMenuPending}
                className="rounded-lg bg-gray-900 text-white text-xs font-semibold px-3 py-1.5 hover:bg-gray-800 disabled:opacity-60 transition-colors">
                {jsonMenuPending ? 'Importing…' : 'Import menu JSON'}
              </button>
              {jsonMenuState && 'ok' in jsonMenuState && <p className="text-[11px] text-green-700 mt-2">{jsonMenuState.message}</p>}
              {jsonMenuState && 'error' in jsonMenuState && <p className="text-[11px] text-red-600 mt-2">{jsonMenuState.error}</p>}
            </form>

            {/* --- Orders JSON --- */}
            <form action={jsonOrdersAction} className="rounded-lg border border-gray-100 p-3">
              <p className="text-[11px] font-semibold text-gray-700 mb-1">Orders JSON</p>
              <p className="text-[10px] text-gray-400 mb-2 leading-relaxed">
                Top-level array of orders, or an object with an <code>orders</code> array. Each
                order needs <code>id</code>, <code>postedAt</code>, and non-empty{' '}
                <code>lineItems</code>. Each line needs one of <code>itemId</code>/
                <code>itemName</code>, plus <code>quantity</code>, <code>unitPrice</code>,{' '}
                <code>totalPrice</code>.
              </p>
              <select name="location_id" required
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="" disabled>Select location…</option>
                {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
              </select>
              <textarea name="input" rows={10} required
                placeholder={
`[
  {
    "id": "ord_0001",
    "postedAt": "2026-04-12T13:00:00Z",
    "totalAmount": 19.50,
    "paymentType": "card",
    "status": "completed",
    "lineItems": [
      { "itemId": "itm_burger", "itemName": "House Burger", "quantity": 1, "unitPrice": 14.00, "totalPrice": 14.00 },
      { "itemId": "itm_fries",  "itemName": "Crispy Fries", "quantity": 1, "unitPrice": 5.50,  "totalPrice": 5.50 }
    ]
  }
]`
                }
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-mono placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2" />
              <button type="submit" disabled={jsonOrdersPending}
                className="rounded-lg bg-gray-900 text-white text-xs font-semibold px-3 py-1.5 hover:bg-gray-800 disabled:opacity-60 transition-colors">
                {jsonOrdersPending ? 'Importing…' : 'Import orders JSON'}
              </button>
              {jsonOrdersState && 'ok' in jsonOrdersState && <p className="text-[11px] text-green-700 mt-2">{jsonOrdersState.message}</p>}
              {jsonOrdersState && 'error' in jsonOrdersState && <p className="text-[11px] text-red-600 mt-2">{jsonOrdersState.error}</p>}
            </form>
          </div>
        )}
      </div>

      {/* ------------- 7. Stripe (test mode) keys ------------- */}
      <StripeKeysSection />
    </div>
  )
}

// ================================================================
// StripeKeysSection — owner-only Stripe test-mode setup.
//
// Writes the secret + publishable keys to the per-restaurant
// `payment_provider_configs` + `payment_provider_secrets` tables via
// the existing `setPaymentProviderConfig` server action. The secret
// stays on the server (RLS gates the secrets table to owners). The
// browser only ever sees the publishable key, surfaced separately
// through `payment_provider_configs.publishable_key`.
//
// Intentionally scoped to the dev tools section — this is a
// development-time setup path, not a polished settings page. Use
// Stripe TEST keys only.
// ================================================================
function StripeKeysSection() {
  const [state, action, pending] = useActionState(setPaymentProviderConfig, null)
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 mt-4">
      <div className="mb-3">
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">Stripe · test mode</p>
        <h3 className="text-sm font-semibold text-gray-900 mt-0.5">Configure payment provider</h3>
        <p className="text-[11px] text-gray-500 mt-1 leading-relaxed max-w-md">
          Paste your <code>sk_test_…</code> secret key and <code>pk_test_…</code> publishable key.
          Secrets are stored per-restaurant under RLS and never exposed to the browser.
          Required before the POS card workflow can request a Stripe Terminal connection token.
        </p>
      </div>
      <form action={action} className="space-y-2">
        <input type="hidden" name="provider" value="stripe" />
        <label className="block">
          <span className="block text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate mb-1">Secret key (sk_test_…)</span>
          <input
            type="password"
            name="secret_key"
            autoComplete="off"
            required
            placeholder="sk_test_..."
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-mono placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate mb-1">Publishable key (pk_test_…)</span>
          <input
            type="text"
            name="publishable_key"
            autoComplete="off"
            placeholder="pk_test_..."
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-mono placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
          />
        </label>
        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white hover:bg-gray-800 shadow-sm disabled:opacity-60 transition-colors"
          >
            {pending ? 'Saving…' : 'Save Stripe keys'}
          </button>
          {state && 'ok' in state && <p className="text-[11px] text-green-700">{state.message}</p>}
          {state && 'error' in state && <p className="text-[11px] text-red-600">{state.error}</p>}
        </div>
      </form>
    </div>
  )
}
