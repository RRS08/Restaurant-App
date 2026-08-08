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
// Re-authorizing here re-runs the same install flow. On success
// Poynt issues a fresh token with every scope currently enabled on
// the app; existing POS sync continues (same token, just refreshed).
// On failure the existing token is preserved (the callback only
// upserts on a successful token exchange).
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
  }
}

/** Scope tokens Poynt uses for the Collect (web CNP charge) grant.
 *  Names vary slightly by SDK version — accept any of them as
 *  evidence the token can charge via /cards/tokenize/charge. */
const COLLECT_SCOPE_HINTS = ['poynt.collect', 'collect', 'poynt.cards.charge', 'poynt.cards.tokenize.charge']

function scopeHasCollect(scope: string | null): boolean {
  if (!scope) return false
  const s = scope.toLowerCase()
  return COLLECT_SCOPE_HINTS.some(hint => s.includes(hint))
}

export default function GoDaddyOnlinePaymentsCard({ connected }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const flag = searchParams.get('godaddy-online')
  const [banner, setBanner] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    if (!flag) return
    if (flag === 'ok') setBanner({ tone: 'ok', text: 'Online payments authorized. The web checkout can now charge cards.' })
    else if (flag === 'declined') setBanner({ tone: 'err', text: 'You declined the authorization — try again to enable web card payments.' })
    else setBanner({ tone: 'err', text: 'Authorization did not complete. Try again in a moment.' })
    const url = new URL(window.location.href)
    url.searchParams.delete('godaddy-online')
    router.replace(url.pathname + (url.search || ''), { scroll: false })
  }, [flag, router])

  // Card only renders when the merchant has ALREADY connected via
  // the POS card — this is a re-auth surface, not a first-time
  // install surface.
  if (!connected) return null

  const hasCollect = scopeHasCollect(connected.scope)

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
        {hasCollect ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-[11px] font-medium text-green-700">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            Ready
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            Needs authorization
          </span>
        )}
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

      <div className="mt-5">
        <a
          href="/api/godaddy/oauth/install?purpose=online"
          className="inline-flex items-center gap-2 rounded-lg bg-[#18181B] px-4 py-2.5 text-sm font-semibold text-[#FAF9F6] hover:bg-black transition-colors"
        >
          {hasCollect ? 'Re-authorize online payments' : 'Authorize online payments'}
          <span aria-hidden="true">→</span>
        </a>
        <p className="mt-2 text-xs text-gray-500 max-w-xl">
          Opens Poynt&apos;s consent page. On success your merchant token is refreshed with the
          latest permissions — POS sync above keeps working uninterrupted. If online checkout
          orders have been failing with a &ldquo;system error&rdquo; at the payment step, this
          usually fixes it.
        </p>
      </div>
    </section>
  )
}
