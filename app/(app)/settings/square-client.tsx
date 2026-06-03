'use client'

// ----------------------------------------------------------------
// SquareClient — interactive surface for the Square Settings card.
//
// Three modes, switched by component state:
//
//   • configured       → read-only summary + actions (Test / Edit /
//                         Disconnect)
//   • editing/connect  → the credentials form, with the access-token
//                         input never pre-filled (the parent Server
//                         Component refuses to forward the token to
//                         the client)
//   • test-result      → shown inline as a status row beneath the
//                         summary or form, NEVER as a modal
//
// All three server actions are owner-only; this component only
// dispatches them — it doesn't re-check ownership client-side.
// ----------------------------------------------------------------

import { useActionState, useState } from 'react'
import {
  saveSquareConfig,
  testSquareConnection,
  disconnectSquare,
} from '@/app/actions/square'
import {
  syncExternalPosMenu,
  syncExternalPosOrders,
} from '@/app/actions/pos-import'

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

type ConfiguredState = {
  configured: true
  environment: 'sandbox' | 'production'
  applicationId: string
  squareLocationId: string
  hasAccessToken: boolean
  lastMenuSyncAt: string | null
  lastOrdersSyncAt: string | null
  lastError: string | null
}
type UnconfiguredState = { configured: false }
type InitialState = ConfiguredState | UnconfiguredState

export default function SquareClient({
  locationId,
  locationName,
  initial,
  pendingItems,
}: {
  locationId: string
  locationName: string
  initial: InitialState
  pendingItems: PendingItem[]
}) {
  const [mode, setMode] = useState<'view' | 'edit'>(
    initial.configured ? 'view' : 'edit',
  )

  // Edit form action
  const [saveState, saveAction, savePending] = useActionState(saveSquareConfig, null)

  // Test connection action
  const [testState, testAction, testPending] = useActionState(testSquareConnection, null)

  // Disconnect action
  const [disconnectState, disconnectAction, disconnectPending] = useActionState(
    disconnectSquare,
    null,
  )

  // Sync actions — pull Square catalog / completed orders through
  // the existing ingest pipeline. Both share the
  // useActionState((prev, formData) => Result) signature.
  const [menuSyncState, menuSyncAction, menuSyncPending] = useActionState(
    syncExternalPosMenu,
    null,
  )
  const [ordersSyncState, ordersSyncAction, ordersSyncPending] = useActionState(
    syncExternalPosOrders,
    null,
  )

  // Flip back to view mode after a successful save.
  if (saveState && 'ok' in saveState && saveState.ok && mode === 'edit' && initial.configured) {
    // The page revalidates, but state-level snap-back keeps the
    // form from sitting open if the user already saved.
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
          pendingItems={pendingItems}
          locationId={locationId}
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
          onCancel={
            initial.configured ? () => setMode('view') : undefined
          }
        />
      )}
    </div>
  )
}

// ================================================================
// ConfiguredSummary — read-only fact rows + Test / Edit / Disconnect
// ================================================================
type SyncResult = { error: string } | { ok: true; message: string }

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
  pendingItems: PendingItem[]
  locationId: string
}) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  return (
    <>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Cell label="Location" value={locationName} />
        <Cell
          label="Environment"
          value={state.environment === 'production' ? 'Production' : 'Sandbox'}
        />
        <Cell label="Square location" value={state.squareLocationId || '—'} mono />
        <Cell
          label="Access token"
          value={state.hasAccessToken ? '•••• stored' : 'Missing'}
          subdued={!state.hasAccessToken}
        />
        {state.applicationId && (
          <Cell label="Application ID" value={state.applicationId} mono />
        )}
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

      {/* Pending review items — Phase A read-only view. The full
          drag-and-drop categorization + recipe + activate UX lands
          in Phase B on the Menu page. Shown here so the import
          pipeline can be verified end-to-end before that work. */}
      <PendingItemsPanel items={pendingItems} />

      {/* Sync actions row — operational. */}
      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
          Sync from Square
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
        {/* Test result */}
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

      {/* Configuration actions row — meta. */}
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

      {/* Disconnect result (success message; error surfaces in red row) */}
      {disconnectState && 'error' in disconnectState && (
        <p className="text-xs text-red-700">{disconnectState.error}</p>
      )}
    </>
  )
}

