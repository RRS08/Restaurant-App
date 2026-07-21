// ----------------------------------------------------------------
// GET /api/godaddy/oauth/callback
//
// Poynt sends the merchant back here after they approve our app.
// Query params (per Poynt spec §2b):
//   • code    — a JWT signed by poynt.net, contains poynt.biz
//   • status  — the merchant's response ("Authorized" / other)
//   • context — echoed back; must match a state we issued
//   • businessId — deprecated by Poynt; we read poynt.biz from
//                  the decoded code instead
//
// Flow:
//   1. Verify the returned `context` against
//      godaddy_poynt_oauth_states (single-use, 15-min lifetime).
//   2. Decode the code to pull the merchant business_id
//      (poynt.biz claim).
//   3. Exchange the code for {access_token, refresh_token} via
//      POST /token (spec §3).
//   4. Persist the token row keyed by (restaurant, business).
//   5. Redirect the owner back to Settings with a success flag
//      the UI can render.
//
// Every failure lane redirects to Settings with a specific query
// flag so the UI can surface the right message. We never leak
// the failure details in the URL — only a short slug.
// ----------------------------------------------------------------

import { NextResponse, type NextRequest } from 'next/server'
import { exchangeAuthorizationCode, decodeBusinessId } from '@/lib/godaddy/oauth'
import { consumeOAuthState, upsertMerchantToken } from '@/lib/godaddy/tokens'

function redirectToSettings(req: NextRequest, flag: string): NextResponse {
  return NextResponse.redirect(new URL(`/settings?godaddy=${flag}`, req.url))
}

// Explicit rejection markers Poynt might send. The docs describe
// `status` as "whether the merchant authorized" without pinning
// the exact string values. To avoid mistaking a successful
// authorization for a decline (my first pass matched "authorized"
// case-insensitively, which rejected any other success wording),
// we now only bail when the status is one of these explicit
// rejection words. Anything else — including empty / missing —
// falls through to the code exchange, which is the real proof of
// authorization anyway.
const DECLINE_STATUSES = new Set(['declined', 'denied', 'rejected', 'canceled', 'cancelled', 'error', 'failed'])

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')?.trim() ?? ''
  const status = url.searchParams.get('status')?.trim() ?? ''
  const context = url.searchParams.get('context')?.trim() ?? ''

  // One-line log of the callback shape (no code contents, no PII)
  // so we can diagnose downstream failures from the deployment
  // logs without having to instrument on the fly.
  console.info('[godaddy/oauth/callback] hit', {
    hasCode: !!code,
    status,
    hasContext: !!context,
    knownParams: [...url.searchParams.keys()],
  })

  if (!code || !context) {
    return redirectToSettings(req, 'missing-params')
  }
  if (status && DECLINE_STATUSES.has(status.toLowerCase())) {
    return redirectToSettings(req, 'declined')
  }

  const restaurantId = await consumeOAuthState(context)
  if (!restaurantId) {
    return redirectToSettings(req, 'stale-state')
  }

  const businessId = decodeBusinessId(code)
  if (!businessId) {
    return redirectToSettings(req, 'bad-code')
  }

  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL
  const origin = configuredOrigin || url.origin
  const redirectUri = `${origin}/api/godaddy/oauth/callback`

  try {
    const tokens = await exchangeAuthorizationCode({ code, redirectUri })
    await upsertMerchantToken({
      restaurantId,
      businessId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      scope: tokens.scope,
      tokenType: tokens.tokenType,
      expiresInSeconds: tokens.expiresIn,
    })
    return redirectToSettings(req, 'connected')
  } catch (err) {
    console.error('[godaddy/oauth/callback] token exchange failed', err)
    return redirectToSettings(req, 'exchange-failed')
  }
}
