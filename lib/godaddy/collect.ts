// ----------------------------------------------------------------
// Poynt Collect — card-not-present (CNP) checkout helpers.
//
// The web flow is a two-step round-trip:
//   1. Client: our /checkout page mounts Poynt's Collect iframe
//      (from collect.commerce.godaddy.com/sdk.js). Buyer types card
//      inside the iframe — PAN never touches our origin. On submit
//      the SDK calls its own tokenize endpoint and hands us back
//      a `nonce` (single-use, short-lived).
//   2. Server: this file. We POST the nonce to Poynt's
//      /cards/tokenize endpoint to exchange it for a paymentToken
//      (a JWT that references the card in Poynt's vault), then POST
//      /transactions with action=SALE + paymentToken to charge the
//      card. Money moves. We get back a transaction id + card brand
//      + last4 to store on the order.
//
// Everything hangs off the merchant's stored OAuth token (already
// covers the tokenize + transactions scopes). Only new env vars:
//
//   POYNT_APPLICATION_ID    — our Checked app's ID (from the Poynt
//                              dev portal). Same across all merchants.
//   POYNT_ENV               — 'prod' (default) or 'ote' (Poynt's
//                              sandbox for test-card flows).
//
// Prod vs OTE swaps two host names:
//   services.poynt.net           ↔  services.ote-poynt.net       (API)
//   collect.commerce.godaddy.com ↔  collect.commerce.ote-godaddy.com (SDK)
// Everything else is identical.
// ----------------------------------------------------------------

import { getValidAccessToken } from './tokens'

function apiBase(): string {
  const explicit = process.env.GODADDY_POYNT_BASE_URL
  if (explicit) return explicit
  return isOte() ? 'https://services.ote-poynt.net' : 'https://services.poynt.net'
}

function collectSdkUrl(): string {
  return isOte()
    ? 'https://collect.commerce.ote-godaddy.com/sdk.js'
    : 'https://collect.commerce.godaddy.com/sdk.js'
}

function isOte(): boolean {
  return (process.env.POYNT_ENV ?? '').toLowerCase() === 'ote'
}

export interface CollectClientConfig {
  /** URL of the Poynt Collect JS SDK. Loaded on /checkout to mount
   *  the iframe that tokenizes the card client-side. */
  sdkUrl: string
  /** Our Checked app's Poynt Application ID. Same for every
   *  merchant using our site host — comes from the Poynt dev
   *  portal, not per-tenant config. */
  applicationId: string
  /** Merchant-specific — the businessId Poynt uses to key the
   *  iframe origin verification. Read from godaddy_poynt_tokens
   *  per the site's restaurant_id. */
  businessId: string
  /** True when running against Poynt's OTE sandbox — surfaces on
   *  the checkout page as a badge so nobody accidentally ships a
   *  test-mode build to production. */
  isSandbox: boolean
}

/** Resolve the client-side config a merchant needs to mount the
 *  Poynt Collect iframe. Returns null when the merchant hasn't
 *  linked GoDaddy Commerce yet, or when POYNT_APPLICATION_ID is
 *  unset — either case, the widget falls back to the deferred-
 *  payment "we'll email a link" message. */
export async function loadCollectConfigForRestaurant(restaurantId: string): Promise<CollectClientConfig | null> {
  const applicationId = process.env.POYNT_APPLICATION_ID
  if (!applicationId) {
    console.warn('[godaddy/collect] POYNT_APPLICATION_ID not set — checkout will fall back to deferred payment')
    return null
  }
  const tok = await getValidAccessToken(restaurantId)
  if ('error' in tok) {
    console.warn('[godaddy/collect] no merchant token', { restaurantId, error: tok.error })
    return null
  }
  return {
    sdkUrl: collectSdkUrl(),
    applicationId,
    businessId: tok.businessId,
    isSandbox: isOte(),
  }
}

export interface ChargeWithNonceArgs {
  restaurantId: string
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
  | {
      status: 'paid'
      transactionId: string
      cardBrand?: string
      cardLast4?: string
    }
  | {
      status: 'declined'
      message: string
      code?: string
    }
  | {
      status: 'error'
      message: string
    }

/** Tokenize the Collect nonce + charge in one call to
 *  Poynt's /cards/tokenize/charge endpoint. One-shot beats
 *  the two-step (/tokenize then /transactions) for our flow —
 *  fewer round trips, and we don't hold onto the paymentToken
 *  server-side for anything else. */
export async function chargeWithNonce(args: ChargeWithNonceArgs): Promise<ChargeResult> {
  const tok = await getValidAccessToken(args.restaurantId)
  if ('error' in tok) return { status: 'error', message: tok.error }

  const amountCents = Math.round(args.amountDollars * 100)
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { status: 'error', message: 'Invalid charge amount.' }
  }

  const url = `${apiBase()}/businesses/${encodeURIComponent(tok.businessId)}/cards/tokenize/charge`
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
    // context.source hints Poynt this is a web transaction rather
    // than a device swipe — keeps merchant reporting clean.
    context: {
      source: 'WEB',
    },
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${tok.accessToken}`,
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
    // 4xx from the processor typically = declined card / bad CVV /
    // insufficient funds. 5xx = provider hiccup — same buyer-facing
    // copy either way, but log the distinction for us.
    console.warn('[godaddy/collect] charge rejected', {
      httpStatus: response.status,
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
