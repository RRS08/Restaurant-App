// ----------------------------------------------------------------
// Row shapes for the sites schema. Kept in one place so both the
// renderer and any future dashboard code point at the same types.
// The DB carries `config` and `seo` as JSONB — we widen them here
// to `Record<string, unknown>` and let callers narrow via the
// specific keys they read.
// ----------------------------------------------------------------

export interface SiteRow {
  id: string
  restaurant_id: string
  slug: string
  status: 'draft' | 'live' | 'archived'
  name: string | null
  config: Record<string, unknown>
  seo: Record<string, unknown>
  published_at: string | null
}

export interface SitePageRow {
  id: string
  site_id: string
  path: string
  title: string | null
  content: Record<string, unknown>
  seo: Record<string, unknown>
  status: 'draft' | 'live'
  published_at: string | null
}

export interface SiteDomainRow {
  id: string
  site_id: string
  hostname: string
  kind: 'subdomain' | 'custom'
  ssl_state: 'pending' | 'active' | 'error' | 'skipped'
  dns_target: string | null
  last_error: string | null
  verified_at: string | null
}
