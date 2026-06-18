import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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

export default async function proxy(request: NextRequest) {
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

  const isPublicPage = path === '/'
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
  // Signed-in users carry a `pos_mode` cookie set by /access. Two
  // values: 'owner' (full system) or 'staff' (POS only).
  //
  //   • No cookie + protected path → redirect to /access. The
  //     /access page itself checks whether the restaurant has set
  //     an owner code. If not, it bounces straight to /dashboard,
  //     so newly-onboarded users aren't gated by their own absence.
  //
  //   • Cookie = 'staff' + path other than /pos or /access → kick
  //     back to /pos. Staff can't browse anywhere else.
  //
  //   • Cookie = 'owner' → no extra restriction; behaves like
  //     before this gate existed.
  //
  // /access, /onboarding, /api/*, and auth-flow pages are exempt so
  // the cookie can be obtained or the user can finish setup. We
  // DON'T gate /onboarding because a brand-new user reaches it
  // before they have a restaurant (and therefore before any code
  // could possibly be set).
  if (user && !isAuthFlowPage && !isPublicPage) {
    const posMode = request.cookies.get('pos_mode')?.value
    const isAccessPage = path === '/access'
    const isOnboardingPage = path.startsWith('/onboarding')
    const isApiRoute = path.startsWith('/api/')

    if (!posMode && !isAccessPage && !isOnboardingPage && !isApiRoute) {
      return NextResponse.redirect(new URL('/access', request.url))
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
// We exclude Next.js internals and static files so we don't slow them down.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
