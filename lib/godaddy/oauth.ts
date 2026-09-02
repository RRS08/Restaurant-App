// ----------------------------------------------------------------
// GoDaddy Poynt — OAuth token exchange
//
// Three flows land here:
//
//   • authorizeUrl(...) — build the URL we redirect the merchant
//     to so they can approve our app.
//
//   • exchangeAuthorizationCode({ code }) — after the merchant
//     approves, Poynt sends them back to our callback with a JWT
//     `code`. We POST that + a fresh self-signed JWT (Bearer
//     header) to /token to receive per-merchant access + refresh
//     tokens. §3 of the Poynt spec.
//
//   • refreshMerchantToken({ refreshToken }) — before a stored
//     access token expires, we POST the refresh token to /token
//     to swap it for a fresh pair. §4 of the spec.
//
// Gotcha we deliberately encode from the spec: §1a and §4 use
// `grantType` (camelCase); §3 uses `grant_type` (snake_case). Both
// are documented that way and both are exercised — do not
// "normalize" without re-reading the doc.
// ----------------------------------------------------------------

import { decodeJwt } from 'jose'
import { signPoyntAppJwt } from './jwt'
import type { PoyntEnv } from './tokens'

export interface PoyntTokenResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  /** Null when Poynt returns no scope string — which is what it
   *  actually does today. See parseTokenResponse. */
  scope: string | null
  tokenType: string
}

// Env-aware URL selection.
//
// Prod defaults preserved for backward compat — existing installs
// don't need env vars set for anything to work. OTE routes use
// Poynt's sandbox hosts. Both can still be overridden per-env by
// explicit env vars if Poynt ever moves the endpoints (unlikely
// but zero-cost to leave the escape hatch).
function baseUrlForEnv(env: PoyntEnv): string {
  if (env === 'ote') {
    return process.env.GODADDY_POYNT_BASE_URL_OTE || 'https://services.ote-poynt.net'
  }
  return process.env.GODADDY_POYNT_BASE_URL || 'https://services.poynt.net'
}

function authorizeHostForEnv(env: PoyntEnv): string {
  if (env === 'ote') {
    return process.env.GODADDY_POYNT_AUTHORIZE_HOST_OTE || 'https://ote.poynt.net'
  }
  return process.env.GODADDY_POYNT_AUTHORIZE_HOST || 'https://poynt.net'
}

function appId(): string {
  const id = process.env.GODADDY_POYNT_APP_ID
  if (!id) throw new Error('GODADDY_POYNT_APP_ID is not set.')
  return id
}

/** Build the URL we redirect the merchant to for install/approval.
 *  `state` is the value we'll match against on the callback for
 *  CSRF protection — Poynt echoes it back as `context`. `env`
 *  drives whether the authorize screen is prod (real merchants)
 *  or OTE (sandbox test merchants). */
export function authorizeUrl(args: { redirectUri: string; state: string; env?: PoyntEnv; forceConsent?: boolean }): string {
  const env: PoyntEnv = args.env ?? 'prod'
  const params = new URLSearchParams({
    redirect_uri: args.redirectUri,
    client_id: appId(),
    context: args.state,
  })
  // Force Poynt's consent screen even when the merchant already
  // OAuth'd this app before. Poynt skips consent on repeat installs
  // when the requested scopes match the previously-consented set —
  // which means a re-auth that's meant to broaden scope silently
  // re-issues a token with the old scope set. Sending prompt=consent
  // tells Poynt to always show the screen so the merchant can grant
  // any newly-added app scopes.
  if (args.forceConsent) params.set('prompt', 'consent')
  return `${authorizeHostForEnv(env)}/applications/authorize?${params.toString()}`
}

/** POST /token with the merchant `code` (a JWT signed by Poynt) to
 *  receive the merchant's access + refresh tokens. Requires an
 *  Authorization: Bearer <self-signed app JWT> header (§3). Env
 *  drives which base URL we exchange against — an OTE code MUST
 *  hit services.ote-poynt.net or the exchange 401s. */
export async function exchangeAuthorizationCode(args: {
  code: string
  redirectUri: string
  env?: PoyntEnv
}): Promise<PoyntTokenResponse> {
  const env: PoyntEnv = args.env ?? 'prod'
  const assertion = await signPoyntAppJwt()

  const body = new URLSearchParams({
    grant_type: 'authorization_code',       // snake_case per §3
    redirect_uri: args.redirectUri,
    client_id: appId(),
    code: args.code,
  })

  const res = await fetch(`${baseUrlForEnv(env)}/token`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'api-version': '1.2',
      Authorization: `Bearer ${assertion}`,
    },
    body: body.toString(),
  })

  return await parseTokenResponse(res, 'exchangeAuthorizationCode')
}

/** POST /token with a REFRESH_TOKEN grant to renew the merchant's
 *  access token before the 24h expiry. §4 of the spec. Env matches
 *  the environment the original token was issued against — a prod
 *  refresh_token doesn't work on services.ote-poynt.net. */
export async function refreshMerchantToken(args: {
  refreshToken: string
  env?: PoyntEnv
}): Promise<PoyntTokenResponse> {
  const env: PoyntEnv = args.env ?? 'prod'
  const body = new URLSearchParams({
    grantType: 'REFRESH_TOKEN',             // camelCase per §4
    refreshToken: args.refreshToken,
  })

  const res = await fetch(`${baseUrlForEnv(env)}/token`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'api-version': '1.2',
    },
    body: body.toString(),
  })

  return await parseTokenResponse(res, 'refreshMerchantToken')
}

/** Extract the business id (Poynt merchant id) from a decoded
 *  access token or authorization code. The claim is `poynt.biz`,
 *  which requires bracket lookup because of the dot. */
export function decodeBusinessId(jwt: string): string | null {
  try {
    const claims = decodeJwt(jwt) as Record<string, unknown>
    const biz = claims['poynt.biz']
    return typeof biz === 'string' && biz.length > 0 ? biz : null
  } catch {
    return null
  }
}

async function parseTokenResponse(res: Response, ctx: string): Promise<PoyntTokenResponse> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim()
    throw new Error(
      `Poynt /token failed (${res.status} ${res.statusText}) in ${ctx}${snippet ? ` — ${snippet}` : ''}`,
    )
  }
  const json = (await res.json().catch(() => null)) as Partial<PoyntTokenResponse> | null
  if (!json || !json.accessToken || !json.refreshToken || typeof json.expiresIn !== 'number') {
    throw new Error(`Poynt /token in ${ctx} returned an unexpected shape.`)
  }
  return {
    accessToken: json.accessToken,
    refreshToken: json.refreshToken,
    expiresIn: json.expiresIn,
    // Record ABSENCE as null, never as a fabricated 'ALL'.
    //
    // Poynt's /token response carries no `scope` field, and the
    // access token JWT has no scope/permissions claim either — its
    // claims are just {sub, aud, poynt.biz, poynt.uid, poynt.org,
    // exp, iat, jti}. Authorization is decided entirely by the
    // permissions configured on the APP in the Poynt Developer
    // Center, not by anything carried on the token.
    //
    // The old `?? 'ALL'` default wrote a confident "ALL" into
    // godaddy_poynt_tokens.scope for every merchant, which reads as
    // "this token grants everything" when the truth is "we don't
    // know — Poynt didn't say." That fiction is actively
    // misleading when diagnosing a 401: it makes a permission
    // problem look impossible. The settings card already renders
    // the honest empty state ("Poynt did not return a scope string
    // with this token") — this makes that state reachable.
    scope: json.scope ?? null,
    tokenType: json.tokenType ?? 'BEARER',
  }
}
