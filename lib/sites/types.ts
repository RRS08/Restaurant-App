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
  /** Buyer-facing option groups (form/size/color/…). Null or [] =
   *  single-variant product with no picker. Shape is intentionally
   *  extensible: every group carries its own label + choices so a
   *  future two-dimensional product (color + size) just adds a
   *  second entry to the array — no schema change. */
  options: SiteProductOptionGroup[] | null
  /** Whether this product's line total contributes to the taxable
   *  subtotal at checkout. Default true — merchant flips it to
   *  false for tax-exempt items (some jurisdictions exempt raw
   *  foods, medical, etc.). Delivery + all other line totals are
   *  taxed normally. */
  taxable: boolean
}

/** One dimension of buyer choice on a product. For a tea, `key` is
 *  "form" and `choices` are [loose, teabags]. For a shirt later, a
 *  product might carry two groups: [color] and [size]. */
export interface SiteProductOptionGroup {
  key: string
  label: string
  choices: SiteProductOptionChoice[]
}

export interface SiteProductOptionChoice {
  key: string
  label: string
  /** Overrides the product's base price when this choice is
   *  selected. Undefined = use the base price. When multiple groups
   *  each carry a price override, resolveUnitPrice() falls back
   *  through them in group order — see lib/sites/cart-options.ts. */
  price?: number
}

export interface SiteCartItem {
  slug: string
  qty: number
  /** Map from option-group key → selected choice key. Absent /
   *  empty = base variant. Two cart lines with same slug but
   *  different options are treated as separate lines, so a buyer
   *  can add loose leaf + tea bags of the same tea and see both. */
  options?: Record<string, string>
}

export interface SiteDeliveryOption {
  /** Stable machine key stored on the order + used for lookups. */
  key: string
  /** Display label (e.g. "Pick up in store", "Ship to me"). */
  label: string
  /** Secondary line under the label (e.g. address, carrier). */
  sublabel?: string
  /** Optional third line (e.g. "Usually ready in 2 hours"). */
  note?: string
  /** Cost in dollars added to the order total. */
  price: number
  /** When true, the buyer must fill in a shipping address on the
   *  delivery step for this option. */
  requires_address?: boolean
  /** When true, this option is preselected on page load. */
  default?: boolean
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
