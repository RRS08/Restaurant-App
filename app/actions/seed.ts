'use server'

// ----------------------------------------------------------------
// Demo seed switcher — server actions
//
// All actions are dev-only: callers must be in isDevEmail() or the
// action returns an error. The /dev-tools UI is the only mounting
// point, so non-dev users never see these in the UI either, but
// the server-side gate is the actual boundary.
//
// Action map:
//   • setActiveSeed(concept | null)   — flip the active concept on
//                                       the caller's restaurant
//   • installSeed(concept)            — insert that concept's menu
//                                       + inventory + recipes,
//                                       idempotent (skip if any rows
//                                       with that concept_key exist)
//   • uninstallSeed(concept)          — delete all rows tagged with
//                                       that concept_key (recipe
//                                       rows cascade via FK)
//   • tagCurrentDataAs(concept)       — relabel all NULL menu/
//                                       inventory rows in the
//                                       caller's restaurant with
//                                       the given concept_key
//                                       (used once to mark "this
//                                       was my test data" so it
//                                       hides when you activate
//                                       another seed)
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isDevEmail } from '@/lib/dev'
import { findConcept } from '@/lib/seed-concepts'

// Resolves the caller's restaurant_id + enforces dev-only access.
// Returns { restaurantId, error } — error is set when caller isn't
// dev or doesn't have a restaurant.
async function requireDevContext(): Promise<
  | { restaurantId: string; error: null }
  | { restaurantId: null; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { restaurantId: null, error: 'Not signed in.' }
  if (!isDevEmail(user.email)) return { restaurantId: null, error: 'Dev only.' }
  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role?.restaurant_id) return { restaurantId: null, error: 'No restaurant.' }
  return { restaurantId: role.restaurant_id, error: null }
}

export async function setActiveSeed(
  concept: string | null,
): Promise<{ error?: string; ok?: boolean }> {
  const { restaurantId, error } = await requireDevContext()
  if (error || !restaurantId) return { error: error ?? 'Unknown error.' }

  const supabase = await createClient()
  const { error: updateErr } = await supabase
    .from('restaurants')
    .update({ active_seed_concept: concept })
    .eq('id', restaurantId)

  if (updateErr) return { error: 'Could not switch seed.' }

  // POS + Menu + Inventory + Dev Tools all need a fresh render.
  revalidatePath('/dev-tools')
  revalidatePath('/pos')
  revalidatePath('/menu')
  revalidatePath('/inventory')
  return { ok: true }
}

export async function installSeed(
  conceptKey: string,
): Promise<{ error?: string; ok?: boolean; counts?: { categories: number; items: number; inventory: number } }> {
  const { restaurantId, error } = await requireDevContext()
  if (error || !restaurantId) return { error: error ?? 'Unknown error.' }

  const seed = findConcept(conceptKey)
  if (!seed) return { error: 'Unknown concept.' }

  const supabase = await createClient()

  // Idempotency check — skip if anything tagged with this concept
  // already exists in the restaurant. Lets the user re-click
  // "Install" without exploding the menu list.
  const { count: existingItems } = await supabase
    .from('menu_items')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId)
    .eq('concept_key', conceptKey)
  if ((existingItems ?? 0) > 0) {
    return { error: 'This concept is already installed. Uninstall first if you want a fresh copy.' }
  }

  // Resolve first location for the restaurant — inventory_items
  // require a location_id. Most dev restaurants have a single
  // location; we pick the earliest by created_at.
  const { data: loc } = await supabase
    .from('locations')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!loc?.id) return { error: 'No location on this restaurant — inventory needs one.' }
  const locationId = loc.id as string

  // 1. Categories
  const categoryRows = seed.categories.map((c) => ({
    restaurant_id: restaurantId,
    name: c.name,
    sort_order: c.sortOrder,
    concept_key: conceptKey,
  }))
  const { data: insertedCategories, error: catErr } = await supabase
    .from('menu_categories')
    .insert(categoryRows)
    .select('id, name')
  if (catErr || !insertedCategories) return { error: `Categories failed: ${catErr?.message ?? 'unknown'}` }
  const catIdByName = new Map(insertedCategories.map((c) => [c.name as string, c.id as string]))

  // 2. Inventory items
  const inventoryRows = seed.inventory.map((i) => ({
    restaurant_id: restaurantId,
    location_id: locationId,
    name: i.name,
    unit_of_measure: i.unit,
    low_stock_threshold: Math.max(1, Math.round(i.parInventory * 0.2)),
    concept_key: conceptKey,
  }))
  const { data: insertedInventory, error: invErr } = await supabase
    .from('inventory_items')
    .insert(inventoryRows)
    .select('id, name')
  if (invErr || !insertedInventory) return { error: `Inventory failed: ${invErr?.message ?? 'unknown'}` }
  // Map seed key → inserted id via the human name we stored.
  const invIdByKey = new Map<string, string>()
  seed.inventory.forEach((seedItem) => {
    const inserted = insertedInventory.find((r) => r.name === seedItem.name)
    if (inserted) invIdByKey.set(seedItem.key, inserted.id as string)
  })

  // 3. Menu items
  const menuItemRows = seed.menuItems.map((m) => {
    const categoryId = catIdByName.get(m.categoryName)
    return {
      restaurant_id: restaurantId,
      name: m.name,
      current_price: m.price,
      category_id: categoryId ?? null,
      active: true,
      concept_key: conceptKey,
    }
  })
  const { data: insertedMenuItems, error: menuErr } = await supabase
    .from('menu_items')
    .insert(menuItemRows)
    .select('id, name')
  if (menuErr || !insertedMenuItems) return { error: `Menu items failed: ${menuErr?.message ?? 'unknown'}` }
  const menuIdByName = new Map(insertedMenuItems.map((m) => [m.name as string, m.id as string]))

  // 4. Recipe components — flatten each menu item's recipe into rows.
  const recipeRows: Array<{
    restaurant_id: string
    menu_item_id: string
    inventory_item_id: string
    quantity_required: number
  }> = []
  for (const m of seed.menuItems) {
    if (!m.recipe || m.recipe.length === 0) continue
    const menuId = menuIdByName.get(m.name)
    if (!menuId) continue
    for (const r of m.recipe) {
      const invId = invIdByKey.get(r.inventoryKey)
      if (!invId) continue
      recipeRows.push({
        restaurant_id: restaurantId,
        menu_item_id: menuId,
        inventory_item_id: invId,
        quantity_required: r.quantity,
      })
    }
  }
  if (recipeRows.length > 0) {
    const { error: recipeErr } = await supabase.from('recipe_components').insert(recipeRows)
    if (recipeErr) return { error: `Recipes failed: ${recipeErr.message}` }
  }

  revalidatePath('/dev-tools')
  revalidatePath('/pos')
  revalidatePath('/menu')
  revalidatePath('/inventory')
  return {
    ok: true,
    counts: {
      categories: insertedCategories.length,
      items: insertedMenuItems.length,
      inventory: insertedInventory.length,
    },
  }
}

