// ----------------------------------------------------------------
// Stock-on-hand snapshot
//
// Single helper that turns raw `inventory_counts` + `inventory_transactions`
// rows into a per-item current-stock estimate. Same rule the Inventory
// page already uses inline:
//
//   estimated stock = latest count quantity
//                   + sum of every transaction posted AFTER that count
//
// An inventory item with no count at all is left out of the snapshot —
// callers should treat "no entry" as "stock unknown" rather than zero
// (so the menu projection layer can mark mapped items as
// `unavailable_to_project` instead of auto-disabling them).
//
// Kept in lib/inventory so menu projection (lib/menu/availability) and
// any future intelligence layer (sales velocity, lead-time-aware
// thresholds) can both read from one canonical computation.
// ----------------------------------------------------------------

export interface InventoryCountRow {
  inventory_item_id: string
  quantity_on_hand: number | string
  count_date: string
}

export interface InventoryTransactionRow {
  inventory_item_id: string
  quantity_change: number | string
  transaction_datetime: string
}

export interface StockSnapshot {
  /** inventory_item_id → estimated current stock-on-hand. */
  byInventoryItemId: Map<string, number>
  /** Convenience helper — `null` for items with no recorded count. */
  get(inventoryItemId: string): number | null
}

export function computeStockSnapshot(
  counts: InventoryCountRow[] | null | undefined,
  transactions: InventoryTransactionRow[] | null | undefined
): StockSnapshot {
  const latestCount = new Map<string, { qty: number; dateMs: number }>()
  for (const c of counts ?? []) {
    const dateMs = new Date(c.count_date).getTime()
    const existing = latestCount.get(c.inventory_item_id)
    if (!existing || dateMs > existing.dateMs) {
      latestCount.set(c.inventory_item_id, { qty: Number(c.quantity_on_hand), dateMs })
    }
  }

  const postCountSum = new Map<string, number>()
  for (const tx of transactions ?? []) {
    const count = latestCount.get(tx.inventory_item_id)
    if (!count) continue
    // `>=` not `>` — JS Date truncates timestamptz microseconds to ms,
    // and a baseline count followed by a same-instant POS sale would
    // otherwise be dropped from the post-count sum. See the matching
    // comment in app/(app)/inventory/page.tsx. Keeps Menu/POS
    // projection consistent with the Inventory page's stock estimate.
    if (new Date(tx.transaction_datetime).getTime() >= count.dateMs) {
      postCountSum.set(
        tx.inventory_item_id,
        (postCountSum.get(tx.inventory_item_id) ?? 0) + Number(tx.quantity_change)
      )
    }
  }

  const byInventoryItemId = new Map<string, number>()
  for (const [id, c] of latestCount) {
    byInventoryItemId.set(id, c.qty + (postCountSum.get(id) ?? 0))
  }

  return {
    byInventoryItemId,
    get(inventoryItemId: string): number | null {
      return byInventoryItemId.has(inventoryItemId)
        ? byInventoryItemId.get(inventoryItemId)!
        : null
    },
  }
}
