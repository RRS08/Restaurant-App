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

// Resolves the caller's restaurant_id + user_id + enforces dev-only
// access. Returns { restaurantId, userId, error } — error is set
// when the caller isn't dev or doesn't have a restaurant. userId
// is needed for inventory_counts.entered_by_user_id (the table
// records who entered each count).
async function requireDevContext(): Promise<
  | { restaurantId: string; userId: string; error: null }
  | { restaurantId: null; userId: null; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { restaurantId: null, userId: null, error: 'Not signed in.' }
  if (!isDevEmail(user.email)) return { restaurantId: null, userId: null, error: 'Dev only.' }
  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role?.restaurant_id) return { restaurantId: null, userId: null, error: 'No restaurant.' }
  return { restaurantId: role.restaurant_id, userId: user.id, error: null }
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
  const { restaurantId, userId, error } = await requireDevContext()
  if (error || !restaurantId || !userId) return { error: error ?? 'Unknown error.' }

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

  // 5. Initial inventory counts — without these the Inventory page
  // shows every freshly-seeded item as "no count yet" and the
  // recipe depletion math has no baseline to subtract from. We
  // record one inventory_counts row per item at a flat 50 units
  // (deliberately, NOT each item's parInventory) so every demo
  // opens with the same round number across every concept. Easier
  // for the cashier to point at depletion: "see, that was 50, now
  // it's 49.83 after that taco rang up." entered_by_user_id is
  // required (non-null FK to auth.users); we record the dev who
  // clicked Install.
  const DEMO_OPENING_STOCK = 50
  const countRows = seed.inventory.map((i) => {
    const invId = invIdByKey.get(i.key)
    if (!invId) return null
    return {
      restaurant_id: restaurantId,
      location_id: locationId,
      inventory_item_id: invId,
      quantity_on_hand: DEMO_OPENING_STOCK,
      entered_by_user_id: userId,
    }
  }).filter((r): r is NonNullable<typeof r> => r !== null)
  if (countRows.length > 0) {
    const { error: countsErr } = await supabase.from('inventory_counts').insert(countRows)
    if (countsErr) return { error: `Counts failed: ${countsErr.message}` }
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

// ----------------------------------------------------------------
// refreshSeedCounts — top up inventory_counts for an already-
// installed concept. Used for restaurants whose Taqueria install
// predates the "seed initial counts" change in installSeed — they
// have inventory_items but every row shows "No count yet" on the
// Inventory page because no count_inventory_counts row was ever
// written.
//
// Idempotent: only inserts a count for items that currently have
// none. Re-running is safe and won't overwrite the most recent
// real count if one already exists.
// ----------------------------------------------------------------
export async function refreshSeedCounts(
  conceptKey: string,
): Promise<{ error?: string; ok?: boolean; topped?: number }> {
  const { restaurantId, userId, error } = await requireDevContext()
  if (error || !restaurantId || !userId) return { error: error ?? 'Unknown error.' }

  const seed = findConcept(conceptKey)
  if (!seed) return { error: 'Unknown concept.' }

  const supabase = await createClient()

  const { data: items } = await supabase
    .from('inventory_items')
    .select('id, name, location_id')
    .eq('restaurant_id', restaurantId)
    .eq('concept_key', conceptKey)

  if (!items || items.length === 0) {
    return { error: 'No items found for this concept.' }
  }

  // Demo opening stock — same flat 50 we use on install, so a
  // refresh leaves every item at a consistent baseline regardless
  // of the per-item parInventory in the seed definition.
  const DEMO_OPENING_STOCK = 50

  // Validate items belong to this concept's seed (we still use
  // the name map to skip random items that aren't part of the
  // seed — defensive). The actual count value is the flat
  // DEMO_OPENING_STOCK constant above.
  const knownNames = new Set(seed.inventory.map((i) => i.name))

  // Skip any item that already has a count, even an old one. The
  // dev can always insert a fresh count manually from /inventory
  // if they want a baseline overwrite.
  const itemIds = items.map((i) => i.id as string)
  const { data: existingCounts } = await supabase
    .from('inventory_counts')
    .select('inventory_item_id')
    .in('inventory_item_id', itemIds)
  const alreadyCounted = new Set((existingCounts ?? []).map((c) => c.inventory_item_id as string))

  const rows = items
    .filter((it) => !alreadyCounted.has(it.id as string))
    .map((it) => {
      if (!knownNames.has(it.name as string)) return null
      return {
        restaurant_id: restaurantId,
        location_id: it.location_id as string,
        inventory_item_id: it.id as string,
        quantity_on_hand: DEMO_OPENING_STOCK,
        entered_by_user_id: userId,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  if (rows.length === 0) {
    return { ok: true, topped: 0 }
  }

  const { error: insErr } = await supabase.from('inventory_counts').insert(rows)
  if (insErr) return { error: `Counts failed: ${insErr.message}` }

  revalidatePath('/dev-tools')
  revalidatePath('/inventory')
  revalidatePath('/pos')
  return { ok: true, topped: rows.length }
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

  // Auto-activate the concept we just tagged. Without this the
  // user's existing menu + inventory disappear from POS / Menu /
  // Inventory immediately after tagging (the filter excludes the
  // rows they just labeled). Auto-activation keeps the visible
  // set intact and makes the "tag → switch later" flow work as
  // expected.
  await supabase
    .from('restaurants')
    .update({ active_seed_concept: conceptKey })
    .eq('id', restaurantId)

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
