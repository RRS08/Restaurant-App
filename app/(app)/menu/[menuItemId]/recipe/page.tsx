// ----------------------------------------------------------------
// Recipe Page  →  /menu/[menuItemId]/recipe
//
// Server Component: fetches the menu item, its current recipe
// components, and the available inventory items for the dropdown.
// Passes all data to the Client Component form.
//
// This page is accessed from the menu list by clicking "Recipe"
// next to a menu item. The URL includes the menu item's UUID
// as a dynamic segment: [menuItemId].
//
// In Next.js 16+, params is a Promise — we must await it.
// ----------------------------------------------------------------

import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import RecipeForm from './form'

export default async function RecipePage({
  params,
}: {
  params: Promise<{ menuItemId: string }>
}) {
  const { menuItemId } = await params
  const supabase = await createClient()

  // Fetch the menu item (to show its name in the header).
  const { data: menuItem } = await supabase
    .from('menu_items')
    .select('id, name')
    .eq('id', menuItemId)
    .single()

  if (!menuItem) {
    return (
      <div className="max-w-md">
        <p className="text-gray-500">Menu item not found.</p>
        <Link href="/menu" className="text-blue-600 hover:underline text-sm mt-2 inline-block">
          Back to menu
        </Link>
      </div>
    )
  }

  // Fetch existing recipe components with the inventory item name + unit.
  const { data: components } = await supabase
    .from('recipe_components')
    .select('id, quantity_required, inventory_items ( id, name, unit_of_measure )')
    .eq('menu_item_id', menuItemId)
    .order('created_at', { ascending: true })

  // Fetch all active inventory items for the "add ingredient" dropdown.
  const { data: inventoryItems } = await supabase
    .from('inventory_items')
    .select('id, name, unit_of_measure')
    .eq('active', true)
    .order('name', { ascending: true })

  return (
    <div className="max-w-xl">

      {/* Header */}
      <div className="mb-8">
        <Link href="/menu" className="text-sm text-gray-500 hover:text-gray-700 transition-colors">
          &larr; Back to menu
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">
          Recipe: {menuItem.name}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Define which inventory ingredients this item uses and how much of each.
        </p>
      </div>

      <RecipeForm
        menuItemId={menuItem.id}
        components={(components ?? []).map((c) => ({
          id: c.id,
          quantity_required: c.quantity_required,
          inventory_items: c.inventory_items as unknown as { id: string; name: string; unit_of_measure: string } | null,
        }))}
        inventoryItems={inventoryItems ?? []}
      />

    </div>
  )
}