// ================================================================
// PendingItemsPanel — Phase A read-only list of imported Square
// items that haven't been categorized + recipe-mapped + activated
// yet. Shows name, current category (will usually be the Square
// auto-created one), and current price. The "Activate" / drag-and-
// drop UX lands in Phase B on the Menu page.
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
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            Pending review
          </p>
          <span
            className={`inline-flex items-center gap-1.5 text-[10px] font-bold tabular-nums px-2 py-0.5 rounded-full ${
              items.length === 0
                ? 'bg-gray-100 text-gray-600'
                : 'bg-blue-50 text-blue-700'
            }`}
          >
            {items.length}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
          Imported from Square. Inactive until you recipe and activate them on the Menu
          page. Items whose Square category name matched one of yours are pre-placed;
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
          No pending Square items. Click <span className="font-semibold">Sync menu now</span>{' '}
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
                <p className="text-xs font-bold tabular-nums text-gray-900 flex-shrink-0">
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
// SyncResultRow — emerald success / red error row used by both
// menu and orders sync actions. Same chrome as the connection-test
// result so the action surfaces feel like one family.
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
// ConfigForm — credentials editor. The access-token input never has
// a default value. On update, leaving it blank preserves the
// previously stored token (server enforces this).
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
        Configuring Square for{' '}
        <span className="font-semibold text-gray-700">{locationName}</span>.{' '}
        {isEditing && (
          <span>
            Leave the access token blank to keep the currently stored token.
          </span>
        )}
      </p>

      <Field
        label="Environment"
        htmlFor="sq-environment"
        hint="Sandbox is for development. Switch to production only after go-live."
      >
        <select
          id="sq-environment"
          name="environment"
          defaultValue={initial.configured ? initial.environment : 'sandbox'}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
        >
          <option value="sandbox">Sandbox</option>
          <option value="production">Production</option>
        </select>
      </Field>

      <Field
        label="Application ID"
        htmlFor="sq-app-id"
        optional
        hint="From the Square Developer Dashboard. Stored for reference; not used by the import flow."
      >
        <input
          id="sq-app-id"
          name="application_id"
          type="text"
          defaultValue={initial.configured ? initial.applicationId : ''}
          placeholder="sandbox-sq0idp-…"
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
        />
      </Field>

      <Field
        label="Access token"
        htmlFor="sq-access-token"
        hint={
          isEditing
            ? 'Leave blank to keep the stored token. Enter a new value to replace it.'
            : 'Sandbox access token from the Square Developer Dashboard. Stored server-side and never shown again.'
        }
      >
        <input
          id="sq-access-token"
          name="access_token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={isEditing ? '•••• stored' : 'EAAA…'}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
        />
      </Field>

      <Field
        label="Square location ID"
        htmlFor="sq-location-id"
        hint="The Square location id ('L…'). The catalog and orders endpoints both anchor on this."
      >
        <input
          id="sq-location-id"
          name="square_location_id"
          type="text"
          required
          defaultValue={initial.configured ? initial.squareLocationId : ''}
          placeholder="L…"
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400"
        />
      </Field>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
        >
          {pending ? 'Saving…' : isEditing ? 'Save changes' : 'Connect Square'}
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
      <dt className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
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
  optional,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  optional?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-gray-700"
      >
        {label}
        {optional && <span className="text-gray-400 font-normal">· optional</span>}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-[10.5px] text-gray-500 leading-relaxed">{hint}</p>
      )}
    </div>
  )
}
