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
  /** Total amount to charge in dollars, INCLUDING tax. Poynt sees
   *  this as transactionAmount + orderAmount. We convert to cents. */
  amountDollars: number
  /** Tax portion of amountDollars. Reported separately on the
   *  transaction body so it shows up in Poynt's merchant reporting;
   *  the buyer is still charged amountDollars total. Missing = 0. */
  taxDollars?: number
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

/** Two-step tokenize + authorize flow:
 *  1) POST /cards/tokenize with the Collect nonce → get back a
 *     paymentToken (JWT) + card metadata (type, last4).
 *  2) POST /cards/tokenize/charge with cardToken + authOnly:true +
 *     action=AUTHORIZE → get back the transaction id.
 *  This shape matches the "Transactions Authorize" scope on the
 *  merchant OAuth grant. The shortcut single-call form (nonce +
 *  action=SALE|AUTHORIZE at top level) requires the broader Charge
 *  scope which we don't have; Poynt rejects it with "This principal
 *  does not have access to this resource". */
export async function chargeWithNonce(args: ChargeWithNonceArgs): Promise<ChargeResult> {
  const tokenResult = await getValidAccessTokenForEnv(args.restaurantId, args.env)
  if ('error' in tokenResult) return { status: 'error', message: tokenResult.error }

  const amountCents = Math.round(args.amountDollars * 100)
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { status: 'error', message: 'Invalid charge amount.' }
  }
  const taxCents = args.taxDollars && args.taxDollars > 0
    ? Math.round(args.taxDollars * 100)
    : 0

  const businessId = tokenResult.businessId
  const bearer = tokenResult.accessToken
  const base = apiBaseForEnv(args.env)
  // Application id from the env — Poynt uses this to figure out
  // which app's granted scopes apply to the request. Same value the
  // Collect JS SDK receives; falls back to omitting the header if
  // the env isn't set (Poynt will then rely on the token alone,
  // which is what we were doing before this fix).
  const appId = process.env.GODADDY_POYNT_APP_ID

  // --- Step 1: nonce → paymentToken ---
  const tokenizeUrl = `${base}/businesses/${encodeURIComponent(businessId)}/cards/tokenize`
  let tokenizeRes: Response
  try {
    tokenizeRes = await fetch(tokenizeUrl, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${bearer}`,
        'content-type': 'application/json',
        'api-version': '1.2',
        'poynt-request-id': args.idempotencyKey + ':tok',
        // x-app-id tells Poynt which application's scopes to check
        // when resolving permissions. Omitting it can produce a
        // generic "principal does not have access" even when the
        // token itself is valid — the server doesn't know which
        // app's grants to apply.
        ...(appId ? { 'x-app-id': appId } : {}),
      },
      body: JSON.stringify({ nonce: args.nonce }),
    })
  } catch (err) {
    console.error('[godaddy/collect] tokenize network failure', err)
    return { status: 'error', message: 'Payment network unavailable — try again in a moment.' }
  }

  const tokenizeRaw = await tokenizeRes.text()
  let tokenizeJson: unknown
  try { tokenizeJson = tokenizeRaw ? JSON.parse(tokenizeRaw) : {} }
  catch {
    console.error('[godaddy/collect] tokenize non-JSON response', { status: tokenizeRes.status, raw: tokenizeRaw })
    return { status: 'error', message: `Payment provider returned unreadable response (${tokenizeRes.status}).` }
  }
  const tokenizeData = (tokenizeJson ?? {}) as {
    paymentToken?: string
    card?: { type?: string; numberLast4?: string }
    developerMessage?: string
    message?: string
    code?: string
  }
  if (!tokenizeRes.ok) {
    const msg = tokenizeData.developerMessage || tokenizeData.message || `Card tokenize failed (${tokenizeRes.status}).`
    console.warn('[godaddy/collect] tokenize rejected', {
      httpStatus: tokenizeRes.status,
      env: args.env,
      code: tokenizeData.code,
      message: msg,
      hadAppIdHeader: !!appId,
      rawBody: tokenizeRaw,
    })
    return tokenizeRes.status >= 400 && tokenizeRes.status < 500
      ? { status: 'declined', message: msg, code: tokenizeData.code }
      : { status: 'error', message: msg }
  }
  const paymentToken = tokenizeData.paymentToken
  if (!paymentToken) {
    console.error('[godaddy/collect] tokenize succeeded but no paymentToken in body', tokenizeData)
    return { status: 'error', message: 'Card tokenization returned no token.' }
  }
  const cardBrand = tokenizeData.card?.type
  const cardLast4 = tokenizeData.card?.numberLast4
  console.log('[godaddy/collect] tokenize ok', {
    env: args.env,
    hadAppIdHeader: !!appId,
    appIdPrefix: appId ? appId.slice(0, 12) : null,
    cardBrand,
    cardLast4,
  })

  // --- Step 2: paymentToken → AUTHORIZE transaction ---
  // Fetch the merchant's default store id — Poynt requires
  // context.storeId on the AUTHORIZE call to attribute the txn to
  // a physical/logical location. Businesses always have at least
  // one store; we take the first one from GET /businesses/{id}/stores.
  const storeId = await fetchDefaultStoreId({ base, businessId, bearer, appId })
  if (!storeId) {
    console.error('[godaddy/collect] could not resolve storeId for business', { businessId })
    return { status: 'error', message: 'Could not resolve merchant store — try again in a moment.' }
  }

  // Body matches Poynt's docs example. taxAmount lives in
  // transactionAmount already for AUTHORIZE.
  const chargeBody: Record<string, unknown> = {
    action: 'AUTHORIZE',
    authOnly: true,
    context: { businessId, storeId },
    amounts: {
      transactionAmount: amountCents,
      orderAmount: amountCents,
      currency: 'USD',
    },
    fundingSource: { cardToken: paymentToken },
  }
  if (args.orderReference) {
    chargeBody.references = [{ type: 'CUSTOM', id: args.orderReference }]
  }
  void taxCents

  const chargeHeaders = {
    'authorization': `Bearer ${bearer}`,
    'content-type': 'application/json',
    'api-version': '1.2',
    'poynt-request-id': args.idempotencyKey,
    ...(appId ? { 'x-app-id': appId } : {}),
  }
  // Try /businesses/{id}/transactions first — the pure Cloud API
  // Transactions endpoint that "Transactions Authorize W" explicitly
  // covers. /cards/tokenize/charge is the Poynt Collect combined
  // endpoint and appears to need a separate "Poynt Collect Charge"
  // sub-scope that Transactions Authorize alone doesn't grant.
  // Fall back on 404 in case this Poynt account only exposes the
  // combined endpoint. On any other error we return the response
  // as-is so the log shows the actual rejection.
  const transactionsUrl = `${base}/businesses/${encodeURIComponent(businessId)}/transactions`
  let response: Response
  let usedEndpoint = 'transactions'
  try {
    response = await fetch(transactionsUrl, {
      method: 'POST',
      headers: chargeHeaders,
      body: JSON.stringify(chargeBody),
    })
  } catch (err) {
    console.error('[godaddy/collect] authorize network failure', err)
    return { status: 'error', message: 'Payment network unavailable — try again in a moment.' }
  }
  if (response.status === 404 || response.status === 405) {
    console.warn('[godaddy/collect] /transactions unavailable, falling back to /cards/tokenize/charge', { status: response.status })
    usedEndpoint = 'tokenize-charge'
    const chargeUrl = `${base}/businesses/${encodeURIComponent(businessId)}/cards/tokenize/charge`
    try {
      response = await fetch(chargeUrl, {
        method: 'POST',
        headers: chargeHeaders,
        body: JSON.stringify(chargeBody),
      })
    } catch (err) {
      console.error('[godaddy/collect] authorize fallback network failure', err)
      return { status: 'error', message: 'Payment network unavailable — try again in a moment.' }
    }
  }
  void usedEndpoint

  const raw = await response.text()
  let json: unknown
  try {
    json = raw ? JSON.parse(raw) : {}
  } catch {
    console.error('[godaddy/collect] authorize non-JSON response', { status: response.status, raw })
    return { status: 'error', message: `Payment provider returned unreadable response (${response.status}).` }
  }

  const data = (json ?? {}) as {
    id?: string
    status?: string
    processorResponse?: { statusMessage?: string; statusCode?: string; approvedAmount?: number }
    developerMessage?: string
    message?: string
    code?: string
  }

  if (!response.ok) {
    const msg = data.developerMessage || data.message || `Payment declined (${response.status}).`
    console.warn('[godaddy/collect] authorize rejected', {
      endpoint: usedEndpoint,
      httpStatus: response.status,
      env: args.env,
      code: data.code,
      message: msg,
      hadAppIdHeader: !!appId,
      appIdPrefix: appId ? appId.slice(0, 12) : null,
      requestBody: { ...chargeBody, fundingSource: { cardToken: '<redacted>' } },
      rawBody: raw,
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
    cardBrand,
    cardLast4,
  }
}

// In-process cache keyed by businessId so we don't hit
// /businesses/{id}/stores on every checkout. Cheap Map, not
// persisted — a fresh serverless instance re-fetches once.
const storeIdCache = new Map<string, string>()

async function fetchDefaultStoreId(args: {
  base: string
  businessId: string
  bearer: string
  appId: string | undefined
}): Promise<string | null> {
  const cached = storeIdCache.get(args.businessId)
  if (cached) return cached

  const headers = {
    'authorization': `Bearer ${args.bearer}`,
    'content-type': 'application/json',
    'api-version': '1.2',
    ...(args.appId ? { 'x-app-id': args.appId } : {}),
  }

  // Try /businesses/{id}/stores first — canonical list endpoint.
  const storesUrl = `${args.base}/businesses/${encodeURIComponent(args.businessId)}/stores`
  const storeFromList = await tryExtractStoreId(storesUrl, headers, 'stores-list')
  if (storeFromList) {
    storeIdCache.set(args.businessId, storeFromList)
    return storeFromList
  }

  // Fallback: /businesses/{id} — the business row usually embeds
  // its stores as `stores: [...]` OR `store: {...}`, depending on
  // the Poynt API version and account type.
  const businessUrl = `${args.base}/businesses/${encodeURIComponent(args.businessId)}`
  const storeFromBusiness = await tryExtractStoreId(businessUrl, headers, 'business-embedded')
  if (storeFromBusiness) {
    storeIdCache.set(args.businessId, storeFromBusiness)
    return storeFromBusiness
  }

  return null
}

async function tryExtractStoreId(
  url: string,
  headers: Record<string, string>,
  source: string,
): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers })
  } catch (err) {
    console.error('[godaddy/collect] fetch failed', { source, err: String(err) })
    return null
  }
  const raw = await res.text()
  if (!res.ok) {
    console.warn('[godaddy/collect] store lookup rejected', { source, status: res.status, raw })
    return null
  }
  let json: unknown
  try { json = raw ? JSON.parse(raw) : {} }
  catch {
    console.warn('[godaddy/collect] store lookup non-JSON', { source, raw })
    return null
  }
  // Poynt varies the shape by endpoint + account: could be a bare
  // array, { stores: [...] }, { results: [...] }, or the business
  // row with an embedded store field. Try each in turn; log the raw
  // body when nothing matches so we can add the actual shape later.
  const asArr = Array.isArray(json) ? json : null
  const asObj = (json ?? {}) as Record<string, unknown>
  const candidates: unknown[] = [
    asArr,
    asObj.stores,
    asObj.results,
    asObj.items,
    asObj.data,
    asObj.store ? [asObj.store] : null,
  ]
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      const first = c[0] as { id?: string; storeId?: string } | undefined
      const id = first?.id ?? first?.storeId
      if (id) {
        console.log('[godaddy/collect] resolved storeId', { source, id: id.slice(0, 8) + '…' })
        return id
      }
    }
  }
  console.warn('[godaddy/collect] no store id in response', { source, raw: raw.slice(0, 500) })
  return null
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
    // Refresh in the same env the token was issued for.
    const fresh = await refreshMerchantToken({ refreshToken: stored.refreshToken, env: stored.env })
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
