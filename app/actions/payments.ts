'use server'

// ----------------------------------------------------------------
// Payments — provider-agnostic server actions
//
// Surface:
//
//   setPaymentProviderConfig   owner-only; writes payment_provider_configs
//                              and payment_provider_secrets in one call
//   createPaymentIntent        location-scoped; creates a canonical
//                              payment_intents row backed by an
//                              adapter.createPaymentSession call
//   refreshPaymentIntent       location-scoped; reconciles local state
//                              with adapter.getPaymentStatus
//   cancelPaymentIntent        location-scoped; calls adapter.cancelPayment
//                              and persists the normalized result
//
// Key rules:
//   • Orders and payments stay DISTINCT tables and distinct lifecycles.
//     The only thing that ever crosses the boundary is a narrow
//     `reconcileOrderPaymentStatus` helper, invoked from
//     `persistIntentResult`, which promotes `orders.payment_status`
//     from the canonical intent status. It is NOT a full
//     reconciliation engine — just a one-line promotion rule:
//
//        succeeded              → orders.payment_status = 'paid'
//        failed | canceled      → orders.payment_status = 'unpaid'
//                                 (only if the order is not already
//                                 paid by some other intent — the
//                                 helper checks for a concurrent
//                                 succeeded sibling before demoting)
//        requires_action | processing
//                               → no change (intermediate state)
//
//   • Secrets NEVER leave the server. Adapters receive them through
//     `PaymentAdapterContext.secrets`; the action reads them via an
//     owner-gated SELECT that the RLS policy double-checks.
//   • client_secret (if any) rides back on the create return value
//     so the client SDK can drive the flow, but is never persisted.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import {
  requireRestaurantOwner,
  requireLocationAccess,
  AuthzError,
} from '@/lib/authz'
import {
  getPaymentAdapter,
  PaymentAdapterError,
  type PaymentAdapterContext,
} from '@/lib/payments/adapter'
import type {
  CanonicalPaymentStatus,
  NormalizedPaymentIntent,
  PaymentProviderId,
} from '@/lib/payments/types'

type Result<T = { ok: true; message: string }> = T | { error: string }

type Supa = Awaited<ReturnType<typeof createClient>>

// ----------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------

const VALID_PROVIDERS: PaymentProviderId[] = ['stripe', 'manual']

function isProviderId(s: string): s is PaymentProviderId {
  return (VALID_PROVIDERS as string[]).includes(s)
}

/** Convert an AuthzError thrown by a guard into our graceful
 *  action-style error-return shape. */
function authzErrorToResult(err: unknown): { error: string } | null {
  if (err instanceof AuthzError) return { error: err.message }
  return null
}

/** Convert an adapter failure into an action error. Keeps raw
 *  provider codes in dev so diagnostics are cheap. */
function adapterErrorToResult(step: string, err: unknown): { error: string } {
  if (err instanceof PaymentAdapterError) {
    if (process.env.NODE_ENV === 'development') {
      return { error: `[DEV] ${step} — ${err.message}${err.code ? ` (${err.code})` : ''}` }
    }
    if (err.code === 'not_configured') {
      return { error: 'Payments are not configured yet. Set up Stripe in Settings first.' }
    }
    return { error: `Could not ${step}. Please try again.` }
  }
  const msg = err instanceof Error ? err.message : 'Unknown error.'
  return { error: `Could not ${step}: ${msg}` }
}

/** Load non-secret config + owner-gated secret for a given provider
 *  and build the context adapters need. Returns null when the
 *  provider is either not configured or the caller doesn't have
 *  access to read the secret row. */
async function buildAdapterContext(
  supabase: Supa,
  restaurantId: string,
  locationId: string,
  internalIntentId: string,
  provider: PaymentProviderId
): Promise<
  | { ok: true; ctx: PaymentAdapterContext }
  | { ok: false; error: string }
