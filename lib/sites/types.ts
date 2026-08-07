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

export interface SiteProductRow {
  id: string
  site_id: string
  slug: string
  name: string
  secondary_name: string | null
  price: number | string
  sku: string | null
  category: string | null
  benefit: string | null
  purpose: string | null
  unit: string | null
  short_description: string | null
  long_description: string | null
  ritual: string | null
  ritual_label: string | null
  ingredients: string | null
  image_url: string | null
  featured: boolean | null
  status: string
  sort_order: number | null
}

export interface SiteCartItem {
  slug: string
  qty: number
}

export interface SiteCartRow {
  id: string
  site_id: string
  session_id: string
  items: SiteCartItem[]
  created_at: string
  updated_at: string
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
