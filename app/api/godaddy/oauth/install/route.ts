// ----------------------------------------------------------------
// GET /api/godaddy/oauth/install
//
// Kicks off Poynt's OAuth install flow. The signed-in owner clicks
// "Connect GoDaddy Commerce" in Settings, which sends them here.
// We:
//   1. Resolve the caller to their restaurant (owner-only).
//   2. Mint a random state, store {state → restaurant_id} in
//      godaddy_poynt_oauth_states for 15 minutes.
//   3. Redirect to Poynt's authorize URL with our client_id +
//      callback URL + the state (as `context`).
//
// Poynt's docs use `context` for what OAuth calls `state`; we
// treat it the same way and verify it on the callback.
// ----------------------------------------------------------------

import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { authorizeUrl } from '@/lib/godaddy/oauth'
import { issueOAuthState, getStoredTokenForEnv } from '@/lib/godaddy/tokens'

/** Short-lived cookie the callback route reads to decide which
 *  settings card should surface the success/failure banner. Set
 *  here when ?purpose=online is on the install URL; consumed and
 *  deleted by the callback route. 15 min TTL matches the state
 *  row's lifetime — either both survive or neither. */
const OAUTH_PURPOSE_COOKIE = 'godaddy_oauth_purpose'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login?redirect=/settings', req.url))
  }

  const { data: role, error: roleError } = await supabase
    .from('user_roles')
    .select('restaurant_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (roleError || !role) {
    return NextResponse.redirect(new URL('/settings?godaddy=no-restaurant', req.url))
  }
  if (role.role !== 'owner') {
    return NextResponse.redirect(new URL('/settings?godaddy=owner-only', req.url))
  }

  const restaurantId = role.restaurant_id as string

  // ?env=ote routes the whole flow (authorize URL + token exchange
  // + resulting token row) to Poynt's sandbox. Absent or any other
  // value = prod. Sandbox link is deliberately not exposed in the
  // Settings UI — sandbox connects are a maintenance / testing
  // action, initiated by hitting the URL directly with the query.
  const url0 = new URL(req.url)
  const envParam = url0.searchParams.get('env')
  const env: 'prod' | 'ote' = envParam === 'ote' ? 'ote' : 'prod'
  const state = await issueOAuthState(restaurantId, env)

  // Stash the purpose (if any) in a short-lived cookie so the
  // callback can route the success/failure banner to the right
  // settings card. 'online' → GoDaddyOnlinePaymentsCard shows a
  // dedicated banner; absent → GoDaddyConnectCard (POS) shows the
  // generic banner.
  const purpose = url0.searchParams.get('purpose')
  if (purpose === 'online') {
    const jar = await cookies()
    jar.set(OAUTH_PURPOSE_COOKIE, 'online', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 60 * 15,
    })
  }

  // Force Poynt's consent screen on ANY re-authorization.
  //
  // Poynt has no `scope` parameter on /applications/authorize (the
  // documented params are exactly redirect_uri, client_id and
  // context). Permissions come from what's configured on the app in
  // the Developer Center, and the consent screen asks the merchant
  // to approve "the resources you specified for your application".
  //
  // The consequence: after we widen the app's API Permissions, an
  // existing merchant re-connecting would — without this flag — get
  // Poynt's silent auto-consent path and a token with exactly the
  // old capabilities. The re-auth would overwrite a working token
  // and gain nothing, which is the specific failure we must avoid
  // on a live merchant.
  //
  // So: any restaurant that ALREADY holds a token for this env is
  // re-authorizing by definition and always gets prompt=consent.
  // First-time installs don't need it (there's no prior consent to
  // skip). `?reconsent=1` forces it manually if ever needed.
  const alreadyConnected = !!(await getStoredTokenForEnv(restaurantId, env))
  const forceConsent =
    purpose === 'online' ||
    alreadyConnected ||
    url0.searchParams.get('reconsent') === '1'

  // Redirect URI must match exactly what's configured in the
  // Poynt Developer Center → OAuth Settings. Derive from the
  // request's own origin so preview deployments (and local dev)
  // work without additional env vars, but honor
  // NEXT_PUBLIC_SITE_URL when it's set so we don't accidentally
  // build a redirect URI Poynt hasn't allow-listed.
  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL
  const origin = configuredOrigin || new URL(req.url).origin
  const redirectUri = `${origin}/api/godaddy/oauth/callback`

  const url = authorizeUrl({ redirectUri, state, env, forceConsent })
  return NextResponse.redirect(url)
}
