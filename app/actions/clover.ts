'use server'

// ----------------------------------------------------------------
// Clover integration — server actions (owner-only)
//
// Same setup-only surface as the Square actions: configure / test /
// disconnect for the per-location Clover connection. These actions
// never import menu data, never import orders, and never mutate
// internal operational data. Import flows live in
// `app/actions/pos-import.ts` and are a separate operational step.
//
// Storage model (mirrors the Square integration):
//   • One row per (restaurant_id, location_id) in
//     `external_pos_connections` with `provider = 'clover'`.
//   • `provider_credentials` jsonb holds:
//       api_token        — secret, never returned to the browser
//       merchant_id      — Clover merchant identifier
//       base_url         — derived from environment
//       environment      — 'sandbox' | 'production'
//   • `external_store_id` mirrors the Clover merchant id so the
//     dev-tools panel + display surfaces have a non-secret pointer.
//
// Security: identical to the Square pattern — owner-only via
// `requireRestaurantOwner`, the api_token is never serialized into
// a return value or echoed back to the client, and the test action
// is strictly read-only against Clover's merchant endpoint.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId } from '@/lib/auth'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'

// ----------------------------------------------------------------
// Shared types
// ----------------------------------------------------------------

type SaveResult = { error: string } | { ok: true; message: string }
type TestResult = {
  ok: boolean
  message: string
  environment?: string
  merchantName?: string
}
type DisconnectResult = { error: string } | { ok: true; message: string }

type Environment = 'sandbox' | 'production'

const CLOVER_BASE_URLS: Record<Environment, string> = {
  sandbox: 'https://apisandbox.dev.clover.com',
  production: 'https://api.clover.com',
}

const TEST_TIMEOUT_MS = 15_000

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
// saveCloverConfig — create or update the Clover connection for
// the active location. Owner-only.
//
// Form fields:
//   location_id     uuid of the internal location (optional;
//                   falls back via resolveLocationId)
//   environment     'sandbox' | 'production' (defaults to sandbox)
//   merchant_id     Clover merchant identifier (non-secret)
//   api_token       Clover API token (secret — if empty on update,
//                   the previously stored token is preserved)
// ----------------------------------------------------------------
export async function saveCloverConfig(
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

  const apiTokenInput = ((formData.get('api_token') as string | null) ?? '').trim()

  // Same defensive normalization as Square's location id — pasting
  // from web dashboards sometimes carries hidden zero-width chars,
  // non-breaking spaces, or wrapping quotes.
  const merchantIdRaw = (formData.get('merchant_id') as string | null) ?? ''
  const merchantId = merchantIdRaw
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, '')
    .replace(/^['"]+|['"]+$/g, '')
    .trim()

  if (!merchantId) return { error: 'Clover merchant ID is required.' }

  // Edit-without-retyping flow: if no api_token is provided and a
  // connection already exists, keep the previously stored token.
  const { data: existing } = await ctx.supabase
    .from('external_pos_connections')
    .select('provider_credentials')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', 'clover')
    .maybeSingle()

  let apiTokenToStore: string
  if (apiTokenInput.length > 0) {
    apiTokenToStore = apiTokenInput
  } else if (existing) {
    const prev = existing.provider_credentials as { api_token?: string } | null
    apiTokenToStore = (prev?.api_token ?? '').trim()
    if (!apiTokenToStore) {
      return { error: 'Clover API token is required.' }
    }
  } else {
    return { error: 'Clover API token is required.' }
  }

  const credentials = {
    api_token: apiTokenToStore,
    merchant_id: merchantId,
    base_url: CLOVER_BASE_URLS[environment],
    environment,
  }

  const { error } = await ctx.supabase
    .from('external_pos_connections')
    .upsert(
      {
        restaurant_id: ctx.restaurantId,
        location_id: locationId,
        provider: 'clover',
        external_store_id: merchantId,
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
      ? 'Clover configuration updated.'
      : 'Clover connected. Configuration saved — menu and sales import are a separate step.',
  }
}

// ----------------------------------------------------------------
// testCloverConnection — read-only verification that Clover accepts
// the saved credentials and that the configured merchant is reachable.
// Owner-only.
//
// What this does:
//   • GET {base_url}/v3/merchants/{merchant_id}
//   • Returns success / failure with a safe message
//   • Reports environment + merchant name when available
//
// What this does NOT do:
//   • Import menu, catalog, or orders
//   • Mutate Clover data
//   • Mutate any internal operational data
// ----------------------------------------------------------------
export async function testCloverConnection(
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
    .eq('provider', 'clover')
    .maybeSingle()

  if (!row) {
    return { ok: false, message: 'Clover is not configured for this location yet.' }
  }

  const creds = row.provider_credentials as {
    api_token?: string
    merchant_id?: string
    base_url?: string
    environment?: Environment
  } | null

  const apiToken = creds?.api_token?.trim() ?? ''
  const merchantId =
    creds?.merchant_id?.trim() ?? (row.external_store_id ?? '').trim()
  const baseUrl = (creds?.base_url ?? CLOVER_BASE_URLS.sandbox).replace(/\/+$/, '')
  const environment: Environment = creds?.environment === 'production' ? 'production' : 'sandbox'

  if (!apiToken || !merchantId) {
    return {
      ok: false,
      message: 'Clover credentials are incomplete. Re-enter them and save.',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    const res = await fetch(
      `${baseUrl}/v3/merchants/${encodeURIComponent(merchantId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
        signal: controller.signal,
      },
    )

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Clover rejected the API token (HTTP ${res.status}). Verify the token and environment.`,
        environment,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: 'Clover merchant not found. Verify the merchant ID and environment.',
        environment,
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        message: `Clover returned HTTP ${res.status}. Verify credentials and try again.`,
        environment,
      }
    }

    const body = (await res.json().catch(() => null)) as
      | { id?: string; name?: string }
      | null
    const merchantName = body?.name ?? null

    return {
      ok: true,
      message: merchantName
        ? `Connected. Clover (${environment}) returned merchant "${merchantName}".`
        : `Connected. Clover (${environment}) accepted the credentials.`,
      environment,
      merchantName: merchantName ?? undefined,
    }
  } catch (err) {
    const baseMsg =
      err instanceof Error && err.name === 'AbortError'
        ? 'Clover did not respond in time.'
        : err instanceof Error
          ? err.message
          : 'Unknown network error.'
    return {
      ok: false,
      message: `Could not reach Clover: ${baseMsg}`,
      environment,
    }
  } finally {
    clearTimeout(timer)
  }
}

// ----------------------------------------------------------------
// disconnectClover — removes the Clover configuration for the
// active location. Owner-only. Imported menu/order data stays
// (those rows are identified by provider + external_id and are
// independent of the connection row).
// ----------------------------------------------------------------
export async function disconnectClover(
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
    .eq('provider', 'clover')

  if (error) return { error: error.message }

  revalidatePath('/settings')
  return { ok: true, message: 'Clover disconnected. Imported menu and sales records were preserved.' }
}
