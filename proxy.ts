import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isMainHost, normalizeHost } from '@/lib/sites/hosts'

// ----------------------------------------------------------------
// proxy.ts  (this is what Next.js 16 calls "middleware")
//
// This file runs on the SERVER before EVERY page request.
// It's the first thing that executes — before any layout or page.
//
// Its two jobs:
//   1. Keep the Supabase session alive (refresh tokens automatically)
//   2. Redirect users to the right place based on whether they're logged in
//
// IMPORTANT: Never use supabase.auth.getSession() here.
//   getSession() reads from a cookie, which can be faked by anyone.
//   getUser() validates the token with Supabase's server — it's safe.
// ----------------------------------------------------------------

// Machine-authenticated routes. These endpoints are called by
// external systems (GitHub Actions cron, Poynt + Plaid webhook
// delivery) that never carry a browser Supabase session. They
// authenticate themselves at the route layer — CRON_SECRET Bearer
// for cron, SHA1 HMAC of the raw body for Poynt, and an ES256 JWT
// (`plaid-verification`) whose request_body_sha256 claim must match
// the raw body for Plaid. Running them through the normal
// session-based redirect below sends every call to /login (307),
// which silently kills the cron and prevents Poynt or Plaid from
// ever delivering a webhook.
//
// This bit Plaid: /api/plaid/webhook shipped in 4fa7906 but was
// never added here, so every SYNC_UPDATES_AVAILABLE Plaid sent
// bounced to /login and no bank transaction ever auto-ingested.
// /api/plaid/cron missed it too — it lives under /api/plaid/,
// NOT the /api/cron/ prefix above, so the safety net was dead as
// well. .github/workflows/plaid-sync.yml now fails loud on any
// 3xx from the cron endpoint, so a regression here is visible.
//
// Short-circuit BEFORE creating the Supabase client so we don't
// pay session-refresh overhead for these calls either. Anything
// added here must have its own request-level auth.
const MACHINE_ROUTES = [
  '/api/cron/',            // any /api/cron/* — GitHub Actions poker
  '/api/godaddy/webhooks', // Poynt POSTs here — verified via HMAC
  '/api/plaid/webhook',    // Plaid POSTs here — verified via ES256 JWT
  '/api/plaid/cron',       // GitHub Actions poker — CRON_SECRET Bearer
] as const

function isMachineRoute(path: string): boolean {
  return MACHINE_ROUTES.some((prefix) =>
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix,
  )
}

