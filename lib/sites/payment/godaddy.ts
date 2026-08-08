// ----------------------------------------------------------------
// GoDaddy Commerce (Poynt) payment adapter.
//
// authorize() takes the Collect nonce from the client, exchanges
// it for a payment token + charges via
// POST /businesses/{id}/cards/tokenize/charge (see
// lib/godaddy/collect.ts for the transport). On success the order
// lands as 'paid' with the transaction id + card metadata; on
// declined the checkout endpoint bounces the buyer back to
// /checkout with the reason.
//
// When no nonce reaches us (GODADDY_POYNT_APP_ID unset, merchant
// not linked, or the client-side Collect SDK failed to mount),
// authorize() returns 'pending' — the order still saves as unpaid
// and the /thanks page surfaces the "we'll email a payment link"
// message. Merchant can collect out-of-band via their Poynt POS
// until the environment is configured.
//
// createHostedCheckout stays unavailable — Poynt does not ship a
// hosted-checkout-URL product. The whole flow is iframe-based on
// our own /checkout page.
// ----------------------------------------------------------------

import type {
  PaymentAdapter,
  PaymentAuthorizeRequest,
  PaymentAuthorizeResult,
  HostedCheckoutRequest,
  HostedCheckoutResult,
} from './types'
import { chargeWithNonce } from '@/lib/godaddy/collect'

export const godaddyAdapter: PaymentAdapter = {
  name: 'godaddy',

  async authorize(req: PaymentAuthorizeRequest): Promise<PaymentAuthorizeResult> {
    if (!req.nonce) {
      console.info('[payment:godaddy] no nonce — falling back to pending', {
        siteId: req.siteId,
      })
      return {
        status: 'pending',
        note: 'Online payment pending — the merchant will email a secure payment link within one business day.',
      }
    }

    const result = await chargeWithNonce({
      restaurantId: req.restaurantId,
      env: req.env,
      nonce: req.nonce,
      amountDollars: req.amount,
      taxDollars: req.taxAmount,
      idempotencyKey: req.idempotencyKey,
      orderReference: req.orderReference,
    })

    if (result.status === 'paid') {
      return {
        status: 'paid',
        reference: result.transactionId,
        cardBrand: result.cardBrand,
        cardLast4: result.cardLast4,
      }
    }
    // Both 'declined' and 'error' surface as failed to the caller
    // — an order that couldn't be charged shouldn't be created.
    // Distinct log lines in chargeWithNonce keep the buyer-facing
    // message honest without leaking provider internals.
    return { status: 'failed', error: result.message }
  },

  async createHostedCheckout(_req: HostedCheckoutRequest): Promise<HostedCheckoutResult> {
    // Poynt has no hosted-checkout-URL product. The Collect iframe
    // on /checkout is the actual CNP flow — no page to redirect
    // to. Leaving this here so the interface is honored but the
    // checkout code path never depends on it.
    return {
      unavailable: true,
      reason: 'Poynt does not offer hosted checkout URLs; use the iframe flow on /checkout instead.',
    }
  },
}
