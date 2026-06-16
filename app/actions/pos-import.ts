'use server'

// ----------------------------------------------------------------
// External POS import server actions — Pilot V1 (multi-location)
//
// Each internal location can have its own external POS connection.
// Sync actions walk every active connection for the current
// restaurant and ingest each one into its own location_id.
//
// Polling cadence (enforced by caller/cron):
//   • syncExternalPosOrders — every 1 minute
//   • syncExternalPosMenu   — every 1 hour
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getAuthContext } from '@/lib/auth'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'
import { getSourceAdapter, isKnownSourceId, type SourceId, type SyncMeta } from '@/lib/import/adapter'
import { ingestMenu, ingestOrders } from '@/lib/import/ingest'

// Owner-only gate layered on top of getAuthContext for sensitive
// external POS connection writes and syncs. Keeps the existing
// graceful action-style return shape.
async function requireOwnerResult(restaurantId: string): Promise<string | null> {
  try {
    await requireRestaurantOwner(restaurantId)
    return null
  } catch (err) {
    if (err instanceof AuthzError) return err.message
    throw err
  }
}

// Maximum raw payload size (chars) for any one-shot import (CSV,
// custom JSON, ...). Pilot V1 runs entirely in-memory — the adapter
// parses the whole input at once, so we cap to keep a single request
// bounded. 2 MB is generous for a typical menu/orders file and cheap
// to validate.
const MAX_IMPORT_INPUT_CHARS = 2 * 1024 * 1024

type Result = { error: string } | { ok: true; message: string }

interface Connection {
  id: string
  restaurant_id: string
  location_id: string
  provider: SourceId
  external_store_id: string | null
  provider_credentials: Record<string, unknown> | null
  last_orders_sync_at: string | null
  last_menu_sync_at: string | null
  active: boolean
}

type Supa = Awaited<ReturnType<typeof createClient>>

async function loadActiveConnections(supabase: Supa, restaurantId: string): Promise<Connection[]> {
  const { data } = await supabase
    .from('external_pos_connections')
    .select('id, restaurant_id, location_id, provider, external_store_id, provider_credentials, last_orders_sync_at, last_menu_sync_at, active')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
  return (data ?? []) as Connection[]
}

async function updateSyncState(
  supabase: Supa,
  connectionId: string,
  patch: Partial<{
    last_orders_sync_at: string
    last_menu_sync_at: string
    last_error: string | null
  }>
) {
  await supabase
    .from('external_pos_connections')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', connectionId)
}

// ----------------------------------------------------------------
// connectExternalPos — one connection per LOCATION.
//
// Required form fields:
//   location_id        uuid of an internal location (must belong to
//                      the current restaurant; RLS enforces this)
//   provider           'mock' | 'square' | 'toast' | 'clover'
//   external_store_id  optional provider-side store identifier
//   credentials        optional JSON blob
// ----------------------------------------------------------------
export async function connectExternalPos(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const locationId = (formData.get('location_id') as string)?.trim()
  if (!locationId) return { error: 'location_id is required.' }

  // Verify the location belongs to the current restaurant. RLS would
  // reject cross-tenant inserts anyway, but a friendly error beats a
  // 42501. A single-row lookup handles the check.
  const { data: loc } = await ctx.supabase
    .from('locations')
    .select('id')
    .eq('id', locationId)
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  if (!loc) return { error: 'That location does not belong to this restaurant.' }

  const providerRaw = (formData.get('provider') as string)?.trim()
  if (!isKnownSourceId(providerRaw)) {
    return { error: 'Unknown source adapter.' }
  }

  const externalStoreId = (formData.get('external_store_id') as string)?.trim() || null

  const credentialsRaw = (formData.get('credentials') as string)?.trim()
  let credentials: Record<string, unknown> | null = null
  if (credentialsRaw) {
    try { credentials = JSON.parse(credentialsRaw) }
    catch { return { error: 'Credentials must be valid JSON or empty.' } }
  }

  // Upsert by location_id — each location holds one row at most.
  const { error } = await ctx.supabase
    .from('external_pos_connections')
    .upsert(
      {
        restaurant_id: ctx.restaurantId,
        location_id: locationId,
        provider: providerRaw,
        external_store_id: externalStoreId,
        provider_credentials: credentials,
        active: true,
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'location_id' }
    )

  if (error) return { error: error.message }
  revalidatePath('/settings')
  return { ok: true, message: `Connected ${providerRaw} for this location.` }
}

