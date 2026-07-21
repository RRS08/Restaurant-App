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

export interface PoyntTokenResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope: string
  tokenType: string
}

function baseUrl(): string {
  return process.env.GODADDY_POYNT_BASE_URL || 'https://services.poynt.net'
}

function authorizeHost(): string {
  return process.env.GODADDY_POYNT_AUTHORIZE_HOST || 'https://poynt.net'
}

function appId(): string {
  const id = process.env.GODADDY_POYNT_APP_ID
  if (!id) throw new Error('GODADDY_POYNT_APP_ID is not set.')
  return id
}

/** Build the URL we redirect the merchant to for install/approval.
 *  `state` is the value we'll match against on the callback for
 *  CSRF protection — Poynt echoes it back as `context`. */
export function authorizeUrl(args: { redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    redirect_uri: args.redirectUri,
    client_id: appId(),
    context: args.state,
  })
  return `${authorizeHost()}/applications/authorize?${params.toString()}`
}

/** POST /token with the merchant `code` (a JWT signed by Poynt) to
 *  receive the merchant's access + refresh tokens. Requires an
 *  Authorization: Bearer <self-signed app JWT> header (§3). */
export async function exchangeAuthorizationCode(args: {
  code: string
  redirectUri: string
}): Promise<PoyntTokenResponse> {
  const assertion = await signPoyntAppJwt()

  const body = new URLSearchParams({
    grant_type: 'authorization_code',       // snake_case per §3
    redirect_uri: args.redirectUri,
    client_id: appId(),
    code: args.code,
  })

  const res = await fetch(`${baseUrl()}/token`, {
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
 *  access token before the 24h expiry. §4 of the spec. */
export async function refreshMerchantToken(args: {
  refreshToken: string
}): Promise<PoyntTokenResponse> {
  const body = new URLSearchParams({
    grantType: 'REFRESH_TOKEN',             // camelCase per §4
    refreshToken: args.refreshToken,
  })

  const res = await fetch(`${baseUrl()}/token`, {
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
    scope: json.scope ?? 'ALL',
    tokenType: json.tokenType ?? 'BEARER',
  }
}
