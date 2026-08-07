// ----------------------------------------------------------------
// /preview-site/[slug]/[[...path]]  — main-host preview of a tenant
// site.
//
// The normal render route only fires under a tenant hostname (host
// rewrite in proxy.ts, guard in app/(sites)/[siteHost]/…). That's
// the tenant illusion — visitors see the site under its own domain,
// never as a subpath.
//
// This preview route breaks that illusion on purpose so the site
// can be inspected on the main host while a tenant hostname is
// still being validated (DNS propagation, Vercel wildcard warmup,
// pre-launch review). The URL is deliberately awkward and
// non-canonical so nobody links to it accidentally.
//
// Behavior:
//   - Looks the site up by SLUG (not by host) via resolveSiteBySlug.
//   - Same page/param resolution as the live route.
//   - Rewrites all `href="/…"` and `action="/…"` in the rendered
//     HTML to `/preview-site/<slug>/…` so in-site navigation stays
//     inside the preview namespace. Asset paths (`/assets/…`,
//     `/_next/…`, `/api/…`) are left alone so images and framework
//     internals still resolve at the main host root.
//   - Sends `noindex` — a preview URL shouldn't turn up in search.
//
// Delete this file once every tenant has a live custom hostname
// and preview-on-main-host is no longer needed. Nothing else in
// the app depends on it.
// ----------------------------------------------------------------

import { NextResponse } from 'next/server'
import {
  resolveSiteBySlug,
  resolvePageWithParams,
  renderPageHTML,
  renderNotFoundHTML,
} from '@/lib/sites/render'

interface Ctx {
  params: Promise<{ slug: string; path?: string[] }>
}

export async function GET(req: Request, { params }: Ctx) {
  const { slug, path } = await params
  const urlPath = normalizePath(path)

  const site = await resolveSiteBySlug(slug)
  if (!site) return htmlResponse(renderNotFoundHTML(slug), 404)

  const resolved = await resolvePageWithParams(site.id, urlPath)
  if (!resolved) return htmlResponse(renderNotFoundHTML(slug), 404)

  const url = new URL(req.url)
  const query: Record<string, string> = {}
  url.searchParams.forEach((value, key) => { query[key] = value })

  const rendered = await renderPageHTML(site, resolved.page, `${slug}.onchecked.app`, {
    query,
    params: resolved.params,
  })

  return htmlResponse(rewriteLinks(rendered, slug), 200)
}

function normalizePath(pathSegments: string[] | undefined): string {
  if (!pathSegments || pathSegments.length === 0) return '/'
  return '/' + pathSegments.join('/')
}

/** Prefix every href/action absolute path with the preview namespace
 *  so in-site nav stays inside /preview-site/<slug>. Asset-shaped
 *  paths are left alone — they must resolve at the main host root
 *  (public/ static files, framework internals). */
function rewriteLinks(html: string, slug: string): string {
  const prefix = `/preview-site/${slug}`
  return html.replace(/(href|action)="\/([^"]*)"/g, (match, attr: string, path: string) => {
    if (
      path.startsWith('assets/') ||
      path.startsWith('_next/') ||
      path.startsWith('api/')
    ) return match
    return `${attr}="${prefix}/${path}"`
  })
}

function htmlResponse(html: string, status: number): Response {
  return new NextResponse(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Preview URLs must not enter the search index — this is a
      // pre-launch fixture, not the canonical tenant URL.
      'x-robots-tag': 'noindex, nofollow',
    },
  })
}
