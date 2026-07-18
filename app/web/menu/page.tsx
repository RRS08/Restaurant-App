// ----------------------------------------------------------------
// Web-native Menu  →  /web/menu
//
// V1 display surface for the menu module. Reads from the same tables
// the classic /menu route reads from. Editing surfaces (create item,
// edit recipe, toggle availability) still live in the classic route.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import WebMenuClient from './client'

export default async function WebMenuPage() {
  const supabase = await createClient()
  const lang = await getLang()

  const { data: { user } } = await supabase.auth.getUser()
  let activeSeedConcept: string | null = null
  let seedColumnsAvailable = true
  if (user) {
    const { data: role } = await supabase
      .from('user_roles')
      .select('restaurant_id')
      .eq('user_id', user.id)
      .single()
    if (role?.restaurant_id) {
      const probe = await supabase
        .from('restaurants')
        .select('active_seed_concept')
        .eq('id', role.restaurant_id)
        .maybeSingle()
      if (probe.error?.code === '42703') seedColumnsAvailable = false
      else activeSeedConcept = (probe.data as { active_seed_concept?: string | null } | null)?.active_seed_concept ?? null
    }
  }

  // Build the category + item base queries inline, then apply the
  // seed filter only when the seed column is actually available.
  // Mirrors the pattern used in /web/inventory's server component.
  const catsBase = supabase.from('menu_categories').select('id, name, sort_order')
  const catsFiltered = !seedColumnsAvailable
    ? catsBase
    : activeSeedConcept
      ? catsBase.or(`concept_key.eq.${activeSeedConcept},concept_key.is.null`)
      : catsBase.is('concept_key', null)

  const itemsBase = supabase
    .from('menu_items')
    .select('id, name, current_price, active, category_id, source, external_provider')
  const itemsFiltered = !seedColumnsAvailable
    ? itemsBase
    : activeSeedConcept
      ? itemsBase.or(`concept_key.eq.${activeSeedConcept},concept_key.is.null`)
      : itemsBase.is('concept_key', null)

  const [
    { data: categories },
    { data: items },
    { data: recipeComponents },
  ] = await Promise.all([
    catsFiltered.order('sort_order', { ascending: true }).order('name', { ascending: true }),
    itemsFiltered.order('name', { ascending: true }),
    supabase
      .from('recipe_components')
      .select('id, menu_item_id, quantity_required, inventory_items ( id, name, unit_of_measure )')
      .order('created_at', { ascending: true }),
  ])

  // Build recipe map: menu_item_id → components[]
  type RC = {
    id: string
    menu_item_id: string
    quantity_required: number
    inventory_items: { id: string; name: string; unit_of_measure: string } | null
  }
  const recipeMap = new Map<string, Array<{
    id: string; inventoryItemId: string; inventoryItemName: string; unitOfMeasure: string; quantityRequired: number
  }>>()
  for (const rc of ((recipeComponents ?? []) as unknown as RC[])) {
    if (!rc.inventory_items) continue
    const list = recipeMap.get(rc.menu_item_id) ?? []
    list.push({
      id: rc.id,
      inventoryItemId: rc.inventory_items.id,
      inventoryItemName: rc.inventory_items.name,
      unitOfMeasure: rc.inventory_items.unit_of_measure,
      quantityRequired: Number(rc.quantity_required),
    })
    recipeMap.set(rc.menu_item_id, list)
  }

  // Shape categories with their items nested inside.
  const sortedCategories = [...(categories ?? [])].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.name.localeCompare(b.name)
  })

  const itemsByCategory = new Map<string | null, Array<{
    id: string; name: string; price: number; active: boolean
    source: string; externalProvider: string | null
    recipe: Array<{ id: string; inventoryItemId: string; inventoryItemName: string; unitOfMeasure: string; quantityRequired: number }>
  }>>()
  for (const it of (items ?? [])) {
    const list = itemsByCategory.get(it.category_id) ?? []
    list.push({
      id: it.id,
      name: it.name,
      price: Number(it.current_price),
      active: it.active,
      source: it.source,
      externalProvider: it.external_provider,
      recipe: recipeMap.get(it.id) ?? [],
    })
    itemsByCategory.set(it.category_id, list)
  }
  for (const list of itemsByCategory.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name))
  }

  const categoriesShaped = sortedCategories.map((c) => ({
    id: c.id,
    name: c.name,
    items: itemsByCategory.get(c.id) ?? [],
  }))
  // Uncategorized bucket (if any items have category_id = null)
  const uncategorized = itemsByCategory.get(null) ?? []
  if (uncategorized.length > 0) {
    categoriesShaped.push({ id: 'uncategorized', name: 'Uncategorized', items: uncategorized })
  }

  return <WebMenuClient lang={lang} categories={categoriesShaped} totalItems={(items ?? []).length} />
}
