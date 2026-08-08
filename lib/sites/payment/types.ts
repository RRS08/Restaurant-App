// ----------------------------------------------------------------
// Payment adapter contract for hosted tenant sites.
//
// Each site declares a `payment_provider` in its config
// ('godaddy', 'stripe', 'square', …). The checkout endpoint
// resolves the matching PaymentAdapter and delegates the actual
// authorization to it — the checkout flow itself stays provider-
// agnostic.
//
// authorize() returns one of three outcomes:
//   'paid'    — provider captured the funds, order lands as paid
//               with the provider's reference stored for reconcile
//   'pending' — order lands as unpaid with a human-readable note
//               (used when the real integration isn't wired yet or
//               the provider is an async flow like a payment link)
//   'failed'  — provider rejected the transaction, no order is
//               written, customer bounces back to /checkout with
//               the error surfaced in the URL
// ----------------------------------------------------------------

export interface PaymentAuthorizeBuyer {
  name: string
  email: string
  phone?: string
}

export interface PaymentAuthorizeCartItem {
  slug: string
  qty: number
  name: string
  price: number
}

export interface PaymentAuthorizeRequest {
  siteId: string
  restaurantId: string
  amount: number
  currency: 'USD'
  buyer: PaymentAuthorizeBuyer
  cart: {
    items: PaymentAuthorizeCartItem[]
    subtotal: number
  }
  /** Deterministic key so provider-side retries can dedupe without
   *  double-charging. Same session + same cart snapshot always
   *  produces the same key. */
  idempotencyKey: string
  /** Client-side card nonce from the provider's tokenizer iframe
   *  (Poynt Collect for godaddy, similar for other adapters). The
   *  adapter exchanges it for a payment token + charges. Missing
   *  nonce = no way to charge — adapter returns pending / failed
   *  depending on its policy. */
  nonce?: string
  /** Reference the adapter can attach to the transaction on the
   *  provider side for reconciliation (typically the orders row id). */
  orderReference?: string
  /** Which provider environment to charge against. Derived per-site
   *  from `sites.config.payment_env` — 'prod' (default) hits the
   *  live provider account, 'ote' hits Poynt sandbox. Global env
   *  vars never drive this — one site's sandbox mode can never
   *  affect another site's live integration. */
  env: 'prod' | 'ote'
}

export type PaymentAuthorizeResult =
  | { status: 'paid'; reference: string; cardBrand?: string; cardLast4?: string }
  | { status: 'pending'; note: string }
  | { status: 'failed'; error: string }

export interface HostedCheckoutRequest {
  siteId: string
  restaurantId: string
  orderId: string
  amount: number
  currency: 'USD'
  buyer: PaymentAuthorizeBuyer
  /** Absolute URL the provider redirects back to on successful
   *  payment. Provider appends its own params (transaction id etc.). */
  successUrl: string
  /** Absolute URL the provider redirects back to on failed/cancelled
   *  payment. */
  cancelUrl: string
}

export type HostedCheckoutResult =
  /** Provider returned a URL — redirect the buyer there. Order was
   *  created before this call; provider callback finalizes payment. */
  | { url: string }
  /** Adapter doesn't support hosted checkout (stub, misconfigured,
   *  API unavailable). Caller falls back to the deferred-payment
   *  path — order stays unpaid, buyer sees the email-a-link message. */
  | { unavailable: true; reason: string }

export interface PaymentAdapter {
  /** Matches `sites.config.payment_provider`. */
  name: string
  authorize(req: PaymentAuthorizeRequest): Promise<PaymentAuthorizeResult>
  /** Optional hosted-checkout flow: return a URL to redirect the
   *  buyer to for payment. When unavailable, caller falls back to
   *  the deferred-payment message on /thanks. */
  createHostedCheckout?(req: HostedCheckoutRequest): Promise<HostedCheckoutResult>
}
