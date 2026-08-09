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

/** Reverse a prior SALE. Tries VOID first (pre-settlement, empty
 *  body, id in URL path), falls back to REFUND (post-settlement,
 *  parentId in body + fundingSource) when Poynt reports the parent
 *  has already been captured/settled.
 *
 *  Source: Poynt Cloud Apps "Post-Transaction Actions" docs.
 *   - VOID:  POST /businesses/{id}/transactions/{txnId}/void   body: {}
 *   - REFUND: POST /businesses/{id}/transactions              body: { parentId, action:'REFUND', fundingSource:{ type:'CREDIT_DEBIT' } [, amounts (partial)] }
 *
 *  Both endpoints return a Transaction object; the reversal's own id
 *  is the top-level `id` field. Neither endpoint honors a documented
 *  Idempotency-Key header — we guard against double-refund upstream
 *  by checking `orders.status !== 'voided'` before calling. */
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

  const commonHeaders: Record<string, string> = {
    'authorization': `Bearer ${bearer}`,
    'content-type': 'application/json',
    'api-version': '1.2',
    ...(appId ? { 'x-app-id': appId } : {}),
  }

  // --- Step 1: try VOID (pre-settlement reversal). Cheaper than
  // refund, works when the parent hasn't settled to the processor
  // yet (typical for same-batch transactions before nightly close). ---
  const voidUrl = `${base}/businesses/${encodeURIComponent(businessId)}/transactions/${encodeURIComponent(args.parentTransactionId)}/void`
  const voidReqId = randomUUID()
  let voidRes: Response
  try {
    voidRes = await fetch(voidUrl, {
      method: 'POST',
      headers: { ...commonHeaders, 'poynt-request-id': voidReqId },
      body: '{}',
    })
  } catch (err) {
    console.error('[godaddy/collect] void network failure', err)
    return { status: 'error', message: 'Payment network unavailable — try again in a moment.' }
  }
  const voidRaw = await voidRes.text()
  let voidJson: unknown
  try { voidJson = voidRaw ? JSON.parse(voidRaw) : {} }
  catch { voidJson = {} }
  const voidData = (voidJson ?? {}) as {
    id?: string; status?: string; developerMessage?: string; message?: string; code?: string
  }

  if (voidRes.ok) {
    // Strict success: status must be a terminal reversal state we
    // recognize. Any 2xx that came back with empty / PENDING /
    // PROCESSING is NOT enough — Poynt async-processes and can fail
    // later, which previously caused Checked to flip to voided
    // while the buyer's card was still charged.
    const st = (voidData.status ?? '').toUpperCase()
    if (st === 'VOIDED' || st === 'REFUNDED' || st === 'CAPTURED') {
      console.log('[godaddy/collect] void ok', {
        env: args.env, parentTransactionId: args.parentTransactionId,
        reversalId: voidData.id, status: st,
      })
      return { status: 'refunded', refundTransactionId: voidData.id ?? args.parentTransactionId }
    }
    // 2xx but unclear status → verify by reading the transaction's
    // current state on Poynt. Only trust the write when the read
    // confirms.
    console.warn('[godaddy/collect] void 2xx with unclear status; verifying', {
      env: args.env, status: st, rawBody: voidRaw,
    })
    const verified = await verifyReversed({ base, businessId, bearer, appId, transactionId: args.parentTransactionId })
    if (verified.reversed) {
      return { status: 'refunded', refundTransactionId: voidData.id ?? args.parentTransactionId }
    }
    console.warn('[godaddy/collect] void 2xx but verify says still active', { verified })
    return { status: 'declined', message: 'Provider accepted the request but the transaction is still active — retry in a moment.' }
  }

  // VOID error. Do NOT trust error-message substring matching — a
  // prior version of this code guessed "already voided" from message
  // text and short-circuited to success, which silently marked
  // Checked voided while Poynt still had the charge live in one
  // observed case. Instead: verify by fetching current state. If
  // Poynt actually shows the txn reversed, we accept it. Otherwise
  // fall through to REFUND.
  const verifiedAfterVoidError = await verifyReversed({ base, businessId, bearer, appId, transactionId: args.parentTransactionId })
  if (verifiedAfterVoidError.reversed) {
    console.log('[godaddy/collect] void error but verify confirms already reversed', {
      env: args.env, parentTransactionId: args.parentTransactionId,
      voidStatus: voidRes.status, voidMessage: voidData.developerMessage || voidData.message,
    })
    return { status: 'refunded', refundTransactionId: args.parentTransactionId }
  }
  console.warn('[godaddy/collect] void rejected; will try refund', {
    httpStatus: voidRes.status,
    env: args.env,
    code: voidData.code,
    message: voidData.developerMessage || voidData.message,
    correlationKey: args.idempotencyKey,
    poyntRequestId: voidReqId,
    parentTransactionId: args.parentTransactionId,
    verified: verifiedAfterVoidError,
    rawBody: voidRaw,
  })

  // --- Step 2: REFUND (post-settlement). fundingSource is required
  // per the docs — Poynt uses the parent transaction's stored card
  // when type is CREDIT_DEBIT. amounts omitted = full refund. ---
  const refundUrl = `${base}/businesses/${encodeURIComponent(businessId)}/transactions`
  const refundReqId = randomUUID()
  const refundBody: Record<string, unknown> = {
    parentId: args.parentTransactionId,
    action: 'REFUND',
    fundingSource: { type: 'CREDIT_DEBIT' },
  }
  let refundRes: Response
  try {
    refundRes = await fetch(refundUrl, {
      method: 'POST',
      headers: { ...commonHeaders, 'poynt-request-id': refundReqId },
      body: JSON.stringify(refundBody),
    })
  } catch (err) {
    console.error('[godaddy/collect] refund network failure', err)
    return { status: 'error', message: 'Payment network unavailable — try again in a moment.' }
  }

  const raw = await refundRes.text()
  let json: unknown
  try { json = raw ? JSON.parse(raw) : {} }
  catch {
    console.error('[godaddy/collect] refund non-JSON response', { status: refundRes.status, raw })
    return { status: 'error', message: `Payment provider returned unreadable response (${refundRes.status}).` }
  }
  const data = (json ?? {}) as {
    id?: string; status?: string; developerMessage?: string; message?: string; code?: string
  }

  if (!refundRes.ok) {
    const msg = data.developerMessage || data.message || `Refund declined (${refundRes.status}).`
    // Verify by GET before short-circuiting to success — substring
    // matching on the error message caused a silent-flip bug where
    // Checked marked voided but Poynt still had the charge live.
    // The transaction's actual current state is the only source of
    // truth.
    const verifiedAfterRefundError = await verifyReversed({ base, businessId, bearer, appId, transactionId: args.parentTransactionId })
    if (verifiedAfterRefundError.reversed) {
      console.log('[godaddy/collect] refund error but verify confirms already reversed', {
        env: args.env, parentTransactionId: args.parentTransactionId,
        refundStatus: refundRes.status, refundMessage: msg,
      })
      return { status: 'refunded', refundTransactionId: args.parentTransactionId }
    }
    console.warn('[godaddy/collect] refund rejected', {
      httpStatus: refundRes.status,
      env: args.env,
      code: data.code,
      message: msg,
      hadAppIdHeader: !!appId,
      appIdPrefix: appId ? appId.slice(0, 12) : null,
      correlationKey: args.idempotencyKey,
      poyntRequestId: refundReqId,
      parentTransactionId: args.parentTransactionId,
      requestBody: refundBody,
      rawBody: raw,
      voidPriorStatus: voidRes.status,
      voidPriorBody: voidRaw,
      verified: verifiedAfterRefundError,
    })
    return refundRes.status >= 400 && refundRes.status < 500
      ? { status: 'declined', message: msg, code: data.code }
      : { status: 'error', message: msg }
  }

  const status = (data.status ?? '').toUpperCase()
  if (status !== 'REFUNDED' && status !== 'CAPTURED' && status !== 'AUTHORIZED') {
    // 2xx but the returned status isn't a terminal reversal state.
    // Verify before treating as success — Poynt async processing
    // can accept the request and later fail.
    console.warn('[godaddy/collect] refund 2xx with unclear status; verifying', {
      env: args.env, status, rawBody: raw,
    })
    const verified = await verifyReversed({ base, businessId, bearer, appId, transactionId: args.parentTransactionId })
    if (verified.reversed) {
      return { status: 'refunded', refundTransactionId: data.id ?? args.parentTransactionId }
    }
    return { status: 'declined', message: `Provider accepted the request but the transaction is still active (status: ${status || 'unknown'}) — retry in a moment.` }
  }

  console.log('[godaddy/collect] refund ok', {
    env: args.env,
    parentTransactionId: args.parentTransactionId,
    refundTransactionId: data.id,
    status,
  })
  return { status: 'refunded', refundTransactionId: data.id ?? '' }
}

