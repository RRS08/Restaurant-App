'use client'

// ----------------------------------------------------------------
// GoDaddyOnlinePaymentsCard — separate authorization surface for
// Poynt Collect (web CNP card charging).
//
// Distinct from the POS-focused GoDaddyConnectCard even though they
// share the same OAuth flow and end up updating the same token row.
// The reason for the split: a merchant who OAuth'd the app BEFORE
// Poynt Collect was added to the app's scope list has a token that
// carries only the older scopes — POS ingest keeps working but web
// checkout hits 500 INTERNAL_ERROR at the /cards/tokenize/charge
// step because the token lacks Poynt Collect W.
//
// Re-authorizing here re-runs the install flow with prompt=consent
// so Poynt shows the consent screen even for repeat merchants (its
// default behavior silently re-issues the old scope set otherwise).
// On success Poynt issues a fresh token with every scope currently
// enabled on the app. On failure the existing token is preserved
// (the callback only upserts on a successful token exchange).
//
// The card shows the raw scope string Poynt returned so the merchant
// can confirm the re-auth actually landed with the expected scopes,
// plus a "connected at" timestamp that updates on every successful
// re-auth as extra evidence the token row was written.
//
// Owner-only. Hidden until GoDaddyConnectCard shows connected — a
// merchant with no initial connection should install via the POS
// card first, then re-authorize here if online checkout errors out.
// ----------------------------------------------------------------

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

interface Props {
  connected: null | {
    businessId: string
    scope: string | null
    connectedAt: string
  }
}

export default function GoDaddyOnlinePaymentsCard({ connected }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const flag = searchParams.get('godaddy-online')
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [showScope, setShowScope] = useState(false)

  useEffect(() => {
    if (!flag) return
    if (flag === 'ok') setBanner({ tone: 'ok', text: 'Poynt sent back a fresh token. Check the Granted scopes below — the checkout can charge cards when Poynt Collect appears there.' })
    else if (flag === 'declined') setBanner({ tone: 'err', text: 'You declined the authorization — try again to enable web card payments.' })
    else setBanner({ tone: 'err', text: 'Authorization did not complete. Try again in a moment.' })
    const url = new URL(window.location.href)
    url.searchParams.delete('godaddy-online')
    router.replace(url.pathname + (url.search || ''), { scroll: false })
  }, [flag, router])

  if (!connected) return null

  const scopeTokens = (connected.scope ?? '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean)

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-mono uppercase tracking-[0.14em] text-gray-500">
            External · Online payments
          </h3>
          <p className="mt-2 text-lg font-semibold tracking-tight text-gray-900">
            Poynt Collect · web checkout
          </p>
          <p className="mt-1 text-sm text-gray-500 max-w-xl">
            Authorizes the online storefront checkout to charge cards through your GoDaddy Poynt
            merchant account. Separate from POS sync above — this covers the web checkout only.
          </p>
        </div>
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

      <div className="mt-5 space-y-4">
        <div className="rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2.5">
          <p className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-gray-400">
            Token last refreshed
          </p>
          <p className="mt-1 text-sm font-mono tabular-nums text-gray-900">
            {formatWhen(connected.connectedAt)}
          </p>
          <p className="mt-1 text-[11px] text-gray-500">
            Updates on every successful re-authorization.
          </p>
        </div>

        <div className="rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-gray-400">
                Granted scopes
              </p>
              <p className="mt-1 text-[11px] text-gray-500">
                What Poynt returned on the last authorization. For online checkout to charge
                cards this should include a Collect-related scope.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowScope(v => !v)}
              className="flex-shrink-0 text-xs text-gray-600 hover:text-gray-900 underline"
            >
              {showScope ? 'Hide' : 'Show'}
            </button>
          </div>
          {showScope && (
            <div className="mt-2">
              {scopeTokens.length === 0 ? (
                <p className="text-xs italic text-gray-500">
                  Poynt did not return a scope string with this token.
                </p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {scopeTokens.map((s, i) => (
                    <li
                      key={i}
                      className="inline-flex items-center rounded-md border border-gray-200 bg-white px-2 py-0.5 font-mono text-[11px] text-gray-800"
                    >
                      {s}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div>
          <a
            href="/api/godaddy/oauth/install?purpose=online"
            className="inline-flex items-center gap-2 rounded-lg bg-[#18181B] px-4 py-2.5 text-sm font-semibold text-[#FAF9F6] hover:bg-black transition-colors"
          >
            Re-authorize online payments
            <span aria-hidden="true">→</span>
          </a>
          <p className="mt-2 text-xs text-gray-500 max-w-xl">
            Opens Poynt&apos;s consent screen (we ask Poynt to always show it, even for repeat
            authorizations — otherwise Poynt silently re-issues the old scope set). Approve to
            get a fresh token with every scope your app currently has enabled. POS sync above
            keeps working through the refresh.
          </p>
        </div>
      </div>
    </section>
  )
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch {
    return iso
  }
}
