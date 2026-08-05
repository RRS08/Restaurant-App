// ----------------------------------------------------------------
// Root middleware — multi-tenant host router.
//
// Every request arrives on either the main app (checked.app,
// localhost, *.vercel.app) or one of the hosted customer sites
// (foo.checked.app, someshop.com). This middleware inspects the
// Host header and, for tenant hosts, rewrites the URL so the
// request lands on the site-render route (`app/(sites)/[siteHost]
// /[[...path]]/route.ts`). Main-host requests are passed through
// unmodified so the existing app routes match normally.
//
// The rewrite is invisible to the browser — the URL bar still
// reads `tea.checked.app/menu`. Internally the app sees
// `/tea.checked.app/menu` which resolves to the tenant route.
//
// Direct-access defense: because `app/(sites)/[siteHost]/[[...path]]`
// is a legal route on ANY host, a curious visitor could try
// `checked.app/tea.checked.app/menu` and hit the site renderer.
// The route handler itself checks the request Host header and
// refuses to serve tenant content when it's the main app.
// ----------------------------------------------------------------

import { NextResponse, type NextRequest } from 'next/server'
import { isMainHost, normalizeHost } from '@/lib/sites/hosts'

export function middleware(req: NextRequest) {
  const host = normalizeHost(req.headers.get('host'))

  // Main app + Vercel previews + localhost — no rewrite.
  if (isMainHost(host)) return NextResponse.next()

  // Everything on a tenant host gets rewritten to the site
  // renderer. `siteHost` is the first URL segment; the renderer
  // uses it to resolve the site record.
  const url = req.nextUrl.clone()
  const currentPath = url.pathname === '/' ? '' : url.pathname
  url.pathname = `/${host}${currentPath}`
  return NextResponse.rewrite(url)
}

export const config = {
  // Skip Next internals + static assets so the middleware isn't a
  // per-image round-trip. Everything else runs through host
  // resolution.
  matcher: [
    '/((?!api|_next/static|_next/image|_next/data|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)',
  ],
}
