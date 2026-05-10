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
import { getOperatingMode } from '@/lib/readiness'
import PosClient from './client'

export default async function PosPage() {
  const supabase = await createClient()

  // operating_mode is needed to decide whether to show the "this
  // restaurant runs on an external POS" banner. The native POS
  // surface stays fully functional regardless — we never hard-disable
  // it, so dev/testing flows are preserved on either branch.
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
      operatingMode={operatingMode}
    />
  )
}
