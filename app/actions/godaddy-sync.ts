'use server'

// ----------------------------------------------------------------
// GoDaddy Poynt — "Sync now" server action
//
// Manual pull triggered by the Settings card. Two data sources
// combined into one click:
//
//   1. /orders       — online storefront + POS orders that
//                       created full Order objects.
//   2. /transactions — terminal / Virtual Terminal / MOTO
//                       charges that don't create Order objects
//                       (Poynt terminal payments live here).
//
// Both get normalized and handed to the shared ingest pipeline.
// Idempotent thanks to dedupe on (provider, external_id) —
// re-clicking Sync now is safe.
//
// Owner-gated; the shared helpers are auth-agnostic so a webhook
// invocation can reuse them without threading a user session
// through.
// ----------------------------------------------------------------

import { getAuthContext } from '@/lib/auth'
import { fetchPoyntOrders, fetchPoyntTransactions } from '@/lib/godaddy/api'
import { ingestPoyntOrders, ingestPoyntTransactions, type IngestBatchResult } from '@/lib/godaddy/ingest'
import { createAdminClient } from '@/lib/supabase/admin'

export type SyncResult = IngestBatchResult

const EMPTY: SyncResult = {
  ordersInserted: 0,
  ordersSkipped: 0,
  ordersFailed: 0,
  placeholdersCreated: 0,
  inventoryDepletionsWritten: 0,
  channelBreakdown: { pos: 0, online: 0 },
  notes: [],
  error: null,
}

export async function syncGodaddyOrders(): Promise<SyncResult> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { ...EMPTY, error: authError ?? 'Authentication error.' }
  if (ctx.role !== 'owner') return { ...EMPTY, error: 'Only the owner can trigger a sync.' }

  const supabase = createAdminClient()
  const merged: SyncResult = { ...EMPTY, channelBreakdown: { pos: 0, online: 0 }, notes: [] }

  // 1. /orders — online + Order-shaped POS sales.
  //    Wrapped so an unhandled throw here can't kill the whole
  //    action — /transactions still gets a chance to run.
  try {
    const pullOrders = await fetchPoyntOrders({ restaurantId: ctx.restaurantId, maxOrders: 1000 })
    if ('error' in pullOrders) {
      merged.notes.push(`/orders fetch failed: ${pullOrders.error}`)
    } else {
      const r = await ingestPoyntOrders({
        supabase, restaurantId: ctx.restaurantId, raw: pullOrders.orders,
      })
      mergeIn(merged, r)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[godaddy/sync] /orders leg threw', err)
    merged.notes.push(`/orders leg threw: ${msg}`)
  }

  // 2. /transactions — terminal charges that skip the Order table.
  //    Critical for merchants (Hatziri) who use the Poynt terminal
  //    heavily; without this we miss all in-person card sales.
  //    Same defensive wrap — an unexpected shape from Poynt on this
  //    endpoint shouldn't undo the /orders leg's work.
  try {
    const pullTx = await fetchPoyntTransactions({ restaurantId: ctx.restaurantId, maxTransactions: 1000 })
    if ('error' in pullTx) {
      merged.notes.push(`/transactions fetch failed: ${pullTx.error}`)
    } else {
      const r = await ingestPoyntTransactions({
        supabase, restaurantId: ctx.restaurantId, raw: pullTx.transactions,
      })
      mergeIn(merged, r)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[godaddy/sync] /transactions leg threw', err)
    merged.notes.push(`/transactions leg threw: ${msg}`)
  }

  return merged
}

function mergeIn(target: SyncResult, src: SyncResult) {
  target.ordersInserted += src.ordersInserted
  target.ordersSkipped += src.ordersSkipped
  target.ordersFailed += src.ordersFailed
  target.placeholdersCreated += src.placeholdersCreated
  target.inventoryDepletionsWritten += src.inventoryDepletionsWritten
  target.channelBreakdown.pos += src.channelBreakdown.pos
  target.channelBreakdown.online += src.channelBreakdown.online
  target.notes.push(...src.notes)
  if (src.error && !target.error) target.error = src.error
}
