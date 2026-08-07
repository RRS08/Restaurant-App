// ----------------------------------------------------------------
// Server-side checkout: validate the cart, dispatch to the site's
// payment adapter, materialize an orders row + site_orders_link,
// clear the cart. Provider-agnostic — the adapter interface hides
// the per-provider mechanics.
//
// Ordering matters: we call the payment adapter BEFORE creating
// the order row. A payment 'failed' result never writes an order.
// A 'pending' result (stub adapter, async payment link, whatever)
// writes the order as unpaid and stores the provider's context on
// the link row so a follow-up reconciliation can mark it paid.
//
// Web orders leave `order_items` empty on purpose — the full
// denormalized cart is on `site_orders_link.cart`. Menu/inventory
// stay untouched per project rule ([[websites-project]]).
// ----------------------------------------------------------------

import { createAdminClient } from '@/lib/supabase/admin'
import { loadCartWithItems, type CartSnapshot } from './cart'
import { resolvePaymentAdapter } from './payment'
import type { SiteRow } from './types'

type Admin = ReturnType<typeof createAdminClient>

export interface CheckoutInput {
  contact: { name: string; email: string; phone?: string }
  shipping?: {
    line1: string
    line2?: string
    city: string
    state: string
    postal: string
    country: string
  }
}

export type CheckoutResult =
  | { orderId: string; paymentStatus: 'paid' | 'unpaid'; note?: string }
  | { error: string }

export async function performCheckout(
  site: SiteRow,
  sessionId: string | null,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  if (!input.contact.name) return { error: 'Name is required.' }
  if (!input.contact.email) return { error: 'Email is required.' }
  if (!sessionId) return { error: 'Your cart session expired — please add items again.' }

  const cart = await loadCartWithItems(site.id, sessionId)
  if (cart.items.length === 0) return { error: 'Your cart is empty.' }

  const admin = createAdminClient()

  const locationId = await resolveWebOrderLocation(admin, site)
  if (!locationId) {
    return { error: 'No fulfillment location configured for this site.' }
  }

  const providerName = readPaymentProvider(site)
  const adapter = resolvePaymentAdapter(providerName)
  if (!adapter) {
    return { error: `No payment adapter registered for provider '${providerName ?? 'none'}'.` }
  }

  const authResult = await adapter.authorize({
    siteId: site.id,
    restaurantId: site.restaurant_id,
    amount: cart.subtotal,
    currency: 'USD',
    buyer: input.contact,
    cart: {
      items: cart.items.map(i => ({ slug: i.slug, qty: i.qty, name: i.name, price: i.price })),
      subtotal: cart.subtotal,
    },
    idempotencyKey: `site:${site.id}:session:${sessionId}`,
  })

  if (authResult.status === 'failed') {
    return { error: authResult.error }
  }

  const paymentStatus: 'paid' | 'unpaid' = authResult.status === 'paid' ? 'paid' : 'unpaid'
  const paymentReference = authResult.status === 'paid' ? authResult.reference : null
  const cardBrand = authResult.status === 'paid' ? authResult.cardBrand ?? null : null
  const cardLast4 = authResult.status === 'paid' ? authResult.cardLast4 ?? null : null
  const pendingNote = authResult.status === 'pending' ? authResult.note : null

  const { data: order, error: orderErr } = await admin
    .from('orders')
    .insert({
      restaurant_id: site.restaurant_id,
      location_id: locationId,
      total_amount: cart.subtotal,
      source: 'web',
      payment_type: 'card',
      payment_status: paymentStatus,
      status: 'completed',
      customer_name: input.contact.name,
      channel_source: providerName ?? 'web',
      card_brand: cardBrand,
      card_last4: cardLast4,
      note: pendingNote,
    })
    .select('id')
    .single()

  if (orderErr || !order) {
    console.error('[checkout] order insert failed', orderErr)
    return { error: `Could not save your order: ${orderErr?.message ?? 'unknown error'}` }
  }

  const orderId = order.id as string
  const linkRow = await writeSiteLink(admin, {
    siteId: site.id,
    orderId,
    sessionId,
    cart,
    contact: input.contact,
    shipping: input.shipping,
    providerName,
    paymentReference,
  })
  if (!linkRow) {
    // The order exists but the site link is missing. Log for
    // reconciliation; do NOT surface as an error to the buyer —
    // their order is captured and the merchant can still fulfill
    // via the orders table. The link is a convenience index.
    console.error('[checkout] site_orders_link write failed', { orderId })
  }

  await clearCart(admin, site.id, sessionId)

  return {
    orderId,
    paymentStatus,
    note: pendingNote ?? undefined,
  }
}

async function resolveWebOrderLocation(admin: Admin, site: SiteRow): Promise<string | null> {
  const config = (site.config ?? {}) as { web_order_location_id?: string }
  if (typeof config.web_order_location_id === 'string' && config.web_order_location_id.length > 0) {
    return config.web_order_location_id
  }
  const { data } = await admin
    .from('locations')
    .select('id')
    .eq('restaurant_id', site.restaurant_id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

function readPaymentProvider(site: SiteRow): string | null {
  const config = (site.config ?? {}) as { payment_provider?: unknown }
  return typeof config.payment_provider === 'string' ? config.payment_provider : null
}

async function writeSiteLink(admin: Admin, args: {
  siteId: string
  orderId: string
  sessionId: string
  cart: CartSnapshot
  contact: CheckoutInput['contact']
  shipping: CheckoutInput['shipping']
  providerName: string | null
  paymentReference: string | null
}): Promise<{ id: string } | null> {
  const { data, error } = await admin
    .from('site_orders_link')
    .insert({
      site_id: args.siteId,
      order_id: args.orderId,
      session_id: args.sessionId,
      cart: args.cart,
      contact: args.contact,
      shipping: args.shipping ?? null,
      payment_provider: args.providerName,
      payment_reference: args.paymentReference,
    })
    .select('id')
    .single()
  if (error) {
    console.error('[checkout] site_orders_link insert failed', error)
    return null
  }
  return { id: data.id as string }
}

async function clearCart(admin: Admin, siteId: string, sessionId: string): Promise<void> {
  const { error } = await admin
    .from('site_carts')
    .update({ items: [], updated_at: new Date().toISOString() })
    .eq('site_id', siteId)
    .eq('session_id', sessionId)
  if (error) console.warn('[checkout] cart clear failed', error)
}
