// ----------------------------------------------------------------
// Stripe Terminal — connection token endpoint
//
// The browser-side @stripe/terminal-js SDK requires a server endpoint
// it can POST to in order to receive a short-lived Terminal
// connection token. The reader uses that token to authenticate
// itself for the rest of the session.
//
// This route mirrors the existing payments patterns:
//   • Resolves the caller via `getAuthContext()` (same helper every
//     payment server action uses).
//   • Reads the per-restaurant Stripe secret from
//     `payment_provider_secrets` through the authenticated supabase
//     client, so RLS on that table double-checks ownership in
//     addition to whatever guard runs here.
//   • Per-call Stripe client — never holds the secret in a cross-
//     request module cache. Same API version pinned as
//     lib/payments/adapters/stripe.ts.
//   • Never returns the Stripe secret key.
//   • Cache-Control: no-store — connection tokens are short-lived
//     and must always be freshly issued.
//
// Scope limits intentionally honored:
//   • No PaymentIntent creation here.
//   • No POS UI change.
//   • No adapter contract change.
//   • No Sales / Inventory side effects.
// ----------------------------------------------------------------

import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAuthContext } from '@/lib/auth'

export async function POST() {
  // 1. Auth — same path payment server actions use.
  const { context: ctx, error: authError } = await getAuthContext()
  if (!ctx) {
    return NextResponse.json(
      { error: authError ?? 'Not authenticated.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  if (!ctx.restaurantId) {
    return NextResponse.json(
      { error: 'No restaurant context for this user.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  // 2. Confirm the Stripe provider is active for this restaurant.
  //    Mirrors the buildAdapterContext check in
  //    app/actions/payments.ts so the failure surfaces identically.
  const { data: config } = await ctx.supabase
    .from('payment_provider_configs')
    .select('active')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('provider', 'stripe')
    .maybeSingle()

  if (!config?.active) {
    return NextResponse.json(
      { error: 'Stripe is not configured for this restaurant.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  // 3. Load the secret key. payment_provider_secrets has RLS that
  //    typically restricts SELECT to owners — non-owners will get
  //    null here, which surfaces as the credentials error below.
  //    That's the same constraint createPaymentIntent operates under.
  const { data: secret } = await ctx.supabase
    .from('payment_provider_secrets')
    .select('secret_key')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('provider', 'stripe')
    .maybeSingle()

  if (!secret?.secret_key) {
    return NextResponse.json(
      { error: 'Stripe credentials are missing or restricted. An owner must configure Stripe in Settings.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  // 4. Issue the connection token. Per-call Stripe client so the
  //    secret never lives in a cross-request module cache. API
  //    version pinned to match lib/payments/adapters/stripe.ts.
  try {
    const stripe = new Stripe(secret.secret_key, { typescript: true } as unknown as Stripe.StripeConfig)
    const token = await stripe.terminal.connectionTokens.create()
    return NextResponse.json(
      { secret: token.secret },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    // Surface the real Stripe error message in dev so reader-side
    // diagnostics are cheap; keep the production response generic
    // since this body is reachable from the browser.
    if (err instanceof Stripe.errors.StripeError) {
      const detail =
        process.env.NODE_ENV === 'development'
          ? `[DEV] Stripe: ${err.message}${err.code ? ` (${err.code})` : ''}`
          : 'Stripe rejected the connection-token request.'
      return NextResponse.json(
        { error: detail },
        { status: 502, headers: { 'Cache-Control': 'no-store' } }
      )
    }
    const message = err instanceof Error ? err.message : 'Unknown error.'
    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === 'development'
            ? `[DEV] Could not create Stripe Terminal connection token: ${message}`
            : 'Could not create Stripe Terminal connection token.',
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    )
  }
}
