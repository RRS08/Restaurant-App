// ----------------------------------------------------------------
// Payment adapter interface + registry.
//
// Every real payment processor lives behind this contract. The rest
// of the app only ever calls `getPaymentAdapter(providerId)` and
// works with the normalized return shapes in `./types.ts`.
//
// Design notes:
//   • The interface is intentionally narrow — just enough to drive
//     one real processor (Stripe first). Adding terminal/reader
//     flows, partial captures, etc. is a later phase, not a guess.
//   • Adapters never touch Supabase. Persistence is the server
//     action's job. This keeps each adapter mockable and pure.
//   • Adapters never see the authenticated user context. They get
//     a narrow `PaymentAdapterContext` with credentials + the amount
//     snapshot. Authz/RLS happen one level up.
//   • Adapters can throw a `PaymentAdapterError` to surface a
//     typed failure to the calling action. Anything else is
//     normalized by the caller.
// ----------------------------------------------------------------

import type {
  NormalizedPaymentIntent,
  PaymentAmount,
  PaymentProviderId,
  CanonicalPaymentStatus,
} from './types'
import { stripePaymentAdapter } from './adapters/stripe'
import { manualPaymentAdapter } from './adapters/manual'

// ================================================================
// Context passed to every adapter call.
// ================================================================

export interface PaymentAdapterContext {
  /** Non-secret config pulled from payment_provider_configs. Safe
   *  to pass around and inspect. */
  config: {
    providerAccountId: string | null
    providerLocationId: string | null
    publishableKey: string | null
    defaultCurrency: string
  }
  /** Owner-only secrets pulled from payment_provider_secrets. Only
   *  present because the calling action gated on requireRestaurantOwner
   *  before reading the row. Never logged, never serialized. */
  secrets: {
    secretKey: string
    webhookSecret?: string | null
  }
  /** Internal restaurant id — useful for idempotency keys and for
   *  tagging provider metadata so provider dashboards are legible. */
  restaurantId: string
  locationId: string
  /** Internal payment intent id. Used as the idempotency key when
   *  the provider supports one, so retries are safe. */
  internalIntentId: string
}

// ================================================================
// Adapter method parameter shapes.
// ================================================================

export interface CreateSessionParams {
  amount: PaymentAmount
  /** Short human description for the provider dashboard. Usually
   *  "Order <short id>" or "Ticket 42". */
  description?: string | null
  /** Anything worth surfacing on the provider side for operator
   *  lookup. Adapters should pass this into the provider's metadata
   *  field when one exists. */
  metadata?: Record<string, string>
}

export interface CancelParams {
  providerIntentId: string
  reason?: string
}

// ================================================================
// Adapter contract.
// ================================================================

export interface PaymentAdapter {
  id: PaymentProviderId
  label: string

  /** Returns whether this adapter can be invoked right now. Mirrors
   *  the lib/plaid/client.ts `isPlaidConfigured` pattern — cheap,
   *  server-safe, never throws. The server action uses this to
   *  short-circuit with a clean error instead of crashing inside
   *  the adapter on a missing secret key. */
  isConfigured(ctx: PaymentAdapterContext): boolean

  /** Create a new payment session / intent on the provider side.
   *  Returns a normalized intent the caller persists into
   *  payment_intents. The client_secret (if any) rides along on
   *  the return value — never persisted. */
  createPaymentSession(
    ctx: PaymentAdapterContext,
    params: CreateSessionParams
  ): Promise<NormalizedPaymentIntent>

  /** Look up the current status of a payment intent at the provider.
   *  Used by refresh actions + webhook fallbacks. */
  getPaymentStatus(
    ctx: PaymentAdapterContext,
    providerIntentId: string
  ): Promise<NormalizedPaymentIntent>

  /** Cancel a still-cancelable intent. Adapters should treat this
   *  as idempotent — already-canceled intents resolve with the
   *  current status, not an error. */
  cancelPayment(
    ctx: PaymentAdapterContext,
    params: CancelParams
  ): Promise<NormalizedPaymentIntent>

  /** Map a provider-native status string to the canonical lifecycle.
   *  Exposed so webhook handlers can translate incoming provider
   *  events without reinstantiating a full adapter context. */
  normalizeStatus(providerStatus: string): CanonicalPaymentStatus
}

// ================================================================
// Typed adapter error.
// ================================================================

/**
 * Every failure inside an adapter should throw `PaymentAdapterError`
 * with a stable `code`. The calling action catches this class and
 * maps it to its own action-style return shape.
 */
export class PaymentAdapterError extends Error {
  public readonly code:
    | 'not_configured'
    | 'provider_error'
    | 'invalid_state'
    | 'not_found'
    | 'not_implemented'

  public readonly providerCode?: string

  constructor(code: PaymentAdapterError['code'], message: string, providerCode?: string) {
    super(message)
    this.name = 'PaymentAdapterError'
    this.code = code
    this.providerCode = providerCode
  }
}

// ================================================================
// Registry.
// ================================================================

export function getPaymentAdapter(id: PaymentProviderId): PaymentAdapter {
  switch (id) {
    case 'stripe':
      return stripePaymentAdapter
    case 'manual':
      return manualPaymentAdapter
    default: {
      // Exhaustiveness check — if we add a new provider to the union
      // without registering it here, TypeScript will fail the build.
      const _exhaustive: never = id
      throw new PaymentAdapterError(
        'not_implemented',
        `No adapter registered for provider '${_exhaustive}'.`
      )
    }
  }
}
