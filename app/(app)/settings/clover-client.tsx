'use client'

// ----------------------------------------------------------------
// CloverClient — interactive surface for the Clover Settings card.
//
// Same three-mode shape as SquareClient: view summary, edit form,
// inline test/sync results. All actions are owner-only on the
// server side; this component only dispatches them.
//
// Credentials handled by the form:
//   • Environment (sandbox / production)
//   • Merchant ID (non-secret)
//   • API token (password input, never pre-filled from props)
// ----------------------------------------------------------------

import { useActionState, useState } from 'react'
import {
  saveCloverConfig,
  testCloverConnection,
  disconnectClover,
  createCloverTestOrder,
  diagnoseCloverOrders,
} from '@/app/actions/clover'
import {
  syncExternalPosMenu,
  syncExternalPosOrders,
} from '@/app/actions/pos-import'
import { resetExternalPosData } from '@/app/actions/external-pos-reset'

interface PendingItem {
  id: string
  name: string
  price: number
  categoryName: string
  /** True when the category was auto-created by the ingest because
   *  no local category shared its name. These items will need
   *  drag/drop assignment in the Phase B menu drawer. False means
   *  the ingest adopted an existing user category by name; the item
   *  already sits in the right home and only needs recipe + activate. */
  needsAssignment: boolean
}

interface ImportedItem {
  id: string
  name: string
  price: number
  active: boolean
  externalId: string
  categoryName: string
}

type TestOrderResult =
  | { error: string; orderId?: string; lineItemIds?: string[] }
  | {
      ok: true
      message: string
      orderId: string
      lineItemIds: string[]
      unitsAdded: number
      totalAmount: number
      paymentId: string | null
      tenderUsed: string | null
      paid: boolean
      environment: 'sandbox' | 'production'
    }

type DiagnosticProbe = {
  label: string
  url: string
  status: number
  elementCount: number
  firstOrderIds: string[]
  bodyPreview?: string
  contentType?: string
  errorBody?: string
}

type DiagnoseResult =
  | { error: string }
  | { ok: true; probes: DiagnosticProbe[] }

type ConfiguredState = {
  configured: true
  environment: 'sandbox' | 'production'
  merchantId: string
  hasApiToken: boolean
  lastMenuSyncAt: string | null
  lastOrdersSyncAt: string | null
  lastError: string | null
}
type UnconfiguredState = { configured: false }
type InitialState = ConfiguredState | UnconfiguredState

type SyncResult = { error: string } | { ok: true; message: string }

