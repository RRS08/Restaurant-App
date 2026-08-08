// ----------------------------------------------------------------
// GoDaddy Poynt — per-merchant token store
//
// Wraps the `godaddy_poynt_tokens` table so the adapter (and any
// future caller) can ask for a valid access token by
// restaurant_id and get one — refreshed if we're within the
// preemptive-refresh window, freshly issued if we've just gone
// through the OAuth callback.
//
// Also wraps the short-lived `godaddy_poynt_oauth_states` table
// used for CSRF-safe install redirects.
//
// All access here is through the Supabase admin client because the
// tables are RLS-locked (using(false)). Direct row browsing is
// impossible; every read/write is server-side and audited.
// ----------------------------------------------------------------

import { createAdminClient } from '@/lib/supabase/admin'
import { randomBytes } from 'crypto'
import { refreshMerchantToken } from './oauth'

// Preemptive refresh: renew when we've got <= this many seconds
// of life left. The 24h token lifetime + a 5-minute cushion
// means a scheduled sync running once every 15 minutes never
// hits an expired token even if a refresh call adds latency.
const REFRESH_SLACK_SECONDS = 300

export interface StoredPoyntToken {
  id: string
  restaurantId: string
  businessId: string
  accessToken: string
  refreshToken: string
  scope: string | null
  tokenType: string
  expiresAt: string
  connectedAt: string
  updatedAt: string
  /** Which Poynt environment this token authorizes against.
   *  'prod' = services.poynt.net (real merchants + real charges).
   *  'ote'  = services.ote-poynt.net (sandbox test merchants).
   *  A restaurant can hold both simultaneously so the same
   *  merchant can be tested in sandbox without touching their
   *  live prod token. */
  env: PoyntEnv
  /** Non-null once webhook registration with Poynt succeeded.
   *  If null, the merchant is connected but no real-time push is
   *  active — the manual Sync + GitHub Actions cron carry the
   *  ingest load and re-registration can be attempted from the
   *  Settings UI. */
  webhookId: string | null
  webhookSecret: string | null
}

/** Poynt environment marker stored on token rows. Prior version
 *  of this file exported a `currentPoyntEnv()` helper that read
 *  POYNT_ENV globally — that was the wrong design: it made ALL
 *  Poynt-touching code paths (POS ingest, webhooks, cron, checkout)
 *  swap environments together, which took Hatziri's live POS sync
 *  down the moment we tried to test checkout in OTE. Env is now
 *  scoped per-caller: POS-side callers (webhooks, ingest) always
 *  use 'prod'; the checkout adapter reads env from the site's
 *  own config so one site can go sandbox without affecting anything
 *  else on the platform. */
export type PoyntEnv = 'prod' | 'ote'

// ================================================================
// OAuth state (CSRF for the install redirect)
// ================================================================

/** Generate a random opaque state, persist {state, restaurant_id,
 *  env} with a 15-minute expiry, and return the state for the
 *  authorize-URL builder to embed. Env defaults to 'prod' — the
 *  install route passes 'ote' explicitly when the merchant is
 *  linking a sandbox test merchant. */
export async function issueOAuthState(
  restaurantId: string,
  env: PoyntEnv = 'prod',
): Promise<string> {
  const state = randomBytes(24).toString('base64url')
  const admin = createAdminClient()
  const { error } = await admin.from('godaddy_poynt_oauth_states').insert({
    state,
    restaurant_id: restaurantId,
    env,
  })
  if (error) {
    throw new Error(`Could not issue OAuth state: ${error.message}`)
  }
  return state
}

/** Look up a pending state, verify it's not expired, and delete
 *  it in the same round-trip (single-use). Returns the
 *  {restaurant_id, env} it was issued for, or null when the state
 *  is unknown, expired, or already consumed. Env drives which
 *  authorize host + token exchange base URL the callback uses. */
export async function consumeOAuthState(state: string): Promise<{ restaurantId: string; env: PoyntEnv } | null> {
  if (!state) return null
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('godaddy_poynt_oauth_states')
    .select('restaurant_id, env, expires_at')
    .eq('state', state)
    .maybeSingle()
  if (error || !data) return null
  const expired = new Date(data.expires_at as string).getTime() < Date.now()
  // Delete unconditionally — either it's consumed or it was
  // expired garbage. Either way it shouldn't sit in the table.
  await admin.from('godaddy_poynt_oauth_states').delete().eq('state', state)
  if (expired) return null
  return {
    restaurantId: data.restaurant_id as string,
    env: ((data.env as PoyntEnv | null) ?? 'prod'),
  }
}

