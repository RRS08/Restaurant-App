// ----------------------------------------------------------------
// Inventory Page  →  /inventory
//
// Server Component — fetches items, counts, transactions, and
// recipe link counts. Passes pre-computed data to the client.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import InventoryClient from './client'

export default async function InventoryPage() {
  const supabase = await createClient()
  const lang = await getLang()

  // Demo seed switcher — see app/(app)/pos/page.tsx for the full
  // explanation. Resolves the caller's restaurant + its active
  // concept so we can filter inventory_items below.
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
      if (probe.error?.code === '42703') {
        seedColumnsAvailable = false
        console.warn('[inventory/page] seed migration not applied — concept filter disabled')
      } else {
        activeSeedConcept = (probe.data as { active_seed_concept?: string | null } | null)?.active_seed_concept ?? null
      }
    }
  }

  // Strict seed filter: concept_key matches the active concept
  // OR is NULL (real customer data). When nothing is active, only
  // untagged rows surface. See app/actions/seed.ts. Skipped when
  // the migration hasn't run yet, so the existing inventory
  // never disappears just because the column is missing.
  const itemsQuery = supabase
    .from('inventory_items')
    .select('id, name, unit_of_measure, low_stock_threshold, active')
  const filteredItemsQuery = !seedColumnsAvailable
    ? itemsQuery
    : activeSeedConcept
      ? itemsQuery.or(`concept_key.eq.${activeSeedConcept},concept_key.is.null`)
      : itemsQuery.is('concept_key', null)

  const [
    { data: items },
    { data: counts },
    { data: allTransactions },
    { data: recentTransactions },
    { data: recipeCounts },
    { data: restockOrders },
    { data: closedRestockOrders },
  ] = await Promise.all([
    // Drop the active filter so the duplicate detection + manual
    // merge drawer can see archived rows too. The page-level item
    // list (table) re-filters to active before render below.
    filteredItemsQuery.order('name', { ascending: true }),

    supabase
      .from('inventory_counts')
      .select(`
        id, inventory_item_id, quantity_on_hand, count_date,
        inventory_items ( name )
      `)
      .order('count_date', { ascending: false }),

    // Order DESC + bump limit defensively. PostgREST defaults to a
    // 1000-row page when no order is specified — if a dev DB ever
    // accumulates more rows, the latest depletion transactions could
    // silently drop out of this page and the estimated stock would
    // stop reflecting them. Latest-first ordering guarantees we
    // always see recent depletion first.
    supabase
      .from('inventory_transactions')
      .select('inventory_item_id, quantity_change, transaction_datetime')
      .order('transaction_datetime', { ascending: false })
      .limit(5000),

    supabase
      .from('inventory_transactions')
      .select(`
        id, inventory_item_id, transaction_type, quantity_change,
        reference_note, transaction_datetime,
        inventory_items ( name )
      `)
      .order('transaction_datetime', { ascending: false })
      .limit(20),

    // Count recipe links per inventory item AND surface the linked
    // menu_items so the item drawer can render "Used in menu items"
    // without a second round-trip. The join is cheap — recipe_components
    // is small relative to orders/transactions, and we already pay for
    // the fetch to count links.
    supabase
      .from('recipe_components')
      .select(`
        inventory_item_id,
        quantity_required,
        menu_items ( id, name, active )
      `),

    // Active restock orders (draft + ordered) — drives the cart's
    // staging area and the Pending Orders section of the Restock
    // Orders drawer.
    supabase
      .from('restock_orders')
      .select('id, inventory_item_id, quantity, vendor, expected_cost, expected_date, notes, status, ordered_at, created_at')
      .in('status', ['draft', 'ordered'])
      .order('created_at', { ascending: false }),

    // Closed restock orders — `received` and `canceled` lines that
    // were actually placed (ordered_at IS NOT NULL). Powers:
    //   • The Closed Orders section in the Restock Orders drawer.
    //   • Partial-receipt detection for Pending Orders — a still-
    //     ordered line whose batch (shared ordered_at) has sibling
    //     `received` rows here is the "Partially received" state.
    //
    // received_quantity is joined off the linked inventory_transaction
    // so the drawer can render "Ordered 10 · Received 7" without a
    // second round-trip. Canceled lines carry no transaction; their
    // received_quantity is null and the drawer reads them as
    // "Closed short."
    //
    // Limited to the most recent 300 closed lines — generous enough
    // to cover real-world partial-receipt spans and to populate the
    // Closed Orders preview, but bounded so the payload stays small
    // as historical activity accumulates.
    supabase
      .from('restock_orders')
      .select(`
        id, inventory_item_id, quantity, vendor, expected_cost, expected_date, notes,
        status, ordered_at, received_at, canceled_at, created_at,
        received_transaction:inventory_transactions!received_transaction_id ( quantity_change )
      `)
      .in('status', ['received', 'canceled'])
      .not('ordered_at', 'is', null)
      .order('ordered_at', { ascending: false })
      .limit(300),
  ])

  // Latest count per item
  const latestCount = new Map<string, { qty: number; date: string }>()
  for (const c of counts ?? []) {
    if (!latestCount.has(c.inventory_item_id)) {
      latestCount.set(c.inventory_item_id, { qty: Number(c.quantity_on_hand), date: c.count_date })
    }
  }

  // Post-count transaction sums.
  //
  // Strict `>` was dropping post-count sales whose `transaction_datetime`
  // shared a JS-millisecond with `count_date`. Two reasons that can
  // happen even though both DB columns have microsecond precision:
  //   1. JS `new Date(...)` truncates timestamptz precision to ms, so
  //      distinct DB timestamps that differ only in microseconds compare
  //      as equal in JS.
  //   2. A baseline count followed immediately by a POS sale can land
  //      within the same wall-clock millisecond during dev testing.
  // `>=` is correct: a transaction recorded at or after the count
  // timestamp is post-count by definition, and we never double-count
  // the count itself (the count row isn't in `allTransactions`).
  const postCountSum = new Map<string, number>()
  for (const tx of allTransactions ?? []) {
    const count = latestCount.get(tx.inventory_item_id)
    if (!count) continue
    if (new Date(tx.transaction_datetime).getTime() >= new Date(count.date).getTime()) {
      postCountSum.set(tx.inventory_item_id, (postCountSum.get(tx.inventory_item_id) ?? 0) + Number(tx.quantity_change))
    }
  }

  // Recipe link count per item
  const recipeCountMap = new Map<string, number>()
  for (const rc of recipeCounts ?? []) {
    recipeCountMap.set(rc.inventory_item_id, (recipeCountMap.get(rc.inventory_item_id) ?? 0) + 1)
  }

  // Mapped menu items per inventory item — surfaces "Used in menu
  // items" inside the drawer. We filter inactive menu_items out so
  // the drawer doesn't list archived dishes as "active dependents".
  // Sorted by menu item name for predictable display.
  type MenuItemDep = { menuItemId: string; menuItemName: string; quantityRequired: number }
  const menuItemDepsMap = new Map<string, MenuItemDep[]>()
  for (const rc of recipeCounts ?? []) {
    const mi = rc.menu_items as unknown as { id: string; name: string; active: boolean } | null
    if (!mi || !mi.active) continue
    const list = menuItemDepsMap.get(rc.inventory_item_id) ?? []
    list.push({
      menuItemId: mi.id,
      menuItemName: mi.name,
      quantityRequired: Number(rc.quantity_required ?? 0),
    })
    menuItemDepsMap.set(rc.inventory_item_id, list)
  }
  for (const deps of menuItemDepsMap.values()) {
    deps.sort((a, b) => a.menuItemName.localeCompare(b.menuItemName))
  }

  // Transaction count per item (for delete safety check display)
  const txCountMap = new Map<string, number>()
  for (const tx of allTransactions ?? []) {
    txCountMap.set(tx.inventory_item_id, (txCountMap.get(tx.inventory_item_id) ?? 0) + 1)
  }

  // Count count per item
  const countCountMap = new Map<string, number>()
  for (const c of counts ?? []) {
    countCountMap.set(c.inventory_item_id, (countCountMap.get(c.inventory_item_id) ?? 0) + 1)
  }

  // Table renders active items only — the duplicate detection and
  // manual merge drawer use the broader (active+archived) list above.
  const inventoryItems = (items ?? []).filter((i) => i.active).map((item) => {
    const count = latestCount.get(item.id)
    const txSum = postCountSum.get(item.id) ?? 0
    const threshold = Number(item.low_stock_threshold)
    const estimated = count ? count.qty + txSum : null
    const recipeLinks = recipeCountMap.get(item.id) ?? 0
    const txCount = txCountMap.get(item.id) ?? 0
    const countCount = countCountMap.get(item.id) ?? 0
    const hasDependencies = recipeLinks > 0 || txCount > 0 || countCount > 0

    let status: 'no_count' | 'out' | 'low' | 'ok'
    if (estimated === null) status = 'no_count'
    else if (estimated <= 0) status = 'out'
    else if (estimated <= threshold) status = 'low'
    else status = 'ok'

    return {
      id: item.id,
      name: item.name,
      unitOfMeasure: item.unit_of_measure,
      threshold,
      estimated,
      lastCount: count?.qty ?? null,
      status,
      recipeLinks,
      hasDependencies,
      menuItems: menuItemDepsMap.get(item.id) ?? [],
    }
  })

  // Duplicate-name detection — broadened.
  //
  // Catches three cases:
  //   (a) 2+ active items sharing a normalized name.
  //   (b) 1 active + 1+ archived items sharing a name where the
  //       archived row still has dependencies (counts / recipes /
  //       transactions). The previous check missed (b), which is
  //       what hides depletion when one duplicate has been archived
  //       manually but its old recipe link or count is still alive.
  //   (c) (skipped) all-archived groups — invisible, no impact.
  //
  // Dep checks reuse the maps already built above (recipeCountMap,
  // txCountMap, countCountMap), all of which are keyed by
  // inventory_item_id regardless of the item's active state.
  const itemsHasDeps = (id: string): boolean =>
    (recipeCountMap.get(id) ?? 0) > 0 ||
    (txCountMap.get(id) ?? 0) > 0 ||
    (countCountMap.get(id) ?? 0) > 0

  const dupNameMap = new Map<string, {
    displayName: string
    activeCount: number
    archivedCount: number
    members: { id: string; active: boolean }[]
  }>()
  for (const item of items ?? []) {
    const key = item.name.trim().toLowerCase()
    let group = dupNameMap.get(key)
    if (!group) {
      group = { displayName: item.name.trim(), activeCount: 0, archivedCount: 0, members: [] }
      dupNameMap.set(key, group)
    }
    if (item.active) group.activeCount += 1
    else group.archivedCount += 1
    group.members.push({ id: item.id, active: item.active })
  }

  const duplicateGroups = [...dupNameMap.values()]
    .filter((g) => {
      if (g.members.length < 2) return false
      if (g.activeCount === 0) return false // invisible — nothing to nag about
      if (g.activeCount >= 2) return true   // case (a)
      // case (b): exactly one active — check whether any archived
      // member still has live deps.
      return g.members.some((m) => !m.active && itemsHasDeps(m.id))
    })
    .map((g) => ({ displayName: g.displayName, count: g.members.length }))

  // All-item snapshot for the manual merge drawer (active + archived).
  // Keeps the merge picker functional even when the auto-banner
  // doesn't fire (e.g., the user has already archived one duplicate).
  const mergeableItems = (items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    active: item.active,
  }))

  // Archived-in-recipes detection.
  //
  // An archived inventory_item that's still referenced by a
  // recipe_component is the root cause of "POS sales create
  // depletion writes but inventory movement isn't visible." The
  // integrity check now auto-repairs this state (reactivates the
  // archived rows); we surface the count + names to the client so a
  // banner can offer one-click resolution without forcing the user
  // to dig through Settings.
  const itemById = new Map<string, { name: string; active: boolean }>()
  for (const item of items ?? []) {
    itemById.set(item.id, { name: item.name, active: item.active })
  }
  const archivedInRecipeNames = new Set<string>()
  for (const rc of recipeCounts ?? []) {
    const inv = itemById.get(rc.inventory_item_id)
    if (inv && !inv.active) {
      archivedInRecipeNames.add(inv.name)
    }
  }
  const archivedInRecipes = [...archivedInRecipeNames]

  // Per-item diagnostic — surfaces the exact numbers behind every
  // estimated-stock value. If two inventory_items share a name (a
  // common testing accident) both rows print, making the
  // mapping-vs-counted-on-the-wrong-one case obvious. Greppable by
  // `[inventory/page] stock`.
  console.info('[inventory/page] stock totals', {
    total_items: (items ?? []).length,
    active_items: (items ?? []).filter((i) => i.active).length,
    archived_items: (items ?? []).filter((i) => !i.active).length,
    counts: (counts ?? []).length,
    all_transactions: (allTransactions ?? []).length,
    duplicate_groups: duplicateGroups.length,
  })
  for (const row of inventoryItems) {
    const c = latestCount.get(row.id)
    const txForItem = (allTransactions ?? []).filter((t) => t.inventory_item_id === row.id)
    const postCountTxForItem = txForItem.filter((t) =>
      c ? new Date(t.transaction_datetime).getTime() >= new Date(c.date).getTime() : false
    )
    console.info('[inventory/page] stock item', {
      id: row.id,
      name: row.name,
      last_count_qty: c?.qty ?? null,
      last_count_date: c?.date ?? null,
      tx_total: txForItem.length,
      tx_post_count: postCountTxForItem.length,
      tx_post_count_sum: postCountSum.get(row.id) ?? 0,
      estimated: row.estimated,
      status: row.status,
    })
  }

  // Build the unified activity feed: transactions + counts (with
  // the earliest count per item tagged as "initial_count" so it
  // reads as a distinct "inventory tracking started" event).
  const firstCountId = new Map<string, string>() // item id → oldest count id
  const oldestCountAt = new Map<string, string>()
  for (const c of counts ?? []) {
    const existing = oldestCountAt.get(c.inventory_item_id)
    if (!existing || new Date(c.count_date) < new Date(existing)) {
      oldestCountAt.set(c.inventory_item_id, c.count_date)
      firstCountId.set(c.inventory_item_id, c.id)
    }
  }

  // FeedEntry carries the originating inventory_item_id so the
  // selected-item rail can filter movement to just the active
  // item without a second round-trip. The global activity feed
  // ignores it.
  type FeedEntry = {
    id: string
    inventoryItemId: string
    itemName: string
    type: string
    qty: number
    note: string | null
    date: string
  }

  const txEntries: FeedEntry[] = (recentTransactions ?? []).map((tx) => ({
    id: `tx:${tx.id}`,
    inventoryItemId: tx.inventory_item_id,
    itemName: (tx.inventory_items as unknown as { name: string } | null)?.name ?? '—',
    type: tx.transaction_type,
    qty: Number(tx.quantity_change),
    note: tx.reference_note,
    date: tx.transaction_datetime,
  }))

  const countEntries: FeedEntry[] = (counts ?? []).map((c) => ({
    id: `ct:${c.id}`,
    inventoryItemId: c.inventory_item_id,
    itemName: (c.inventory_items as unknown as { name: string } | null)?.name ?? '—',
    type: firstCountId.get(c.inventory_item_id) === c.id ? 'initial_count' : 'count',
    qty: Number(c.quantity_on_hand),
    note: null,
    date: c.count_date,
  }))

  const activity = [...txEntries, ...countEntries]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 20)

  // Shape active restock orders for the client (draft + ordered).
  // These drive the Cart's staging area and Pending Orders.
  const restockOrdersForClient = (restockOrders ?? []).map((o) => ({
    id: o.id,
    inventoryItemId: o.inventory_item_id,
    quantity: Number(o.quantity),
    vendor: o.vendor as string | null,
    expectedCost: o.expected_cost !== null && o.expected_cost !== undefined ? Number(o.expected_cost) : null,
    expectedDate: (o.expected_date as string | null) ?? null,
    notes: o.notes as string | null,
    status: o.status as 'draft' | 'ordered',
    orderedAt: (o.ordered_at as string | null) ?? null,
    receivedAt: null,
    canceledAt: null,
    receivedQuantity: null,
    createdAt: o.created_at as string,
  }))

  // Shape closed restock orders for the client (received + canceled
  // with ordered_at set). The Restock Orders drawer uses these for:
  //   • Closed Orders section (rendered as one card per batch).
  //   • Partial-receipt detection — a pending batch whose ordered_at
  //     matches a received sibling here is "Partially received".
  //
  // receivedQuantity is read off the linked inventory_transaction's
  // quantity_change. Canceled lines (closed short, or canceled at
  // draft time then somehow re-promoted) carry null — the drawer
  // renders that as "Closed short."
  const closedRestockOrdersForClient = (closedRestockOrders ?? []).map((o) => {
    const tx = (o.received_transaction as unknown as { quantity_change: number } | null)
    return {
      id: o.id,
      inventoryItemId: o.inventory_item_id,
      quantity: Number(o.quantity),
      vendor: o.vendor as string | null,
      expectedCost: o.expected_cost !== null && o.expected_cost !== undefined ? Number(o.expected_cost) : null,
      expectedDate: (o.expected_date as string | null) ?? null,
      notes: o.notes as string | null,
      status: o.status as 'received' | 'canceled',
      orderedAt: (o.ordered_at as string | null) ?? null,
      receivedAt: (o.received_at as string | null) ?? null,
      canceledAt: (o.canceled_at as string | null) ?? null,
      receivedQuantity: tx ? Number(tx.quantity_change) : null,
      createdAt: o.created_at as string,
    }
  })

  return (
    <InventoryClient
      items={inventoryItems}
      transactions={activity}
      restockOrders={restockOrdersForClient}
      closedRestockOrders={closedRestockOrdersForClient}
      duplicateGroups={duplicateGroups}
      mergeableItems={mergeableItems}
      archivedInRecipes={archivedInRecipes}
      lang={lang}
    />
  )
}
