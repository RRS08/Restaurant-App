// ----------------------------------------------------------------
// Menu Page  →  /menu
//
// Server Component — fetches all data needed for the interactive
// menu client: categories, items, recipe components with inventory
// names, and inventory items for the ingredient dropdown.
//
// A fresh restaurant with zero categories/items will see an
// honest empty state inside MenuClient.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import MenuClient from './client'

export default async function MenuPage() {
  const supabase = await createClient()

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
    />
  )
}