// ----------------------------------------------------------------
// disconnectExternalPos — deactivates the connection for one
// location. Accepts `location_id`. Imported data stays.
// ----------------------------------------------------------------
export async function disconnectExternalPos(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const locationId = (formData.get('location_id') as string)?.trim()
  if (!locationId) return { error: 'location_id is required.' }

  const { error } = await ctx.supabase
    .from('external_pos_connections')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)

  if (error) return { error: error.message }
  revalidatePath('/settings')
  return { ok: true, message: 'Disconnected.' }
}

// ----------------------------------------------------------------
// syncExternalPosMenu — full-upsert menu sync, batched across all
// active connections. Each location's menu lands in the same
// restaurant-scoped `menu_items` + `menu_categories` tables, so
// they naturally share a menu — but provider + external_id dedupe
// still works correctly when different locations use different
// providers or external store ids.
// ----------------------------------------------------------------
export async function syncExternalPosMenu(
  prevState: Result | null,
  _formData: FormData
): Promise<Result> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const connections = await loadActiveConnections(ctx.supabase, ctx.restaurantId)
  if (connections.length === 0) return { error: 'No active POS connections.' }

  let totalCategories = 0
  let totalItems = 0
  let failedCount = 0
  // Transparency aggregates — adapters populate per-call `meta`
  // buckets; we fold them into the final result message.
  let totalPagesFetched = 0
  let truncatedCount = 0
  const errors: string[] = []
  const adapterNotes: string[] = []

  for (const connection of connections) {
    try {
      const adapter = getSourceAdapter(connection.provider)
      const meta: SyncMeta = {}
      const menu = await adapter.listMenu({
        credentials: connection.provider_credentials,
        since: null,
        meta,
      })
      const result = await ingestMenu({
        supabase: ctx.supabase,
        restaurantId: ctx.restaurantId,
        sourceId: connection.provider,
        menu,
      })
      if (result.error) {
        await updateSyncState(ctx.supabase, connection.id, { last_error: result.error })
        errors.push(`${connection.provider}: ${result.error}`)
        failedCount++
        continue
      }
      await updateSyncState(ctx.supabase, connection.id, {
        last_menu_sync_at: new Date().toISOString(),
        last_error: null,
      })
      totalCategories += result.categoriesUpserted
      totalItems += result.itemsUpserted
      totalPagesFetched += meta.pagesFetched ?? 0
      if (meta.truncated) truncatedCount += 1
      if (meta.notes) adapterNotes.push(...meta.notes)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error.'
      await updateSyncState(ctx.supabase, connection.id, { last_error: msg })
      errors.push(`${connection.provider}: ${msg}`)
      failedCount++
    }
  }

  revalidatePath('/menu')
  revalidatePath('/settings')

  if (failedCount === connections.length) {
    return { error: `All ${failedCount} menu syncs failed. ${errors[0] ?? ''}` }
  }
  const pageHint = totalPagesFetched > 0 ? ` · ${totalPagesFetched} page${totalPagesFetched === 1 ? '' : 's'}` : ''
  const truncHint = truncatedCount > 0
    ? ` · ${truncatedCount} connection${truncatedCount === 1 ? '' : 's'} truncated (Pilot V1 cap — run sync again to fetch the rest)`
    : ''
  const failHint = failedCount > 0 ? ` (${failedCount} failed)` : ''
  const base = `Menu sync across ${connections.length} location${connections.length === 1 ? '' : 's'}: ${totalCategories} categories, ${totalItems} items${pageHint}${truncHint}${failHint}.`
  return { ok: true, message: base }
}

