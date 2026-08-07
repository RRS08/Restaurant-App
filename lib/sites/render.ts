// ----------------------------------------------------------------
// Site render pipeline — resolve a host to a site, look up the
// requested page, expand shortcodes, wrap in an HTML shell.
//
// Runs with service-role Supabase (RLS off) because visitors to a
// hosted site are anonymous — the middleware has already vetted
// that the request maps to a `live` site + page, so leaking a
// draft is guarded there, not by row-level policy.
//
// All exported helpers are pure server code — never imported
// into a 'use client' file.
// ----------------------------------------------------------------

import { createAdminClient } from '@/lib/supabase/admin'
import { expandShortcodes } from './shortcodes'
import type { SiteRow, SitePageRow } from './types'

/** Look up a live site by any of its attached hostnames. Returns
 *  null when the hostname isn't attached, the site is archived,
 *  or (defensively) when RLS somehow bites. */
export async function resolveSiteByHost(host: string): Promise<SiteRow | null> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('site_domains')
    .select('site_id, sites!inner(id, restaurant_id, slug, status, name, config, seo, published_at)')
    .eq('hostname', host.toLowerCase())
    .maybeSingle()
  if (error || !data) return null
  // Supabase typing for the nested `sites` join is loose; cast the
  // shape after the runtime check that it's present.
  const site = (data as unknown as { sites: SiteRow }).sites
  if (!site || site.status !== 'live') return null
  return site
}

/** Look up a live site whose SLUG matches the leading subdomain
 *  label. Faster than the site_domains scan for the platform
 *  subdomain case (`tea.checked.app` → sites.slug='tea'). Falls
 *  back to `resolveSiteByHost` on miss so a slug-shaped domain
 *  attached explicitly still resolves. */
export async function resolveSiteBySlug(slug: string): Promise<SiteRow | null> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('sites')
    .select('id, restaurant_id, slug, status, name, config, seo, published_at')
    .eq('slug', slug.toLowerCase())
    .eq('status', 'live')
    .maybeSingle()
  if (error || !data) return null
  return data as SiteRow
}

/** Fetch a live page by site + URL path. `path` should start with
 *  '/' and match `site_pages.path` exactly. Static-only — for
 *  dynamic (`:slug`) matching, use `resolvePageWithParams`. */
export async function resolvePage(siteId: string, path: string): Promise<SitePageRow | null> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('site_pages')
    .select('id, site_id, path, title, content, seo, status, published_at')
    .eq('site_id', siteId)
    .eq('path', path)
    .eq('status', 'live')
    .maybeSingle()
  if (error || !data) return null
  return data as SitePageRow
}

export interface ResolvedPage {
  page: SitePageRow
  params: Record<string, string>
}

/** Resolve a page for a request path, trying an exact match first
 *  and falling back to pattern matching on paths that contain
 *  `:name` segments (e.g. `/shop/:slug`). Returns the matched page
 *  plus any captured params from the pattern. */
export async function resolvePageWithParams(siteId: string, path: string): Promise<ResolvedPage | null> {
  const exact = await resolvePage(siteId, path)
  if (exact) return { page: exact, params: {} }

  const supabase = createAdminClient()
  // Only consider rows whose stored path could conceivably be a
  // pattern — a colon anywhere in the path is our syntax for a
  // segment placeholder. Keeps the scan cheap on sites with many
  // static pages.
  const { data, error } = await supabase
    .from('site_pages')
    .select('id, site_id, path, title, content, seo, status, published_at')
    .eq('site_id', siteId)
    .eq('status', 'live')
    .like('path', '%:%')
  if (error || !data) return null

  // Rank by number of static segments so a more-specific pattern
  // wins over a broader one when both could match — e.g.
  // `/shop/featured` beats `/shop/:slug` for the URL `/shop/featured`.
  const candidates = (data as SitePageRow[])
    .map(page => ({ page, match: matchPattern(page.path, path) }))
    .filter((c): c is { page: SitePageRow; match: Record<string, string> } => c.match !== null)
    .sort((a, b) => staticSegments(b.page.path) - staticSegments(a.page.path))

  const first = candidates[0]
  if (!first) return null
  return { page: first.page, params: first.match }
}