export default function CloverClient({
  locationId,
  locationName,
  initial,
  pendingItems,
  isDev,
  importedItems,
}: {
  locationId: string
  locationName: string
  initial: InitialState
  pendingItems: PendingItem[]
  isDev: boolean
  importedItems: ImportedItem[]
}) {
  const [mode, setMode] = useState<'view' | 'edit'>(
    initial.configured ? 'view' : 'edit',
  )

  const [saveState, saveAction, savePending] = useActionState(saveCloverConfig, null)
  const [testState, testAction, testPending] = useActionState(testCloverConnection, null)
  const [disconnectState, disconnectAction, disconnectPending] = useActionState(
    disconnectClover,
    null,
  )
  const [menuSyncState, menuSyncAction, menuSyncPending] = useActionState(
    syncExternalPosMenu,
    null,
  )
  const [ordersSyncState, ordersSyncAction, ordersSyncPending] = useActionState(
    syncExternalPosOrders,
    null,
  )
  const [resetState, resetAction, resetPending] = useActionState(
    resetExternalPosData,
    null,
  )
  const [testOrderState, testOrderAction, testOrderPending] = useActionState(
    createCloverTestOrder,
    null,
  )
  const [diagnoseState, diagnoseAction, diagnosePending] = useActionState(
    diagnoseCloverOrders,
    null,
  )

  // Flip back to view mode after a successful save.
  if (saveState && 'ok' in saveState && saveState.ok && mode === 'edit' && initial.configured) {
    queueMicrotask(() => setMode('view'))
  }

  // Effective mode for rendering. When the underlying connection
  // doesn't exist, force the form regardless of the local `mode`
  // state — otherwise a disconnect-while-in-view-mode leaves a
  // mode='view' / configured=false combination that matches neither
  // render branch and produces a blank card body.
  const effectiveMode: 'view' | 'edit' = initial.configured ? mode : 'edit'

  return (
    <div className="space-y-4">
      {effectiveMode === 'view' && initial.configured && (
        <ConfiguredSummary
          locationName={locationName}
          state={initial}
          onEdit={() => setMode('edit')}
          testAction={testAction}
          testPending={testPending}
          testState={testState}
          disconnectAction={disconnectAction}
          disconnectPending={disconnectPending}
          disconnectState={disconnectState}
          menuSyncAction={menuSyncAction}
          menuSyncPending={menuSyncPending}
          menuSyncState={menuSyncState}
          ordersSyncAction={ordersSyncAction}
          ordersSyncPending={ordersSyncPending}
          ordersSyncState={ordersSyncState}
          resetAction={resetAction}
          resetPending={resetPending}
          resetState={resetState}
          pendingItems={pendingItems}
          locationId={locationId}
        />
      )}

      {/* Dev-only test-order creator. Renders as a sibling of the
          configured summary so it always sits at the bottom of the
          card when active. Gated on isDev AND initial.configured —
          the server action re-checks both, so this is just visibility.
          Lives here (not inside ConfiguredSummary) to avoid passing
          another batch of props through the summary component. */}
      {isDev && initial.configured && effectiveMode === 'view' && (
        <TestOrderPanel
          locationId={locationId}
          importedItems={importedItems}
          action={testOrderAction}
          pending={testOrderPending}
          state={testOrderState}
          diagnoseAction={diagnoseAction}
          diagnosePending={diagnosePending}
          diagnoseState={diagnoseState}
        />
      )}

      {effectiveMode === 'edit' && (
        <ConfigForm
          locationId={locationId}
          locationName={locationName}
          initial={initial}
          action={saveAction}
          pending={savePending}
          state={saveState}
          onCancel={initial.configured ? () => setMode('view') : undefined}
        />
      )}
    </div>
  )
}

