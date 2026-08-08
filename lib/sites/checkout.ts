// ----------------------------------------------------------------
// Server-side checkout: validate form + cart, resolve delivery,
// calculate total, dispatch to the site's payment adapter, then
// materialize the orders row + site_orders_link. Cart clears last.
//
// Ordering matters:
//   1. validate everything cheap first (name, email, cart, delivery)
//   2. call adapter.authorize() with the client-side nonce — if the
//      card is declined we bail BEFORE writing any DB row. No
//      phantom orders for failed charges.
//   3. on 'paid' or 'pending' we write orders + link + clear cart.
//
// 'pending' happens when the merchant has GODADDY_POYNT_APP_ID
// unset or hasn't linked GoDaddy Commerce — adapter returns
// pending, order lands unpaid with the "email a payment link" note.
// 'failed' bounces the buyer back to /checkout with the reason.
//
// Web orders leave `order_items` empty on purpose — full receipt
// lives on site_orders_link.cart.
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
  /** Buyer's name as printed on the card. Captured on step 3 next
   *  to the Poynt Collect iframe so the merchant has it for chargeback
   *  disputes — Poynt itself does not surface this from the token. */
  cardholder_name?: string
  /** Billing address for card verification. Only populated when the
   *  buyer unchecks "Billing address is the same as delivery"; when
   *  billing_same is true these stay undefined and the merchant uses
   *  the shipping address instead. */
  billing?: {
    line1: string
    line2?: string
    city: string
    state: string
    postal: string
  }
  notes?: string
  opt_in_marketing?: boolean
  /** Card nonce from Poynt Collect (or equivalent) on the client.
   *  Missing nonce → adapter returns pending → order saves unpaid. */
  nonce?: string
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
  // Widget captures a single Full-name field and the endpoint splits
  // it on the first space; either half may be empty for buyers with
  // a single-word name (mononym) or who type just their first name.
  // Requiring the joined value keeps us from writing empty rows
  // without forcing everyone to fabricate a last name.
  if (!fullName) return { error: 'Please enter your name.' }
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
  if (!locationId) return { error: 'No fulfillment location configured for this site.' }

  const providerName = readPaymentProvider(site)
  const adapter = resolvePaymentAdapter(providerName)
  if (!adapter) {
    return { error: `No payment adapter registered for provider '${providerName ?? 'none'}'.` }
  }

  // Tax applied to (subtotal + delivery). Site config carries the
  // rate as a decimal (0.0825 = 8.25%). Missing config = 0 = no tax.
  // Client-side widget uses the same formula, so the amount buyer
  // sees on the Place order button is exactly what we charge.
  const taxRate = readSiteTaxRate(site)
  const taxAmount = round2((cart.subtotal + deliveryOption.price) * taxRate)
  const total = round2(cart.subtotal + deliveryOption.price + taxAmount)
  const buyer = { name: fullName, email: input.contact.email, phone: input.contact.phone }
  const idempotencyKey = `site:${site.id}:session:${sessionId}:v2`
  const env = readSitePaymentEnv(site)

  // Authorize FIRST. A failed charge never writes an order.
  const authResult = await adapter.authorize({
    siteId: site.id,
    restaurantId: site.restaurant_id,
    amount: total,
    currency: 'USD',
    buyer,
    cart: {
      items: cart.items.map(i => ({ slug: i.slug, qty: i.qty, name: i.name, price: i.price })),
      subtotal: cart.subtotal,
    },
    idempotencyKey,
    nonce: input.nonce,
    env,
    taxAmount,
    // orderReference is populated post-hoc for reconciliation
    // — Poynt lets us reference the txn later without our order
    // id since idempotencyKey uniquely identifies the attempt.
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
      total_amount: total,
      subtotal: cart.subtotal,
      tax_total: taxAmount > 0 ? taxAmount : null,
      source: 'web',
      payment_type: 'card',
      payment_status: paymentStatus,
      status: 'completed',
      customer_name: fullName,
      channel_source: providerName ?? 'web',
      card_brand: cardBrand,
      card_last4: cardLast4,
      note: pendingNote ?? input.notes ?? null,
    })
    .select('id')
    .single()

  if (orderErr || !order) {
    console.error('[checkout] order insert failed', orderErr)
    // If we got here after a real charge, the merchant will see the
    // transaction on Poynt's side without a matching orders row —
    // manual reconciliation. Log loud enough to catch this.
    if (paymentStatus === 'paid') {
      console.error('[checkout] ORPHAN CHARGE — reconcile Poynt txn against site_orders_link', {
        siteId: site.id,
        paymentReference,
      })
    }
    return { error: `Could not save your order: ${orderErr?.message ?? 'unknown error'}` }
  }

  const orderId = order.id as string

  const billingSame = input.billing_same !== false
  const billingAddress = billingSame ? null : (input.billing ?? null)

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
      cardholder_name: input.cardholder_name?.trim() || null,
      billing_address: billingAddress,
    },
    shipping: deliveryOption.requires_address ? input.shipping ?? null : null,
    delivery: {
      key: deliveryOption.key,
      label: deliveryOption.label,
      price: deliveryOption.price,
    },
    notes: input.notes ?? null,
    billingSame,
    providerName,
    paymentReference,
  })

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

/** Which provider environment this site charges against. Default is
 *  'prod' — a site opts into sandbox by setting
 *  `sites.config.payment_env = 'ote'`. Value flows through the
 *  payment adapter → collect helpers → API base URL + token lookup.
 *  Never derived from a global env var; per-site keeps one site's
 *  sandbox mode from leaking into another site's live integration. */
function readSitePaymentEnv(site: SiteRow): 'prod' | 'ote' {
  const config = (site.config ?? {}) as { payment_env?: unknown }
  return config.payment_env === 'ote' ? 'ote' : 'prod'
}

/** Site sales-tax rate as a decimal (0.0825 = 8.25%). Missing /
 *  invalid = 0 = no tax. Applied server-side to (subtotal +
 *  delivery) in performCheckout so the client-side widget's
 *  computed total matches what we actually charge — same formula
 *  runs in the widget's applyDelivery. */
function readSiteTaxRate(site: SiteRow): number {
  const config = (site.config ?? {}) as { tax_rate?: unknown }
  const raw = config.tax_rate
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  if (typeof raw === 'string') {
    const parsed = parseFloat(raw)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return 0
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
