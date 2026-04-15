// ----------------------------------------------------------------
// Inventory Page  →  /inventory
//
// Server Component — fetches items, counts, transactions, and
// recipe link counts. Passes pre-computed data to the client.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import InventoryClient from './client'

export default async function InventoryPage() {
  const supabase = await createClient()

  const [
    { data: items },
    { data: counts },
    { data: allTransactions },
    { data: recentTransactions },
    { data: recipeCounts },
  ] = await Promise.all([
    supabase
      .from('inventory_items')
      .select('id, name, unit_of_measure, low_stock_threshold, active')
      .eq('active', true)
      .order('name', { ascending: true }),

    supabase
      .from('inventory_counts')
      .select(`
        id, inventory_item_id, quantity_on_hand, count_date,
        inventory_items ( name )
      `)
      .order('count_date', { ascending: false }),

    supabase
      .from('inventory_transactions')
      .select('inventory_item_id, quantity_change, transaction_datetime'),

    supabase
      .from('inventory_transactions')
      .select(`
        id, inventory_item_id, transaction_type, quantity_change,
        reference_note, transaction_datetime,
        inventory_items ( name )
      `)
      .order('transaction_datetime', { ascending: false })
      .limit(20),

    // Count recipe links per inventory item
    supabase
      .from('recipe_components')
      .select('inventory_item_id'),
  ])

  // Latest count per item
  const latestCount = new Map<string, { qty: number; date: string }>()
  for (const c of counts ?? []) {
    if (!latestCount.has(c.inventory_item_id)) {
      latestCount.set(c.inventory_item_id, { qty: Number(c.quantity_on_hand), date: c.count_date })
    }
  }

  // Post-count transaction sums
  const postCountSum = new Map<string, number>()
  for (const tx of allTransactions ?? []) {
    const count = latestCount.get(tx.inventory_item_id)
    if (!count) continue
    if (new Date(tx.transaction_datetime) > new Date(count.date)) {
      postCountSum.set(tx.inventory_item_id, (postCountSum.get(tx.inventory_item_id) ?? 0) + Number(tx.quantity_change))
    }
  }

  // Recipe link count per item
  const recipeCountMap = new Map<string, number>()
  for (const rc of recipeCounts ?? []) {
    recipeCountMap.set(rc.inventory_item_id, (recipeCountMap.get(rc.inventory_item_id) ?? 0) + 1)
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

  const inventoryItems = (items ?? []).map((item) => {
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
    }
  })

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

  type FeedEntry = { id: string; itemName: string; type: string; qty: number; note: string | null; date: string }

  const txEntries: FeedEntry[] = (recentTransactions ?? []).map((tx) => ({
    id: `tx:${tx.id}`,
    itemName: (tx.inventory_items as unknown as { name: string } | null)?.name ?? '—',
    type: tx.transaction_type,
    qty: Number(tx.quantity_change),
    note: tx.reference_note,
    date: tx.transaction_datetime,
  }))

  const countEntries: FeedEntry[] = (counts ?? []).map((c) => ({
    id: `ct:${c.id}`,
    itemName: (c.inventory_items as unknown as { name: string } | null)?.name ?? '—',
    type: firstCountId.get(c.inventory_item_id) === c.id ? 'initial_count' : 'count',
    qty: Number(c.quantity_on_hand),
    note: null,
    date: c.count_date,
  }))

  const activity = [...txEntries, ...countEntries]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 20)

  return <InventoryClient items={inventoryItems} transactions={activity} />
}
