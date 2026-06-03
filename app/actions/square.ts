'use server'

// ----------------------------------------------------------------
// Square integration — server actions (owner-only)
//
// Setup-only surface. These actions configure / test / disconnect
// the per-location Square connection. They never import menu data,
// never import orders, and never mutate any internal operational
// data (sales, inventory, finance). Import flows live in
// `app/actions/pos-import.ts` and are a separate operational step.
//
// Storage model:
//   • One row per (restaurant_id, location_id) in
//     `external_pos_connections` with `provider = 'square'`.
//   • `provider_credentials` jsonb holds:
//       access_token       — secret, never returned to the browser
//       location_id        — Square's location id (starts with 'L')
//       base_url           — derived from environment
//       application_id     — non-secret reference id (optional)
//       environment        — 'sandbox' | 'production'
//   • `external_store_id` mirrors the Square location id so the
//     dev-tools panel + display surfaces have a non-secret pointer.
//
// Security:
//   • `requireRestaurantOwner` gates every action. Managers cannot
//     view, edit, test, or disconnect Square credentials.
//   • The access token is never serialized into a Server Action
//     return value, never logged, and never echoed back to the
//     client. The UI sends a token only on create/update; on edit
//     without a new token, the previously stored value is preserved
//     server-side.
//   • The "test connection" call is strictly read-only against
//     Square's `/v2/locations/{id}` endpoint.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId } from '@/lib/auth'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'

// ----------------------------------------------------------------
// Shared types
// ----------------------------------------------------------------

type SaveResult = { error: string } | { ok: true; message: string }
type TestResult = { ok: boolean; message: string; environment?: string; locationName?: string }
type DisconnectResult = { error: string } | { ok: true; message: string }

type Environment = 'sandbox' | 'production'

const SQUARE_BASE_URLS: Record<Environment, string> = {
  sandbox: 'https://connect.squareupsandbox.com',
  production: 'https://connect.squareup.com',
}

// Pin the same Square-Version the adapter uses so the test and a
// real sync would behave identically against the same API surface.
const SQUARE_API_VERSION = '2024-01-18'
const TEST_TIMEOUT_MS = 15_000

// ----------------------------------------------------------------
// Owner-only gate wrapped to fit the graceful action-result shape.
// Mirrors the `requireOwnerResult` helper in pos-import.ts so both
// surfaces share one definition of "is this user an owner?".
// ----------------------------------------------------------------
async function requireOwnerResult(restaurantId: string): Promise<string | null> {
  try {
    await requireRestaurantOwner(restaurantId)
    return null
  } catch (err) {
    if (err instanceof AuthzError) return err.message
    throw err
  }
}