// ================================================================
// ConfiguredSummary
// ================================================================
function ConfiguredSummary({
  locationName,
  state,
  onEdit,
  testAction,
  testPending,
  testState,
  disconnectAction,
  disconnectPending,
  disconnectState,
  menuSyncAction,
  menuSyncPending,
  menuSyncState,
  ordersSyncAction,
  ordersSyncPending,
  ordersSyncState,
  resetAction,
  resetPending,
  resetState,
  pendingItems,
  locationId,
}: {
  locationName: string
  state: ConfiguredState
  onEdit: () => void
  testAction: (formData: FormData) => void
  testPending: boolean
  testState: { ok: boolean; message: string } | null
  disconnectAction: (formData: FormData) => void
  disconnectPending: boolean
  disconnectState: { error: string } | { ok: true; message: string } | null
  menuSyncAction: (formData: FormData) => void
  menuSyncPending: boolean
  menuSyncState: SyncResult | null
  ordersSyncAction: (formData: FormData) => void
  ordersSyncPending: boolean
  ordersSyncState: SyncResult | null
  resetAction: (formData: FormData) => void
  resetPending: boolean
  resetState: { error: string } | { ok: true; message: string } | null
  pendingItems: PendingItem[]
  locationId: string
}) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  return (
    <>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Cell label="Location" value={locationName} />
        <Cell
          label="Environment"
          value={state.environment === 'production' ? 'Production' : 'Sandbox'}
        />
        <Cell label="Merchant ID" value={state.merchantId || '—'} mono />
        <Cell
          label="API token"
          value={state.hasApiToken ? '•••• stored' : 'Missing'}
          subdued={!state.hasApiToken}
        />
        <Cell
          label="Last menu sync"
          value={state.lastMenuSyncAt ? new Date(state.lastMenuSyncAt).toLocaleString() : 'Never'}
          subdued={!state.lastMenuSyncAt}
        />
        <Cell
          label="Last orders sync"
          value={
            state.lastOrdersSyncAt
              ? new Date(state.lastOrdersSyncAt).toLocaleString()
              : 'Never'
          }
          subdued={!state.lastOrdersSyncAt}
        />
      </dl>

      {state.lastError && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          Last error: {state.lastError}
        </p>
      )}

      <PendingItemsPanel items={pendingItems} />

      {/* Sync actions row */}
      <div className="space-y-2">
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          Sync from Clover
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <form action={menuSyncAction}>
            <button
              type="submit"
              disabled={menuSyncPending}
              className="rounded-md bg-gray-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
            >
              {menuSyncPending ? 'Syncing menu…' : 'Sync menu now'}
            </button>
          </form>
          <form action={ordersSyncAction}>
            <button
              type="submit"
              disabled={ordersSyncPending}
              className="rounded-md bg-gray-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
            >
              {ordersSyncPending ? 'Syncing orders…' : 'Sync orders now'}
            </button>
          </form>
          <form action={testAction}>
            <input type="hidden" name="location_id" value={locationId} />
            <button
              type="submit"
              disabled={testPending}
              className="rounded-md border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors"
            >
              {testPending ? 'Testing…' : 'Test connection'}
            </button>
          </form>
        </div>
        {menuSyncState && <SyncResultRow label="Menu sync" result={menuSyncState} />}
        {ordersSyncState && <SyncResultRow label="Orders sync" result={ordersSyncState} />}
        {testState && (
          <div
            className={`rounded-md px-3 py-2 text-xs ${
              testState.ok
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                : 'bg-red-50 border border-red-200 text-red-800'
            }`}
          >
            <p className="font-semibold">
              {testState.ok ? 'Connection successful' : 'Connection failed'}
            </p>
            <p className="mt-0.5 leading-relaxed">{testState.message}</p>
          </div>
        )}
      </div>

      {/* Config actions row */}
      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Edit configuration
        </button>
        {!confirmDisconnect ? (
          <button
            type="button"
            onClick={() => setConfirmDisconnect(true)}
            className="rounded-md border border-red-200 bg-white px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 transition-colors"
          >
            Disconnect
          </button>
        ) : (
          <form action={disconnectAction} className="inline-flex items-center gap-2">
            <input type="hidden" name="location_id" value={locationId} />
            <button
              type="submit"
              disabled={disconnectPending}
              className="rounded-md border border-red-300 bg-red-50 px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 transition-colors"
            >
              {disconnectPending ? 'Disconnecting…' : 'Confirm disconnect'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDisconnect(false)}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </form>
        )}
      </div>

      {disconnectState && 'error' in disconnectState && (
        <p className="text-xs text-red-700">{disconnectState.error}</p>
      )}

      {/* Reset all imported data — destructive dev tool.
          Disconnect removes only the credentials; this also wipes
          imported categories, items, and orders so the next sync
          starts from a clean slate. Adopted user categories (the
          name-match ones) get unbound rather than deleted. */}
      <div className="mt-3 pt-3 border-t border-gray-100">
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate mb-1">
          Dev: reset Clover data
        </p>
        <p className="text-[11px] text-gray-500 leading-relaxed max-w-prose mb-2">
          Removes the Clover connection AND everything imported through it: auto-created
          categories, all Clover-tagged menu items, and all Clover-sourced orders.
          Categories the ingest adopted by name match are kept (just unbound). Useful
          before switching sandboxes or pivoting providers. Not reversible.
        </p>
        {!confirmReset ? (
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="rounded-md border border-red-200 bg-white px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 transition-colors"
          >
            Reset all Clover data…
          </button>
        ) : (
          <form action={resetAction} className="inline-flex items-center gap-2">
            <input type="hidden" name="provider" value="clover" />
            <button
              type="submit"
              disabled={resetPending}
              className="rounded-md border border-red-300 bg-red-50 px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 transition-colors"
            >
              {resetPending ? 'Resetting…' : 'Yes, wipe all Clover data'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </form>
        )}
        {resetState && (
          <div
            className={`mt-2 rounded-md px-3 py-2 text-xs ${
              'ok' in resetState
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                : 'bg-red-50 border border-red-200 text-red-800'
            }`}
          >
            <p className="font-semibold">
              {'ok' in resetState ? 'Reset complete' : 'Reset failed'}
            </p>
            <p className="mt-0.5 leading-relaxed">
              {'ok' in resetState ? resetState.message : resetState.error}
            </p>
          </div>
        )}
      </div>
    </>
  )
}