export default async function proxy(request: NextRequest) {
  const machinePath = request.nextUrl.pathname
  if (isMachineRoute(machinePath)) {
    return NextResponse.next()
  }

  // ---- Tenant-host routing (websites project) ----
  //
  // Anything not on the main app's host is a hosted customer site
  // and needs to reach `app/(sites)/[siteHost]/[[...path]]/route.ts`.
  // Visitors are anonymous — SKIP the Supabase session refresh + the
  // login/kiosk redirects entirely; those are main-app-only concerns.
  //
  // The rewrite is invisible to the browser: the URL bar keeps
  // showing `tea.checked.app/menu` while the app internally handles
  // `/tea.checked.app/menu`. See [[websites-project]].
  const host = normalizeHost(request.headers.get('host'))
  if (!isMainHost(host)) {
    const url = request.nextUrl.clone()
    const currentPath = url.pathname === '/' ? '' : url.pathname
    url.pathname = `/${host}${currentPath}`
    return NextResponse.rewrite(url)
  }

  // We start with a plain "continue" response and may replace it with
  // a redirect. We must pass the request object into it so Supabase
  // can attach updated cookies to the response.
  let response = NextResponse.next({ request })

  // Create a Supabase client that reads/writes cookies directly on the
  // request and response objects (not from next/headers — that's for
  // server components and actions only).
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // First, write updated cookies onto the request object
          // (needed for Supabase internals within this same request).
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          // Then, write them onto the response so the browser receives
          // and stores the refreshed session token.
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Validate the user's session with Supabase's server.
  // This also refreshes the token if it's about to expire.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname

  // ---- Routing rules ----
  //
  // DESIGN: Instead of listing every protected path (and forgetting
  // new ones like /menu, /sales, etc.), we list the FEW public paths
  // and protect everything else. This way new modules are automatically
  // protected without editing this file.

  // Site-preview URLs (/preview-site/<slug>/…) render a hosted
  // tenant site on the main host. Same public read model as the
  // tenant hostname itself — no login required. Safe: the preview
  // route only surfaces sites already at status='live'.
  const isPublicPage = path === '/' || path.startsWith('/preview-site/')
  // Pages logged-out users are allowed to reach as part of the auth
  // flow itself. /forgot-password starts a reset; /auth/callback
  // exchanges the magic-link code for a session; /reset-password
  // is the form they land on AFTER the callback (the callback gave
  // them a session). All three must be reachable without an existing
  // session.
  const isAuthFlowPage =
    path === '/login' ||
    path === '/signup' ||
    path === '/forgot-password' ||
    path === '/reset-password' ||
    path === '/auth/callback' ||
    // /auth/accept-invite lands an INVITED user immediately after
    // /auth/callback gave them a session. By the time the proxy
    // sees this request they SHOULD have a session, but listing
    // it as an auth-flow page makes the page reachable even if
    // the session refresh races with the redirect (avoids a
    // momentary bounce to /login).
    path === '/auth/accept-invite'
  // The subset of auth-flow pages that signed-IN users should NOT
  // sit on. /login and /signup belong here — they should bounce to
  // the app. /forgot-password and /reset-password DON'T belong here
  // — a signed-in user may still want to change their password.
  const isSigninPage = path === '/login' || path === '/signup'

  // Rule 1: Not logged in + not on a public or auth-flow page → go to login.
  // This covers /dashboard, /menu, /sales, /onboarding, and any
  // future route automatically.
  if (!user && !isPublicPage && !isAuthFlowPage) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Rule 2: Logged in + on /login or /signup → go to dashboard.
  // (app)/layout.tsx will redirect to /onboarding if they have no restaurant.
  if (user && isSigninPage) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  // ---- Kiosk access-mode gate ----
  //
  // Signed-in users carry a `pos_mode` cookie set here or by
  // /access. Two values: 'owner' (full system) or 'staff' (POS only).
  //
  //   • No cookie + protected path → check whether the restaurant
  //     has an owner code configured. If not, set the cookie to
  //     'owner' and continue (newly-onboarded users aren't gated
  //     by their own absence). If yes, redirect to /access.
  //
  //   • Cookie = 'staff' + path other than /pos or /access → kick
  //     back to /pos. Staff can't browse anywhere else.
  //
  //   • Cookie = 'owner' → no extra restriction; behaves like
  //     before this gate existed.
  //
  // We do the DB lookup ONLY when the cookie is missing — once set
  // the next 30 days of requests skip this branch entirely.
  if (user && !isAuthFlowPage && !isPublicPage) {
    const posMode = request.cookies.get('pos_mode')?.value
    const isAccessPage = path === '/access'
    const isOnboardingPage = path.startsWith('/onboarding')
    const isApiRoute = path.startsWith('/api/')

    if (!posMode && !isAccessPage && !isOnboardingPage && !isApiRoute) {
      // Determine whether the gate is actually configured for this
      // restaurant. The query is tolerant of a pre-migration deploy
      // — if the column doesn't exist the select errors and we treat
      // ownerCodeSet as false (gate off), so the kiosk feature
      // degrades gracefully until the SQL is run.
      let ownerCodeSet = false
      try {
        const { data: roleRow } = await supabase
          .from('user_roles')
          .select('restaurant_id')
          .eq('user_id', user.id)
          .maybeSingle()
        if (roleRow?.restaurant_id) {
          const { data: r } = await supabase
            .from('restaurants')
            .select('owner_passcode_hash')
            .eq('id', roleRow.restaurant_id)
            .maybeSingle()
          ownerCodeSet = !!(r as { owner_passcode_hash?: string | null } | null)?.owner_passcode_hash
        }
      } catch {
        ownerCodeSet = false
      }

      if (ownerCodeSet) {
        return NextResponse.redirect(new URL('/access', request.url))
      }
      // No gate configured → set the cookie and let them through.
      // This is the path a freshly-onboarded user takes; they never
      // see the access screen until they explicitly configure codes.
      response.cookies.set('pos_mode', 'owner', {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      })
      return response
    }
    if (posMode === 'staff' && !isAccessPage && path !== '/pos' && !isApiRoute) {
      return NextResponse.redirect(new URL('/pos', request.url))
    }
  }

  // For everything else, continue normally and return the response
  // (which may carry refreshed session cookies).
  return response
}

// Tell Next.js which paths this proxy should run on.
// We exclude Next.js internals and static files so we don't slow them down —
// and, more importantly, so tenant-host rewrites don't misroute /assets/*
// files. Anything ending in a static-asset extension bypasses the middleware
// entirely and is served directly from public/ by Next.js. Includes .js,
// .json, and font/CSS extensions so hosted-site widgets (Valley's D3 map)
// can pull their own scripts + data files off the platform origin.
//
// tv-k7m2q9x4 is the office TV display (public/tv-k7m2q9x4/index.html) —
// a static, unlisted slideshow that has to load in a kiosk browser with no
// session. Excluded by path prefix so it never hits the login redirect.
// The slug is the only thing keeping it unlisted; do not link to it from
// anywhere indexable.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|tv-k7m2q9x4|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|mjs|json|woff|woff2|ttf|eot|map|txt|xml)$).*)',
  ],
}
