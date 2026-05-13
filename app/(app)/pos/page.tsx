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
import { computeStockSnapshot } from '@/lib/inventory/stock'
import {
  computeAvailability,
  type AvailabilityOverride,
} from '@/lib/menu/availability'
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

  // Pulls the same data the Menu page uses to compute effective
  // sellability so POS reaches the same conclusion (auto-disable
  // out-of-stock items, honor manual overrides, leave unmapped /
  // unknown items sellable). RLS scopes by restaurant.
  // Same defensive fetch as menu/page.tsx — fall back to the base
  // column set when the new availability_override migration hasn't
  // landed yet, so POS keeps rendering tiles either way.
  async function fetchActiveMenuItems() {
    const rich = await supabase
      .from('menu_items')
      .select('id, name, current_price, category_id, active, availability_override')
      .eq('active', true)
      .order('name', { ascending: true })
    if (!rich.error) return rich.data
    if (rich.error.code !== '42703') {
      console.error('[pos/page] menu_items select failed:', rich.error)
    } else {
      console.warn('[pos/page] availability_override column missing — falling back to base select. Run the schema migration to enable overrides.')
    }
    const base = await supabase
      .from('menu_items')
      .select('id, name, current_price, category_id, active')
      .eq('active', true)
      .order('name', { ascending: true })
    if (base.error) {
      console.error('[pos/page] menu_items base select failed:', base.error)
      return null
    }
    return base.data
  }

  // Same observability shape as menu/page.tsx — destructure the
  // wrapped responses so error captures surface real failures.
  const [
    categoriesRes,
    rawItems,
    recipeRes,
    setupRes,
    countsRes,
    transactionsRes,
  ] = await Promise.all([
    supabase
      .from('menu_categories')
      .select('id, name, sort_order')
      .order('sort_order', { ascending: true }),

    fetchActiveMenuItems(),

    supabase
      .from('recipe_components')
      .select('menu_item_id, inventory_item_id, quantity_required'),

    supabase
      .from('restaurant_setup_state')
      .select('inventory_activated_at')
      .maybeSingle(),

    supabase
      .from('inventory_counts')
      .select('inventory_item_id, quantity_on_hand, count_date'),

    supabase
      .from('inventory_transactions')
      .select('inventory_item_id, quantity_change, transaction_datetime'),
  ])

  const categories = categoriesRes.data
  const recipeComponents = recipeRes.data
  const setupRow = setupRes.data
  const invCounts = countsRes.data
  const invTransactions = transactionsRes.data

  if (recipeRes.error) console.error('[pos/page] recipe_components select failed:', recipeRes.error)
  if (countsRes.error) console.error('[pos/page] inventory_counts select failed:', countsRes.error)
  if (transactionsRes.error) console.error('[pos/page] inventory_transactions select failed:', transactionsRes.error)

  const items = rawItems as Array<{
    id: string; name: string; current_price: number | string
    category_id: string | null; active: boolean
    availability_override?: string | null
  }> | null

  const itemIdSet = new Set((items ?? []).map((i) => i.id))
  const distinctRecipeMenuItemIds = new Set((recipeComponents ?? []).map((rc) => rc.menu_item_id as string))
  const matchCount = [...distinctRecipeMenuItemIds].filter((id) => itemIdSet.has(id)).length

  console.info('[pos/page] raw counts', {
    user_id: user?.id ?? null,
    categories: (categories ?? []).length,
    active_menu_items: items?.length ?? 0,
    recipe_components: (recipeComponents ?? []).length,
    distinct_menu_items_with_recipe: distinctRecipeMenuItemIds.size,
    match_count: matchCount,
    inventory_activated_at: setupRow?.inventory_activated_at ?? null,
  })

  if ((items?.length ?? 0) > 0 && (recipeComponents ?? []).length > 0 && matchCount === 0) {
    console.warn('[pos/page] menu_items ↔ recipe_components ID MISMATCH', {
      sample_menu_item_ids: (items ?? []).slice(0, 5).map((i) => i.id),
      sample_recipe_menu_item_ids: [...distinctRecipeMenuItemIds].slice(0, 5),
    })
  }

  const inventoryActive = !!setupRow?.inventory_activated_at
  const stockSnapshot = computeStockSnapshot(invCounts, invTransactions)

  // Build a recipe map keyed by menu_item_id for projection.
  const recipeByMenuItem = new Map<string, { inventoryItemId: string; quantityRequired: number }[]>()
  for (const rc of recipeComponents ?? []) {
    const list = recipeByMenuItem.get(rc.menu_item_id) ?? []
    list.push({
      inventoryItemId: rc.inventory_item_id,
      quantityRequired: Number(rc.quantity_required),
    })
    recipeByMenuItem.set(rc.menu_item_id, list)
  }

  return (
    <PosClient
      categories={(categories ?? []).map((c) => ({ id: c.id, name: c.name }))}
      items={(items ?? []).map((i) => {
        // `availability_override` may be undefined if the migration
        // hasn't landed; treat as 'none' to keep tiles sellable.
        const override = ((i.availability_override ?? null) as string | null ?? 'none') as AvailabilityOverride
        const availability = computeAvailability({
          active: i.active,
          recipe: recipeByMenuItem.get(i.id) ?? [],
          override,
          inventoryActive,
          stockByInventoryItemId: stockSnapshot.byInventoryItemId,
        })
        return {
          id: i.id,
          name: i.name,
          price: Number(i.current_price),
          categoryId: i.category_id,
          effectiveSellability: availability.effectiveSellability,
          projectedCount: availability.projectedCount,
          projectionState: availability.projectionState,
        }
      })}
      operatingMode={operatingMode}
    />
  )
}