// ----------------------------------------------------------------
// saveSquareConfig — create or update the Square connection for
// the active location. Owner-only.
//
// Form fields:
//   location_id          uuid of the internal location (optional;
//                        falls back via resolveLocationId)
//   environment          'sandbox' | 'production' (defaults to
//                        sandbox so dev testing never crosses over)
//   application_id       Square dashboard Application ID (optional;
//                        stored for reference, not used by the
//                        sync adapter)
//   access_token         Square personal access token (secret —
//                        if empty on update, the previously stored
//                        token is preserved)
//   square_location_id   Square's location id ('L...'); the catalog
//                        and orders endpoints both anchor on this
// ----------------------------------------------------------------
export async function saveSquareConfig(
  prevState: SaveResult | null,
  formData: FormData,
): Promise<SaveResult> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const formLocationId = (formData.get('location_id') as string | null)?.trim() || null
  const { locationId, error: locErr } = await resolveLocationId(ctx, formLocationId)
  if (locErr) return { error: locErr }

  const environmentRaw = ((formData.get('environment') as string | null) ?? 'sandbox').trim()
  if (environmentRaw !== 'sandbox' && environmentRaw !== 'production') {
    return { error: 'Environment must be sandbox or production.' }
  }
  const environment = environmentRaw as Environment

  const applicationId = ((formData.get('application_id') as string | null) ?? '').trim()
  const accessTokenInput = ((formData.get('access_token') as string | null) ?? '').trim()

  // Aggressive defensive normalization for the location ID, because
  // it's the field most likely to carry hidden junk from a copy/paste:
  //   • wrapping quotes (when grabbed from a JSON snippet)
  //   • zero-width characters (U+200B, U+200C, U+200D, U+FEFF) —
  //     these are common when copying from rich-text web dashboards
  //   • non-breaking spaces (U+00A0) and other whitespace
  // After this pass, what remains should be exactly what the user
  // intended to type. We DO NOT enforce a regex shape — Square's
  // API is the authority on what's a real location id, and a real
  // 404 from /v2/locations/{id} is a far more useful error than a
  // local regex guess.
  const squareLocationIdRaw = (formData.get('square_location_id') as string | null) ?? ''
  const squareLocationId = squareLocationIdRaw
    .replace(/[​-‍﻿]/g, '') // zero-width chars
    .replace(/\s+/g, '')                    // all whitespace incl. NBSP
    .replace(/^['"]+|['"]+$/g, '')          // wrapping quotes
    .trim()

  if (!squareLocationId) return { error: 'Square location ID is required.' }

  // Edit-without-retyping flow: if no access_token is provided and
  // a connection already exists, keep the previously stored token.
  // Otherwise require the field.
  const { data: existing } = await ctx.supabase
    .from('external_pos_connections')
    .select('provider_credentials')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', 'square')
    .maybeSingle()

  let accessTokenToStore: string
  if (accessTokenInput.length > 0) {
    accessTokenToStore = accessTokenInput
  } else if (existing) {
    const prev = existing.provider_credentials as { access_token?: string } | null
    accessTokenToStore = (prev?.access_token ?? '').trim()
    if (!accessTokenToStore) {
      return { error: 'Square access token is required.' }
    }
  } else {
    return { error: 'Square access token is required.' }
  }

  // Shape stored in provider_credentials. The adapter reads
  // access_token, location_id, base_url; environment +
  // application_id are stored for the UI + future flows
  // (webhooks, OAuth migration).
  const credentials = {
    access_token: accessTokenToStore,
    location_id: squareLocationId,
    base_url: SQUARE_BASE_URLS[environment],
    application_id: applicationId || null,
    environment,
  }

  const { error } = await ctx.supabase
    .from('external_pos_connections')
    .upsert(
      {
        restaurant_id: ctx.restaurantId,
        location_id: locationId,
        provider: 'square',
        external_store_id: squareLocationId,
        provider_credentials: credentials,
        active: true,
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'location_id' },
    )

  if (error) return { error: error.message }

  revalidatePath('/settings')
  return {
    ok: true,
    message: existing
      ? 'Square configuration updated.'
      : 'Square connected. Configuration saved — menu and sales import are a separate step.',
  }
}

// ----------------------------------------------------------------
// testSquareConnection — read-only verification that Square accepts
// the saved credentials and that the configured location is
// reachable. Owner-only.
//
// What this does:
//   • GET {base_url}/v2/locations/{square_location_id}
//   • Returns success / failure with a safe message
//   • Reports environment + location name when available
//
// What this does NOT do:
//   • Import menu, catalog, or orders
//   • Mutate Square data
//   • Mutate any internal operational data
//   • Create inventory or sales rows
// ----------------------------------------------------------------
export async function testSquareConnection(
  prevState: TestResult | null,
  formData: FormData,
): Promise<TestResult> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { ok: false, message: authError ?? 'Authentication error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { ok: false, message: ownerErr }

  const formLocationId = (formData.get('location_id') as string | null)?.trim() || null
  const { locationId, error: locErr } = await resolveLocationId(ctx, formLocationId)
  if (locErr) return { ok: false, message: locErr }

  const { data: row } = await ctx.supabase
    .from('external_pos_connections')
    .select('provider_credentials, external_store_id')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', 'square')
    .maybeSingle()

  if (!row) {
    return { ok: false, message: 'Square is not configured for this location yet.' }
  }

  const creds = row.provider_credentials as {
    access_token?: string
    location_id?: string
    base_url?: string
    environment?: Environment
  } | null

  const accessToken = creds?.access_token?.trim() ?? ''
  const squareLocationId =
    creds?.location_id?.trim() ?? (row.external_store_id ?? '').trim()
  const baseUrl = (creds?.base_url ?? SQUARE_BASE_URLS.sandbox).replace(/\/+$/, '')
  const environment: Environment = creds?.environment === 'production' ? 'production' : 'sandbox'

  if (!accessToken || !squareLocationId) {
    return {
      ok: false,
      message: 'Square credentials are incomplete. Re-enter them and save.',
    }
  }

  // Abort the fetch if Square doesn't respond promptly so the
  // server action doesn't hang in the rare API-stall case.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    const res = await fetch(
      `${baseUrl}/v2/locations/${encodeURIComponent(squareLocationId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Square-Version': SQUARE_API_VERSION,
          Accept: 'application/json',
        },
        cache: 'no-store',
        signal: controller.signal,
      },
    )

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Square rejected the access token (HTTP ${res.status}). Verify the token and environment.`,
        environment,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: 'Square location not found. Verify the location ID and environment.',
        environment,
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        message: `Square returned HTTP ${res.status}. Verify credentials and try again.`,
        environment,
      }
    }

    const body = (await res.json().catch(() => null)) as
      | { location?: { id?: string; name?: string; status?: string } }
      | null
    const locationName = body?.location?.name ?? null

    return {
      ok: true,
      message: locationName
        ? `Connected. Square (${environment}) returned location "${locationName}".`
        : `Connected. Square (${environment}) accepted the credentials.`,
      environment,
      locationName: locationName ?? undefined,
    }
  } catch (err) {
    const baseMsg =
      err instanceof Error && err.name === 'AbortError'
        ? 'Square did not respond in time.'
        : err instanceof Error
          ? err.message
          : 'Unknown network error.'
    return {
      ok: false,
      message: `Could not reach Square: ${baseMsg}`,
      environment,
    }
  } finally {
    clearTimeout(timer)
  }
}

// ----------------------------------------------------------------
// disconnectSquare — removes the Square configuration for the
// active location. Owner-only. Imported menu/order data stays
// (those rows are identified by provider + external_id and are
// independent of the connection row).
// ----------------------------------------------------------------
export async function disconnectSquare(
  prevState: DisconnectResult | null,
  formData: FormData,
): Promise<DisconnectResult> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const formLocationId = (formData.get('location_id') as string | null)?.trim() || null
  const { locationId, error: locErr } = await resolveLocationId(ctx, formLocationId)
  if (locErr) return { error: locErr }

  const { error } = await ctx.supabase
    .from('external_pos_connections')
    .delete()
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', 'square')

  if (error) return { error: error.message }

  revalidatePath('/settings')
  return { ok: true, message: 'Square disconnected. Imported menu and sales records were preserved.' }
}
