// ----------------------------------------------------------------
// Server-side checkout: validate the cart + form, resolve delivery
// option, calculate total, dispatch to the site's payment adapter,
// create orders row + site_orders_link, clear the cart. Returns
// either a hosted-checkout URL (redirect the buyer to the
// provider's payment page) or the created order id (fall back to
// the deferred-payment /thanks flow when the adapter's hosted
// checkout is unavailable / stubbed).
//
// Total = cart subtotal + delivery cost. Delivery option is looked
// up in sites.config.delivery_options by key; unknown key rejects
// the checkout rather than silently charging a wrong amount.
//
// Web orders leave `order_items` empty on purpose — the full
// denormalized cart, plus buyer/delivery/notes/opt-in, live on
// `site_orders_link`.
// ----------------------------------------------------------------

import { createAdminClient } from '@/lib/supabase/admin'
import { loadCartWithItems, type CartSnapshot } from './cart'
import { resolvePaymentAdapter } from './payment'
import type { SiteRow, SiteDeliveryOption } from './types'

type Admin = ReturnType<typeof createAdminClient>

export interface CheckoutInput {
  contact: {
    email: string
    first_name: string
    last_name: string
    phone?: string
  }
  delivery_option_key: string
  shipping?: {
    line1: string
    line2?: string
    city: string
    state: string
    postal: string
    country: string
  }
  billing_same?: boolean
  notes?: string
  opt_in_marketing?: boolean
}

export type CheckoutResult =
  | { orderId: string; paymentStatus: 'paid' | 'unpaid'; note?: string; hostedUrl?: string }
  | { error: string }

export async function performCheckout(
  site: SiteRow,
  sessionId: string | null,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const fullName = `${input.contact.first_name} ${input.contact.last_name}`.trim()
  if (!input.contact.first_name || !input.contact.last_name) return { error: 'Full name is required.' }
  if (!input.contact.email) return { error: 'Email is required.' }
  if (!sessionId) return { error: 'Your cart session expired — please add items again.' }

  const cart = await loadCartWithItems(site.id, sessionId)
  if (cart.items.length === 0) return { error: 'Your cart is empty.' }

  const config = (site.config ?? {}) as Record<string, unknown>
  const deliveryOption = resolveDeliveryOption(config, input.delivery_option_key)
  if (!deliveryOption) return { error: 'Please choose a delivery option.' }

  if (deliveryOption.requires_address) {
    if (!input.shipping || !input.shipping.line1 || !input.shipping.city || !input.shipping.state || !input.shipping.postal) {
      return { error: 'Shipping address is required for this delivery option.' }
    }
  }

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

  const total = round2(cart.subtotal + deliveryOption.price)

  // Skip the (stubbed) direct authorize call — for the deferred-
  // payment MVP, the adapter always returns 'pending' anyway and
  // the real work is either the future hosted-checkout redirect or
  // an out-of-band email. Save the order first, then attempt
  // hosted checkout, then fall back to unpaid.
  const buyer = { name: fullName, email: input.contact.email, phone: input.contact.phone }

  const { data: order, error: orderErr } = await admin
    .from('orders')
    .insert({
      restaurant_id: site.restaurant_id,
      location_id: locationId,
      total_amount: total,
      source: 'web',
      payment_type: 'card',
      payment_status: 'unpaid',
      status: 'completed',
      customer_name: fullName,
      channel_source: providerName ?? 'web',
      note: input.notes ?? null,
    })
    .select('id')
    .single()

  if (orderErr || !order) {
    console.error('[checkout] order insert failed', orderErr)
    return { error: `Could not save your order: ${orderErr?.message ?? 'unknown error'}` }
  }

  const orderId = order.id as string

  // Try the hosted-checkout URL flow. When the adapter returns a
  // URL, redirect the buyer there; the provider's callback (a
  // follow-up webhook we haven't wired yet) marks the order paid.
  // When unavailable (current stub for GoDaddy), leave the order
  // unpaid and route to /thanks with the email-link message.
  let hostedUrl: string | undefined
  if (adapter.createHostedCheckout) {
    const successUrl = `https://${site.slug}.onchecked.app/thanks?order=${encodeURIComponent(orderId)}`
    const cancelUrl = `https://${site.slug}.onchecked.app/checkout?checkout_error=${encodeURIComponent('Payment cancelled — your order is still saved.')}`
    const hosted = await adapter.createHostedCheckout({
      siteId: site.id,
      restaurantId: site.restaurant_id,
      orderId,
      amount: total,
      currency: 'USD',
      buyer,
      successUrl,
      cancelUrl,
    })
    if ('url' in hosted) hostedUrl = hosted.url
    else console.info('[checkout] hosted checkout unavailable', { orderId, reason: hosted.reason })
  }

  await writeSiteLink(admin, {
    siteId: site.id,
    orderId,
    sessionId,
    cart,
    contact: {
      name: fullName,
      first_name: input.contact.first_name,
      last_name: input.contact.last_name,
      email: input.contact.email,
      phone: input.contact.phone ?? null,
      opted_in_marketing: input.opt_in_marketing === true,
    },
    shipping: deliveryOption.requires_address ? input.shipping ?? null : null,
    delivery: {
      key: deliveryOption.key,
      label: deliveryOption.label,
      price: deliveryOption.price,
    },
    notes: input.notes ?? null,
    billingSame: input.billing_same === true,
    providerName,
    paymentReference: null,
  })

  await clearCart(admin, site.id, sessionId)

  return {
    orderId,
    paymentStatus: 'unpaid',
    note: hostedUrl ? undefined : 'Online payment pending — the merchant will email a secure payment link within one business day.',
    hostedUrl,
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

function resolveDeliveryOption(config: Record<string, unknown>, key: string): SiteDeliveryOption | null {
  if (!key) return null
  const raw = config.delivery_options
  if (!Array.isArray(raw)) return null
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Partial<SiteDeliveryOption>
    if (o.key === key && typeof o.label === 'string' && typeof o.price === 'number') {
      return {
        key: o.key,
        label: o.label,
        sublabel: typeof o.sublabel === 'string' ? o.sublabel : undefined,
        note: typeof o.note === 'string' ? o.note : undefined,
        price: o.price,
        requires_address: o.requires_address === true,
        default: o.default === true,
      }
    }
  }
  return null
}

interface LinkWriteArgs {
  siteId: string
  orderId: string
  sessionId: string
  cart: CartSnapshot
  contact: Record<string, unknown>
  shipping: CheckoutInput['shipping'] | null
  delivery: { key: string; label: string; price: number }
  notes: string | null
  billingSame: boolean
  providerName: string | null
  paymentReference: string | null
}

async function writeSiteLink(admin: Admin, args: LinkWriteArgs): Promise<void> {
  const { error } = await admin
    .from('site_orders_link')
    .insert({
      site_id: args.siteId,
      order_id: args.orderId,
      session_id: args.sessionId,
      cart: {
        ...args.cart,
        delivery: args.delivery,
        billing_same: args.billingSame,
        notes: args.notes,
      },
      contact: args.contact,
      shipping: args.shipping ?? null,
      payment_provider: args.providerName,
      payment_reference: args.paymentReference,
    })
  if (error) {
    console.error('[checkout] site_orders_link insert failed', { orderId: args.orderId, error })
  }
}

async function clearCart(admin: Admin, siteId: string, sessionId: string): Promise<void> {
  const { error } = await admin
    .from('site_carts')
    .update({ items: [], updated_at: new Date().toISOString() })
    .eq('site_id', siteId)
    .eq('session_id', sessionId)
  if (error) console.warn('[checkout] cart clear failed', error)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
