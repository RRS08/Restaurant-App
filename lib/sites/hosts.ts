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
export const SITE_ROOT_HOSTNAME = 'checked.app'

/** Hosts that map to the main app (dashboard / menu / staffing /
 *  etc.), NOT to a hosted site. Comparisons are lowercase and
 *  port-stripped. Vercel preview URLs (`*.vercel.app`) are also
 *  considered main-app so we don't try to route them through the
 *  tenant matcher. */
const MAIN_HOSTNAMES: readonly string[] = [
  SITE_ROOT_HOSTNAME,
  `www.${SITE_ROOT_HOSTNAME}`,
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

/** For a `<slug>.checked.app` host, return the leading slug. */
export function extractPlatformSlug(host: string | null | undefined): string | null {
  const h = normalizeHost(host)
  if (!isPlatformSubdomain(h)) return null
  return h.slice(0, -(`.${SITE_ROOT_HOSTNAME}`.length))
}
