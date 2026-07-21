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
import { createClient } from '@/lib/supabase/server'
import { authorizeUrl } from '@/lib/godaddy/oauth'
import { issueOAuthState } from '@/lib/godaddy/tokens'

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
  const state = await issueOAuthState(restaurantId)

  // Redirect URI must match exactly what's configured in the
  // Poynt Developer Center → OAuth Settings. Derive from the
  // request's own origin so preview deployments (and local dev)
  // work without additional env vars, but honor
  // NEXT_PUBLIC_SITE_URL when it's set so we don't accidentally
  // build a redirect URI Poynt hasn't allow-listed.
  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL
  const origin = configuredOrigin || new URL(req.url).origin
  const redirectUri = `${origin}/api/godaddy/oauth/callback`

  const url = authorizeUrl({ redirectUri, state })
  return NextResponse.redirect(url)
}
