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
import { getOperatingMode } from '@/lib/readiness'
import SalesClient from './client'

export default async function SalesPage() {
  const supabase = await createClient()

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
      location_id,
      locations ( name ),
      order_items ( id, quantity, unit_price, total_price, menu_items ( name ) )
    `)
    .order('created_at', { ascending: false })
    .limit(50)

  const normalized = (orders ?? []).map((o) => ({
    id: o.id,
    total: Number(o.total_amount),
    createdAt: o.created_at,
    source: (o.source ?? 'manual') as 'manual' | 'native_pos' | 'external_pos',
    paymentType: (o.payment_type ?? 'cash') as 'cash' | 'card' | 'other',
    paymentStatus: (o.payment_status ?? 'paid') as 'paid' | 'unpaid',
    status: (o.status ?? 'completed') as 'completed' | 'voided',
    note: o.note ?? null,
    locationName: (o.locations as unknown as { name: string } | null)?.name ?? null,
    lineItems: ((o.order_items as unknown as Array<{
      id: string; quantity: number; unit_price: number; total_price: number
      menu_items: { name: string } | null
    }>) ?? []).map((li) => ({
      id: li.id,
      name: li.menu_items?.name ?? '—',
      quantity: li.quantity,
      unitPrice: Number(li.unit_price),
      totalPrice: Number(li.total_price),
    })),
  }))

  // The page header (title + subtitle + source-of-truth chip) lives
  // inside SalesClient now, mirroring the Finance pattern. Keeping
  // it there means the chip can sit beside the h1 and the band reads
  // as one thing.
  return <SalesClient orders={normalized} operatingMode={operatingMode} />
}