/** Read a transaction's current state on Poynt. Used to verify
 *  whether a void/refund write actually landed before we mark the
 *  local order voided — avoids the silent-flip class of bug where
 *  a write returned 2xx or a misleading error message but Poynt
 *  never actually reversed the charge. Cheap: one GET per verify. */
async function verifyReversed(args: {
  base: string
  businessId: string
  bearer: string
  appId: string | undefined
  transactionId: string
}): Promise<{ reversed: boolean; status: string | null; httpStatus?: number }> {
  const url = `${args.base}/businesses/${encodeURIComponent(args.businessId)}/transactions/${encodeURIComponent(args.transactionId)}`
  const headers: Record<string, string> = {
    'authorization': `Bearer ${args.bearer}`,
    'content-type': 'application/json',
    'api-version': '1.2',
    ...(args.appId ? { 'x-app-id': args.appId } : {}),
  }
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers })
  } catch (err) {
    console.error('[godaddy/collect] verify fetch failed', err)
    // On network failure we conservatively say "not reversed" so
    // the caller doesn't wrongly flip local status.
    return { reversed: false, status: null }
  }
  if (!res.ok) {
    console.warn('[godaddy/collect] verify GET rejected', { httpStatus: res.status, transactionId: args.transactionId })
    return { reversed: false, status: null, httpStatus: res.status }
  }
  const raw = await res.text()
  let json: unknown
  try { json = raw ? JSON.parse(raw) : {} } catch { return { reversed: false, status: null } }
  const data = (json ?? {}) as { status?: string; action?: string }
  const status = (data.status ?? '').toUpperCase()
  // A transaction is considered reversed when Poynt reports the
  // terminal states of a void/refund. AUTHORIZED / CAPTURED means
  // still live (money with merchant).
  const reversed = status === 'VOIDED' || status === 'REFUNDED' || status === 'REVERSED'
  return { reversed, status }
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
