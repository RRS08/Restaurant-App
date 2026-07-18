'use server'

// ----------------------------------------------------------------
// External POS reset — provider-parameterized dev tool.
//
// Owner-only. Wipes everything the named provider's import created
// for the current restaurant:
//   • connection row(s) in external_pos_connections
//   • auto-created menu_categories  (source = 'imported')
//   • adopted menu_categories       (source != 'imported') get
//                                    UNBOUND, not deleted — the
//                                    manager's original category
//                                    row stays, we just clear the
//                                    external_provider + external_id
//                                    so a future re-sync can re-adopt
//   • menu_items with this provider (all import-provenance)
//   • orders with this provider     (cascade order_items via FK)
//   • order_items from native orders that referenced provider items —
//     these are cleared individually before menu_items can be deleted
//     because the order_items.menu_item_id FK is ON DELETE RESTRICT.
//     Native parent orders are kept (their total_amount stays intact)
//     but lose those specific line items. This handles the dev-flow
//     case where a Clover-imported item was sold via the native POS
//     before the reset.
//
// What this does NOT do:
//   • inventory_transactions tied to the deleted orders are NOT
//     reversed — they stay as historical depletion records. The
//     ingest doesn't tag transactions with order_id, and inferring
//     them by timestamp is fragile. For a dev reset this small
//     inconsistency is acceptable; the next sync re-creates the
//     data and the depletion pattern resumes.
//
// Designed to be safe to run repeatedly. If nothing exists for the
// provider, the action returns ok with zero counts.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { getAuthContext } from '@/lib/auth'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'

type Result = { error: string } | { ok: true; message: string }

// Mirrors the provider check on `external_pos_connections.provider`
// in the schema. Keeping this list local rather than importing the
// adapter registry avoids pulling adapter code into a destructive
// server action.
const VALID_PROVIDERS = new Set([
  'square',
  'clover',
  'toast',
  'godaddy_pos',
  'godaddy_online',
  'mock',
  'csv',
  'custom_json',
])

async function requireOwnerResult(restaurantId: string): Promise<string | null> {
  try {
    await requireRestaurantOwner(restaurantId)
    return null
  } catch (err) {
    if (err instanceof AuthzError) return err.message
    throw err
  }
}

export async function resetExternalPosData(
  prevState: Result | null,
  formData: FormData,
): Promise<Result> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const provider = ((formData.get('provider') as string | null) ?? '').trim()
  if (!VALID_PROVIDERS.has(provider)) return { error: 'Unknown provider.' }

  // ---- 1. Orders (FK cascades to order_items via order_id) ----
  // This wipes provider-imported orders and their order_items in one
  // shot. order_items.order_id is ON DELETE CASCADE, so any line item
  // attached to a provider order goes away too. But order_items
  // attached to NATIVE orders that happen to reference a provider
  // menu_item won't be touched here — step 1.5 handles those.
  const { data: deletedOrders, error: ordersErr } = await ctx.supabase
    .from('orders')
    .delete()
    .eq('restaurant_id', ctx.restaurantId)
    .eq('external_provider', provider)
    .select('id')
  if (ordersErr) return { error: `Order delete failed: ${ordersErr.message}` }

  // ---- 1.5. Orphaned order_items pointing at provider menu_items ----
  // menu_items has an ON DELETE RESTRICT FK on order_items.menu_item_id,
  // so the upcoming menu_items delete will fail if ANY order_item still
  // references a provider menu_item. Native POS sales that used a
  // provider-imported item are the common case. We clear those line
  // items here so step 2 can succeed. Parent native orders keep their
  // total_amount intact — only the line item rows go away.
  const { data: providerItemIds, error: lookupErr } = await ctx.supabase
    .from('menu_items')
    .select('id')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('external_provider', provider)
  if (lookupErr) return { error: `Item lookup failed: ${lookupErr.message}` }

  let strandedLineItems = 0
  if (providerItemIds && providerItemIds.length > 0) {
    const idList = providerItemIds.map((r) => r.id as string)
    const { data: strandedRows, error: strandedErr } = await ctx.supabase
      .from('order_items')
      .delete()
      .in('menu_item_id', idList)
      .select('id')
    if (strandedErr) {
      return { error: `Stranded line-item cleanup failed: ${strandedErr.message}` }
    }
    strandedLineItems = (strandedRows ?? []).length
  }

  // ---- 2. Menu items (always import-provenance for this provider) ----
  const { data: deletedItems, error: itemsErr } = await ctx.supabase
    .from('menu_items')
    .delete()
    .eq('restaurant_id', ctx.restaurantId)
    .eq('external_provider', provider)
    .select('id')
  if (itemsErr) return { error: `Item delete failed: ${itemsErr.message}` }

  // ---- 3a. Categories AUTO-CREATED by the ingest → delete ----
  const { data: deletedCats, error: catsErr } = await ctx.supabase
    .from('menu_categories')
    .delete()
    .eq('restaurant_id', ctx.restaurantId)
    .eq('external_provider', provider)
    .eq('source', 'imported')
    .select('id')
  if (catsErr) return { error: `Category delete failed: ${catsErr.message}` }

  // ---- 3b. Categories ADOPTED by name-match → unbind, keep the row ----
  const { data: unboundCats, error: unbindErr } = await ctx.supabase
    .from('menu_categories')
    .update({ external_provider: null, external_id: null })
    .eq('restaurant_id', ctx.restaurantId)
    .eq('external_provider', provider)
    .neq('source', 'imported')
    .select('id')
  if (unbindErr) return { error: `Category unbind failed: ${unbindErr.message}` }

  // ---- 4. Connection row(s) ----
  const { data: deletedConns, error: connErr } = await ctx.supabase
    .from('external_pos_connections')
    .delete()
    .eq('restaurant_id', ctx.restaurantId)
    .eq('provider', provider)
    .select('id')
  if (connErr) return { error: `Connection delete failed: ${connErr.message}` }

  revalidatePath('/settings')
  revalidatePath('/menu')
  revalidatePath('/web/menu')
  revalidatePath('/pos')
  revalidatePath('/sales')
  revalidatePath('/web/sales')

  const ord = (deletedOrders ?? []).length
  const itm = (deletedItems ?? []).length
  const cat = (deletedCats ?? []).length
  const ub = (unboundCats ?? []).length
  const conn = (deletedConns ?? []).length

  const summary =
    `Removed ${conn} connection${conn === 1 ? '' : 's'}, ` +
    `${cat} imported categor${cat === 1 ? 'y' : 'ies'}, ` +
    `${itm} menu item${itm === 1 ? '' : 's'}, ` +
    `${ord} order${ord === 1 ? '' : 's'}.` +
    (ub > 0
      ? ` Unbound ${ub} adopted categor${ub === 1 ? 'y' : 'ies'} (rows preserved).`
      : '') +
    (strandedLineItems > 0
      ? ` Cleared ${strandedLineItems} stranded line item${strandedLineItems === 1 ? '' : 's'} ` +
        `from native orders that had referenced these items (parent orders kept).`
      : '') +
    ' Historical inventory transactions are preserved.'

  return { ok: true, message: summary }
}
