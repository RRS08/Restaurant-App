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
}

export type PaymentAuthorizeResult =
  | { status: 'paid'; reference: string; cardBrand?: string; cardLast4?: string }
  | { status: 'pending'; note: string }
  | { status: 'failed'; error: string }

export interface PaymentAdapter {
  /** Matches `sites.config.payment_provider`. */
  name: string
  authorize(req: PaymentAuthorizeRequest): Promise<PaymentAuthorizeResult>
}
