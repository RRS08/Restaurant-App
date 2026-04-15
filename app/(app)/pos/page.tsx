// ----------------------------------------------------------------
// POS Page  →  /pos
//
// The live transaction-entry surface of the Sales pillar.
// POS is a thin surface over the existing Sales backbone:
// orders submitted here reuse `createOrder` and write into the
// same `orders` + `order_items` tables, tagged `source='native_pos'`.
// The existing Sales → Inventory bridge keeps working unchanged.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import PosClient from './client'

export default async function PosPage() {
  const supabase = await createClient()

  // Active menu items grouped by category. RLS filters by restaurant.
  const [{ data: categories }, { data: items }] = await Promise.all([
    supabase
      .from('menu_categories')
      .select('id, name, sort_order')
      .order('sort_order', { ascending: true }),

    supabase
      .from('menu_items')
      .select('id, name, current_price, category_id')
      .eq('active', true)
      .order('name', { ascending: true }),
  ])

  return (
    <PosClient
      categories={(categories ?? []).map((c) => ({ id: c.id, name: c.name }))}
      items={(items ?? []).map((i) => ({
        id: i.id,
        name: i.name,
        price: Number(i.current_price),
        categoryId: i.category_id,
      }))}
    />
  )
}
