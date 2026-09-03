// ----------------------------------------------------------------
// Tenant site render route.
//
// The middleware rewrites every request on a tenant host to
// `/{siteHost}/{path...}` — this handler catches it, resolves the
// site + page, and returns the fully-rendered HTML (or a 404 in
// the site's shell).
//
// GET  → render the page.
// POST → process a submission from a shortcode form (lead-form),
//         then redirect back to the same page with a
//         `?lead-form-submitted=<key>` query so the widget can
//         swap into its thanks state.
//
// Direct-access guard: the middleware never rewrites main-host
// requests, but the (sites) route is still reachable on the main
// host at `checked.app/{siteHost}/{path}`. We check the request
// Host header on entry and 404 when it doesn't match — the
// tenant illusion holds either way.
// ----------------------------------------------------------------

import { NextResponse } from 'next/server'
import { cookies, headers } from 'next/headers'
import { isMainHost, normalizeHost } from '@/lib/sites/hosts'
import { resolveSiteByHost, resolvePageWithParams, renderPageHTML, renderNotFoundHTML } from '@/lib/sites/render'
import { createLead } from '@/lib/sites/leads'
import { CART_COOKIE_NAME, loadCartCount } from '@/lib/sites/cart'

interface Ctx {
  params: Promise<{ siteHost: string; path?: string[] }>
}

export async function GET(req: Request, { params }: Ctx) {
  const requestHost = normalizeHost((await headers()).get('host'))
  if (isMainHost(requestHost)) {
    return htmlResponse(renderNotFoundHTML(requestHost || 'unknown'), 404)
  }

  const { siteHost, path } = await params
  const urlPath = normalizePath(path)

  const site = await resolveSiteByHost(siteHost)
  if (!site) return htmlResponse(renderNotFoundHTML(siteHost), 404)

  const resolved = await resolvePageWithParams(site.id, urlPath)
  if (!resolved) return htmlResponse(renderNotFoundHTML(siteHost), 404)

  // Flatten the URL's search params into a plain map for shortcodes
  // to read via `{{query.name}}` substitution. Repeated keys collapse
  // to their last value — good enough for filter-strip use, and we
  // can add explicit list semantics later if a widget needs them.
  const url = new URL(req.url)
  const query: Record<string, string> = {}
  url.searchParams.forEach((value, key) => { query[key] = value })

  // Read the cart session cookie once here so every {{cart-count}}
  // on the page shares the same DB query instead of each widget
  // hitting Supabase independently.
  const cookieStore = await cookies()
  const sessionId = cookieStore.get(CART_COOKIE_NAME)?.value ?? null
  const cartCount = await loadCartCount(site.id, sessionId)

  const html = await renderPageHTML(site, resolved.page, siteHost, {
    query,
    params: resolved.params,
    sessionId,
    cartCount,
  })
  return htmlResponse(html, 200)
}

export async function POST(req: Request, { params }: Ctx) {
  const requestHost = normalizeHost((await headers()).get('host'))
  if (isMainHost(requestHost)) {
    return new NextResponse('Not found', { status: 404 })
  }

  const { siteHost, path } = await params
  const urlPath = normalizePath(path)

  const site = await resolveSiteByHost(siteHost)
  if (!site) return new NextResponse('Not found', { status: 404 })

  const formData = await req.formData()
  const formKey = firstFormString(formData, '_form') ?? 'default'

  // Collect all non-underscore-prefixed fields into a plain
  // payload map. Underscore-prefixed keys are reserved (e.g.
  // `_form`), never persisted.
  const payload: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('_')) continue
    if (typeof value === 'string') payload[key] = value
  }

  const h = await headers()
  await createLead({
    siteId: site.id,
    formKey,
    payload,
    sourcePath: urlPath,
    userAgent: h.get('user-agent'),
    ipAddress: firstForwardedIp(h.get('x-forwarded-for')),
    referer: h.get('referer'),
  })

  // Redirect back to the same page with a query flag the widget
  // reads to render its thanks state. POST → 303 See Other means
  // the browser refetches with GET (idempotent, refresh-safe).
  //
  // The Location must be the PUBLIC path, not the internal one.
  // proxy.ts rewrites `host/contact` → `/host/contact` so this
  // route's `[siteHost]` segment can carry the hostname, but that
  // rewrite is invisible to the browser — the address bar still
  // says `/contact`. Reconstructing `/${siteHost}${urlPath}` here
  // leaked that internal path into a Location header, and the
  // browser resolved it against the current page, producing
  // `https://www.valleycarriersllc.com/www.valleycarriersllc.com/contact`
  // — the hostname doubled into the path, 404. The lead itself was
  // always saved; only this redirect was wrong.
  //
  // Deliberately RELATIVE. A relative Location is resolved by the
  // browser against the URL it actually requested, so this lands on
  // whichever host the visitor submitted from — custom domain,
  // `<slug>.onchecked.app`, or localhost — with no origin guessing
  // and no dependence on req.url's host surviving the proxy hop.
  // Note this is intentionally NOT siteOrigin(): that resolves to
  // the site's canonical primary_hostname, which would bounce a
  // visitor who submitted on the subdomain over to the custom
  // domain mid-flow.
  const redirectUrl = new URL(req.url)
  redirectUrl.pathname = urlPath
  redirectUrl.searchParams.set('lead-form-submitted', formKey)
  const location = `${redirectUrl.pathname}${redirectUrl.search}`
  return new NextResponse(null, { status: 303, headers: { Location: location } })
}

// ---- helpers ---------------------------------------------------

function normalizePath(pathSegments: string[] | undefined): string {
  if (!pathSegments || pathSegments.length === 0) return '/'
  return '/' + pathSegments.join('/')
}

function htmlResponse(html: string, status: number): Response {
  return new NextResponse(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Modest cache. Sites are per-tenant so a shared public
      // cache would leak. Private + a few seconds keeps a burst
      // of hits cheap without stale content on edits.
      'cache-control': 'private, max-age=10',
    },
  })
}

function firstFormString(fd: FormData, key: string): string | null {
  const v = fd.get(key)
  return typeof v === 'string' ? v : null
}

function firstForwardedIp(header: string | null): string | null {
  if (!header) return null
  const first = header.split(',')[0]?.trim()
  return first && first.length > 0 ? first : null
}
