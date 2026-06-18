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
import { makeT, type Lang } from '@/lib/i18n'

type T = (en: string, es?: string) => string

export default function IntegrationsCard({
  lang,
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
  lang: Lang
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
  const t = makeT(lang)
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="px-5 py-3 flex items-center justify-between border-b border-gray-100">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
          {t('Integrations', 'Integraciones')}
        </p>
        {isDev && (
          <Link
            href="/dev-tools"
            className="text-[11px] font-medium text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline transition-colors"
          >
            {t('Manage in Dev Toolbox →', 'Administrar en Dev Toolbox →')}
          </Link>
        )}
      </div>

      <div className="divide-y divide-gray-50">
        <BankSyncRow
          t={t}
          lang={lang}
          configured={bankConfigured}
          connected={bankConnected}
          connectionCount={bankConnectionCount}
          latestSyncAt={bankLatestSyncAt}
        />
        {showExternalPos && (
          <ExternalPosRow
            t={t}
            lang={lang}
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
  t,
  lang,
  configured,
  connected,
  connectionCount,
  latestSyncAt,
}: {
  t: T
  lang: Lang
  configured: boolean
  connected: boolean
  connectionCount: number
  latestSyncAt: string | null
}) {
  const status: { label: string; tone: StatusTone } = connected
    ? { label: t('Connected', 'Conectado'), tone: 'active' }
    : configured
      ? { label: t('Not connected', 'No conectado'), tone: 'setup' }
      : { label: t('Not configured', 'No configurado'), tone: 'idle' }

  // Compact metadata line. Skip "0 connections" when not connected;
  // the status pill already conveys the absence.
  const parts: string[] = []
  parts.push('Plaid')
  if (connected) {
    parts.push(
      connectionCount === 1
        ? `${connectionCount} ${t('connection', 'conexión')}`
        : `${connectionCount} ${t('connections', 'conexiones')}`
    )
    if (latestSyncAt) {
      parts.push(`${t('Last synced', 'Última sincronización')} ${formatShortStamp(latestSyncAt, lang)}`)
    }
  }

  return (
    <div className="px-5 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900">{t('Bank Sync', 'Sincronización bancaria')}</p>
        <StatusPill label={status.label} tone={status.tone} />
      </div>
      <p className="mt-0.5 text-[11px] text-gray-500 truncate">{parts.join(' · ')}</p>
    </div>
  )
}

function ExternalPosRow({
  t,
  lang,
  connected,
  provider,
  environment,
  lastMenuSyncAt,
  lastOrdersSyncAt,
  pendingReviewCount,
}: {
  t: T
  lang: Lang
  connected: boolean
  provider: string
  environment: 'sandbox' | 'production' | null
  lastMenuSyncAt: string | null
  lastOrdersSyncAt: string | null
  pendingReviewCount: number
}) {
  const status: { label: string; tone: StatusTone } = connected
    ? { label: t('Configured', 'Configurado'), tone: 'active' }
    : { label: t('Not connected', 'No conectado'), tone: 'idle' }

  const parts: string[] = [provider]
  if (connected) {
    if (environment === 'production') parts.push(t('Production', 'Producción'))
    else if (environment === 'sandbox') parts.push(t('Sandbox', 'Pruebas'))
    if (lastOrdersSyncAt) {
      parts.push(`${t('Last orders sync', 'Última sinc. de pedidos')} ${formatShortStamp(lastOrdersSyncAt, lang)}`)
    } else if (lastMenuSyncAt) {
      parts.push(`${t('Last menu sync', 'Última sinc. de menú')} ${formatShortStamp(lastMenuSyncAt, lang)}`)
    }
  }

  return (
    <div className="px-5 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900">{t('External POS', 'POS externo')}</p>
        <StatusPill label={status.label} tone={status.tone} />
      </div>
      <p className="mt-0.5 text-[11px] text-gray-500 truncate">{parts.join(' · ')}</p>
      {connected && pendingReviewCount > 0 && (
        <p className="mt-0.5 text-[10.5px] text-amber-700">
          {pendingReviewCount}{' '}
          {pendingReviewCount === 1
            ? t('item needs assignment', 'artículo necesita asignación')
            : t('items need assignment', 'artículos necesitan asignación')}
        </p>
      )}
    </div>
  )
}

// Today/yesterday → time only; older → "Jun 3" without year. Keeps
// the metadata line short.
function formatShortStamp(iso: string, lang: Lang): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const locale = lang === 'es' ? 'es-ES' : 'en-US'
  if (sameDay) {
    return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}