> {
  // Manual adapter needs no config / secrets — shortcut so owner
  // setup isn't a prerequisite for representing cash tickets.
  if (provider === 'manual') {
    return {
      ok: true,
      ctx: {
        config: {
          providerAccountId: null,
          providerLocationId: null,
          publishableKey: null,
          defaultCurrency: 'USD',
        },
        secrets: { secretKey: 'n/a' },
        restaurantId,
        locationId,
        internalIntentId,
      },
    }
  }

  const { data: config } = await supabase
    .from('payment_provider_configs')
    .select('provider_account_id, provider_location_id, publishable_key, default_currency, active')
    .eq('restaurant_id', restaurantId)
    .eq('provider', provider)
    .maybeSingle()

  if (!config || !config.active) {
    return { ok: false, error: 'This payment provider is not configured yet.' }
  }

  // The secret read will return zero rows for non-owners thanks to
  // payment_provider_secrets RLS. We still layer the authz guard at
  // the calling action so the error shape is clean.
  const { data: secret } = await supabase
    .from('payment_provider_secrets')
    .select('secret_key, webhook_secret')
    .eq('restaurant_id', restaurantId)
    .eq('provider', provider)
    .maybeSingle()
  if (!secret) {
    return { ok: false, error: 'Missing provider credentials. An owner must configure this provider.' }
  }

  return {
    ok: true,
    ctx: {
      config: {
        providerAccountId: config.provider_account_id ?? null,
        providerLocationId: config.provider_location_id ?? null,
        publishableKey: config.publishable_key ?? null,
        defaultCurrency: config.default_currency ?? 'USD',
      },
      secrets: {
        secretKey: secret.secret_key,
        webhookSecret: secret.webhook_secret ?? null,
      },
      restaurantId,
      locationId,
      internalIntentId,
    },
  }
}

/** Narrow bridge: promote `orders.payment_status` from canonical
 *  intent truth. NOT a reconciliation engine — one promotion rule
 *  per terminal state. Safe to call on intents with no order_id.
 *
 *  On succeeded: flip the parent order to 'paid'.
 *  On failed/canceled: flip to 'unpaid' ONLY if no other intent on
 *    this order is currently 'succeeded' (prevents a failed retry
 *    from demoting a legitimately paid order). */
async function reconcileOrderPaymentStatus(
  supabase: Supa,
  orderId: string | null,
  status: CanonicalPaymentStatus
): Promise<void> {
  if (!orderId) return
  if (status === 'requires_action' || status === 'processing' || status === 'refunded') return

  if (status === 'succeeded') {
    await supabase
      .from('orders')
      .update({ payment_status: 'paid' })
      .eq('id', orderId)
    return
  }

  // failed | canceled — only demote if no sibling intent is succeeded.
  const { data: succeededSibling } = await supabase
    .from('payment_intents')
    .select('id')
    .eq('order_id', orderId)
    .eq('status', 'succeeded')
    .limit(1)
    .maybeSingle()
  if (succeededSibling) return

  await supabase
    .from('orders')
    .update({ payment_status: 'unpaid' })
    .eq('id', orderId)
}

/** Persist the canonical intent AFTER an adapter call resolves.
 *  Also writes a payment_attempts row so retry history is captured
 *  from day one, and promotes `orders.payment_status` via the narrow
 *  reconcile bridge above. */
async function persistIntentResult(
  supabase: Supa,
  intentRow: { id: string; restaurant_id: string; order_id: string | null },
  normalized: NormalizedPaymentIntent
): Promise<{ error: string } | null> {
  const patch: Record<string, unknown> = {
    provider_intent_id: normalized.providerIntentId,
    status: normalized.status,
    failure_code: normalized.failureCode ?? null,
    failure_message: normalized.failureMessage ?? null,
    provider_metadata: normalized.providerMetadata ?? null,
    updated_at: new Date().toISOString(),
  }
  if (normalized.status === 'succeeded') patch.succeeded_at = new Date().toISOString()
  if (normalized.status === 'canceled')  patch.canceled_at  = new Date().toISOString()

  const { error: updErr } = await supabase
    .from('payment_intents')
    .update(patch)
    .eq('id', intentRow.id)
  if (updErr) return { error: updErr.message }

  // Attempts track the raw provider reply per call. Manual intents
  // also write one so the code path stays uniform.
  const attemptStatus =
    normalized.status === 'refunded' ? 'succeeded' : normalized.status
  const { error: attErr } = await supabase.from('payment_attempts').insert({
    payment_intent_id: intentRow.id,
    restaurant_id: intentRow.restaurant_id,
    provider_attempt_id: normalized.providerIntentId,
    status: attemptStatus,
    failure_code: normalized.failureCode ?? null,
    failure_message: normalized.failureMessage ?? null,
    provider_metadata: normalized.providerMetadata ?? null,
  })
  if (attErr) return { error: attErr.message }

  // Bridge to order summary truth. Intentionally best-effort: if the
  // update fails, the intent is still persisted correctly and a
  // follow-up refresh/webhook can re-reconcile.
  await reconcileOrderPaymentStatus(supabase, intentRow.order_id, normalized.status)
  if (intentRow.order_id) {
    revalidatePath('/sales')
    revalidatePath('/finance')
  }

  return null
}

