// ----------------------------------------------------------------
// GoDaddy Commerce (Poynt) payment adapter.
//
// STUB. The real integration calls Poynt's Transactions Authorize
// endpoint (we already hold the scope on the dev app), but Authorize
// needs a card token — Poynt's card-not-present flow requires their
// tokenizer JS running client-side to turn a PAN into a token before
// it ever touches our server. Building that blind (docs, SDK URLs,
// iframe embedding) is worse than deferring: the order-capture side
// of checkout still ships, and this adapter slots the real call in
// later without any change to the caller.
//
// Until the real integration lands, authorize() returns 'pending' —
// the order writes with payment_status='unpaid' and the confirmation
// page surfaces "payment link will be emailed" copy. The merchant
// collects payment out-of-band via their existing Poynt POS.
// ----------------------------------------------------------------

import type {
  PaymentAdapter,
  PaymentAuthorizeRequest,
  PaymentAuthorizeResult,
} from './types'

export const godaddyAdapter: PaymentAdapter = {
  name: 'godaddy',
  async authorize(req: PaymentAuthorizeRequest): Promise<PaymentAuthorizeResult> {
    console.info('[payment:godaddy] stub authorize', {
      siteId: req.siteId,
      amount: req.amount,
      idempotencyKey: req.idempotencyKey,
    })
    return {
      status: 'pending',
      note: 'Online payment pending — the merchant will email a secure payment link within one business day.',
    }
  },
}
