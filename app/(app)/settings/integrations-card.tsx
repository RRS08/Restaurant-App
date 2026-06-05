// ----------------------------------------------------------------
// IntegrationsCard — single compact card combining Bank Sync +
// External POS status. Replaces the prior pair of summary cards.
//
// One Manage in Dev Toolbox → link in the card header (dev-only),
// not duplicated on every integration row. Two short rows below:
//
//   Bank Sync          [● status]
//   Plaid · 4 connections · Last synced 12:44 PM
//
//   External POS       [● status]
//   Clover · Sandbox · Last orders sync Jun 3
//   2 items need assignment              (only when count > 0)
//
// No standalone Provider / Environment / Last menu sync rows — all
// inline metadata. The detailed panels live in /dev-tools.
// ----------------------------------------------------------------

import Link from 'next/link'
import { StatusPill, type StatusTone } from './ui'

export default function IntegrationsCard({
  bankConfigured,
  bankConnected,
  bankConnectionCount,
  bankLatestSyncAt,

  showExternalPos,
  posConnected,
  posProvider,
  posEnvironment,
  posLastMenuSyncAt,
  posLastOrdersSyncAt,
  posPendingReviewCount,

  isDev,
}: {
  bankConfigured: boolean
  bankConnected: boolean
  bankConnectionCount: number
  bankLatestSyncAt: string | null

  /** Mode-gated visibility. Native-POS restaurants don't show the
   *  External POS row (unless dev override). */
  showExternalPos: boolean
  posConnected: boolean
  posProvider: string
  posEnvironment: 'sandbox' | 'production' | null
  posLastMenuSyncAt: string | null
  posLastOrdersSyncAt: string | null
  posPendingReviewCount: number

  isDev: boolean
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="px-5 py-3 flex items-center justify-between border-b border-gray-100">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
          Integrations
        </p>
        {isDev && (
          <Link
            href="/dev-tools"
            className="text-[11px] font-medium text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline transition-colors"
          >
            Manage in Dev Toolbox →
          </Link>
        )}
      </div>

      <div className="divide-y divide-gray-50">
        <BankSyncRow
          configured={bankConfigured}
          connected={bankConnected}
          connectionCount={bankConnectionCount}
          latestSyncAt={bankLatestSyncAt}
        />
        {showExternalPos && (
          <ExternalPosRow
            connected={posConnected}
            provider={posProvider}
            environment={posEnvironment}
            lastMenuSyncAt={posLastMenuSyncAt}
            lastOrdersSyncAt={posLastOrdersSyncAt}
            pendingReviewCount={posPendingReviewCount}
          />
        )}
      </div>
    </section>
  )
}

function BankSyncRow({
  configured,
  connected,
  connectionCount,
  latestSyncAt,
}: {
  configured: boolean
  connected: boolean
  connectionCount: number
  latestSyncAt: string | null
}) {
  const status: { label: string; tone: StatusTone } = connected
    ? { label: 'Connected', tone: 'active' }
    : configured
      ? { label: 'Not connected', tone: 'setup' }
      : { label: 'Not configured', tone: 'idle' }

  // Compact metadata line. Skip "0 connections" when not connected;
  // the status pill already conveys the absence.
  const parts: string[] = []
  parts.push('Plaid')
  if (connected) {
    parts.push(`${connectionCount} ${connectionCount === 1 ? 'connection' : 'connections'}`)
    if (latestSyncAt) {
      parts.push(`Last synced ${formatShortStamp(latestSyncAt)}`)
    }
  }

  return (
    <div className="px-5 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900">Bank Sync</p>
        <StatusPill label={status.label} tone={status.tone} />
      </div>
      <p className="mt-0.5 text-[11px] text-gray-500 truncate">{parts.join(' · ')}</p>
    </div>
  )
}

function ExternalPosRow({
  connected,
  provider,
  environment,
  lastMenuSyncAt,
  lastOrdersSyncAt,
  pendingReviewCount,
}: {
  connected: boolean
  provider: string
  environment: 'sandbox' | 'production' | null
  lastMenuSyncAt: string | null
  lastOrdersSyncAt: string | null
  pendingReviewCount: number
}) {
  const status: { label: string; tone: StatusTone } = connected
    ? { label: 'Configured', tone: 'active' }
    : { label: 'Not connected', tone: 'idle' }

  const parts: string[] = [provider]
  if (connected) {
    if (environment === 'production') parts.push('Production')
    else if (environment === 'sandbox') parts.push('Sandbox')
    if (lastOrdersSyncAt) {
      parts.push(`Last orders sync ${formatShortStamp(lastOrdersSyncAt)}`)
    } else if (lastMenuSyncAt) {
      parts.push(`Last menu sync ${formatShortStamp(lastMenuSyncAt)}`)
    }
  }

  return (
    <div className="px-5 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900">External POS</p>
        <StatusPill label={status.label} tone={status.tone} />
      </div>
      <p className="mt-0.5 text-[11px] text-gray-500 truncate">{parts.join(' · ')}</p>
      {connected && pendingReviewCount > 0 && (
        <p className="mt-0.5 text-[10.5px] text-amber-700">
          {pendingReviewCount} {pendingReviewCount === 1 ? 'item needs' : 'items need'} assignment
        </p>
      )}
    </div>
  )
}

// Today/yesterday → time only; older → "Jun 3" without year. Keeps
// the metadata line short.
function formatShortStamp(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
