// ----------------------------------------------------------------
// Pickup order helpers — shared by the POS bubble, the sidebar
// badge, and the /orders drawer.
//
// A "pending pickup" is a web order where:
//   - source        = 'web'
//   - status        = 'completed' (not voided)
//   - business_date = today (in the restaurant's tz — the caller
//                     resolves this and passes the ISO date in
//                     so the query stays timezone-agnostic)
//   - fulfillment_state = 'new'
//   - the linked site_orders_link row has shipping IS NULL (pickup
//     option — a shipping address means delivery, which lives on
//     the online workspace but isn't the POS staff's problem)
//
// Kept in one place so the badge count and the popover list can't
// diverge from what /orders considers actionable. Every caller
// reads through here.
// ----------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'

export interface PendingPickup {
  id: string
  orderNumber: string
  createdAt: string
  totalAmount: number
  customerName: string | null
  itemsSummary: string
}

/** Bare count — used by the sidebar badge and the POS bubble's
 *  pill. One indexed query, no join to the cart snapshot. */
export async function countPendingPickups(
  supabase: SupabaseClient,
  restaurantId: string,
  businessDate: string,
): Promise<number> {
  const { count } = await supabase
    .from('orders')
    .select('id, site_orders_link!inner(shipping)', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
    .eq('source', 'web')
    .eq('status', 'completed')
    .eq('business_date', businessDate)
    .eq('fulfillment_state', 'new')
    .is('site_orders_link.shipping', null)
  return count ?? 0
}

/** Full list — used by the POS bubble popover. Enriched with a
 *  human item-summary ("Passiflora Night · Loose leaf · 3 oz")
 *  cobbled from the frozen cart snapshot so the counter person
 *  can scan the order without opening the drawer. */
export async function listPendingPickups(
  supabase: SupabaseClient,
  restaurantId: string,
  businessDate: string,
): Promise<PendingPickup[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('id, created_at, total_amount, customer_name, site_orders_link!inner(cart, shipping)')
    .eq('restaurant_id', restaurantId)
    .eq('source', 'web')
    .eq('status', 'completed')
    .eq('business_date', businessDate)
    .eq('fulfillment_state', 'new')
    .is('site_orders_link.shipping', null)
    .order('created_at', { ascending: true })
  if (error || !data) return []
  type Row = {
    id: string
    created_at: string
    total_amount: number | string
    customer_name: string | null
    site_orders_link: { cart: unknown; shipping: unknown } | Array<{ cart: unknown; shipping: unknown }>
  }
  return (data as Row[]).map(r => {
    // PostgREST returns the embedded row as either an object or a
    // one-element array depending on the FK cardinality. Normalize
    // so downstream logic doesn't care which form landed.
    const link = Array.isArray(r.site_orders_link) ? r.site_orders_link[0] : r.site_orders_link
    return {
      id: r.id,
      orderNumber: r.id.slice(0, 8).toUpperCase(),
      createdAt: r.created_at,
      totalAmount: typeof r.total_amount === 'number' ? r.total_amount : parseFloat(String(r.total_amount)),
      customerName: r.customer_name,
      itemsSummary: summarizeCart(link?.cart),
    }
  })
}

/** One-line item summary. Uses variant labels when present so
 *  "Passiflora Night · Tea bags · 30 ct" reads as one line the
 *  counter person can quickly scan for. */
function summarizeCart(cart: unknown): string {
  if (!cart || typeof cart !== 'object') return ''
  const items = (cart as { items?: unknown }).items
  if (!Array.isArray(items)) return ''
  const parts: string[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const it = raw as { name?: unknown; qty?: unknown; variant_label?: unknown }
    if (typeof it.name !== 'string') continue
    const qty = typeof it.qty === 'number' && it.qty > 1 ? ` × ${it.qty}` : ''
    const variant = typeof it.variant_label === 'string' && it.variant_label.length > 0
      ? ` (${it.variant_label})`
      : ''
    parts.push(`${it.name}${qty}${variant}`)
  }
  return parts.join(', ')
}