// ----------------------------------------------------------------
// syncExternalPosOrders — incremental orders sync, batched across
// all active connections. Orders from each connection land in the
// correct location_id via ingestOrders.
//
// First-sync window: 7 days. Subsequent syncs use last_orders_sync_at.
// ----------------------------------------------------------------
export async function syncExternalPosOrders(
  prevState: Result | null,
  _formData: FormData
): Promise<Result> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const connections = await loadActiveConnections(ctx.supabase, ctx.restaurantId)
  if (connections.length === 0) return { error: 'No active POS connections.' }

  let totalInserted = 0
  let totalSkipped = 0
  let totalFailed = 0
  let totalPlaceholders = 0
  let totalDepletions = 0
  let failedCount = 0
  // Transparency aggregates — same pattern as the menu sync loop.
  let totalPagesFetched = 0
  let totalRecordsFetched = 0
  let truncatedCount = 0
  const errors: string[] = []
  const rejectionNotes: string[] = []

  for (const connection of connections) {
    const since = connection.last_orders_sync_at
      ? new Date(connection.last_orders_sync_at)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

    try {
      const adapter = getSourceAdapter(connection.provider)
      const meta: SyncMeta = {}
      const orders = await adapter.listOrders({
        credentials: connection.provider_credentials,
        since,
        meta,
      })
      const result = await ingestOrders({
        supabase: ctx.supabase,
        restaurantId: ctx.restaurantId,
        locationId: connection.location_id,
        sourceId: connection.provider,
        orders,
        meta,
      })
      if (result.error) {
        await updateSyncState(ctx.supabase, connection.id, { last_error: result.error })
        errors.push(`${connection.provider}: ${result.error}`)
        failedCount++
        continue
      }
      // Important: when the adapter truncated, we still advance the
      // cursor so the NEXT sync call picks up where this one stopped.
      // That means "hit cap → run sync again" is a viable recovery
      // path instead of a stuck state. Notes on the cap are surfaced
      // in the aggregate result message below.
      await updateSyncState(ctx.supabase, connection.id, {
        last_orders_sync_at: new Date().toISOString(),
        last_error: null,
      })
      totalInserted += result.ordersInserted
      totalSkipped += result.ordersSkipped
      totalFailed += result.ordersFailed
      totalPlaceholders += result.placeholdersCreated
      totalDepletions += result.inventoryDepletionsWritten
      if (result.rejectionNotes.length > 0) {
        rejectionNotes.push(...result.rejectionNotes.map((n) => `${connection.provider}: ${n}`))
      }
      totalPagesFetched += meta.pagesFetched ?? 0
      totalRecordsFetched += meta.recordsFetched ?? 0
      if (meta.truncated) truncatedCount += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error.'
      await updateSyncState(ctx.supabase, connection.id, { last_error: msg })
      errors.push(`${connection.provider}: ${msg}`)
      failedCount++
    }
  }

  revalidatePath('/sales')
  revalidatePath('/dashboard')
  revalidatePath('/finance')
  revalidatePath('/inventory')
  revalidatePath('/settings')

  if (failedCount === connections.length) {
    return { error: `All ${failedCount} order syncs failed. ${errors[0] ?? ''}` }
  }

  const pageHint = totalPagesFetched > 0
    ? ` · fetched ${totalRecordsFetched} record${totalRecordsFetched === 1 ? '' : 's'} over ${totalPagesFetched} page${totalPagesFetched === 1 ? '' : 's'}`
    : ''
  const truncHint = truncatedCount > 0
    ? ` · ${truncatedCount} connection${truncatedCount === 1 ? '' : 's'} truncated (Pilot V1 cap — run sync again to fetch the rest)`
    : ''
  const failHint = failedCount > 0 ? ` (${failedCount} connection${failedCount === 1 ? '' : 's'} failed)` : ''
  const rowFailHint = totalFailed > 0 ? ` · ${totalFailed} row${totalFailed === 1 ? '' : 's'} rejected` : ''
  const firstNote = rejectionNotes[0]
  const extraNotes = rejectionNotes.length > 1 ? ` (+${rejectionNotes.length - 1} more)` : ''
  const noteHint = firstNote ? `. Warning: ${firstNote}${extraNotes}` : ''

  const base =
    `Orders sync across ${connections.length} location${connections.length === 1 ? '' : 's'}: ` +
    `${totalInserted} new, ${totalSkipped} duplicate${totalSkipped === 1 ? '' : 's'}, ` +
    `${totalPlaceholders} placeholder item${totalPlaceholders === 1 ? '' : 's'}, ` +
    `${totalDepletions} inventory movement${totalDepletions === 1 ? '' : 's'}${rowFailHint}${pageHint}${truncHint}${failHint}${noteHint}.`
  return { ok: true, message: base }
}

// ----------------------------------------------------------------
// CSV imports — one-shot, location-targeted.
//
// Unlike the API sync actions above, CSV imports are transient:
// no credentials, no sync cursors, no persistent connection row.
// The dev supplies the raw CSV text, picks a target location, and
// we call the existing `csv` adapter → shared ingest pipeline.
//
// Orders are tagged `source='external_pos'`, `external_provider='csv'`
// and dedupe uses the existing location-aware key, so re-uploading
// the same CSV is safe.
// ----------------------------------------------------------------

