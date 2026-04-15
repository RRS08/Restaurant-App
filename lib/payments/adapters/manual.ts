// ----------------------------------------------------------------
// Manual adapter.
//
// Represents payments that never touched a real processor — cash,
// owner-recorded tickets, legacy imports. Exists so the backbone
// can describe every real payment using the same canonical shape
// instead of a special `payment_type = 'cash'` carve-out on orders.
//
// Why this still lives behind the adapter interface:
//   • Keeps one code path through the system. The calling action
//     never has to branch on "is this provider a real one?".
//   • Forces manual tickets to be honest about their lifecycle.
//     A manual intent goes straight to `succeeded` on creation,
//     but it still exists as a distinct row that can be audited.
//
// This adapter is NOT configurable — it always runs — and it never
// produces a client_secret or talks to an external API.
// ----------------------------------------------------------------

import {
  PaymentAdapter,
  PaymentAdapterContext,
  PaymentAdapterError,
  CreateSessionParams,
  CancelParams,
} from '../adapter'
import type { CanonicalPaymentStatus, NormalizedPaymentIntent } from '../types'

export const manualPaymentAdapter: PaymentAdapter = {
  id: 'manual',
  label: 'Manual',

  isConfigured(_ctx: PaymentAdapterContext): boolean {
    return true
  },

  async createPaymentSession(
    ctx: PaymentAdapterContext,
    _params: CreateSessionParams
  ): Promise<NormalizedPaymentIntent> {
    // Manual tickets are born succeeded. We still mint a synthetic
    // provider_intent_id so the (provider, provider_intent_id)
    // unique index stays consistent.
    return {
      providerIntentId: `manual_${ctx.internalIntentId}`,
      status: 'succeeded',
      providerMetadata: { adapter: 'manual' },
      clientSecret: null,
    }
  },

  async getPaymentStatus(
    _ctx: PaymentAdapterContext,
    providerIntentId: string
  ): Promise<NormalizedPaymentIntent> {
    // Manual intents never change state after creation. The refresh
    // action still calls this to keep the code path uniform.
    return {
      providerIntentId,
      status: 'succeeded',
      providerMetadata: { adapter: 'manual' },
    }
  },

  async cancelPayment(
    _ctx: PaymentAdapterContext,
    _params: CancelParams
  ): Promise<NormalizedPaymentIntent> {
    // Canceling a manual ticket doesn't make sense — it was already
    // final at creation. Surface a typed error so the caller can
    // show a friendly message instead of silently succeeding.
    throw new PaymentAdapterError(
      'invalid_state',
      'Manual payments cannot be canceled. Use an order void instead.'
    )
  },

  normalizeStatus(_providerStatus: string): CanonicalPaymentStatus {
    return 'succeeded'
  },
}