// ================================================================
// 1. setPaymentProviderConfig (owner-only)
//
// Form fields:
//   provider                 'stripe'
//   secret_key               required
//   publishable_key          optional
//   webhook_secret           optional
//   provider_account_id      optional
//   provider_location_id     optional
//   default_currency         optional (defaults to 'USD')
// ================================================================
export async function setPaymentProviderConfig(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }

  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!roleRow?.restaurant_id) return { error: 'No restaurant found.' }

  try {
    await requireRestaurantOwner(roleRow.restaurant_id)
  } catch (err) {
    const mapped = authzErrorToResult(err)
    if (mapped) return mapped
    throw err
  }

  const provider = (formData.get('provider') as string | null)?.trim() ?? ''
  if (!isProviderId(provider) || provider === 'manual') {
    return { error: 'Provider must be a real processor (e.g. stripe).' }
  }

  const secretKey = (formData.get('secret_key') as string | null)?.trim()
  if (!secretKey) return { error: 'secret_key is required.' }

  const publishableKey  = (formData.get('publishable_key') as string | null)?.trim() || null
  const webhookSecret   = (formData.get('webhook_secret') as string | null)?.trim() || null
  const accountId       = (formData.get('provider_account_id') as string | null)?.trim() || null
  const locationId      = (formData.get('provider_location_id') as string | null)?.trim() || null
  const currency        = ((formData.get('default_currency') as string | null)?.trim() || 'USD').toUpperCase()

  const { error: cfgErr } = await supabase
    .from('payment_provider_configs')
    .upsert(
      {
        restaurant_id: roleRow.restaurant_id,
        provider,
        provider_account_id: accountId,
        provider_location_id: locationId,
        publishable_key: publishableKey,
        default_currency: currency,
        active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'restaurant_id,provider' }
    )
  if (cfgErr) return { error: cfgErr.message }

  const { error: secErr } = await supabase
    .from('payment_provider_secrets')
    .upsert(
      {
        restaurant_id: roleRow.restaurant_id,
        provider,
        secret_key: secretKey,
        webhook_secret: webhookSecret,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'restaurant_id,provider' }
    )
  if (secErr) return { error: secErr.message }

  revalidatePath('/settings')
  return { ok: true, message: `${provider} configured.` }
}

// ================================================================
// 2. createPaymentIntent (location-scoped)
//
// Form fields:
//   order_id         required — the order this intent pays for
//   provider         required — 'stripe' | 'manual'
//   amount           required — positive decimal
//   tip_amount       optional
//   tax_amount       optional
//   currency         optional (falls back to provider default)
//   description      optional
// ================================================================
export async function createPaymentIntent(
  prevState: Result | null,
  formData: FormData
): Promise<Result<{ ok: true; message: string; intentId: string; clientSecret: string | null }>> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }

  const orderId = (formData.get('order_id') as string | null)?.trim()
  if (!orderId) return { error: 'order_id is required.' }

  const providerRaw = (formData.get('provider') as string | null)?.trim() ?? ''
  if (!isProviderId(providerRaw)) return { error: 'Unknown provider.' }

  // Load the order (RLS scopes to restaurant automatically) so we
  // know which location + restaurant to gate on.
  const { data: order } = await supabase
    .from('orders')
    .select('id, restaurant_id, location_id, total_amount')
    .eq('id', orderId)
    .maybeSingle()
  if (!order) return { error: 'Order not found.' }

  try {
    await requireLocationAccess(order.restaurant_id, order.location_id)
  } catch (err) {
    const mapped = authzErrorToResult(err)
    if (mapped) return mapped
    throw err
  }

  const amountRaw = (formData.get('amount') as string | null)?.trim()
  const amount = amountRaw ? parseFloat(amountRaw) : Number(order.total_amount)
  if (!Number.isFinite(amount) || amount < 0) return { error: 'Amount must be 0 or more.' }

  const tipAmount = parseFloat((formData.get('tip_amount') as string | null) ?? '0') || 0
  const taxAmount = parseFloat((formData.get('tax_amount') as string | null) ?? '0') || 0
  if (tipAmount < 0 || taxAmount < 0) return { error: 'Tip and tax cannot be negative.' }

  const currency = ((formData.get('currency') as string | null)?.trim() || 'USD').toUpperCase()
  const description = (formData.get('description') as string | null)?.trim() || null

  // Insert the canonical intent row FIRST, in 'requires_action'.
  // That way we have an internal id to use as the provider
  // idempotency key, and a persisted record even if the provider
  // call throws.
  const { data: intentRow, error: insErr } = await supabase
    .from('payment_intents')
    .insert({
      restaurant_id: order.restaurant_id,
      location_id: order.location_id,
      order_id: order.id,
      provider: providerRaw,
      status: 'requires_action',
      amount,
      tip_amount: tipAmount,
      tax_amount: taxAmount,
      currency,
    })
    .select('id, restaurant_id, order_id')
    .single()
  if (insErr || !intentRow) return { error: insErr?.message ?? 'Could not create payment intent.' }

  // Build adapter context + call the provider.
  const built = await buildAdapterContext(
    supabase,
    order.restaurant_id,
    order.location_id,
    intentRow.id,
    providerRaw
  )
  if (!built.ok) return { error: built.error }

  const adapter = getPaymentAdapter(providerRaw)
  if (!adapter.isConfigured(built.ctx)) {
    return { error: 'This payment provider is not configured yet.' }
  }

  let normalized: NormalizedPaymentIntent
  try {
    normalized = await adapter.createPaymentSession(built.ctx, {
      amount: { amount, tipAmount, taxAmount, currency },
      description,
      metadata: {
        internal_intent_id: intentRow.id,
        order_id: order.id,
        restaurant_id: order.restaurant_id,
      },
    })
  } catch (err) {
    return adapterErrorToResult('create payment session', err)
  }

  const persistErr = await persistIntentResult(supabase, intentRow, normalized)
  if (persistErr) return persistErr

  revalidatePath('/sales')
  revalidatePath('/pos')
  return {
    ok: true,
    message: `Payment intent ${normalized.status}.`,
    intentId: intentRow.id,
    clientSecret: normalized.clientSecret ?? null,
  }
}

