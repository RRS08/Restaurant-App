// ----------------------------------------------------------------
// /orders — web-order ledger for the online workspace.
//
// Server component. Fetches today's web orders + the linked
// site_orders_link snapshot so every row carries its channel
// (pickup vs delivery) and its item list without a second round
// trip. The client then handles filtering, drawer state, and
// wiring the Mark-ready action.
//
// Nav item lives under the Online workspace but this page renders
// under any active place — a direct URL hit still works. All
// filtering is scoped to the operator's restaurant.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { businessDateInTimezone } from '@/lib/sales/business-date'
import { getLang } from '@/lib/i18n-server'
import OrdersClient, { type OrderRow } from './client'
import ComingSoon from '@/components/coming-soon'

export const metadata = { title: 'Orders · Checked' }

interface OrdersPageProps {
  // Next.js 16 hands searchParams as a Promise; must await.
  searchParams?: Promise<{ date?: string }>
}

export default async function OrdersPage({ searchParams }: OrdersPageProps) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return <ComingSoon eyebrow="ORDERS" title="Sign in required" body="You need to be signed in to view orders." />

  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role) return <ComingSoon eyebrow="ORDERS" title="No restaurant" body="Finish onboarding to see orders." />

  const admin = createAdminClient()

  // Business date resolved off the first retail location's tz so
  // the "today" bucket matches what web checkouts stamp.
  const { data: tzRow } = await admin
    .from('locations')
    .select('timezone')
    .eq('restaurant_id', role.restaurant_id)
    .order('created_at')
    .limit(1)
    .maybeSingle()
  const today = businessDateInTimezone(new Date(), (tzRow?.timezone as string | null | undefined) ?? null)

  // Requested day: ?date=YYYY-MM-DD, sanitized. Malformed / future
  // dates fall back to today so a stray URL can't crash the page.
  const rawDate = (await searchParams)?.date
  const requestedDate =
    typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : today

  const { data: rows } = await admin
    .from('orders')
    .select(`
      id, total_amount, subtotal, tax_total, discount_total,
      created_at, status, fulfillment_state, ready_at,
      customer_name, card_brand, card_last4, note, business_date,
      site_orders_link!inner(cart, contact, shipping, payment_provider, payment_reference)
    `)
    .eq('restaurant_id', role.restaurant_id)
    .eq('source', 'web')
    .eq('business_date', requestedDate)
    .order('created_at', { ascending: false })

  const lang = await getLang()

  type SupabaseRow = {
    id: string
    total_amount: number | string
    subtotal: number | string | null
    tax_total: number | string | null
    discount_total: number | string | null
    created_at: string
    status: string
    fulfillment_state: string
    ready_at: string | null
    customer_name: string | null
    card_brand: string | null
    card_last4: string | null
    note: string | null
    business_date: string
    site_orders_link: {
      cart: unknown
      contact: unknown
      shipping: unknown
      payment_provider: string | null
      payment_reference: string | null
    } | Array<{
      cart: unknown
      contact: unknown
      shipping: unknown
      payment_provider: string | null
      payment_reference: string | null
    }>
  }

  function toNum(v: number | string | null | undefined): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = parseFloat(v)
      return Number.isFinite(n) ? n : null
    }
    return null
  }

  const orders: OrderRow[] = ((rows ?? []) as SupabaseRow[]).map(r => {
    // PostgREST returns embedded rows as either an object or a
    // one-element array depending on the FK cardinality; normalize
    // here so downstream code doesn't need to care.
    const link = Array.isArray(r.site_orders_link) ? r.site_orders_link[0] : r.site_orders_link
    const shipping = (link?.shipping ?? null) as { line1?: string; line2?: string; city?: string; state?: string; postal?: string; country?: string } | null
    const hasShipping = !!(shipping && shipping.line1)
    const channel: 'pickup' | 'delivery' = hasShipping ? 'delivery' : 'pickup'
    const cart = link?.cart as {
      items?: Array<{ name?: string; qty?: number; variant_label?: string; line_total?: number }>
      delivery?: { key?: string; label?: string; price?: number; sublabel?: string }
      notes?: string
    } | null
    const contact = link?.contact as {
      email?: string
      phone?: string
      cardholder_name?: string
    } | null
    const items = (cart?.items ?? []).map(it => ({
      name: typeof it.name === 'string' ? it.name : '—',
      qty: typeof it.qty === 'number' ? it.qty : 1,
      variantLabel: typeof it.variant_label === 'string' ? it.variant_label : null,
      lineTotal: typeof it.line_total === 'number' ? it.line_total : 0,
    }))
    const deliveryFromCart = cart?.delivery ?? {}
    return {
      id: r.id,
      orderNumber: r.id.slice(0, 8).toUpperCase(),
      createdAt: r.created_at,
      total: toNum(r.total_amount) ?? 0,
      subtotal: toNum(r.subtotal),
      discountTotal: toNum(r.discount_total),
      taxTotal: toNum(r.tax_total),
      status: r.status === 'voided' ? 'voided' : 'completed',
      fulfillmentState: (r.fulfillment_state === 'ready' || r.fulfillment_state === 'completed')
        ? r.fulfillment_state
        : 'new',
      readyAt: r.ready_at,
      customerName: r.customer_name,
      channel,
      itemCount: items.reduce((s, i) => s + i.qty, 0),
      items,
      buyerEmail: contact?.email ?? null,
      buyerPhone: contact?.phone ?? null,
      cardholderName: contact?.cardholder_name ?? null,
      cardBrand: r.card_brand,
      cardLast4: r.card_last4,
      shipping: {
        line1: shipping?.line1 ?? null,
        line2: shipping?.line2 ?? null,
        city: shipping?.city ?? null,
        state: shipping?.state ?? null,
        postal: shipping?.postal ?? null,
        country: shipping?.country ?? null,
      },
      delivery: {
        key: typeof deliveryFromCart.key === 'string' ? deliveryFromCart.key : null,
        label: typeof deliveryFromCart.label === 'string' ? deliveryFromCart.label : null,
        price: typeof deliveryFromCart.price === 'number' ? deliveryFromCart.price : null,
        sublabel: typeof deliveryFromCart.sublabel === 'string' ? deliveryFromCart.sublabel : null,
      },
      note: typeof cart?.notes === 'string' ? cart.notes : (r.note ?? null),
      paymentProvider: link?.payment_provider ?? null,
      paymentReference: link?.payment_reference ?? null,
    }
  })

  return <OrdersClient lang={lang} orders={orders} date={requestedDate} today={today} />
}
