// ----------------------------------------------------------------
// Web-native Sales  →  /web/sales
//
// Mirrors the classic /sales display layer in web-native form:
// type-led top-down read, no card chrome, hairline dividers, and a
// focused-card overlay for full order detail instead of an inline
// row expand. The underlying tables, RLS scoping, and order shape
// are identical to the classic route — same data, two presentations.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import WebSalesClient from './client'

export default async function WebSalesPage() {
  const supabase = await createClient()
  const lang = await getLang()

  const { data: orders } = await supabase
    .from('orders')
    .select(`
      id, total_amount, created_at,
      source, payment_type, payment_status, status, note,
      location_id,
      locations ( name ),
      order_items ( id, quantity, unit_price, total_price, menu_items ( name ) )
    `)
    .order('created_at', { ascending: false })
    .limit(50)

  type RawOrder = {
    id: string
    total_amount: number
    created_at: string
    source: string | null
    payment_type: string | null
    payment_status: string | null
    status: string | null
    note: string | null
    locations: { name: string } | null
    order_items: Array<{
      id: string
      quantity: number
      unit_price: number
      total_price: number
      menu_items: { name: string } | null
    }>
  }

  const normalized = ((orders ?? []) as unknown as RawOrder[]).map((o) => ({
    id: o.id,
    total: Number(o.total_amount),
    createdAt: o.created_at,
    source: (o.source ?? 'manual') as 'manual' | 'native_pos' | 'external_pos',
    paymentType: (o.payment_type ?? 'cash') as 'cash' | 'card' | 'other',
    paymentStatus: (o.payment_status ?? 'paid') as 'paid' | 'unpaid',
    status: (o.status ?? 'completed') as 'completed' | 'voided',
    note: o.note ?? null,
    locationName: o.locations?.name ?? null,
    lineItems: (o.order_items ?? []).map((li) => ({
      id: li.id,
      name: li.menu_items?.name ?? '—',
      quantity: li.quantity,
      unitPrice: Number(li.unit_price),
      totalPrice: Number(li.total_price),
    })),
  }))

  return <WebSalesClient lang={lang} orders={normalized} />
}
