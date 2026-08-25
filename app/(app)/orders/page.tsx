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

export default async function OrdersPage() {
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

  const { data: rows } = await admin
    .from('orders')
    .select(`
      id, total_amount, created_at, status, fulfillment_state, ready_at,
      customer_name, business_date,
      site_orders_link!inner(cart, contact, shipping)
    `)
    .eq('restaurant_id', role.restaurant_id)
    .eq('source', 'web')
    .eq('business_date', today)
    .order('created_at', { ascending: false })

  const lang = await getLang()

  type SupabaseRow = {
    id: string
    total_amount: number | string
    created_at: string
    status: string
    fulfillment_state: string
    ready_at: string | null
    customer_name: string | null
    business_date: string
    site_orders_link: { cart: unknown; contact: unknown; shipping: unknown }
      | Array<{ cart: unknown; contact: unknown; shipping: unknown }>
  }

  const orders: OrderRow[] = ((rows ?? []) as SupabaseRow[]).map(r => {
    // PostgREST returns embedded rows as either an object or a
    // one-element array depending on the FK cardinality; normalize
    // here so downstream code doesn't need to care.
    const link = Array.isArray(r.site_orders_link) ? r.site_orders_link[0] : r.site_orders_link
    const shipping = link?.shipping as { line1?: string } | null
    const channel: 'pickup' | 'delivery' = shipping && shipping.line1 ? 'delivery' : 'pickup'
    const cart = link?.cart as { items?: Array<{ name?: string; qty?: number; variant_label?: string; line_total?: number }> } | null
    const contact = link?.contact as { email?: string; phone?: string } | null
    const items = (cart?.items ?? []).map(it => ({
      name: typeof it.name === 'string' ? it.name : '—',
      qty: typeof it.qty === 'number' ? it.qty : 1,
      variantLabel: typeof it.variant_label === 'string' ? it.variant_label : null,
      lineTotal: typeof it.line_total === 'number' ? it.line_total : 0,
    }))
    return {
      id: r.id,
      orderNumber: r.id.slice(0, 8).toUpperCase(),
      createdAt: r.created_at,
      total: typeof r.total_amount === 'number' ? r.total_amount : parseFloat(String(r.total_amount)),
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
      shippingLine1: shipping?.line1 ?? null,
    }
  })

  return <OrdersClient lang={lang} orders={orders} businessDate={today} />
}