/** Match a stored path pattern against a request path. Returns the
 *  captured params on match, or null on mismatch. Segments starting
 *  with `:` are wildcards; everything else must match literally. */
function matchPattern(pattern: string, actual: string): Record<string, string> | null {
  const pSegs = pattern.split('/')
  const aSegs = actual.split('/')
  if (pSegs.length !== aSegs.length) return null

  const out: Record<string, string> = {}
  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i]
    const a = aSegs[i]
    if (p.startsWith(':')) {
      if (a.length === 0) return null
      out[p.slice(1)] = decodeURIComponent(a)
    } else if (p !== a) {
      return null
    }
  }
  return out
}

function staticSegments(pattern: string): number {
  return pattern.split('/').filter(s => s.length > 0 && !s.startsWith(':')).length
}

/** Build the final HTML for a page render.
 *
 *  Content shapes accepted (per the JSONB column):
 *    { kind: 'raw', html, css?, js_head?, js_body? }
 *
 *  Future shapes (block editor) will be added here by branching on
 *  content.kind; the middleware and route handler don't need to
 *  know about the storage format.
 */
export interface RenderOpts {
  query?: Record<string, string>
  params?: Record<string, string>
}

export async function renderPageHTML(
  site: SiteRow,
  page: SitePageRow,
  host: string,
  opts: RenderOpts = {},
): Promise<string> {
  const content = page.content as {
    kind?: string
    html?: string
    css?: string
    js_head?: string
    js_body?: string
  }
  const rawHtml = typeof content?.html === 'string' ? content.html : ''
  const bodyHtml = await expandShortcodes(rawHtml, {
    site,
    page,
    host,
    query: opts.query ?? {},
    params: opts.params ?? {},
  })

  const seo = { ...(site.seo ?? {}), ...(page.seo ?? {}) } as {
    title?: string
    description?: string
    og_image_url?: string
    favicon_url?: string
  }
  const title = page.title ?? seo.title ?? site.name ?? site.slug
  const description = seo.description ?? ''
  const ogImage = seo.og_image_url ?? ''
  const favicon = seo.favicon_url ?? ''

  const inlineHead = typeof content?.js_head === 'string' ? content.js_head : ''
  const inlineBody = typeof content?.js_body === 'string' ? content.js_body : ''
  const pageCss = typeof content?.css === 'string' ? content.css : ''

  // Site-wide extras from sites.config. `global_css` is prepended to
  // every page's <style> so shared rules (typography, layout, brand
  // colors) live in one place. `head_extras` is a free-form HTML
  // string dropped into <head> — the canonical use is external
  // stylesheet <link> tags (Google Fonts) that don't fit the
  // page-level js_head slot.
  const config = (site.config ?? {}) as { global_css?: unknown; head_extras?: unknown }
  const globalCss = typeof config.global_css === 'string' ? config.global_css : ''
  const headExtras = typeof config.head_extras === 'string' ? config.head_extras : ''
  const combinedCss = globalCss + pageCss

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}" />` : ''}
${favicon ? `<link rel="icon" href="${escapeHtml(favicon)}" />` : ''}
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}" />` : ''}
<meta property="og:title" content="${escapeHtml(title)}" />
${description ? `<meta property="og:description" content="${escapeHtml(description)}" />` : ''}
${headExtras}
${combinedCss ? `<style>${combinedCss}</style>` : ''}
${inlineHead}
</head>
<body>
${bodyHtml}
${inlineBody}
</body>
</html>`
}

/** Minimal 404 page returned when the host or path doesn't
 *  resolve. Keeps the tenant illusion — visitors see a page from
 *  the site's shell rather than a Vercel 404. */
export function renderNotFoundHTML(host: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Not found</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; font: 15px system-ui, sans-serif; color: #52525b; background: #fafaf9; }
  main { text-align: center; padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 20px; color: #18181b; letter-spacing: -0.02em; }
</style>
</head>
<body>
<main>
  <h1>This page isn't here</h1>
  <p>Try the site's home page at <code>${escapeHtml(host)}</code>.</p>
</main>
</body>
</html>`
}

/** Escape a string for interpolation inside an HTML attribute or
 *  text node. Small, deliberately not a full sanitizer — page
 *  authors supply their own HTML in `content.html` and are
 *  trusted with it. This helper is only for values WE inject
 *  (title, meta description, host). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