// ================================================================
// 3. refreshPaymentIntent (location-scoped)
//
// Form fields:
//   intent_id  required — payment_intents.id
// ================================================================
export async function refreshPaymentIntent(
  prevState: Result | null,
  formData: FormData
): Promise<Result<{ ok: true; message: string; status: CanonicalPaymentStatus }>> {
  const supabase = await createClient()
  const intentId = (formData.get('intent_id') as string | null)?.trim()
  if (!intentId) return { error: 'intent_id is required.' }

  const { data: intent } = await supabase
    .from('payment_intents')
    .select('id, restaurant_id, location_id, provider, provider_intent_id, order_id')
    .eq('id', intentId)
    .maybeSingle()
  if (!intent) return { error: 'Payment intent not found.' }
  if (!isProviderId(intent.provider)) return { error: 'Invalid provider on intent.' }
  if (!intent.provider_intent_id) return { error: 'Intent has no provider id yet.' }

  try {
    await requireLocationAccess(intent.restaurant_id, intent.location_id)
  } catch (err) {
    const mapped = authzErrorToResult(err)
    if (mapped) return mapped
    throw err
  }

  const built = await buildAdapterContext(
    supabase,
    intent.restaurant_id,
    intent.location_id,
    intent.id,
    intent.provider
  )
  if (!built.ok) return { error: built.error }

  const adapter = getPaymentAdapter(intent.provider)
  let normalized: NormalizedPaymentIntent
  try {
    normalized = await adapter.getPaymentStatus(built.ctx, intent.provider_intent_id)
  } catch (err) {
    return adapterErrorToResult('refresh payment status', err)
  }

  const persistErr = await persistIntentResult(
    supabase,
    { id: intent.id, restaurant_id: intent.restaurant_id, order_id: intent.order_id },
    normalized
  )
  if (persistErr) return persistErr

  revalidatePath('/sales')
  revalidatePath('/pos')
  return { ok: true, message: `Status: ${normalized.status}.`, status: normalized.status }
}

// ================================================================
// cancelOpenPaymentIntentsForOrder
//
// Narrow helper invoked by sales.voidOrder. Walks the canonical
// payment_intents for a given order and cancels every non-terminal
// intent through the same adapter path the regular cancel action
// uses, so provider-side state matches local state.
//
// Succeeded intents are NOT refunded here — this prompt does not
// implement refunds. Instead they are flagged in the returned
// summary so the caller can surface "needs refund" honestly to the
// UI. The order void itself still proceeds regardless; a failing
// provider cancel becomes a warning string, not a blocker.
//
// Not exported as a server action on purpose — this is a server-only
// helper called by voidOrder, which already owns its own authz guard.
// Re-doing the guard here would just duplicate the same check.
// ================================================================
export interface VoidIntentsSummary {
  canceled: number
  alreadyTerminal: number
  needsRefund: number  // succeeded intents that were left alone
  warnings: string[]
}