export async function uninstallSeed(
  conceptKey: string,
): Promise<{ error?: string; ok?: boolean }> {
  const { restaurantId, error } = await requireDevContext()
  if (error || !restaurantId) return { error: error ?? 'Unknown error.' }

  const supabase = await createClient()

  // Recipe components don't carry concept_key — they cascade-delete
  // via FK when menu_items rows go away. So we delete menu_items
  // first, then categories, then inventory_items. recipe_components
  // rows tied to those menu_items disappear with them.
  await supabase
    .from('menu_items')
    .delete()
    .eq('restaurant_id', restaurantId)
    .eq('concept_key', conceptKey)
  await supabase
    .from('menu_categories')
    .delete()
    .eq('restaurant_id', restaurantId)
    .eq('concept_key', conceptKey)
  await supabase
    .from('inventory_items')
    .delete()
    .eq('restaurant_id', restaurantId)
    .eq('concept_key', conceptKey)

  // If the active seed was the one we just removed, deactivate it
  // so the next page render doesn't filter to a now-empty set.
  const { data: r } = await supabase
    .from('restaurants')
    .select('active_seed_concept')
    .eq('id', restaurantId)
    .single()
  if (r?.active_seed_concept === conceptKey) {
    await supabase
      .from('restaurants')
      .update({ active_seed_concept: null })
      .eq('id', restaurantId)
  }

  revalidatePath('/dev-tools')
  revalidatePath('/pos')
  revalidatePath('/menu')
  revalidatePath('/inventory')
  return { ok: true }
}

export async function tagCurrentDataAs(
  conceptKey: string,
): Promise<{ error?: string; ok?: boolean; tagged?: { menuItems: number; categories: number; inventory: number } }> {
  const { restaurantId, error } = await requireDevContext()
  if (error || !restaurantId) return { error: error ?? 'Unknown error.' }

  const supabase = await createClient()

  // Only touch rows that are currently NULL — never overwrite
  // existing concept tags. This lets the dev safely re-run this
  // action if they add more "test" content over time.
  // .select() after .update() returns the affected rows; we use
  // .length below as the count. The chained count: 'exact' option
  // isn't typed on this path so we don't try to pass it.
  const updateMenuItems = await supabase
    .from('menu_items')
    .update({ concept_key: conceptKey })
    .eq('restaurant_id', restaurantId)
    .is('concept_key', null)
    .select('id')
  const updateCategories = await supabase
    .from('menu_categories')
    .update({ concept_key: conceptKey })
    .eq('restaurant_id', restaurantId)
    .is('concept_key', null)
    .select('id')
  const updateInventory = await supabase
    .from('inventory_items')
    .update({ concept_key: conceptKey })
    .eq('restaurant_id', restaurantId)
    .is('concept_key', null)
    .select('id')

  revalidatePath('/dev-tools')
  revalidatePath('/pos')
  revalidatePath('/menu')
  revalidatePath('/inventory')
  return {
    ok: true,
    tagged: {
      menuItems: updateMenuItems.data?.length ?? 0,
      categories: updateCategories.data?.length ?? 0,
      inventory: updateInventory.data?.length ?? 0,
    },
  }
}