/**
 * Generic validator for one-shot raw-input imports (CSV, custom JSON).
 * Returns either the validated pair or an error shape suitable for
 * returning directly from a server action.
 */
async function validateImportInput(
  formData: FormData
): Promise<{ locationId: string; input: string } | { error: string }> {
  const locationId = (formData.get('location_id') as string | null)?.trim() ?? ''
  if (!locationId) return { error: 'location_id is required.' }

  const input = ((formData.get('input') as string | null) ?? '').trim()
  if (!input) return { error: 'Input is empty.' }
  if (input.length > MAX_IMPORT_INPUT_CHARS) {
    return { error: `Input is too large (${input.length} chars, max ${MAX_IMPORT_INPUT_CHARS}).` }
  }

  return { locationId, input }
}

async function verifyLocation(
  ctx: { supabase: Awaited<ReturnType<typeof createClient>>; restaurantId: string },
  locationId: string
): Promise<string | null> {
  const { data: loc } = await ctx.supabase
    .from('locations')
    .select('id')
    .eq('id', locationId)
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  return loc ? null : 'That location does not belong to this restaurant.'
}

/**
 * Build the transparency suffix for one-shot import messages so the
 * CSV / JSON actions all format their results identically.
 *
 * Produces strings like:
 *   " · 12 rows parsed"
 *   " · 12 rows parsed, 3 invalid"
 *   " · 12 rows parsed, 3 invalid. Warning: Row 5: price ... (+1 more)"
 *
 * Empty when the adapter populated no meta (so existing messages stay
 * tight for adapters that don't report anything).
 */
function formatImportTransparency(
  meta: SyncMeta,
  recordLabel: 'row' | 'order' | 'item'
): string {
  const fetched = meta.recordsFetched ?? 0
  const skipped = meta.recordsSkipped ?? 0
  if (fetched === 0 && skipped === 0) return ''

  const noun = `${recordLabel}${fetched === 1 ? '' : 's'}`
  const skipHint = skipped > 0 ? `, ${skipped} invalid` : ''
  let suffix = ` · ${fetched} ${noun} parsed${skipHint}`

  const firstNote = meta.notes && meta.notes.length > 0 ? meta.notes[0] : null
  if (firstNote) {
    const extra =
      meta.notes && meta.notes.length > 1
        ? ` (+${meta.notes.length - 1} more)`
        : ''
    suffix += `. Warning: ${firstNote}${extra}`
  }
  return suffix
}

