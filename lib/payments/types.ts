// ----------------------------------------------------------------
// Canonical payment types.
//
// These are the shapes the rest of the app uses when it talks about
// payments. Provider adapters are responsible for mapping their own
// wire format onto these — no `stripe.*` or `square.*` types should
// ever leak past an adapter boundary.
//
// Kept narrow on purpose: just enough to support one real adapter
// (Stripe first) without boxing us into that adapter's vocabulary.
// ----------------------------------------------------------------

// Every provider the backbone knows about. Adding a new provider is
// a matter of extending this union + registering an adapter. Keep
// 'manual' as an escape hatch for legacy / owner-recorded cash
// tickets so the backbone can represent every real payment, even
// the ones that never touched an API.
export type PaymentProviderId = 'stripe' | 'manual'

// The canonical lifecycle every adapter must map into. Mirrors the
// check constraint on payment_intents.status.
//
//   requires_action  intent exists, customer/card action pending
//   processing       submitted, provider working
//   succeeded        captured and final
//   failed           terminal failure
//   canceled         canceled before capture
//   refunded         reserved — not emitted in this phase
export type CanonicalPaymentStatus =
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'refunded'

// Attempts have a slightly narrower set (no 'refunded').
export type CanonicalAttemptStatus = Exclude<CanonicalPaymentStatus, 'refunded'>

// Money snapshot captured at intent creation time. amount is the
// total the customer owes for THIS intent — if the order gets split
// later, a second intent carries its own snapshot.
export interface PaymentAmount {
  amount: number
  tipAmount: number
  taxAmount: number
  currency: string
}

// The normalized shape an adapter returns from createPaymentSession
// / getPaymentStatus / cancelPayment. This is what the backbone
// persists into payment_intents after the call.
export interface NormalizedPaymentIntent {
  providerIntentId: string
  status: CanonicalPaymentStatus
  failureCode?: string | null
  failureMessage?: string | null
  /** Anything the adapter wants kept raw for later inspection.
   *  Persisted into payment_intents.provider_metadata verbatim. */
  providerMetadata?: Record<string, unknown> | null
  /** Optional short-lived client secret / session identifier the
   *  client-side SDK needs to drive the flow (e.g. Stripe's
   *  client_secret). NEVER persisted — handed straight to the
   *  caller and forgotten. */
  clientSecret?: string | null
}

export interface NormalizedPaymentAttempt {
  providerAttemptId: string | null
  status: CanonicalAttemptStatus
  failureCode?: string | null
  failureMessage?: string | null
  providerMetadata?: Record<string, unknown> | null
}
