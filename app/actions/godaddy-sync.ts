'use server'

// ----------------------------------------------------------------
// GoDaddy Poynt — "Sync now" server action
//
// Manual pull triggered by the Settings card. Pulls up to 200
// recent orders across POS + online in one shot and hands them to
// the shared ingest helper (`lib/godaddy/ingest.ts`), which is also
// used by the webhook route. Idempotent thanks to dedupe on
// (provider, external_id).
//
// Owner-gated; the shared helper is auth-agnostic so a webhook
// invocation can reuse it without threading a user session
// through.
// ----------------------------------------------------------------

import { getAuthContext } from '@/lib/auth'
import { fetchPoyntOrders } from '@/lib/godaddy/api'
import { ingestPoyntOrders, type IngestBatchResult } from '@/lib/godaddy/ingest'
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

  const pull = await fetchPoyntOrders({ restaurantId: ctx.restaurantId, maxOrders: 200 })
  if ('error' in pull) return { ...EMPTY, error: pull.error }

  return await ingestPoyntOrders({
    supabase: createAdminClient(),
    restaurantId: ctx.restaurantId,
    raw: pull.orders,
  })
}
