// ----------------------------------------------------------------
// Sales Page  →  /sales
//
// The review/history layer for the Sales backbone. Displays orders
// enriched with source, payment_type, payment_status, and status
// so the manager can distinguish manual entry, native POS, and
// (future) external POS orders at a glance.
//
// A completed order can be voided from here via the minimal
// correction workflow — see `voidOrder` in actions/sales.ts.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import { getOperatingMode } from '@/lib/readiness'
import SalesClient from './client'

export default async function SalesPage() {
  const supabase = await createClient()
  const lang = await getLang()

  // Resolve the caller's restaurant once so we can look up
  // operating_mode alongside the orders fetch. RLS still scopes the
  // orders query — we just need the restaurant id for the mode lookup.
  const { data: { user } } = await supabase.auth.getUser()
  let operatingMode: 'native_pos' | 'external_pos' | null = null
  if (user) {
    const { data: role } = await supabase
      .from('user_roles')
      .select('restaurant_id')
      .eq('user_id', user.id)
      .single()
    if (role?.restaurant_id) {
      operatingMode = await getOperatingMode(supabase, role.restaurant_id)
    }
  }

  // 50 most recent orders with their line items + location name.
  // RLS scopes by restaurant automatically.
  const { data: orders } = await supabase
    .from('orders')
    .select(`
      id, total_amount, created_at,
      source, payment_type, payment_status, status, note,
      subtotal, discount_total, tax_total,
      card_brand, card_last4, customer_name, channel_source,
      location_id,
      locations ( name ),
      order_items ( id, quantity, unit_price, total_price, variant_label, menu_items ( name ) )
    `)
    .order('created_at', { ascending: false })
    // Was 50 — too tight for merchants doing 20+ sales a day
    // (a couple of days of history vanishes off the bottom).
    // 500 covers ~2 weeks of a busy retail day at Hatziri's
    // volume; still a bounded read so a merchant with years of
    // orders doesn't ship megabytes to the browser. Proper
    // pagination is a phase-2 build if this ceiling gets hit.
    .limit(500)

  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const strOrNull = (v: unknown): string | null => {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    return s.length > 0 ? s : null
  }

  const normalized = (orders ?? []).map((o) => ({
    id: o.id,
    total: Number(o.total_amount),
    createdAt: o.created_at,
    source: (o.source ?? 'manual') as 'manual' | 'native_pos' | 'external_pos',
    paymentType: (o.payment_type ?? 'cash') as 'cash' | 'card' | 'other',
    paymentStatus: (o.payment_status ?? 'paid') as 'paid' | 'unpaid',
    status: (o.status ?? 'completed') as 'completed' | 'voided',
    note: o.note ?? null,
    subtotal:      numOrNull(o.subtotal),
    discountTotal: numOrNull(o.discount_total),
    taxTotal:      numOrNull(o.tax_total),
    cardBrand:     strOrNull(o.card_brand),
    cardLast4:     strOrNull(o.card_last4),
    customerName:  strOrNull(o.customer_name),
    channelSource: strOrNull(o.channel_source),
    locationName: (o.locations as unknown as { name: string } | null)?.name ?? null,
    lineItems: ((o.order_items as unknown as Array<{
      id: string; quantity: number; unit_price: number; total_price: number
      variant_label: string | null
      menu_items: { name: string } | null
    }>) ?? []).map((li) => ({
      id: li.id,
      name: li.menu_items?.name ?? '—',
      variantLabel: strOrNull(li.variant_label),
      quantity: li.quantity,
      unitPrice: Number(li.unit_price),
      totalPrice: Number(li.total_price),
    })),
  }))

  // The page header (title + subtitle + source-of-truth chip) lives
  // inside SalesClient now, mirroring the Finance pattern. Keeping
  // it there means the chip can sit beside the h1 and the band reads
  // as one thing.
  return <SalesClient lang={lang} orders={normalized} operatingMode={operatingMode} />
}
