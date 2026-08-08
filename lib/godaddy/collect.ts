// ----------------------------------------------------------------
// Poynt Collect — card-not-present (CNP) checkout helpers.
//
// The web flow is a two-step round-trip:
//   1. Client: our /checkout page mounts Poynt's Collect iframe.
//      Buyer types card inside the iframe — PAN never touches our
//      origin. On submit the SDK calls its own tokenize endpoint
//      and hands us back a `nonce` (single-use, short-lived).
//   2. Server: this file. We POST the nonce to Poynt's
//      /cards/tokenize/charge endpoint (SALE action) to exchange
//      it for a payment token AND charge the card in one call.
//      We get back a transaction id + card brand + last4 to store
//      on the order.
//
// Environment routing is PER-SITE, not global. Each site declares
// `sites.config.payment_env` = 'prod' (default) | 'ote' (sandbox).
// The value flows through every callable in this file as an `env`
// parameter — never a global env var — so one site's sandbox mode
// can never affect any other site's live integration.
//
// URLs by env:
//   prod → services.poynt.net              + collect.commerce.godaddy.com
//   ote  → services.ote-poynt.net          + collect.commerce.ote-godaddy.com
// ----------------------------------------------------------------

import { getStoredTokenForEnv, upsertMerchantToken, type PoyntEnv } from './tokens'
import { refreshMerchantToken } from './oauth'

const REFRESH_SLACK_SECONDS = 300

function apiBaseForEnv(env: PoyntEnv): string {
  return env === 'ote' ? 'https://services.ote-poynt.net' : 'https://services.poynt.net'
}

function collectSdkUrlForEnv(env: PoyntEnv): string {
  return env === 'ote'
    ? 'https://collect.commerce.ote-godaddy.com/sdk.js'
    : 'https://collect.commerce.godaddy.com/sdk.js'
}

export interface CollectClientConfig {
  /** URL of the Poynt Collect JS SDK, env-specific. */
  sdkUrl: string
  /** Our Checked app's Poynt Application ID — same value for every
   *  merchant using this Checked build. */
  applicationId: string
  /** Merchant-specific — the businessId Poynt uses for iframe
   *  origin verification. Pulled from the env-scoped token row. */
  businessId: string
  /** True when this site is running in Poynt sandbox — surfaces on
   *  the checkout page as a badge. */
  isSandbox: boolean
}

/** Resolve the client-side config for a specific site + env. Returns
 *  null when the merchant hasn't linked a token for that env, or
 *  when GODADDY_POYNT_APP_ID is unset. Widget falls back to the
 *  deferred-payment "we'll email a link" message when null. */
export async function loadCollectConfigForSite(args: {
  restaurantId: string
  env: PoyntEnv
}): Promise<CollectClientConfig | null> {
  const applicationId = process.env.GODADDY_POYNT_APP_ID
  if (!applicationId) {
    console.warn('[godaddy/collect] GODADDY_POYNT_APP_ID not set — checkout will fall back to deferred payment')
    return null
  }
  const stored = await getStoredTokenForEnv(args.restaurantId, args.env)
  if (!stored) {
    console.warn('[godaddy/collect] no merchant token for env', { restaurantId: args.restaurantId, env: args.env })
    return null
  }
  return {
    sdkUrl: collectSdkUrlForEnv(args.env),
    applicationId,
    businessId: stored.businessId,
    isSandbox: args.env === 'ote',
  }
}

export interface ChargeWithNonceArgs {
  restaurantId: string
  env: PoyntEnv
  nonce: string
  /** Amount in dollars (e.g. 18.50). We convert to cents for Poynt. */
  amountDollars: number
  /** Idempotency key so retries don't double-charge. */
  idempotencyKey: string
  /** Optional order reference stored on the transaction for
   *  reconciliation against the orders table later. */
  orderReference?: string
}

export type ChargeResult =
  | { status: 'paid'; transactionId: string; cardBrand?: string; cardLast4?: string }
  | { status: 'declined'; message: string; code?: string }
  | { status: 'error'; message: string }

/** Tokenize the Collect nonce + charge in one call to Poynt's
 *  /cards/tokenize/charge endpoint. Env determines both which token
 *  row we look up AND which API base URL we hit. */
