// ----------------------------------------------------------------
// Stripe adapter — real implementation.
//
// Uses the per-restaurant secret key from `ctx.secrets.secretKey`
// (loaded from payment_provider_secrets by the calling action, which
// gates on ownership and whose RLS policy double-checks). A fresh
// Stripe client is instantiated per call so no secret key ever
// lives in a cross-request module cache.
//
// Canonical rules honored here:
//   • Stripe types never leak past this file. Returns are all
//     NormalizedPaymentIntent. Errors are PaymentAdapterError.
//   • Amounts are canonical decimals (e.g. 12.34). Stripe takes
//     integer minor units — we convert at the boundary.
//   • The internal payment_intents.id is used as the idempotency
//     key so retries from the calling action are safe.
// ----------------------------------------------------------------

import Stripe from 'stripe'
import {
  PaymentAdapter,
  PaymentAdapterContext,
  PaymentAdapterError,
  CreateSessionParams,
  CancelParams,
} from '../adapter'
import type { CanonicalPaymentStatus, NormalizedPaymentIntent } from '../types'

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function buildStripe(ctx: PaymentAdapterContext): Stripe {
  if (!ctx.secrets?.secretKey) {
    throw new PaymentAdapterError(
      'not_configured',
      'Stripe secret key is missing. Configure Stripe in Settings first.'
    )
  }
  // Pin the API version so upstream changes don't silently alter
  // response shapes. Upgrade deliberately in a follow-up phase.
  return new Stripe(ctx.secrets.secretKey, {
    apiVersion: '2026-03-25.dahlia',
    typescript: true,
  })
}

/** Convert a canonical decimal amount to Stripe's integer minor
 *  unit. Uses Math.round to sidestep the usual float drift at cents
 *  resolution (e.g. 12.10 * 100 → 1209.9999…). */
function toMinorUnits(amount: number): number {
  return Math.round(amount * 100)
}

function mapStripeStatus(s: Stripe.PaymentIntent.Status): CanonicalPaymentStatus {
  switch (s) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'requires_capture':
      return 'requires_action'
    case 'processing':
      return 'processing'
    case 'succeeded':
      return 'succeeded'
    case 'canceled':
      return 'canceled'
    default:
      return 'processing'
  }
}

function normalize(pi: Stripe.PaymentIntent): NormalizedPaymentIntent {
  const status = mapStripeStatus(pi.status)
  return {
    providerIntentId: pi.id,
    status,
    failureCode: pi.last_payment_error?.code ?? null,
    failureMessage: pi.last_payment_error?.message ?? null,
    // Keep a small, bounded snapshot — never the full Stripe object.
    // Big blobs make payment_intents.provider_metadata hard to read
    // and can drift in shape across API versions.
    providerMetadata: {
      id: pi.id,
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
      livemode: pi.livemode,
      latest_charge:
        typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id ?? null,
    },
    clientSecret: pi.client_secret,
  }
}

/** Translate a Stripe SDK error into the canonical adapter error. */
function wrapStripeError(step: string, err: unknown): never {
  if (err instanceof PaymentAdapterError) throw err
  if (err instanceof Stripe.errors.StripeError) {
    const code = err.code ?? err.type
    if (err.type === 'StripeInvalidRequestError' && /No such payment_intent/i.test(err.message)) {
      throw new PaymentAdapterError('not_found', `Stripe: ${err.message}`, code)
    }
    throw new PaymentAdapterError('provider_error', `Stripe ${step}: ${err.message}`, code)
  }
  const msg = err instanceof Error ? err.message : 'Unknown error'
  throw new PaymentAdapterError('provider_error', `Stripe ${step}: ${msg}`)
}

// ----------------------------------------------------------------
// Adapter
// ----------------------------------------------------------------

export const stripePaymentAdapter: PaymentAdapter = {
  id: 'stripe',
  label: 'Stripe',

  isConfigured(ctx: PaymentAdapterContext): boolean {
    return Boolean(ctx.secrets?.secretKey)
  },

  async createPaymentSession(
    ctx: PaymentAdapterContext,
    params: CreateSessionParams
  ): Promise<NormalizedPaymentIntent> {
    const stripe = buildStripe(ctx)
    const total =
      toMinorUnits(params.amount.amount) +
      toMinorUnits(params.amount.tipAmount) +
      toMinorUnits(params.amount.taxAmount)
    if (total <= 0) {
      throw new PaymentAdapterError(
        'invalid_state',
        'Stripe PaymentIntent amount must be greater than zero.'
      )
    }

    const currency = (params.amount.currency || ctx.config.defaultCurrency || 'USD').toLowerCase()

    try {
      const pi = await stripe.paymentIntents.create(
        {
          amount: total,
          currency,
          description: params.description ?? undefined,
          // Card is the narrow V1 target. Terminal/reader flows come
          // later and will extend this list when they land.
          payment_method_types: ['card'],
          metadata: {
            ...(params.metadata ?? {}),
            internal_intent_id: ctx.internalIntentId,
            restaurant_id: ctx.restaurantId,
            location_id: ctx.locationId,
          },
        },
        {
          // Make retries safe. Stripe rejects reuse of this key with
          // conflicting params, which is exactly the guarantee we
          // want — the calling action can safely retry.
          idempotencyKey: `pi_create_${ctx.internalIntentId}`,
        }
      )
      return normalize(pi)
    } catch (err) {
      wrapStripeError('createPaymentSession', err)
    }
  },

  async getPaymentStatus(
    ctx: PaymentAdapterContext,
    providerIntentId: string
  ): Promise<NormalizedPaymentIntent> {
    const stripe = buildStripe(ctx)
    try {
      const pi = await stripe.paymentIntents.retrieve(providerIntentId)
      return normalize(pi)
    } catch (err) {
      wrapStripeError('getPaymentStatus', err)
    }
  },

  async cancelPayment(
    ctx: PaymentAdapterContext,
    params: CancelParams
  ): Promise<NormalizedPaymentIntent> {
    const stripe = buildStripe(ctx)
    if (!params.providerIntentId) {
      throw new PaymentAdapterError(
        'invalid_state',
        'Cannot cancel: no provider intent id on this payment.'
      )
    }

    try {
      const pi = await stripe.paymentIntents.cancel(params.providerIntentId, {
        cancellation_reason: 'requested_by_customer',
      })
      return normalize(pi)
    } catch (err) {
      // Idempotency on already-terminal intents: if Stripe complains
      // about cancel being disallowed, fall back to a retrieve so
      // the caller gets the real current state instead of an error
      // for a payment that's already settled.
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        /cannot be canceled|already/i.test(err.message)
      ) {
        try {
          const pi = await stripe.paymentIntents.retrieve(params.providerIntentId)
          return normalize(pi)
        } catch (err2) {
          wrapStripeError('cancelPayment.retrieveFallback', err2)
        }
      }
      wrapStripeError('cancelPayment', err)
    }
  },

  normalizeStatus(providerStatus: string): CanonicalPaymentStatus {
    // Kept as the thin string variant for webhook handlers that
    // don't have a full PaymentIntent in hand — mirrors mapStripeStatus.
    switch (providerStatus) {
      case 'requires_payment_method':
      case 'requires_confirmation':
      case 'requires_action':
      case 'requires_capture':
        return 'requires_action'
      case 'processing':
        return 'processing'
      case 'succeeded':
        return 'succeeded'
      case 'canceled':
        return 'canceled'
      default:
        return 'processing'
    }
  },
}
