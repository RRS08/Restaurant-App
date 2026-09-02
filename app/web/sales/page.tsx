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

  // Base orders query — no embeds. Protects the list from a
  // schema-cache / RLS hiccup on any child table (which silently
  // returns zero parent rows). Location name + line items come
  // from follow-up queries; each failure only degrades one part
  // of the row rather than nuking the whole list.
  const { data: orders } = await supabase
    .from('orders')
    .select(`
      id, total_amount, created_at,
      source, payment_type, payment_status, status, note, location_id
    `)
    .order('created_at', { ascending: false })
    .limit(50)

  const orderIds = (orders ?? []).map((o) => o.id)
  const locationIds = Array.from(
    new Set(((orders ?? []).map((o) => o.location_id).filter(Boolean) as string[]))
  )

  const [{ data: locs }, { data: itemRows }] = await Promise.all([
    locationIds.length > 0
      ? supabase.from('locations').select('id, name').in('id', locationIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    orderIds.length > 0
      ? supabase
          .from('order_items')
          .select('id, order_id, quantity, unit_price, total_price, menu_items ( name )')
          .in('order_id', orderIds)
      : Promise.resolve({ data: [] as unknown[] }),
  ])

  const locName = new Map<string, string>()
  for (const r of (locs ?? []) as { id: string; name: string }[]) {
    locName.set(r.id, r.name)
  }

  type RawItem = {
    id: string
    order_id: string
    quantity: number
    unit_price: number
    total_price: number
    menu_items: { name: string } | null
  }
  const itemsByOrder = new Map<string, RawItem[]>()
  for (const it of ((itemRows ?? []) as RawItem[])) {
    const list = itemsByOrder.get(it.order_id) ?? []
    list.push(it)
    itemsByOrder.set(it.order_id, list)
  }

  type RawOrder = {
    id: string
    total_amount: number
    created_at: string
    source: string | null
    payment_type: string | null
    payment_status: string | null
    status: string | null
    note: string | null
    location_id: string | null
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
    locationName: o.location_id ? (locName.get(o.location_id) ?? null) : null,
    lineItems: (itemsByOrder.get(o.id) ?? []).map((li) => ({
      id: li.id,
      name: li.menu_items?.name ?? '—',
      quantity: li.quantity,
      unitPrice: Number(li.unit_price),
      totalPrice: Number(li.total_price),
    })),
  }))

  return <WebSalesClient lang={lang} orders={normalized} />
}