export async function importCsvMenu(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  // Owner-only: one-shot imports overwrite menu state directly,
  // bypassing the external POS connection flow that's already
  // owner-gated. Without this check a manager/staff could upload
  // arbitrary CSV and rewrite the menu.
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const validated = await validateImportInput(formData)
  if ('error' in validated) return { error: validated.error }

  const locErr = await verifyLocation(ctx, validated.locationId)
  if (locErr) return { error: locErr }

  try {
    const adapter = getSourceAdapter('csv')
    const meta: SyncMeta = {}
    const menu = await adapter.listMenu({
      credentials: null,
      since: null,
      input: validated.input,
      meta,
    })

    if (menu.items.length === 0 && menu.categories.length === 0) {
      return { error: 'CSV parsed successfully but contained no rows.' }
    }

    const result = await ingestMenu({
      supabase: ctx.supabase,
      restaurantId: ctx.restaurantId,
      sourceId: 'csv',
      menu,
    })
    if (result.error) return { error: result.error }

    revalidatePath('/menu')
    revalidatePath('/settings')
    return {
      ok: true,
      message:
        `CSV menu import: ${result.categoriesUpserted} categories, ${result.itemsUpserted} items` +
        formatImportTransparency(meta, 'row') + '.',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown CSV error.'
    return { error: msg }
  }
}

export async function importCsvOrders(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  // Owner-only — see importCsvMenu above for rationale.
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const validated = await validateImportInput(formData)
  if ('error' in validated) return { error: validated.error }

  const locErr = await verifyLocation(ctx, validated.locationId)
  if (locErr) return { error: locErr }

  try {
    const adapter = getSourceAdapter('csv')
    const meta: SyncMeta = {}
    const orders = await adapter.listOrders({
      credentials: null,
      since: null,
      input: validated.input,
      meta,
    })

    if (orders.length === 0) {
      return { error: 'CSV parsed successfully but contained no orders.' }
    }

    const result = await ingestOrders({
      supabase: ctx.supabase,
      restaurantId: ctx.restaurantId,
      locationId: validated.locationId,
      sourceId: 'csv',
      orders,
      meta,
    })
    if (result.error) return { error: result.error }

    revalidatePath('/sales')
    revalidatePath('/dashboard')
    revalidatePath('/finance')
    revalidatePath('/inventory')
    revalidatePath('/settings')
    return {
      ok: true,
      message:
        `CSV orders import: ${result.ordersInserted} new, ${result.ordersSkipped} duplicate${result.ordersSkipped === 1 ? '' : 's'}, ` +
        `${result.placeholdersCreated} placeholder item${result.placeholdersCreated === 1 ? '' : 's'}, ` +
        `${result.inventoryDepletionsWritten} inventory movement${result.inventoryDepletionsWritten === 1 ? '' : 's'}` +
        formatImportTransparency(meta, 'row') + '.',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown CSV error.'
    return { error: msg }
  }
}

// ----------------------------------------------------------------
// Custom JSON imports — one-shot, location-targeted.
//
// Same shape as the CSV actions: no connection row, no persistent
// credentials, no sync cursor. The dev supplies the raw JSON text
// and a target location; we call the existing `custom_json` adapter
// and hand the normalized result into the shared ingest pipeline.
//
// Rows land with source='external_pos' + external_provider='custom_json'.
// The existing location-aware dedupe key means re-importing the same
// payload is safe — duplicates are skipped, not double-inserted.
// ----------------------------------------------------------------

export async function importCustomJsonMenu(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  // Owner-only — see importCsvMenu above for rationale.
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const validated = await validateImportInput(formData)
  if ('error' in validated) return { error: validated.error }

  const locErr = await verifyLocation(ctx, validated.locationId)
  if (locErr) return { error: locErr }

  try {
    const adapter = getSourceAdapter('custom_json')
    const meta: SyncMeta = {}
    const menu = await adapter.listMenu({
      credentials: null,
      since: null,
      input: validated.input,
      meta,
    })

    if (menu.items.length === 0 && menu.categories.length === 0) {
      return { error: 'JSON parsed successfully but contained no items.' }
    }

    const result = await ingestMenu({
      supabase: ctx.supabase,
      restaurantId: ctx.restaurantId,
      sourceId: 'custom_json',
      menu,
    })
    if (result.error) return { error: result.error }

    revalidatePath('/menu')
    revalidatePath('/settings')
    return {
      ok: true,
      message:
        `Custom JSON menu import: ${result.categoriesUpserted} categories, ${result.itemsUpserted} items` +
        formatImportTransparency(meta, 'item') + '.',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown JSON error.'
    return { error: msg }
  }
}

export async function importCustomJsonOrders(
  prevState: Result | null,
  formData: FormData
): Promise<Result> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Auth error.' }

  // Owner-only — see importCsvMenu above for rationale.
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const validated = await validateImportInput(formData)
  if ('error' in validated) return { error: validated.error }

  const locErr = await verifyLocation(ctx, validated.locationId)
  if (locErr) return { error: locErr }

  try {
    const adapter = getSourceAdapter('custom_json')
    const meta: SyncMeta = {}
    const orders = await adapter.listOrders({
      credentials: null,
      since: null,
      input: validated.input,
      meta,
    })

    if (orders.length === 0) {
      return { error: 'JSON parsed successfully but contained no orders.' }
    }

    const result = await ingestOrders({
      supabase: ctx.supabase,
      restaurantId: ctx.restaurantId,
      locationId: validated.locationId,
      sourceId: 'custom_json',
      orders,
      meta,
    })
    if (result.error) return { error: result.error }

    revalidatePath('/sales')
    revalidatePath('/dashboard')
    revalidatePath('/finance')
    revalidatePath('/inventory')
    revalidatePath('/settings')
    return {
      ok: true,
      message:
        `Custom JSON orders import: ${result.ordersInserted} new, ${result.ordersSkipped} duplicate${result.ordersSkipped === 1 ? '' : 's'}, ` +
        `${result.placeholdersCreated} placeholder item${result.placeholdersCreated === 1 ? '' : 's'}, ` +
        `${result.inventoryDepletionsWritten} inventory movement${result.inventoryDepletionsWritten === 1 ? '' : 's'}` +
        formatImportTransparency(meta, 'order') + '.',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown JSON error.'
    return { error: msg }
  }
}
