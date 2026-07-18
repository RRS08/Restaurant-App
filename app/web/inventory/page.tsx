// ----------------------------------------------------------------
// Web-native Inventory  →  /web/inventory
//
// Phase 2 deliverable. The web-native version of the inventory
// surface, designed to feel like a continuation of the marketing
// site rather than a tablet-shell dashboard. Type-led top-down
// reading flow:
//
//   eyebrow → headline → short summary
//   status snapshot strip (OUT · LOW · NO COUNT · OK counts)
//   items list (sorted by urgency, status-dot per row)
//
// Deferred to later phases:
//   - Restock-orders workflow (cart, drawer, batch close)
//   - Duplicate detection + manual merge UI
//   - Archived-in-recipes auto-repair UI
//   - Item edit drawer (counts, threshold updates, archive)
//   - Activity feed
//
// All of those still live in the classic /inventory route — the
// avatar dropdown's "Switch to classic view" gets the owner there
// when they need to edit. This page is the type-led DISPLAY of the
// inventory state. Editing surfaces ship as the module deepens.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import WebInventoryClient from './client'

export default async function WebInventoryPage() {
  const supabase = await createClient()
  const lang = await getLang()

  // Demo seed switcher — mirrors the classic /inventory route so
  // the same active concept gates which items show up here. Without
  // this, switching seeds would only affect the classic view, and
  // the web-native page would silently show stale items.
  const {
    data: { user },
  } = await supabase.auth.getUser()
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
      } else {
        activeSeedConcept =
          (probe.data as { active_seed_concept?: string | null } | null)?.active_seed_concept ?? null
      }
    }
  }

  const itemsQuery = supabase
    .from('inventory_items')
    .select('id, name, unit_of_measure, low_stock_threshold, active')
  const filteredItemsQuery = !seedColumnsAvailable
    ? itemsQuery
    : activeSeedConcept
      ? itemsQuery.or(`concept_key.eq.${activeSeedConcept},concept_key.is.null`)
      : itemsQuery.is('concept_key', null)

  // Fetch the data the list page + focused card need:
  //   - items (active only)
  //   - counts (to derive last-known stock per item)
  //   - transactions (for both the estimated-stock math AND the
  //     "Recent movement" section inside the focused card)
  //   - recipe_components (joined to menu_items) → drives the
  //     "Used in" section inside the focused card
  //
  // The whole transactions array is passed through to the client so
  // the focused card can filter per-item without a second round-trip
  // when the user clicks a row.
  const [
    { data: items },
    { data: counts },
    { data: allTransactions },
    { data: recipeLinks },
  ] = await Promise.all([
    filteredItemsQuery.order('name', { ascending: true }),
    supabase
      .from('inventory_counts')
      .select('inventory_item_id, quantity_on_hand, count_date')
      .order('count_date', { ascending: false }),
    supabase
      .from('inventory_transactions')
      .select('id, inventory_item_id, transaction_type, quantity_change, reference_note, transaction_datetime')
      .order('transaction_datetime', { ascending: false })
      .limit(5000),
    supabase
      .from('recipe_components')
      .select(`
        inventory_item_id,
        quantity_required,
        menu_items ( id, name, active )
      `),
  ])

  // Latest count per item — mirrors classic route logic.
  const latestCount = new Map<string, { qty: number; date: string }>()
  for (const c of counts ?? []) {
    if (!latestCount.has(c.inventory_item_id)) {
      latestCount.set(c.inventory_item_id, {
        qty: Number(c.quantity_on_hand),
        date: c.count_date,
      })
    }
  }

  // Post-count transaction sums. `>=` matches the classic route's
  // tolerance for JS-ms precision collisions between a count's
  // timestamp and an immediately-following sale.
  const postCountSum = new Map<string, number>()
  for (const tx of allTransactions ?? []) {
    const count = latestCount.get(tx.inventory_item_id)
    if (!count) continue
    if (
      new Date(tx.transaction_datetime).getTime() >= new Date(count.date).getTime()
    ) {
      postCountSum.set(
        tx.inventory_item_id,
        (postCountSum.get(tx.inventory_item_id) ?? 0) + Number(tx.quantity_change),
      )
    }
  }

  // Build per-item menu dependencies once. Each inventory item gets
  // a list of active menu items whose recipes consume it, with the
  // per-sale quantity. Sorted alphabetically for predictable
  // display inside the focused card.
  type MenuDep = { menuItemId: string; menuItemName: string; quantityRequired: number }
  const menuDepsByItem = new Map<string, MenuDep[]>()
  type RC = {
    inventory_item_id: string
    quantity_required: number
    menu_items: { id: string; name: string; active: boolean } | null
  }
  for (const rc of (recipeLinks ?? []) as unknown as RC[]) {
    if (!rc.menu_items || !rc.menu_items.active) continue
    const list = menuDepsByItem.get(rc.inventory_item_id) ?? []
    list.push({
      menuItemId: rc.menu_items.id,
      menuItemName: rc.menu_items.name,
      quantityRequired: Number(rc.quantity_required ?? 0),
    })
    menuDepsByItem.set(rc.inventory_item_id, list)
  }
  for (const list of menuDepsByItem.values()) {
    list.sort((a, b) => a.menuItemName.localeCompare(b.menuItemName))
  }

  // Shape rows for the client. Status logic matches the classic
  // route bucket-for-bucket so the two surfaces never disagree.
  const inventoryItems = (items ?? [])
    .filter((i) => i.active)
    .map((item) => {
      const count = latestCount.get(item.id)
      const txSum = postCountSum.get(item.id) ?? 0
      const threshold = Number(item.low_stock_threshold)
      const estimated = count ? count.qty + txSum : null

      let status: 'no_count' | 'out' | 'low' | 'ok'
      if (estimated === null) status = 'no_count'
      else if (estimated <= 0) status = 'out'
      else if (estimated <= threshold) status = 'low'
      else status = 'ok'

      return {
        id: item.id,
        name: item.name,
        unitOfMeasure: item.unit_of_measure as string,
        threshold,
        estimated,
        lastCount: count?.qty ?? null,
        lastCountDate: count?.date ?? null,
        status,
        menuItems: menuDepsByItem.get(item.id) ?? [],
      }
    })

  // Compact transaction shape passed to the client. The focused card
  // filters this list by inventory_item_id when it opens. Keeps the
  // server doing the heavy lift; the client only filters + slices.
  const transactionsForClient = (allTransactions ?? []).map((tx) => ({
    id: tx.id as string,
    inventoryItemId: tx.inventory_item_id as string,
    type: tx.transaction_type as string,
    quantity: Number(tx.quantity_change),
    note: (tx.reference_note as string | null) ?? null,
    date: tx.transaction_datetime as string,
  }))

  // Build the counts feed too — counts and transactions interleave
  // in the "Recent movement" section so the manager sees both kinds
  // of stock events in one timeline.
  const countsForClient = (counts ?? []).map((c) => ({
    id: `ct:${c.inventory_item_id}:${c.count_date}`,
    inventoryItemId: c.inventory_item_id as string,
    quantity: Number(c.quantity_on_hand),
    date: c.count_date as string,
  }))

  return (
    <WebInventoryClient
      items={inventoryItems}
      transactions={transactionsForClient}
      inventoryCounts={countsForClient}
      lang={lang}
    />
  )
}
