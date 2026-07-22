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
import { computeStockSnapshot } from '@/lib/inventory/stock'
import {
  computeAvailability,
  type AvailabilityOverride,
} from '@/lib/menu/availability'
import { getLang } from '@/lib/i18n-server'
import MenuClient from './client'

export default async function MenuPage() {
  const supabase = await createClient()
  const lang = await getLang()

  const { data: { user } } = await supabase.auth.getUser()
  const isDev = isDevEmail(user?.email)

  // Resolve restaurant id once for the operating-mode + locations +
  // connections lookups. RLS still scopes the rest of the queries.
  let restaurantId: string | null = null
  // Demo seed switcher — dev only. See app/actions/seed.ts.
  let activeSeedConcept: string | null = null
  let seedColumnsAvailable = true
  if (user) {
    const { data: role } = await supabase
      .from('user_roles')
      .select('restaurant_id')
      .eq('user_id', user.id)
      .single()
    restaurantId = role?.restaurant_id ?? null
    if (restaurantId) {
      const probe = await supabase
        .from('restaurants')
        .select('active_seed_concept')
        .eq('id', restaurantId)
        .maybeSingle()
      if (probe.error?.code === '42703') {
        seedColumnsAvailable = false
        console.warn('[menu/page] seed migration not applied — concept filter disabled')
      } else {
        activeSeedConcept = (probe.data as { active_seed_concept?: string | null } | null)?.active_seed_concept ?? null
      }
    }
  }

  // Legacy cleanup: prior ingest revisions auto-created an "Imported
  // · Uncategorized" bucket for CSV/API imports without an upstream
  // category. That bucket is no longer created — items now land with
  // category_id = null and surface in the "Awaiting a section" band
  // below. This delete zaps any stragglers left by the old code
  // path so managers never see a fake category chip. FK is
  // `on delete set null`, so affected items reparent to null cleanly
  // and appear where the manager expects them (Awaiting).
  //
  // Cost: one indexed lookup on (restaurant_id, external_id).
  // Returns 0 rows in the steady state, so it's effectively free.
  if (restaurantId) {
    await supabase
      .from('menu_categories')
      .delete()
      .eq('restaurant_id', restaurantId)
      .eq('external_id', '__uncategorized__')
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

  // Defensive menu_items fetch.
  // The availability_override / set_at columns are part of an
  // additive migration that may not have been applied to every
  // environment yet. Postgres returns error 42703 ("column does not
  // exist") when those columns are missing; without this fallback,
  // `items` collapses to `null` and the whole menu reads as empty.
  // We try the rich select first and fall back to the base select if
  // those columns are missing — items still render, override just
  // defaults to 'none' for every row until the migration lands.
  // Seed filter helper. Strict semantics — only show rows whose
  // concept_key matches the active seed OR is NULL. Same as POS /
  // Inventory. Defensive: identity function when the migration
  // hasn't run so the menu doesn't blank.
  const applySeedFilter = <T extends { or: (s: string) => T; is: (col: string, val: null) => T }>(q: T): T => {
    if (!seedColumnsAvailable) return q
    if (activeSeedConcept) {
      return q.or(`concept_key.eq.${activeSeedConcept},concept_key.is.null`)
    }
    return q.is('concept_key', null)
  }

  async function fetchMenuItems() {
    const rich = await applySeedFilter(
      supabase
        .from('menu_items')
        .select('id, name, current_price, active, category_id, source, external_provider, availability_override, availability_override_set_at')
    ).order('name', { ascending: true })
    if (!rich.error) return { data: rich.data, hasOverrideColumns: true }

    // 42703 = undefined column. Any other error: surface it via the
    // console so a real failure (RLS, auth, etc.) doesn't disguise
    // itself as a "schema not migrated yet" fallback.
    if (rich.error.code !== '42703') {
      console.error('[menu/page] menu_items select failed:', rich.error)
    } else {
      console.warn('[menu/page] availability_override columns missing — falling back to base select. Run the schema migration to enable overrides.')
    }

    const base = await applySeedFilter(
      supabase
        .from('menu_items')
        .select('id, name, current_price, active, category_id, source, external_provider')
    ).order('name', { ascending: true })
    if (base.error) {
      console.error('[menu/page] menu_items base select failed:', base.error)
      return { data: null as null | unknown[], hasOverrideColumns: false }
    }
    return { data: base.data, hasOverrideColumns: false }
  }

  // Promise.all preserves the result shape per entry — keeping
  // recipe / inventory / setup as full results (not destructured)
  // so we can surface query errors in the diagnostic log instead
  // of silently swallowing them.
  const [
    categoriesRes,
    itemsResult,
    recipeRes,
    inventoryRes,
    setupRes,
    countsRes,
    transactionsRes,
  ] = await Promise.all([
    applySeedFilter(
      supabase
        .from('menu_categories')
        .select('id, name, sort_order, source, parent_id')
    )
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),

    fetchMenuItems(),

    // All recipe components with inventory item name + unit. The
    // top-level `unit` column is the RECIPE's own unit (nullable —
    // null means "same as the inventory item's unit_of_measure").
    supabase
      .from('recipe_components')
      .select('id, menu_item_id, inventory_item_id, quantity_required, unit, inventory_items ( name, unit_of_measure )')
      .order('created_at', { ascending: true }),

    // Active inventory items for the ingredient dropdown — also
    // filtered by seed so the dropdown matches the visible menu.
    applySeedFilter(
      supabase
        .from('inventory_items')
        .select('id, name, unit_of_measure')
        .eq('active', true)
    ).order('name', { ascending: true }),

    // Inventory activation gate. Projection logic is skipped entirely
    // when the bridge is not live so we never auto-disable items
    // before a baseline exists.
    supabase
      .from('restaurant_setup_state')
      .select('inventory_activated_at')
      .maybeSingle(),

    // Stock snapshot inputs. Same source rows the Inventory page uses.
    supabase
      .from('inventory_counts')
      .select('inventory_item_id, quantity_on_hand, count_date'),

    supabase
      .from('inventory_transactions')
      .select('inventory_item_id, quantity_change, transaction_datetime'),
  ])

  const categories = categoriesRes.data
  const recipeComponents = recipeRes.data
  const inventoryItems = inventoryRes.data
  const setupRow = setupRes.data
  const invCounts = countsRes.data
  const invTransactions = transactionsRes.data

  // Surface errors that previously hid behind null `data`. RLS-zero
  // rows are NOT errors, so this catches genuine failures only.
  if (recipeRes.error) console.error('[menu/page] recipe_components select failed:', recipeRes.error)
  if (inventoryRes.error) console.error('[menu/page] inventory_items select failed:', inventoryRes.error)
  if (countsRes.error) console.error('[menu/page] inventory_counts select failed:', countsRes.error)
  if (transactionsRes.error) console.error('[menu/page] inventory_transactions select failed:', transactionsRes.error)

  const items = itemsResult.data as Array<{
    id: string; name: string; current_price: number | string; active: boolean
    category_id: string | null; source: string
    /** Provider tag for items imported from an external POS — drives
     *  the "local-only" hint on the Menu drawer. */
    external_provider?: string | null
    availability_override?: string | null
    availability_override_set_at?: string | null
  }> | null

  // Visibility logs for "everything went empty" failure modes.
  // Greppable by `[menu/page] raw counts`.
  //
  // Diagnostic strategy:
  //   • Counts at every layer (so we can see where the chain breaks).
  //   • A direct ID-set intersection between the menu_items the app
  //     resolved and the menu_item_id values referenced by
  //     recipe_components — collapses "is RLS filtering one of the
  //     two tables to a different restaurant" and "is there a
  //     historical ID mismatch from a manual import" into one
  //     unambiguous match_count signal.
  //   • Three-id samples on both sides so a real mismatch is visible
  //     at a glance in the server console.
  //   • The app-resolved restaurant_id is included so it can be
  //     compared against the restaurant_id of the rows visible to a
  //     service-role query in the DB.
  const itemIdSet = new Set((items ?? []).map((i) => i.id))
  const recipeMenuItemIds = (recipeComponents ?? []).map((rc) => rc.menu_item_id as string)
  const distinctRecipeMenuItemIds = new Set(recipeMenuItemIds)
  const matchCount = [...distinctRecipeMenuItemIds].filter((id) => itemIdSet.has(id)).length

  console.info('[menu/page] raw counts', {
    user_id: user?.id ?? null,
    restaurant_id_resolved: restaurantId,
    categories: (categories ?? []).length,
    menu_items: items?.length ?? 0,
    recipe_components: (recipeComponents ?? []).length,
    distinct_menu_items_with_recipe: distinctRecipeMenuItemIds.size,
    match_count: matchCount,
    inventory_items: (inventoryItems ?? []).length,
    inventory_activated_at: setupRow?.inventory_activated_at ?? null,
    overrideColumnsPresent: itemsResult.hasOverrideColumns,
  })

  // Sample-id comparison — only logs when there's something to
  // compare AND the match is suspicious. Keeps the console quiet on
  // healthy loads.
  if ((items?.length ?? 0) > 0 && (recipeComponents ?? []).length > 0 && matchCount === 0) {
    console.warn('[menu/page] menu_items ↔ recipe_components ID MISMATCH', {
      sample_menu_item_ids: (items ?? []).slice(0, 5).map((i) => i.id),
      sample_recipe_menu_item_ids: [...distinctRecipeMenuItemIds].slice(0, 5),
    })
  }

  const inventoryActive = !!setupRow?.inventory_activated_at
  const stockSnapshot = computeStockSnapshot(invCounts, invTransactions)

  // Build recipe map: menu_item_id → components[]. `unit` here is
  // the recipe's own unit (may be null → treat as identity with the
  // inventory item's unit_of_measure at render time).
  const recipeMap = new Map<string, {
    id: string
    inventoryItemId: string
    inventoryItemName: string
    unitOfMeasure: string
    quantityRequired: number
    unit: string | null
  }[]>()

  for (const rc of recipeComponents ?? []) {
    const inv = rc.inventory_items as unknown as { name: string; unit_of_measure: string } | null
    const entry = {
      id: rc.id,
      inventoryItemId: rc.inventory_item_id,
      inventoryItemName: inv?.name ?? 'Unknown',
      unitOfMeasure: inv?.unit_of_measure ?? '',
      quantityRequired: Number(rc.quantity_required),
      unit: (rc.unit as string | null) ?? null,
    }
    if (!recipeMap.has(rc.menu_item_id)) recipeMap.set(rc.menu_item_id, [])
    recipeMap.get(rc.menu_item_id)!.push(entry)
  }

  // Inventory item id → display name (for surfacing the bottleneck
  // ingredient in the drawer's availability section).
  const inventoryNameById = new Map<string, string>()
  for (const ii of inventoryItems ?? []) {
    inventoryNameById.set(ii.id, ii.name)
  }
  // Recipes can also reference inactive inventory items, which are
  // filtered out of `inventoryItems`. Pull names from the recipe-join
  // payload as a fallback so bottleneck display still works.
  for (const rc of recipeComponents ?? []) {
    if (!inventoryNameById.has(rc.inventory_item_id)) {
      const inv = rc.inventory_items as unknown as { name: string } | null
      if (inv?.name) inventoryNameById.set(rc.inventory_item_id, inv.name)
    }
  }

  const menuItems = (items ?? []).map((item) => {
    const recipe = recipeMap.get(item.id) ?? []
    // `availability_override` may be undefined when the schema
    // migration hasn't been applied; default to 'none' so projection
    // still works and the drawer renders consistent state.
    const override = ((item.availability_override ?? null) as string | null ?? 'none') as AvailabilityOverride
    const availability = computeAvailability({
      active: item.active,
      recipe: recipe.map((r) => ({
        inventoryItemId: r.inventoryItemId,
        quantityRequired: r.quantityRequired,
      })),
      override,
      inventoryActive,
      stockByInventoryItemId: stockSnapshot.byInventoryItemId,
    })

    return {
      id: item.id,
      name: item.name,
      currentPrice: Number(item.current_price),
      active: item.active,
      categoryId: item.category_id,
      source: item.source,
      // null for native items; 'square' / 'clover' / etc. for items
      // imported from an external POS. The drawer uses this to
      // explain that our `active` toggle is local-only — the actual
      // "stop selling" decision lives in the external POS dashboard.
      externalProvider:
        (item.external_provider ?? null) as string | null,
      recipe,
      override,
      overrideSetAt: (item.availability_override_set_at ?? null) as string | null,
      projectedCount: availability.projectedCount,
      projectionState: availability.projectionState,
      effectiveSellability: availability.effectiveSellability,
      bottleneckInventoryItemName: availability.bottleneckInventoryItemId
        ? (inventoryNameById.get(availability.bottleneckInventoryItemId) ?? null)
        : null,
    }
  })

  // Cross-check: how many items the client will see as mapped.
  // If this is 0 while `recipe_components` > 0, the bridge broke at
  // attachment (e.g. ID mismatch). If both are 0, the DB has no
  // mapping rows from the user's restaurant.
  const itemsWithAttachedRecipe = menuItems.filter((m) => m.recipe.length > 0).length
  console.info('[menu/page] final items to client:', {
    total: menuItems.length,
    items_with_attached_recipe: itemsWithAttachedRecipe,
  })

  const externalConnections = (posConnections ?? []).map((c) => ({
    id: c.id,
    locationId: c.location_id,
    provider: c.provider,
    active: c.active,
    externalStoreId: c.external_store_id,
    lastMenuSyncAt: c.last_menu_sync_at,
    lastError: c.last_error,
  }))

  // ---- Empty-category filter ----
  // Drop auto-imported categories that have zero items — those are
  // noise from an external POS sync the manager hasn't engaged with.
  // User-created (or adopted) empty categories stay visible so the
  // manager can add items to them. A category is considered "auto-
  // imported" when `source = 'imported'`; adopted categories keep
  // the manager's original source (typically 'manual' or NULL).
  const categoryIdsWithItems = new Set(
    menuItems.map((i) => i.categoryId).filter((id): id is string => !!id),
  )
  const visibleCategories = (categories ?? []).filter((c) => {
    if (categoryIdsWithItems.has(c.id)) return true
    return c.source !== 'imported'
  })

  return (
    <MenuClient
      categories={visibleCategories.map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sort_order,
        parentId: (c.parent_id as string | null) ?? null,
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
      inventoryActive={inventoryActive}
      lang={lang}
    />
  )
}