// ================================================================
// PendingItemsPanel
// ================================================================
function PendingItemsPanel({ items }: { items: PendingItem[] }) {
  const fmtMoney = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const matchedCount = items.filter((i) => !i.needsAssignment).length
  const needsAssignmentCount = items.filter((i) => i.needsAssignment).length

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50/60 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-200">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
            Pending review
          </p>
          <span
            className={`inline-flex items-center gap-1.5 text-[10px] font-bold font-mono tabular-nums px-2 py-0.5 rounded-full ${
              items.length === 0
                ? 'bg-gray-100 text-gray-600'
                : 'bg-blue-50 text-blue-700'
            }`}
          >
            {items.length}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
          Imported from Clover. Inactive until you recipe and activate them on the Menu
          page. Items whose Clover category name matched one of yours are pre-placed;
          the rest will need drag-and-drop assignment in the menu drawer.
        </p>
        {items.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 font-semibold">
              <span className="h-1 w-1 rounded-full bg-emerald-500" aria-hidden="true" />
              {matchedCount} matched
            </span>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 font-semibold">
              <span className="h-1 w-1 rounded-full bg-amber-500" aria-hidden="true" />
              {needsAssignmentCount} need assignment
            </span>
          </div>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-4 text-xs text-gray-500">
          No pending Clover items. Click <span className="font-semibold">Sync menu now</span>{' '}
          to import.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200">
          {items.map((it) => {
            const tone = it.needsAssignment
              ? { dot: 'bg-amber-500', tag: 'text-amber-700' }
              : { dot: 'bg-emerald-500', tag: 'text-emerald-700' }
            return (
              <li
                key={it.id}
                className="px-4 py-2.5 flex items-center justify-between gap-3"
              >
                <div className="min-w-0 flex items-center gap-2.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${tone.dot}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-gray-900 truncate">
                      {it.name}
                    </p>
                    <p className="mt-0.5 text-[11px] text-gray-500 truncate">
                      <span className={`font-semibold ${tone.tag}`}>
                        {it.needsAssignment ? 'Needs assignment' : 'Matched'}
                      </span>{' '}
                      · {it.categoryName}
                    </p>
                  </div>
                </div>
                <p className="text-xs font-bold font-mono tabular-nums text-gray-900 flex-shrink-0">
                  {fmtMoney(it.price)}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ================================================================
// SyncResultRow
// ================================================================
function SyncResultRow({
  label,
  result,
}: {
  label: string
  result: SyncResult
}) {
  const ok = 'ok' in result && result.ok
  return (
    <div
      className={`rounded-md px-3 py-2 text-xs ${
        ok
          ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
          : 'bg-red-50 border border-red-200 text-red-800'
      }`}
    >
      <p className="font-semibold">
        {label}: {ok ? 'OK' : 'Failed'}
      </p>
      <p className="mt-0.5 leading-relaxed">
        {ok ? result.message : (result as { error: string }).error}
      </p>
    </div>
  )
}

// ================================================================
// TestOrderPanel — dev-only Clover sandbox order creator
//
// Pick an imported Clover menu item, set quantity, click create.
// The server action POSTs to Clover's /v3/merchants/{mid}/orders +
// /line_items endpoints — no internal sale rows are written here.
// The internal sale only appears after the operator clicks
// "Sync orders now" and the existing import pipeline runs.
// ================================================================
function TestOrderPanel({
  locationId,
  importedItems,
  action,
  pending,
  state,
  diagnoseAction,
  diagnosePending,
  diagnoseState,
}: {
  locationId: string
  importedItems: ImportedItem[]
  action: (formData: FormData) => void
  pending: boolean
  state: TestOrderResult | null
  diagnoseAction: (formData: FormData) => void
  diagnosePending: boolean
  diagnoseState: DiagnoseResult | null
}) {
  const fmtMoney = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  if (importedItems.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-gray-300 bg-gray-50/40 px-4 py-3">
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          Dev: create Clover test order
        </p>
        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
          Import some Clover items first (click <span className="font-semibold">Sync menu now</span>
          {' '}above). Once items are in the menu you can use this panel to push a test order
          back into Clover for the import pipeline to pick up on the next{' '}
          <span className="font-semibold">Sync orders now</span>.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-dashed border-gray-300 bg-gray-50/40 px-4 py-3">
      <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
        Dev: create Clover test order
      </p>
      <p className="mt-1 text-[11px] text-gray-500 leading-relaxed max-w-prose">
        Creates a <span className="font-semibold">paid</span> itemized order in Clover
        Sandbox (does <span className="font-semibold">not</span> write an internal sale).
        Picks a cash tender on the merchant, closes the order with a full-amount payment,
        and returns Clover&apos;s IDs. Then click{' '}
        <span className="font-semibold">Sync orders now</span> above to import the
        completed sale through the normal pipeline — Sales / Inventory / Finance /
        Dashboard will update via the existing path.
      </p>

      <form action={action} className="mt-3 flex flex-wrap items-end gap-2">
        <input type="hidden" name="location_id" value={locationId} />

        <div className="flex flex-col gap-1 min-w-[260px] flex-1">
          <label
            htmlFor="cl-test-item"
            className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate"
          >
            Clover-imported item
          </label>
          <select
            id="cl-test-item"
            name="menu_item_id"
            required
            defaultValue={importedItems[0]?.id ?? ''}
            className="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
          >
            {importedItems.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name} · {fmtMoney(it.price)} · {it.categoryName}
                {it.active ? '' : ' · inactive'}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 w-20">
          <label
            htmlFor="cl-test-qty"
            className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate"
          >
            Quantity
          </label>
          <input
            id="cl-test-qty"
            name="quantity"
            type="number"
            min={1}
            max={50}
            defaultValue={1}
            required
            className="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-mono tabular-nums focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-gray-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
        >
          {pending ? 'Creating in Clover…' : 'Create Clover test order'}
        </button>
      </form>

      {state && (
        <div
          className={`mt-3 rounded-md px-3 py-2 text-xs ${
            'ok' in state
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}
        >
          {'ok' in state ? (
            <>
              <p className="font-semibold">Paid order created in Clover</p>
              <p className="mt-0.5 leading-relaxed">{state.message}</p>
              <dl className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 text-[10px]">
                <div>
                  <dt className="font-semibold uppercase tracking-widest text-emerald-700/80">
                    Order ID
                  </dt>
                  <dd className="font-mono text-emerald-900 truncate">{state.orderId}</dd>
                </div>
                <div>
                  <dt className="font-semibold uppercase tracking-widest text-emerald-700/80">
                    Line items
                  </dt>
                  <dd className="font-mono text-emerald-900">{state.unitsAdded}</dd>
                </div>
                <div>
                  <dt className="font-semibold uppercase tracking-widest text-emerald-700/80">
                    Total
                  </dt>
                  <dd className="font-mono text-emerald-900">{fmtMoney(state.totalAmount)}</dd>
                </div>
                <div>
                  <dt className="font-semibold uppercase tracking-widest text-emerald-700/80">
                    Tender
                  </dt>
                  <dd className="font-mono text-emerald-900 truncate">{state.tenderUsed ?? '—'}</dd>
                </div>
                <div>
                  <dt className="font-semibold uppercase tracking-widest text-emerald-700/80">
                    Payment ID
                  </dt>
                  <dd className="font-mono text-emerald-900 truncate">{state.paymentId ?? '—'}</dd>
                </div>
                <div>
                  <dt className="font-semibold uppercase tracking-widest text-emerald-700/80">
                    Environment
                  </dt>
                  <dd className="font-mono text-emerald-900">{state.environment}</dd>
                </div>
              </dl>
              {state.lineItemIds.length > 0 && (
                <p className="mt-2 text-[10px] text-emerald-700/80 break-all">
                  Line item IDs: {state.lineItemIds.join(', ')}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="font-semibold">Could not create test order</p>
              <p className="mt-0.5 leading-relaxed">{state.error}</p>
              {/* Partial-success surfacing — when the action got
                  far enough to create the order or some line items
                  before failing, show those IDs so the operator can
                  clean up or debug in Clover. */}
              {(state.orderId || (state.lineItemIds && state.lineItemIds.length > 0)) && (
                <dl className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                  {state.orderId && (
                    <div>
                      <dt className="font-semibold uppercase tracking-widest text-red-700/80">
                        Order ID (still open in Clover)
                      </dt>
                      <dd className="font-mono text-red-900 truncate">{state.orderId}</dd>
                    </div>
                  )}
                  {state.lineItemIds && state.lineItemIds.length > 0 && (
                    <div>
                      <dt className="font-semibold uppercase tracking-widest text-red-700/80">
                        Line items attached
                      </dt>
                      <dd className="font-mono text-red-900">{state.lineItemIds.length}</dd>
                    </div>
                  )}
                </dl>
              )}
            </>
          )}
        </div>
      )}

      {/* Diagnostic — only useful when the regular sync returns 0
          but you know paid orders exist in Clover. Hits the orders
          endpoint three ways and reports raw counts so we can see
          if the issue is encoding, the time window, or token scope. */}
      <div className="mt-3 pt-3 border-t border-dashed border-gray-300">
        <form action={diagnoseAction}>
          <input type="hidden" name="location_id" value={locationId} />
          <button
            type="submit"
            disabled={diagnosePending}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors"
          >
            {diagnosePending ? 'Probing Clover…' : 'Diagnose orders fetch'}
          </button>
        </form>
        {diagnoseState && 'error' in diagnoseState && (
          <p className="mt-2 text-[11px] text-red-700">{diagnoseState.error}</p>
        )}
        {diagnoseState && 'ok' in diagnoseState && (
          <div className="mt-2 space-y-2">
            {diagnoseState.probes.map((p, i) => {
              const ok = p.status >= 200 && p.status < 300
              return (
                <div
                  key={i}
                  className={`rounded-md px-3 py-2 text-[11px] ${
                    ok
                      ? p.elementCount > 0
                        ? 'bg-emerald-50 border border-emerald-200'
                        : 'bg-amber-50 border border-amber-200'
                      : 'bg-red-50 border border-red-200'
                  }`}
                >
                  <p className="font-semibold font-mono uppercase tracking-[0.14em] text-slate text-[10px]">
                    {p.label}
                  </p>
                  <p className="mt-0.5 font-mono break-all text-gray-600 text-[10px]">
                    {p.url}
                  </p>
                  <p className="mt-1 font-mono tabular-nums">
                    HTTP <span className="font-bold">{p.status}</span> · elements:{' '}
                    <span className="font-bold">{p.elementCount}</span>
                    {p.contentType && (
                      <> · <span className="font-mono text-[10px]">{p.contentType}</span></>
                    )}
                    {p.firstOrderIds.length > 0 && (
                      <> · first IDs: <span className="font-mono">{p.firstOrderIds.join(', ')}</span></>
                    )}
                  </p>
                  {p.bodyPreview && (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-[10px] font-semibold text-gray-600 hover:text-gray-900">
                        Raw response body ({p.bodyPreview.length} chars)
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap break-all bg-white/60 border border-gray-200 rounded px-2 py-1.5 font-mono text-[10px] text-gray-700 max-h-48 overflow-auto">
                        {p.bodyPreview}
                      </pre>
                    </details>
                  )}
                  {p.errorBody && !p.bodyPreview && (
                    <p className="mt-1 text-red-700 break-words text-[10px]">{p.errorBody}</p>
                  )}
                </div>
              )
            })}
            <p className="text-[10px] text-gray-500 leading-relaxed">
              <span className="font-semibold">How to read this:</span>{' '}
              Probes 1–3 hit the orders LIST endpoint with progressively
              more filtering. Probe 4 explicitly asks for paid/locked orders.
              Probe 5 swaps Bearer auth for the legacy X-Auth-Token header.
              Click <span className="font-mono">Raw response body</span> on any
              probe to see exactly what Clover returned.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ================================================================
// ConfigForm
// ================================================================
function ConfigForm({
  locationId,
  locationName,
  initial,
  action,
  pending,
  state,
  onCancel,
}: {
  locationId: string
  locationName: string
  initial: InitialState
  action: (formData: FormData) => void
  pending: boolean
  state: { error: string } | { ok: true; message: string } | null
  onCancel?: () => void
}) {
  const isEditing = initial.configured
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="location_id" value={locationId} />

      <p className="text-xs text-gray-500">
        Configuring Clover for{' '}
        <span className="font-semibold text-gray-700">{locationName}</span>.{' '}
        {isEditing && (
          <span>Leave the API token blank to keep the currently stored token.</span>
        )}
      </p>

      <Field
        label="Environment"
        htmlFor="cl-environment"
        hint="Sandbox is for development. Switch to production only after go-live."
      >
        <select
          id="cl-environment"
          name="environment"
          defaultValue={initial.configured ? initial.environment : 'sandbox'}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
        >
          <option value="sandbox">Sandbox</option>
          <option value="production">Production</option>
        </select>
      </Field>

      <Field
        label="Merchant ID"
        htmlFor="cl-merchant-id"
        hint="Not the merchant display name. It's the alphanumeric chunk in your Clover dashboard URL after /m/ — e.g., in sandbox.dev.clover.com/setupapp/m/VNE7RQ4TK9EW1/api-tokens the merchant ID is VNE7RQ4TK9EW1."
      >
        <input
          id="cl-merchant-id"
          name="merchant_id"
          type="text"
          required
          defaultValue={initial.configured ? initial.merchantId : ''}
          placeholder="VNE7RQ4TK9EW1"
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
        />
      </Field>

      <Field
        label="API token"
        htmlFor="cl-api-token"
        hint={
          isEditing
            ? 'Leave blank to keep the stored token. Enter a new value to replace it.'
            : 'Sandbox API token from the Clover Developer Dashboard. Stored server-side and never shown again.'
        }
      >
        <input
          id="cl-api-token"
          name="api_token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={isEditing ? '•••• stored' : 'Paste your API token here'}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
        />
      </Field>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
        >
          {pending ? 'Saving…' : isEditing ? 'Save changes' : 'Connect Clover'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>

      {state && 'error' in state && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {state.error}
        </p>
      )}
      {state && 'ok' in state && state.ok && (
        <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
          {state.message}
        </p>
      )}
    </form>
  )
}

// ================================================================
// Small primitives
// ================================================================
function Cell({
  label,
  value,
  subdued,
  mono,
}: {
  label: string
  value: string
  subdued?: boolean
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
        {label}
      </dt>
      <dd
        className={`mt-1 text-sm truncate ${subdued ? 'text-gray-400' : 'text-gray-900'} ${
          mono ? 'font-mono' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-gray-700"
      >
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-[10.5px] text-gray-500 leading-relaxed">{hint}</p>
      )}
    </div>
  )
}
