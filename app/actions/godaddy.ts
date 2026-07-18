'use server'

// ----------------------------------------------------------------
// GoDaddy Commerce integration — server actions (owner-only)
//
// Setup-only surface, exactly like the Square integration actions.
// These configure / test / disconnect the per-location GoDaddy
// connection. They never import menu data, never import orders, and
// never mutate internal operational data. Import flows live in
// `app/actions/pos-import.ts` and are a separate operational step.
//
// GoDaddy Commerce is ONE provider with TWO channels — the in-store
// POS and the online storefront — surfaced as two source ids:
//   channel 'pos'    → provider 'godaddy_pos'
//   channel 'online' → provider 'godaddy_online'
// A connection row is keyed per internal location, so connect the POS
// on the location that runs a register and the storefront on the
// location that fulfills web orders (or the same location if a store
// only uses one channel).
//
// Storage model (external_pos_connections.provider_credentials jsonb):
//   store_id        — GoDaddy Commerce store id (non-secret)
//   base_url        — API base, defaults to production
//   client_id       — OAuth2 client id (non-secret reference)
//   scope           — optional OAuth scopes
//   client_secret   — SECRET, never returned to the browser
//   access_token    — SECRET (optional pre-issued bearer), never returned
//
// Security mirrors square.ts: `requireRestaurantOwner` gates every
// action; secrets are never serialized into a Server Action return
// value, never logged, never echoed back. On edit without a new
// secret, the previously stored value is preserved server-side.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId } from '@/lib/auth'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'

type SaveResult = { error: string } | { ok: true; message: string }
type TestResult = { ok: boolean; message: string }
type DisconnectResult = { error: string } | { ok: true; message: string }

type Channel = 'pos' | 'online'

const DEFAULT_BASE_URL = 'https://api.godaddy.com'
const TOKEN_PATH = '/v2/oauth2/token'
const TEST_TIMEOUT_MS = 15_000

function providerForChannel(channel: Channel): 'godaddy_pos' | 'godaddy_online' {
  return channel === 'online' ? 'godaddy_online' : 'godaddy_pos'
}

async function requireOwnerResult(restaurantId: string): Promise<string | null> {
  try {
    await requireRestaurantOwner(restaurantId)
    return null
  } catch (err) {
    if (err instanceof AuthzError) return err.message
    throw err
  }
}

interface StoredCredentials {
  store_id?: string
  base_url?: string
  client_id?: string
  scope?: string
  client_secret?: string
  access_token?: string
}