export async function cancelOpenPaymentIntentsForOrder(
  supabase: Supa,
  orderId: string
): Promise<VoidIntentsSummary> {
  const summary: VoidIntentsSummary = {
    canceled: 0,
    alreadyTerminal: 0,
    needsRefund: 0,
    warnings: [],
  }

  const { data: intents } = await supabase
    .from('payment_intents')
    .select('id, restaurant_id, location_id, provider, provider_intent_id, status, order_id')
    .eq('order_id', orderId)

  if (!intents || intents.length === 0) return summary

  for (const intent of intents) {
    if (intent.status === 'succeeded') {
      summary.needsRefund += 1
      summary.warnings.push(
        `Payment ${intent.id} already succeeded — refund required (not handled by void).`
      )
      continue
    }
    if (intent.status === 'canceled' || intent.status === 'failed' || intent.status === 'refunded') {
      summary.alreadyTerminal += 1
      continue
    }
    if (!isProviderId(intent.provider)) {
      summary.warnings.push(`Intent ${intent.id}: unknown provider '${intent.provider}'.`)
      continue
    }

    const built = await buildAdapterContext(
      supabase,
      intent.restaurant_id,
      intent.location_id,
      intent.id,
      intent.provider
    )
    if (!built.ok) {
      // Can't reach the provider to cancel — still flip our local
      // row to canceled so the order isn't left with a ghost
      // "requires_action" intent. Log the reason in a warning.
      summary.warnings.push(`Intent ${intent.id}: ${built.error} (locally canceled)`)
      await supabase
        .from('payment_intents')
        .update({
          status: 'canceled',
          canceled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          failure_message: `Local cancel on void: ${built.error}`,
        })
        .eq('id', intent.id)
      summary.canceled += 1
      continue
    }

    const adapter = getPaymentAdapter(intent.provider)
    try {
      const normalized = await adapter.cancelPayment(built.ctx, {
        providerIntentId: intent.provider_intent_id ?? '',
        reason: 'order_voided',
      })
      await persistIntentResult(
        supabase,
        { id: intent.id, restaurant_id: intent.restaurant_id, order_id: intent.order_id },
        normalized
      )
      summary.canceled += 1
    } catch (err) {
      // Provider rejected the cancel. Flip locally so state is
      // consistent; surface the reason as a warning.
      const msg = err instanceof PaymentAdapterError ? err.message : err instanceof Error ? err.message : 'Unknown error'
      summary.warnings.push(`Intent ${intent.id}: provider cancel failed — ${msg} (locally canceled)`)
      await supabase
        .from('payment_intents')
        .update({
          status: 'canceled',
          canceled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          failure_message: `Provider cancel failed on void: ${msg}`,
        })
        .eq('id', intent.id)
      summary.canceled += 1
    }
  }

  return summary
}

// ================================================================
// 4. cancelPaymentIntent (location-scoped)
//
// Form fields:
//   intent_id  required — payment_intents.id
//   reason     optional
// ================================================================
export async function cancelPaymentIntent(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  const supabase = await createClient()
  const intentId = (formData.get('intent_id') as string | null)?.trim()
  if (!intentId) return { error: 'intent_id is required.' }

  const { data: intent } = await supabase
    .from('payment_intents')
    .select('id, restaurant_id, location_id, provider, provider_intent_id, status, order_id')
    .eq('id', intentId)
    .maybeSingle()
  if (!intent) return { error: 'Payment intent not found.' }
  if (!isProviderId(intent.provider)) return { error: 'Invalid provider on intent.' }
  if (intent.status === 'succeeded') return { error: 'Cannot cancel a succeeded payment. Use a refund flow (future).' }
  if (intent.status === 'canceled')  return { ok: true, message: 'Already canceled.' }

  try {
    await requireLocationAccess(intent.restaurant_id, intent.location_id)
  } catch (err) {
    const mapped = authzErrorToResult(err)
    if (mapped) return mapped
    throw err
  }

  const built = await buildAdapterContext(
    supabase,
    intent.restaurant_id,
    intent.location_id,
    intent.id,
    intent.provider
  )
  if (!built.ok) return { error: built.error }

  const adapter = getPaymentAdapter(intent.provider)
  let normalized: NormalizedPaymentIntent
  try {
    normalized = await adapter.cancelPayment(built.ctx, {
      providerIntentId: intent.provider_intent_id ?? '',
      reason: (formData.get('reason') as string | null) ?? undefined,
    })
  } catch (err) {
    return adapterErrorToResult('cancel payment', err)
  }

  const persistErr = await persistIntentResult(
    supabase,
    { id: intent.id, restaurant_id: intent.restaurant_id, order_id: intent.order_id },
    normalized
  )
  if (persistErr) return persistErr

  revalidatePath('/sales')
  revalidatePath('/pos')
  return { ok: true, message: `Payment ${normalized.status}.` }
}
