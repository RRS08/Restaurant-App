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

import { randomUUID } from 'crypto'
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
  /** OUR internal correlation id for this checkout attempt
   *  (`site:{siteId}:session:{sessionId}:v2`). Logged on every line
   *  in this file so a Vercel log search can stitch the tokenize and
   *  charge halves of one attempt back together. It is NOT sent to
   *  Poynt — see the Poynt-Request-Id note in chargeWithNonce. */
  idempotencyKey: string
  /** Optional order reference stored on the transaction for
   *  reconciliation against the orders table later. */
  orderReference?: string
}

export type ChargeResult =
  | { status: 'paid'; transactionId: string; cardBrand?: string; cardLast4?: string }
  | { status: 'declined'; message: string; code?: string }
  | { status: 'error'; message: string }

/** Two-step charge flow:
 *  1) POST /cards/tokenize with the Collect nonce → get back a
 *     paymentToken (JWT) + card metadata (type, last4) + a status
 *     field. Reject INVALID here before spending the charge call.
 *  2) POST /cards/tokenize/charge with fundingSource.cardToken +
 *     action=SALE + context.{businessId, storeId} → get back the
 *     transaction id. SALE captures in one step (matches the
 *     Poynt Collect W scope on the app). storeId is required to
 *     attribute the transaction correctly.
 */
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
  void taxCents

  const businessId = tokenResult.businessId
  const bearer = tokenResult.accessToken
  const base = apiBaseForEnv(args.env)
  const appId = process.env.GODADDY_POYNT_APP_ID

  // Poynt-Request-Id MUST be a bare UUID, one per request. We used
  // to send our own `site:{uuid}:session:{uuid}:v2` correlation key
  // here (89 chars); Poynt persists this header on the transaction
  // row and the oversized non-UUID value blew up their writer with
  // a Hibernate "could not execute statement" DataException — a 500
  // on every /cards/tokenize/charge. Generate a fresh UUID per call
  // and keep our correlation key in OUR logs only.
  const tokenizeRequestId = randomUUID()
  const chargeRequestId = randomUUID()
  const commonHeaders = {
    'authorization': `Bearer ${bearer}`,
    'content-type': 'application/json',
    'api-version': '1.2',
    ...(appId ? { 'x-app-id': appId } : {}),
  }

  // Fetch the merchant's default storeId — /cards/tokenize/charge
  // needs context.storeId to attribute the transaction correctly.
  const storeId = await fetchDefaultStoreId({ base, businessId, bearer, appId })
  if (!storeId) {
    console.error('[godaddy/collect] could not resolve storeId for business', { businessId })
    return { status: 'error', message: 'Could not resolve merchant store — try again in a moment.' }
  }

  // --- Step 1: nonce → paymentToken (+ card metadata + status) ---
  const tokenizeUrl = `${base}/businesses/${encodeURIComponent(businessId)}/cards/tokenize`
  let tokenizeRes: Response
  try {
    tokenizeRes = await fetch(tokenizeUrl, {
      method: 'POST',
      headers: { ...commonHeaders, 'poynt-request-id': tokenizeRequestId },
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
    status?: string
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
      correlationKey: args.idempotencyKey,
      poyntRequestId: tokenizeRequestId,
      rawBody: tokenizeRaw,
    })
    return tokenizeRes.status >= 400 && tokenizeRes.status < 500
      ? { status: 'declined', message: msg, code: tokenizeData.code }
      : { status: 'error', message: msg }
  }
  // Reject INVALID status before spending the charge call — Poynt
  // returns 200 on tokenize even when the card was refused by the
  // network (bad number, expired, etc); the status field is what
  // tells us it's not usable.
  const tokStatus = (tokenizeData.status ?? '').toUpperCase()
  if (tokStatus === 'INVALID' || tokStatus === 'FAILED') {
    return { status: 'declined', message: 'That card was declined at the network. Try another card.' }
  }
  const paymentToken = tokenizeData.paymentToken
  if (!paymentToken) {
    console.error('[godaddy/collect] tokenize returned no paymentToken', tokenizeData)
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
    tokStatus,
    correlationKey: args.idempotencyKey,
    poyntRequestId: tokenizeRequestId,
  })

  // --- Step 2: paymentToken → SALE (auth + capture in one) ---
  // SALE settles same-day via Poynt's processor; AUTHORIZE would
  // reserve funds without ever capturing (broken behavior — the
  // hold releases in 7 days and the merchant never gets paid).
  const chargeBody: Record<string, unknown> = {
    action: 'SALE',
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
  const chargeUrl = `${base}/businesses/${encodeURIComponent(businessId)}/cards/tokenize/charge`
  let response: Response
  try {
    response = await fetch(chargeUrl, {
      method: 'POST',
      headers: { ...commonHeaders, 'poynt-request-id': chargeRequestId },
      body: JSON.stringify(chargeBody),
    })
  } catch (err) {
    console.error('[godaddy/collect] charge network failure', err)
    return { status: 'error', message: 'Payment network unavailable — try again in a moment.' }
  }

  const raw = await response.text()
  let json: unknown
  try {
    json = raw ? JSON.parse(raw) : {}
  } catch {
    console.error('[godaddy/collect] charge non-JSON response', { status: response.status, raw })
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
    console.warn('[godaddy/collect] charge rejected', {
      httpStatus: response.status,
      env: args.env,
      code: data.code,
      message: msg,
      hadAppIdHeader: !!appId,
      appIdPrefix: appId ? appId.slice(0, 12) : null,
      correlationKey: args.idempotencyKey,
      poyntRequestId: chargeRequestId,
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

// ----------------------------------------------------------------
// Refund flow
// ----------------------------------------------------------------

export interface RefundParentTransactionArgs {
  restaurantId: string
  env: PoyntEnv
  /** The original SALE transaction id — what we stored on the
   *  order's external_id at checkout time. Poynt reverses to the
   *  same card, so no card token is needed. */
  parentTransactionId: string
  /** Full refund amount in dollars. Partial refunds would land here
   *  too but no caller uses them yet. */
  amountDollars: number
  /** Deterministic key so a merchant clicking Void twice doesn't
   *  refund twice — Poynt dedupes on Poynt-Request-Id and we hand
   *  it a stable value derived from the order id. */
  idempotencyKey: string
}

export type RefundResult =
  | { status: 'refunded'; refundTransactionId: string }
  | { status: 'declined'; message: string; code?: string }
  | { status: 'error'; message: string }

/** Issue a REFUND against a prior SALE. Uses the same
 *  /cards/tokenize/charge endpoint we used to create the SALE
 *  (Poynt's action field accepts REFUND alongside SALE/AUTHORIZE);
 *  the merchant's "Transactions Refund W" scope covers it. */
export async function refundParentTransaction(
  args: RefundParentTransactionArgs,
): Promise<RefundResult> {
  const tokenResult = await getValidAccessTokenForEnv(args.restaurantId, args.env)
  if ('error' in tokenResult) return { status: 'error', message: tokenResult.error }

  const amountCents = Math.round(args.amountDollars * 100)
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { status: 'error', message: 'Invalid refund amount.' }
  }

  const businessId = tokenResult.businessId
  const bearer = tokenResult.accessToken
  const base = apiBaseForEnv(args.env)
  const appId = process.env.GODADDY_POYNT_APP_ID
  const requestId = randomUUID()

  // storeId — required on the SALE call and almost certainly
  // required here too for the transaction to be attributed
  // correctly on the merchant's Poynt reports.
  const storeId = await fetchDefaultStoreId({ base, businessId, bearer, appId })
  if (!storeId) {
    console.error('[godaddy/collect] refund could not resolve storeId', { businessId })
    return { status: 'error', message: 'Could not resolve merchant store — try again in a moment.' }
  }

  const url = `${base}/businesses/${encodeURIComponent(businessId)}/cards/tokenize/charge`
  const body: Record<string, unknown> = {
    action: 'REFUND',
    parentId: args.parentTransactionId,
    context: { businessId, storeId },
    amounts: {
      transactionAmount: amountCents,
      orderAmount: amountCents,
      currency: 'USD',
    },
  }
  const headers: Record<string, string> = {
    'authorization': `Bearer ${bearer}`,
    'content-type': 'application/json',
    'api-version': '1.2',
    'poynt-request-id': requestId,
    ...(appId ? { 'x-app-id': appId } : {}),
  }

  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (err) {
    console.error('[godaddy/collect] refund network failure', err)
    return { status: 'error', message: 'Payment network unavailable — try again in a moment.' }
  }

  const raw = await response.text()
  let json: unknown
  try { json = raw ? JSON.parse(raw) : {} }
  catch {
    console.error('[godaddy/collect] refund non-JSON response', { status: response.status, raw })
    return { status: 'error', message: `Payment provider returned unreadable response (${response.status}).` }
  }
  const data = (json ?? {}) as {
    id?: string
    status?: string
    developerMessage?: string
    message?: string
    code?: string
  }

  if (!response.ok) {
    const msg = data.developerMessage || data.message || `Refund declined (${response.status}).`
    console.warn('[godaddy/collect] refund rejected', {
      httpStatus: response.status,
      env: args.env,
      code: data.code,
      message: msg,
      hadAppIdHeader: !!appId,
      appIdPrefix: appId ? appId.slice(0, 12) : null,
      correlationKey: args.idempotencyKey,
      poyntRequestId: requestId,
      parentTransactionId: args.parentTransactionId,
      requestBody: body,
      rawBody: raw,
    })
    return response.status >= 400 && response.status < 500
      ? { status: 'declined', message: msg, code: data.code }
      : { status: 'error', message: msg }
  }

  const status = (data.status ?? '').toUpperCase()
  // A refund can settle as REFUNDED (POS accepted) or CAPTURED
  // (posted to processor). Anything else is a failure worth logging.
  if (status !== 'REFUNDED' && status !== 'CAPTURED' && status !== 'AUTHORIZED') {
    console.warn('[godaddy/collect] refund returned unexpected status', {
      env: args.env,
      status,
      parentTransactionId: args.parentTransactionId,
      rawBody: raw,
    })
    return { status: 'declined', message: `Refund status from processor: ${status || 'unknown'}` }
  }

  console.log('[godaddy/collect] refund ok', {
    env: args.env,
    parentTransactionId: args.parentTransactionId,
    refundTransactionId: data.id,
    status,
  })
  return { status: 'refunded', refundTransactionId: data.id ?? '' }
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
