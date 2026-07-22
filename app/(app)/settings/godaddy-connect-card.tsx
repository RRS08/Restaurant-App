'use client'

// ----------------------------------------------------------------
// GoDaddyConnectCard — live GoDaddy Poynt connection surface.
//
// Two states:
//
//   • Not connected → renders the "Connect GoDaddy Commerce" CTA.
//     Clicking it hits /api/godaddy/oauth/install, which redirects
//     the browser to Poynt's authorize URL. When the merchant
//     approves and Poynt sends them back to our /callback route,
//     the tokens land in godaddy_poynt_tokens and Settings
//     re-renders in "connected" state.
//
//   • Connected → renders a short summary (business id, connected
//     time, next-refresh estimate) and a "Sync now" button that
//     invokes the syncGodaddyOrders server action. The action's
//     result (counts + notes) renders inline so the manager can
//     verify what actually happened.
//
// A tiny banner surfaces the `?godaddy=<flag>` query params the
// callback route redirects with (connected / declined / stale-
// state / bad-code / exchange-failed). The banner clears itself
// out of the URL after showing once, so a reload doesn't repeat
// the message.
// ----------------------------------------------------------------

import { useEffect, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { syncGodaddyOrders, type SyncResult } from '@/app/actions/godaddy-sync'
import { reregisterGodaddyWebhook } from '@/app/actions/godaddy-webhook'

interface Props {
  connected: null | {
    businessId: string
    connectedAt: string
    expiresAt: string
    /** True when webhook_secret exists on the token row — proves
     *  registration with Poynt succeeded at some point. False
     *  when registration silently failed at install time; owner
     *  can retry via the button. */
    webhookRegistered: boolean
  }
}

const FLAG_COPY: Record<string, { tone: 'ok' | 'err'; en: string }> = {
  connected:        { tone: 'ok',  en: 'Connected. Poynt is now sending sales into Checked.' },
  declined:         { tone: 'err', en: 'The merchant declined the authorization.' },
  'stale-state':    { tone: 'err', en: 'That authorization link expired. Please try connecting again.' },
  'bad-code':       { tone: 'err', en: 'Poynt returned an unexpected code — try again.' },
  'exchange-failed':{ tone: 'err', en: 'We got the code but the token exchange failed. Try again.' },
  'missing-params': { tone: 'err', en: 'Poynt redirected back without the expected parameters.' },
  'no-restaurant':  { tone: 'err', en: 'No restaurant is linked to your account yet.' },
  'owner-only':     { tone: 'err', en: 'Only the owner can connect an external provider.' },
}

export default function GoDaddyConnectCard({ connected }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const flag = searchParams.get('godaddy')
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  // On mount, if the URL carries a ?godaddy=<flag>, show the
  // matching banner and then strip the query so a page reload
  // doesn't replay the same message.
  useEffect(() => {
    if (!flag) return
    const meta = FLAG_COPY[flag]
    if (meta) setBanner({ tone: meta.tone, text: meta.en })
    const url = new URL(window.location.href)
    url.searchParams.delete('godaddy')
    router.replace(url.pathname + (url.search || ''), { scroll: false })
    // The router.replace intentionally doesn't cause a data refetch —
    // the `connected` prop is stable for this render pass; the parent
    // fetches it server-side on the next navigation.
  }, [flag, router])

  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<SyncResult | null>(null)

  // Independent transition + result state for the webhook
  // re-registration action so hitting one button doesn't spin
  // the other or clobber its message.
  const [hookPending, startHookTransition] = useTransition()
  const [hookResult, setHookResult] = useState<
    | { ok: true }
    | { error: string }
    | null
  >(null)

  const onSync = () => {
    setResult(null)
    startTransition(async () => {
      const r = await syncGodaddyOrders()
      setResult(r)
      // A successful sync produces new rows the rest of Settings
      // doesn't care about, but re-fetching the connection state
      // is cheap and keeps expiresAt fresh if a refresh happened.
      router.refresh()
    })
  }

  const onRetryHook = () => {
    setHookResult(null)
    startHookTransition(async () => {
      const r = await reregisterGodaddyWebhook()
      setHookResult(r)
      router.refresh()
    })
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-mono uppercase tracking-[0.14em] text-gray-500">
            External · GoDaddy Commerce
          </h3>
          <p className="mt-2 text-lg font-semibold tracking-tight text-gray-900">
            Live Poynt sales sync
          </p>
          <p className="mt-1 text-sm text-gray-500 max-w-xl">
            Connect the Checked app to your GoDaddy Poynt account. Sales from your terminal and
            your online storefront flow into Checked automatically — no CSV exports.
          </p>
        </div>
        <StatusChip connected={!!connected} />
      </div>

      {banner && (
        <div
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            banner.tone === 'ok'
              ? 'bg-green-50 border border-green-200 text-green-800'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}
        >
          {banner.text}
        </div>
      )}

      {!connected ? (
        <div className="mt-5">
          <a
            href="/api/godaddy/oauth/install"
            className="inline-flex items-center gap-2 rounded-lg bg-[#18181B] px-4 py-2.5 text-sm font-semibold text-[#FAF9F6] hover:bg-black transition-colors"
          >
            Connect GoDaddy Commerce
            <span aria-hidden="true">→</span>
          </a>
          <p className="mt-2 text-xs text-gray-500">
            Opens Poynt&apos;s sign-in page. You approve access, and we&apos;re done — nothing
            else to configure on your side.
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <Field label="Business ID" value={truncate(connected.businessId, 22)} />
            <Field label="Connected" value={formatWhen(connected.connectedAt)} />
            <Field label="Token refreshes" value={formatUntil(connected.expiresAt)} />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSync}
              disabled={pending}
              className="inline-flex items-center gap-2 rounded-lg bg-[#18181B] px-4 py-2 text-sm font-semibold text-[#FAF9F6] hover:bg-black disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {pending ? 'Syncing…' : 'Sync now'}
            </button>
            <span className="text-xs text-gray-500">
              Pulls online + terminal sales from the last 30 days in one click.
            </span>
          </div>

          {result && <SyncResultPanel result={result} />}

          {/* Real-time push status. When the webhook registered at
              install time, Poynt POSTs to our /api/godaddy/webhooks
              route as sales close on the terminal / storefront —
              orders appear in Checked within seconds. If registration
              failed silently (endpoint shape mismatch, permission
              gap), the manager can retry it here without a full
              re-connect. GitHub Actions cron backstops either way. */}
          <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-gray-900">Real-time push</p>
                  {connected.webhookRegistered ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[10px] font-medium text-green-700">
                      <span className="w-1 h-1 rounded-full bg-green-500" /> Active
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                      <span className="w-1 h-1 rounded-full bg-amber-500" /> Not registered
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500 max-w-xl">
                  {connected.webhookRegistered
                    ? 'Poynt is set up to push each sale to Checked as it closes. New orders appear within seconds. Automatic 15-min sync also runs as a safety net.'
                    : 'The install-time webhook registration didn\'t take. Sales still flow through the automatic 15-min sync, but not in real time. Retry to enable real-time.'}
                </p>
              </div>
              <button
                type="button"
                onClick={onRetryHook}
                disabled={hookPending}
                className="flex-shrink-0 inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {hookPending ? 'Retrying…' : connected.webhookRegistered ? 'Re-register' : 'Try to register'}
              </button>
            </div>
            {hookResult && (
              <div
                className={`mt-2.5 rounded-md px-2.5 py-1.5 text-xs ${
                  'ok' in hookResult
                    ? 'bg-green-50 border border-green-200 text-green-800'
                    : 'bg-red-50 border border-red-200 text-red-700'
                }`}
              >
                {'ok' in hookResult
                  ? 'Webhook registered. Real-time push is live.'
                  : hookResult.error}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function StatusChip({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-[11px] font-medium text-green-700">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
      Connected
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-[11px] font-medium text-gray-500">
      <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
      Not connected
    </span>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2.5">
      <p className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-gray-400">{label}</p>
      <p className="mt-1 text-sm font-mono tabular-nums text-gray-900 truncate">{value}</p>
    </div>
  )
}

function SyncResultPanel({ result }: { result: SyncResult }) {
  if (result.error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
        <p className="font-medium">Sync failed.</p>
        <p className="mt-1">{result.error}</p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2.5">
      <p className="text-sm font-medium text-gray-900">
        {result.ordersInserted} order{result.ordersInserted === 1 ? '' : 's'} imported
        {' '}<span className="text-gray-500">·</span>{' '}
        {result.channelBreakdown.pos} POS
        {' '}<span className="text-gray-500">·</span>{' '}
        {result.channelBreakdown.online} online
      </p>
      <p className="mt-1 text-xs text-gray-500">
        Skipped {result.ordersSkipped} (dedupe) · Failed {result.ordersFailed} · Placeholders created {result.placeholdersCreated} · Inventory rows written {result.inventoryDepletionsWritten}
      </p>
      {result.notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-gray-500">
          {result.notes.slice(0, 5).map((n, i) => (
            <li key={i}>• {n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch {
    return iso
  }
}

function formatUntil(iso: string): string {
  try {
    const d = new Date(iso)
    const mins = Math.max(0, Math.floor((d.getTime() - Date.now()) / 60000))
    if (mins < 60) return `in ${mins} min`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `in ${hrs} hr`
    return `in ${Math.floor(hrs / 24)} d`
  } catch {
    return iso
  }
}
