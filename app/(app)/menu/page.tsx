// ----------------------------------------------------------------
// Menu Page  →  /menu
//
// Server Component — fetches all data needed for the interactive
// menu client: categories, items, recipe components with inventory
// names, and inventory items for the ingredient dropdown.
//
// Branches on operating_mode (locked at onboarding):
//   external_pos → render an import panel up top so users can connect
//                  their provider and pull menu, then review below.
//   native_pos   → standard native menu builder.
// External POS connections + locations are fetched alongside so the
// import panel can render with live state. The dev path (DevTools in
// Settings) is unchanged — this is the production-grade branch-A
// surface, not a replacement for dev tooling.
//
// A fresh restaurant with zero categories/items will see an
// honest empty state inside MenuClient.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getOperatingMode } from '@/lib/readiness'
import { isDevEmail } from '@/lib/dev'
import MenuClient from './client'

export default async function MenuPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  const isDev = isDevEmail(user?.email)

  // Resolve restaurant id once for the operating-mode + locations +
  // connections lookups. RLS still scopes the rest of the queries.
  let restaurantId: string | null = null
  if (user) {
    const { data: role } = await supabase
      .from('user_roles')
      .select('restaurant_id')
      .eq('user_id', user.id)
      .single()
    restaurantId = role?.restaurant_id ?? null
  }

  const operatingMode = restaurantId
    ? await getOperatingMode(supabase, restaurantId)
    : null
  const isExternalPos = operatingMode === 'external_pos'

  // Locations + active POS connections only matter for the external
  // branch's import panel — skip the round-trips on native restaurants.
  const [{ data: locations }, { data: posConnections }] = isExternalPos && restaurantId
    ? await Promise.all([
        supabase
          .from('locations')
          .select('id, name')
          .eq('restaurant_id', restaurantId)
          .order('created_at', { ascending: true }),
        supabase
          .from('external_pos_connections')
          .select('id, location_id, provider, active, external_store_id, last_menu_sync_at, last_error')
          .eq('restaurant_id', restaurantId)
          .order('created_at', { ascending: true }),
      ])
    : [{ data: [] as Array<{ id: string; name: string }> }, { data: [] as Array<{
        id: string; location_id: string; provider: string; active: boolean
        external_store_id: string | null; last_menu_sync_at: string | null; last_error: string | null
      }> }]

  const [
    { data: categories },
    { data: items },
    { data: recipeComponents },
    { data: inventoryItems },
  ] = await Promise.all([
    supabase
      .from('menu_categories')
      .select('id, name, sort_order')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),

    supabase
      .from('menu_items')
      .select('id, name, current_price, active, category_id, source')
      .order('name', { ascending: true }),

    // All recipe components with inventory item name + unit
    supabase
      .from('recipe_components')
      .select('id, menu_item_id, inventory_item_id, quantity_required, inventory_items ( name, unit_of_measure )')
      .order('created_at', { ascending: true }),

    // Active inventory items for the ingredient dropdown
    supabase
      .from('inventory_items')
      .select('id, name, unit_of_measure')
      .eq('active', true)
      .order('name', { ascending: true }),
  ])

  // Build recipe map: menu_item_id → components[]
  const recipeMap = new Map<string, {
    id: string
    inventoryItemId: string
    inventoryItemName: string
    unitOfMeasure: string
    quantityRequired: number
  }[]>()

  for (const rc of recipeComponents ?? []) {
    const inv = rc.inventory_items as unknown as { name: string; unit_of_measure: string } | null
    const entry = {
      id: rc.id,
      inventoryItemId: rc.inventory_item_id,
      inventoryItemName: inv?.name ?? 'Unknown',
      unitOfMeasure: inv?.unit_of_measure ?? '',
      quantityRequired: Number(rc.quantity_required),
    }
    if (!recipeMap.has(rc.menu_item_id)) recipeMap.set(rc.menu_item_id, [])
    recipeMap.get(rc.menu_item_id)!.push(entry)
  }

  const menuItems = (items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    currentPrice: Number(item.current_price),
    active: item.active,
    categoryId: item.category_id,
    source: item.source,
    recipe: recipeMap.get(item.id) ?? [],
  }))

  const externalConnections = (posConnections ?? []).map((c) => ({
    id: c.id,
    locationId: c.location_id,
    provider: c.provider,
    active: c.active,
    externalStoreId: c.external_store_id,
    lastMenuSyncAt: c.last_menu_sync_at,
    lastError: c.last_error,
  }))

  return (
    <MenuClient
      categories={(categories ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sort_order,
      }))}
      items={menuItems}
      inventoryItems={(inventoryItems ?? []).map((ii) => ({
        id: ii.id,
        name: ii.name,
        unitOfMeasure: ii.unit_of_measure,
      }))}
      operatingMode={operatingMode}
      locations={locations ?? []}
      externalConnections={externalConnections}
      isDev={isDev}
    />
  )
}
