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
import PageShell from '@/components/page-shell'
import SalesClient from './client'

export default async function SalesPage() {
  const supabase = await createClient()

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

  return (
    <PageShell title="Sales" description="Review recent orders and correct mistaken sales.">
      <SalesClient orders={normalized} />
    </PageShell>
  )
}
