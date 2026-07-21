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
import { getT, getLang } from '@/lib/i18n-server'
import RecipeForm from './form'

export default async function RecipePage({
  params,
}: {
  params: Promise<{ menuItemId: string }>
}) {
  const { menuItemId } = await params
  const supabase = await createClient()
  const t = await getT()
  const lang = await getLang()

  // Fetch the menu item (to show its name in the header).
  const { data: menuItem } = await supabase
    .from('menu_items')
    .select('id, name')
    .eq('id', menuItemId)
    .single()

  if (!menuItem) {
    return (
      <div className="max-w-md">
        <p className="text-gray-500">{t('Menu item not found.', 'Artículo del menú no encontrado.')}</p>
        <Link href="/menu" className="text-blue-600 hover:underline text-sm mt-2 inline-block">
          {t('Back to menu', 'Volver al menú')}
        </Link>
      </div>
    )
  }

  // Fetch existing recipe components with the inventory item name +
  // unit, plus the recipe row's own `unit` (nullable — null means
  // "identity with the inventory item's unit_of_measure").
  const { data: components } = await supabase
    .from('recipe_components')
    .select('id, quantity_required, unit, inventory_items ( id, name, unit_of_measure )')
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
          &larr; {t('Back to menu', 'Volver al menú')}
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">
          {t('Recipe', 'Receta')}: {menuItem.name}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          {t('Define which inventory ingredients this item uses and how much of each.', 'Define qué ingredientes del inventario usa este artículo y cuánto de cada uno.')}
        </p>
      </div>

      <RecipeForm
        menuItemId={menuItem.id}
        components={(components ?? []).map((c) => ({
          id: c.id,
          quantity_required: c.quantity_required,
          unit: (c.unit as string | null) ?? null,
          inventory_items: c.inventory_items as unknown as { id: string; name: string; unit_of_measure: string } | null,
        }))}
        inventoryItems={inventoryItems ?? []}
        lang={lang}
      />

    </div>
  )
}