export async function chargeWithNonce(args: ChargeWithNonceArgs): Promise<ChargeResult> {
  const tokenResult = await getValidAccessTokenForEnv(args.restaurantId, args.env)
  if ('error' in tokenResult) return { status: 'error', message: tokenResult.error }

  const amountCents = Math.round(args.amountDollars * 100)
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { status: 'error', message: 'Invalid charge amount.' }
  }

  const url = `${apiBaseForEnv(args.env)}/businesses/${encodeURIComponent(tokenResult.businessId)}/cards/tokenize/charge`
  const body = {
    nonce: args.nonce,
    action: 'SALE',
    amounts: {
      transactionAmount: amountCents,
      orderAmount: amountCents,
      currency: 'USD',
    },
    references: args.orderReference
      ? [{ type: 'CUSTOM', id: args.orderReference }]
      : undefined,
    context: { source: 'WEB' },
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${tokenResult.accessToken}`,
        'content-type': 'application/json',
        'api-version': '1.2',
        'poynt-request-id': args.idempotencyKey,
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    console.error('[godaddy/collect] network failure charging card', err)
    return { status: 'error', message: 'Payment network unavailable — try again in a moment.' }
  }

  const raw = await response.text()
  let json: unknown
  try {
    json = raw ? JSON.parse(raw) : {}
  } catch {
    console.error('[godaddy/collect] non-JSON response', { status: response.status, raw })
    return { status: 'error', message: `Payment provider returned unreadable response (${response.status}).` }
  }

  const data = (json ?? {}) as {
    id?: string
    status?: string
    processorResponse?: { statusMessage?: string; statusCode?: string; approvedAmount?: number }
    fundingSource?: { card?: { type?: string; numberLast4?: string } }
    developerMessage?: string
    message?: string
    code?: string
  }

  if (!response.ok) {
    const msg = data.developerMessage || data.message || `Payment declined (${response.status}).`
    console.warn('[godaddy/collect] charge rejected', {
      httpStatus: response.status,
      env: args.env,
      code: data.code,
      message: msg,
    })
    return response.status >= 400 && response.status < 500
      ? { status: 'declined', message: msg, code: data.code }
      : { status: 'error', message: msg }
  }

  const status = (data.status ?? '').toUpperCase()
  if (status !== 'CAPTURED' && status !== 'AUTHORIZED') {
    return { status: 'declined', message: data.processorResponse?.statusMessage ?? `Payment status: ${status || 'unknown'}` }
  }

  return {
    status: 'paid',
    transactionId: data.id ?? '',
    cardBrand: data.fundingSource?.card?.type,
    cardLast4: data.fundingSource?.card?.numberLast4,
  }
}

/** Env-aware sibling of getValidAccessToken — POS ingest uses the
 *  prod-locked helper in tokens.ts; checkout uses this one with
 *  the site's declared env so sandbox testing never touches the
 *  prod token flow. Preserves env on refresh (never migrates rows
 *  between environments). */
async function getValidAccessTokenForEnv(
  restaurantId: string,
  env: PoyntEnv,
): Promise<{ accessToken: string; businessId: string } | { error: string }> {
  const stored = await getStoredTokenForEnv(restaurantId, env)
  if (!stored) {
    return {
      error: env === 'ote'
        ? 'This site is in sandbox mode but no OTE Poynt merchant is linked yet.'
        : 'This restaurant has not linked a GoDaddy Commerce merchant yet.',
    }
  }

  const secondsLeft = Math.floor((new Date(stored.expiresAt).getTime() - Date.now()) / 1000)
  if (secondsLeft > REFRESH_SLACK_SECONDS) {
    return { accessToken: stored.accessToken, businessId: stored.businessId }
  }

  try {
    const fresh = await refreshMerchantToken({ refreshToken: stored.refreshToken })
    await upsertMerchantToken({
      restaurantId: stored.restaurantId,
      businessId: stored.businessId,
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      scope: fresh.scope,
      tokenType: fresh.tokenType,
      expiresInSeconds: fresh.expiresIn,
      env: stored.env,
    })
    return { accessToken: fresh.accessToken, businessId: stored.businessId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `Refresh failed — the merchant may need to reconnect: ${msg}` }
  }
}