// ================================================================
// Per-merchant tokens
// ================================================================

/** Insert or update the token row for (restaurant, business, env).
 *  The post-OAuth callback + refresh paths both land here. Env
 *  defaults to 'prod' — the OAuth callback triggered from the app's
 *  Connect GoDaddy Commerce button is a production grant unless a
 *  future sandbox-OAuth flow overrides it explicitly. */
export async function upsertMerchantToken(args: {
  restaurantId: string
  businessId: string
  accessToken: string
  refreshToken: string
  scope: string | null
  tokenType: string
  expiresInSeconds: number
  env?: PoyntEnv
}): Promise<void> {
  const admin = createAdminClient()
  const expiresAt = new Date(Date.now() + args.expiresInSeconds * 1000).toISOString()
  const env: PoyntEnv = args.env ?? 'prod'
  const { error } = await admin
    .from('godaddy_poynt_tokens')
    .upsert(
      {
        restaurant_id: args.restaurantId,
        business_id: args.businessId,
        env,
        access_token: args.accessToken,
        refresh_token: args.refreshToken,
        scope: args.scope,
        token_type: args.tokenType,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'restaurant_id,business_id,env' },
    )
  if (error) {
    throw new Error(`Could not persist Poynt tokens: ${error.message}`)
  }
}

/** Load the PROD Poynt connection for a restaurant. All POS-side
 *  callers (webhook processing, ingest cron, manual sync, order
 *  fetches) use this — production Poynt is where real money and
 *  real POS orders live, and defaulting there means an accidental
 *  env var (or a future dev experimenting with sandbox) can never
 *  take live POS ingest down. Checkout code paths that need to opt
 *  into sandbox use `getStoredTokenForEnv(restaurantId, 'ote')`
 *  explicitly. */
export async function getStoredToken(restaurantId: string): Promise<StoredPoyntToken | null> {
  return getStoredTokenForEnv(restaurantId, 'prod')
}

/** Explicit-env variant. The checkout adapter uses this with the
 *  env derived from `sites.config.payment_env` so one site can go
 *  sandbox without any other Poynt-touching code seeing OTE. */
export async function getStoredTokenForEnv(
  restaurantId: string,
  env: PoyntEnv,
): Promise<StoredPoyntToken | null> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('godaddy_poynt_tokens')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('env', env)
    .maybeSingle()
  if (error || !data) return null
  return {
    id: data.id as string,
    restaurantId: data.restaurant_id as string,
    businessId: data.business_id as string,
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    scope: (data.scope as string | null) ?? null,
    tokenType: (data.token_type as string) ?? 'BEARER',
    expiresAt: data.expires_at as string,
    connectedAt: data.connected_at as string,
    updatedAt: data.updated_at as string,
    env: (data.env as PoyntEnv) ?? 'prod',
    webhookId: (data.webhook_id as string | null) ?? null,
    webhookSecret: (data.webhook_secret as string | null) ?? null,
  }
}

/** Return a currently-valid access token for a restaurant,
 *  refreshing preemptively when we're inside the slack window.
 *  Callers hitting Poynt's API should always go through this so
 *  a stale token in the store never surfaces as a 401. */
export async function getValidAccessToken(restaurantId: string): Promise<
  | { accessToken: string; businessId: string }
  | { error: string }
> {
  const stored = await getStoredToken(restaurantId)
  if (!stored) return { error: 'This restaurant has not linked a GoDaddy Commerce merchant yet.' }

  const secondsLeft = Math.floor((new Date(stored.expiresAt).getTime() - Date.now()) / 1000)
  if (secondsLeft > REFRESH_SLACK_SECONDS) {
    return { accessToken: stored.accessToken, businessId: stored.businessId }
  }

  // Refresh path. On failure we bubble a useful error rather than
  // returning the stale token — a 401 downstream is worse than a
  // clear "reconnect required" message here.
  try {
    // Refresh must hit the SAME env the token was issued against —
    // a prod refresh_token 401s on services.ote-poynt.net.
    const fresh = await refreshMerchantToken({ refreshToken: stored.refreshToken, env: stored.env })
    await upsertMerchantToken({
      restaurantId: stored.restaurantId,
      businessId: stored.businessId,
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      scope: fresh.scope,
      tokenType: fresh.tokenType,
      expiresInSeconds: fresh.expiresIn,
      // Preserve the row's env — a refresh must never migrate a
      // token between environments even if config changed
      // between issue and refresh.
      env: stored.env,
    })
    return { accessToken: fresh.accessToken, businessId: stored.businessId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `Refresh failed — the merchant may need to reconnect: ${msg}` }
  }
}
