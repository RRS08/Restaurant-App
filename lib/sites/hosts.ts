// ----------------------------------------------------------------
// Host / hostname helpers for the multi-tenant site renderer.
//
// A single Next.js app serves both:
//   - the main product surface (checked.app / localhost / preview URLs)
//   - every hosted customer site (tea-co.checked.app, customdomain.com)
//
// Middleware needs to tell those two cases apart before deciding
// whether to rewrite. A tiny centralized module here keeps the
// "which host is main?" logic in one place — the middleware, the
// site renderer, and any future domain-management action all
// consult the same list.
// ----------------------------------------------------------------

/** The apex domain the platform ships under. Every hosted site
 *  gets a free `<slug>.SITE_ROOT_HOSTNAME` subdomain. */
export const SITE_ROOT_HOSTNAME = 'onchecked.app'

/** Hosts that map to the main app (dashboard / menu / staffing /
 *  etc.), NOT to a hosted site. Comparisons are lowercase and
 *  port-stripped. Vercel preview URLs (`*.vercel.app`) are also
 *  considered main-app so we don't try to route them through the
 *  tenant matcher. `checked.app` is included as a legacy alias in
 *  case the original naming ever gets rehydrated as a redirect. */
const MAIN_HOSTNAMES: readonly string[] = [
  SITE_ROOT_HOSTNAME,
  `www.${SITE_ROOT_HOSTNAME}`,
  'checked.app',
  'www.checked.app',
  'localhost',
  '127.0.0.1',
]

/** Strip an optional `:port` suffix and lowercase. */
export function normalizeHost(host: string | null | undefined): string {
  if (!host) return ''
  return host.split(':')[0].trim().toLowerCase()
}

/** True when the host is one of the main-app hostnames. */
export function isMainHost(host: string | null | undefined): boolean {
  const h = normalizeHost(host)
  if (!h) return false
  if (MAIN_HOSTNAMES.includes(h)) return true
  // Vercel preview URLs (`<random>.vercel.app`) also serve the main
  // app so we never accidentally treat a preview build as a tenant.
  if (h.endsWith('.vercel.app')) return true
  return false
}

/** True when the host looks like a `<slug>.checked.app` subdomain
 *  of the platform. Used by the middleware to prefer the fast
 *  `sites.slug` lookup over the general `site_domains.hostname`
 *  match. */
export function isPlatformSubdomain(host: string | null | undefined): boolean {
  const h = normalizeHost(host)
  if (!h) return false
  const suffix = `.${SITE_ROOT_HOSTNAME}`
  if (!h.endsWith(suffix)) return false
  const label = h.slice(0, -suffix.length)
  // Reject anything that isn't a single subdomain label (i.e.
  // `foo.bar.checked.app` shouldn't match, only `foo.checked.app`).
  return label.length > 0 && !label.includes('.')
}

/** Guaranteed-alive platform origin for a hosted site, e.g.
 *  `https://hatziri.onchecked.app`. The subdomain answers even if
 *  a custom domain lapses, so this is the ultimate fallback for
 *  content that outlives the request (emails, receipts, links a
 *  buyer opens months later). Use `siteOrigin()` in most places —
 *  this is only for callers that don't have a site row on hand. */
export function platformOriginForSlug(slug: string): string {
  return `https://${slug}.${SITE_ROOT_HOSTNAME}`
}

/** Canonical https origin for a site — the "unplug one domain,
 *  plug in another" adapter. Resolution order:
 *
 *    1. `sites.config.primary_hostname` — explicit override.
 *       Set this to the custom domain when it goes live
 *       (`'www.hatziri.com'`) so emails and receipts brand-match
 *       the URL buyers used. Clear it to fall back to the
 *       subdomain if the custom domain lapses.
 *    2. Platform subdomain (`<slug>.onchecked.app`) — always
 *       answers, so it's the safe fallback.
 *
 *  Sync (no DB query) because it reads from the site row already
 *  in memory. Every email / receipt / anything that outlives the
 *  request should go through here instead of hardcoding the
 *  subdomain — that way domain moves are a one-row JSONB update
 *  with no code changes. */
export function siteOrigin(site: {
  slug: string
  config?: Record<string, unknown> | null
}): string {
  const primary = site.config && typeof site.config === 'object'
    ? (site.config as { primary_hostname?: unknown }).primary_hostname
    : null
  if (typeof primary === 'string' && primary.length > 0) {
    // Strip any accidental scheme prefix so operators can set
    // 'www.hatziri.com' or 'https://www.hatziri.com' interchangeably.
    const host = primary.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    return `https://${host}`
  }
  return platformOriginForSlug(site.slug)
}

/** Absolutize a site-relative asset path against a site origin.
 *  Already-absolute URLs pass through untouched, so a site that
 *  moves its images to a CDN keeps working with no change here. */
export function absoluteAssetUrl(origin: string, path: string | null | undefined): string | null {
  if (!path) return null
  if (/^https?:\/\//i.test(path)) return path
  return `${origin}${path.startsWith('/') ? '' : '/'}${path}`
}

/** Canonical https URL for the Checked wordmark glyph. Every
 *  Checked-produced surface (order confirmation emails, future PDF
 *  receipts, invoices, in-app notifications, transactional messages)
 *  should sign off with this same asset — the equivalent of a
 *  painter's signature. Served from public/ on the platform root
 *  so a single URL works across every tenant subdomain. */
export function checkedMarkUrl(): string {
  return `https://${SITE_ROOT_HOSTNAME}/checked-mark.svg`
}

/** For a `<slug>.checked.app` host, return the leading slug. */
export function extractPlatformSlug(host: string | null | undefined): string | null {
  const h = normalizeHost(host)
  if (!isPlatformSubdomain(h)) return null
  return h.slice(0, -(`.${SITE_ROOT_HOSTNAME}`.length))
}