// ----------------------------------------------------------------
// saveGodaddyConfig — create or update the GoDaddy connection for
// the active location + channel. Owner-only.
//
// Form fields:
//   location_id     uuid of the internal location (optional; falls
//                   back via resolveLocationId)
//   channel         'pos' | 'online' (defaults to 'pos')
//   store_id        GoDaddy Commerce store id (required)
//   base_url        API base override (optional; defaults production)
//   client_id       OAuth2 client id (optional)
//   scope           OAuth2 scopes (optional)
//   client_secret   OAuth2 client secret (secret; preserved if blank
//                   on edit)
//   access_token    pre-issued bearer (secret; preserved if blank on
//                   edit) — alternative to client_id/secret
//
// At least an access_token OR client_id + client_secret must end up
// stored, so the adapter can authenticate.
// ----------------------------------------------------------------
export async function saveGodaddyConfig(
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

  const channelRaw = ((formData.get('channel') as string | null) ?? 'pos').trim()
  if (channelRaw !== 'pos' && channelRaw !== 'online') {
    return { error: 'Channel must be pos or online.' }
  }
  const channel = channelRaw as Channel
  const provider = providerForChannel(channel)

  const str = (k: string) => ((formData.get(k) as string | null) ?? '').trim()

  const storeId = str('store_id')
  if (!storeId) return { error: 'GoDaddy store ID is required.' }

  const baseUrl = (str('base_url') || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const clientId = str('client_id')
  const scope = str('scope')
  const clientSecretInput = str('client_secret')
  const accessTokenInput = str('access_token')

  // Edit-without-retyping: preserve stored secrets when the field is
  // left blank and a connection already exists.
  const { data: existing } = await ctx.supabase
    .from('external_pos_connections')
    .select('provider_credentials')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', provider)
    .maybeSingle()

  const prev = (existing?.provider_credentials ?? null) as StoredCredentials | null

  const clientSecret = clientSecretInput || (prev?.client_secret ?? '')
  const accessToken = accessTokenInput || (prev?.access_token ?? '')

  const hasClientCreds = !!clientId && !!clientSecret
  if (!accessToken && !hasClientCreds) {
    return {
      error:
        'Provide an access token, or both a client ID and client secret, ' +
        'so GoDaddy can authenticate.',
    }
  }

  const credentials: StoredCredentials = {
    store_id: storeId,
    base_url: baseUrl,
    client_id: clientId || undefined,
    scope: scope || undefined,
    client_secret: clientSecret || undefined,
    access_token: accessToken || undefined,
  }

  const { error } = await ctx.supabase
    .from('external_pos_connections')
    .upsert(
      {
        restaurant_id: ctx.restaurantId,
        location_id: locationId,
        provider,
        external_store_id: storeId,
        provider_credentials: credentials,
        active: true,
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'location_id' },
    )

  if (error) return { error: error.message }

  revalidatePath('/settings')
  const label = channel === 'online' ? 'GoDaddy Online Store' : 'GoDaddy POS'
  return {
    ok: true,
    message: existing
      ? `${label} configuration updated.`
      : `${label} connected. Menu and sales import are a separate step.`,
  }
}

// ----------------------------------------------------------------
// testGodaddyConnection — read-only credential verification.
// Owner-only.
//
// When client credentials are stored, this runs the real OAuth2
// client_credentials grant (the documented, verified endpoint) and
// reports whether GoDaddy issued a token — provable the moment the
// developer account is live, before any store has orders. When only
// a pre-issued access token is stored, it reports that (a full probe
// of the orders endpoint is deferred until that path is confirmed
// against the live API).
//
// Does NOT import data or mutate anything on either side.
// ----------------------------------------------------------------
export async function testGodaddyConnection(
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

  const channelRaw = ((formData.get('channel') as string | null) ?? 'pos').trim()
  const channel: Channel = channelRaw === 'online' ? 'online' : 'pos'
  const provider = providerForChannel(channel)

  const { data: row } = await ctx.supabase
    .from('external_pos_connections')
    .select('provider_credentials')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', provider)
    .maybeSingle()

  if (!row) {
    return { ok: false, message: 'GoDaddy is not configured for this location + channel yet.' }
  }

  const creds = (row.provider_credentials ?? null) as StoredCredentials | null
  const baseUrl = (creds?.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const clientId = (creds?.client_id ?? '').trim()
  const clientSecret = (creds?.client_secret ?? '').trim()
  const accessToken = (creds?.access_token ?? '').trim()
  const scope = (creds?.scope ?? '').trim()

  if (!clientId || !clientSecret) {
    // No client credentials to exchange. If a bearer token is stored,
    // we can't verify it against a confirmed endpoint yet.
    if (accessToken) {
      return {
        ok: true,
        message:
          'A pre-issued access token is stored. Full verification runs against ' +
          'the orders endpoint once your GoDaddy developer account is live.',
      }
    }
    return { ok: false, message: 'GoDaddy credentials are incomplete. Re-enter them and save.' }
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  })
  if (scope) body.set('scope', scope)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl}${TOKEN_PATH}`, {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    })

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `GoDaddy rejected the client credentials (HTTP ${res.status}).` }
    }
    if (!res.ok) {
      return { ok: false, message: `GoDaddy returned HTTP ${res.status}. Verify credentials and base URL.` }
    }

    const json = (await res.json().catch(() => null)) as { access_token?: string } | null
    if (!json?.access_token) {
      return { ok: false, message: 'GoDaddy responded but returned no access token.' }
    }
    return { ok: true, message: 'Connected. GoDaddy issued an access token for these credentials.' }
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? 'GoDaddy did not respond in time.'
        : err instanceof Error
          ? err.message
          : 'Unknown network error.'
    return { ok: false, message: `Could not reach GoDaddy: ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

// ----------------------------------------------------------------
// disconnectGodaddy — removes the GoDaddy configuration for the
// active location + channel. Owner-only. Imported menu/order data
// stays (those rows are identified by provider + external_id and are
// independent of the connection row).
// ----------------------------------------------------------------
export async function disconnectGodaddy(
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

  const channelRaw = ((formData.get('channel') as string | null) ?? 'pos').trim()
  const channel: Channel = channelRaw === 'online' ? 'online' : 'pos'
  const provider = providerForChannel(channel)

  const { error } = await ctx.supabase
    .from('external_pos_connections')
    .delete()
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', provider)

  if (error) return { error: error.message }

  revalidatePath('/settings')
  return { ok: true, message: 'GoDaddy disconnected. Imported menu and sales records were preserved.' }
}
