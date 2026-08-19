// ----------------------------------------------------------------
// Server-side session cart for hosted tenant sites.
//
// Cart state lives in `site_carts` (one row per (site, session)),
// keyed by an opaque UUID stored in an httpOnly cookie scoped to
// the tenant subdomain. The server owns every mutation — the
// client never edits `items` directly, only POSTs
// slug/qty via /api/site-cart/(add|set).
//
// Product metadata (name, price, image, unit) is NOT copied into
// the cart. It's joined at read time from `site_products` so a
// price edit is reflected on the next cart view — no stale
// snapshots inside carts we can't easily migrate.
//
// Concurrency: add/set does a read-modify-write against the JSONB
// column. Two concurrent adds from the same session could clobber.
// Acceptable at this stage (no reports, no analytics dependent on
// exact counts); revisit with a locked upsert if it starts to matter.
// ----------------------------------------------------------------

import { randomUUID } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SiteCartItem } from './types'
import {
  fillDefaults,
  formatVariantLabel,
  normalizeGroups,
  normalizeOptions,
  optionsKey,
  resolveUnitPrice,
} from './cart-options'

export const CART_COOKIE_NAME = 'site_cart_session'
export const CART_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export interface EnrichedCartItem {
  slug: string
  qty: number
  name: string
  /** Unit price resolved against the chosen options (or base price
   *  if no picker). Line_total = price * qty. */
  price: number
  image_url: string | null
  unit: string | null
  line_total: number
  /** Selected options for this line (undefined for no-picker
   *  products). Persisted as part of the cart row. */
  options?: Record<string, string>
  /** Pre-rendered display label for the chosen variant
   *  ("Tea bags · 30 ct"). Empty string when there's no picker. */
  variant_label: string
}

export interface CartSnapshot {
  items: EnrichedCartItem[]
  count: number
  subtotal: number
}

/** Fast path used by the header's {{cart-count}} badge. Skips the
 *  join to `site_products` — the badge just needs the total qty. */
export async function loadCartCount(siteId: string, sessionId: string | null): Promise<number> {
  if (!sessionId) return 0
  const admin = createAdminClient()
  const { data } = await admin
    .from('site_carts')
    .select('items')
    .eq('site_id', siteId)
    .eq('session_id', sessionId)
    .maybeSingle()
  if (!data) return 0
  return countItems(data.items as SiteCartItem[] | null)
}

/** Full snapshot used by the {{cart}} widget on /cart. Joins
 *  `site_products` to fill in name/price/image/unit and drops any
 *  cart items whose product no longer exists or went `draft`
 *  (deleted/hidden products silently disappear from the cart). */
export async function loadCartWithItems(siteId: string, sessionId: string | null): Promise<CartSnapshot> {
  const empty: CartSnapshot = { items: [], count: 0, subtotal: 0 }
  if (!sessionId) return empty

  const admin = createAdminClient()
  const { data: cart } = await admin
    .from('site_carts')
    .select('items')
    .eq('site_id', siteId)
    .eq('session_id', sessionId)
    .maybeSingle()
  if (!cart) return empty

  const raw = (cart.items ?? []) as SiteCartItem[]
  const valid = raw.filter(i => i && typeof i.slug === 'string' && typeof i.qty === 'number' && i.qty > 0)
  if (valid.length === 0) return empty

  const slugs = valid.map(i => i.slug)
  const { data: products } = await admin
    .from('site_products')
    .select('slug, name, price, image_url, unit, options')
    .eq('site_id', siteId)
    .eq('status', 'live')
    .in('slug', slugs)

  type ProductRow = {
    slug: string
    name: string
    price: number | string
    image_url: string | null
    unit: string | null
    options: unknown
  }
  const productMap = new Map<string, ProductRow>((products ?? []).map(p => [(p as ProductRow).slug, p as ProductRow]))

  const enriched: EnrichedCartItem[] = []
  for (const i of valid) {
    const p = productMap.get(i.slug)
    if (!p) continue
    const basePrice = typeof p.price === 'number' ? p.price : parseFloat(String(p.price))
    if (!Number.isFinite(basePrice)) continue
    // Options resolution — the picker's chosen choices dictate
    // the actual unit price and the variant subtitle. A stored
    // cart line that predates the picker (or a product that has
    // no picker) yields undefined options + base price + empty
    // variant_label, so downstream renderers can treat both
    // shapes uniformly.
    const groups = normalizeGroups(p.options)
    const options = normalizeOptions(i.options)
    const unitPrice = resolveUnitPrice(basePrice, groups, options)
    const variantLabel = formatVariantLabel(groups, options)
    enriched.push({
      slug: i.slug,
      qty: i.qty,
      name: p.name,
      price: unitPrice,
      image_url: p.image_url,
      unit: p.unit,
      line_total: round2(unitPrice * i.qty),
      options,
      variant_label: variantLabel,
    })
  }

  const count = enriched.reduce((a, i) => a + i.qty, 0)
  const subtotal = round2(enriched.reduce((a, i) => a + i.line_total, 0))
  return { items: enriched, count, subtotal }
}

export type CartMutationResult =
  | { sessionId: string; count: number }
  | { error: string }

/** Increment `qty` for `slug` in the session's cart. Creates the
 *  session + row on first add. Returns the (possibly new) sessionId
 *  so the endpoint can set the cookie on response.
 *
 *  `options` carries the buyer's picker selection ({form: teabags}
 *  for a tea, {color: red, size: L} later for a shirt). When the
 *  product has a picker but options is omitted (e.g. an Add-button
 *  click from the shop grid), we silently fill in each group's
 *  default choice so the line has a fully-resolved options set —
 *  keeps rendering + line-key math consistent everywhere. */
export async function addToCart(
  siteId: string,
  sessionId: string | null,
  slug: string,
  qty: number,
  optionsIn?: Record<string, string>,
): Promise<CartMutationResult> {
  if (!Number.isInteger(qty) || qty <= 0) return { error: 'quantity must be a positive integer' }
  const product = await fetchProductForAdd(siteId, slug)
  if (!product) return { error: 'unknown product' }
  const groups = normalizeGroups(product.options)
  const options = groups.length > 0
    ? fillDefaults(groups, normalizeOptions(optionsIn))
    : undefined

  const effective = sessionId ?? randomUUID()
  const admin = createAdminClient()
  const existing = await fetchRow(admin, siteId, effective)
  const items = mergeAdd(existing?.items ?? [], slug, qty, options)
  await persist(admin, siteId, effective, existing?.id ?? null, items)
  return { sessionId: effective, count: countItems(items) }
}

/** Set (or remove) `qty` for a specific `slug` + `options` line.
 *  qty=0 removes the line. Options identify WHICH line to update
 *  when the same slug appears more than once in the cart with
 *  different variants (loose leaf + tea bags of the same tea).
 *  Creates the session lazily so a stepper action from a fresh
 *  visitor still works — an edge case, but the code is simpler
 *  this way. */
export async function setCartItem(
  siteId: string,
  sessionId: string | null,
  slug: string,
  qty: number,
  optionsIn?: Record<string, string>,
): Promise<CartMutationResult> {
  if (!Number.isInteger(qty) || qty < 0) return { error: 'quantity must be a non-negative integer' }
  let options: Record<string, string> | undefined
  if (qty > 0) {
    const product = await fetchProductForAdd(siteId, slug)
    if (!product) return { error: 'unknown product' }
    const groups = normalizeGroups(product.options)
    options = groups.length > 0
      ? fillDefaults(groups, normalizeOptions(optionsIn))
      : undefined
  } else {
    // qty=0 (removal) still needs the options key to identify the
    // right line, but we don't need to look up the product to do it.
    options = normalizeOptions(optionsIn)
  }

  const effective = sessionId ?? randomUUID()
  const admin = createAdminClient()
  const existing = await fetchRow(admin, siteId, effective)
  const items = mergeSet(existing?.items ?? [], slug, qty, options)
  await persist(admin, siteId, effective, existing?.id ?? null, items)
  return { sessionId: effective, count: countItems(items) }
}

// ---- internals -------------------------------------------------

type Admin = ReturnType<typeof createAdminClient>

/** Lightweight product lookup used on the add/set path. Returns
 *  just what we need to resolve options, or null if the slug isn't
 *  a live product on this site. Kept separate from the enrichment
 *  query in loadCartWithItems so mutation paths aren't paying for
 *  columns they won't use. */
async function fetchProductForAdd(
  siteId: string,
  slug: string,
): Promise<{ options: unknown } | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('site_products')
    .select('options')
    .eq('site_id', siteId)
    .eq('slug', slug)
    .eq('status', 'live')
    .maybeSingle()
  return data ? { options: (data as { options: unknown }).options } : null
}

async function fetchRow(admin: Admin, siteId: string, sessionId: string): Promise<{ id: string; items: SiteCartItem[] } | null> {
  const { data } = await admin
    .from('site_carts')
    .select('id, items')
    .eq('site_id', siteId)
    .eq('session_id', sessionId)
    .maybeSingle()
  if (!data) return null
  const items = Array.isArray(data.items) ? (data.items as SiteCartItem[]) : []
  return { id: data.id as string, items }
}

async function persist(admin: Admin, siteId: string, sessionId: string, rowId: string | null, items: SiteCartItem[]): Promise<void> {
  const nowIso = new Date().toISOString()
  if (rowId) {
    await admin
      .from('site_carts')
      .update({ items, updated_at: nowIso })
      .eq('id', rowId)
    return
  }
  if (items.length === 0) return // don't materialize an empty cart row for nothing
  await admin
    .from('site_carts')
    .insert({ site_id: siteId, session_id: sessionId, items })
}

function mergeAdd(
  items: SiteCartItem[],
  slug: string,
  qty: number,
  options: Record<string, string> | undefined,
): SiteCartItem[] {
  const wantKey = optionsKey(options)
  const next = [...items]
  const idx = next.findIndex(i => i.slug === slug && optionsKey(i.options) === wantKey)
  if (idx >= 0) {
    next[idx] = { slug, qty: next[idx].qty + qty, options }
  } else {
    next.push({ slug, qty, options })
  }
  return next
}

function mergeSet(
  items: SiteCartItem[],
  slug: string,
  qty: number,
  options: Record<string, string> | undefined,
): SiteCartItem[] {
  const wantKey = optionsKey(options)
  if (qty === 0) {
    return items.filter(i => !(i.slug === slug && optionsKey(i.options) === wantKey))
  }
  const next = [...items]
  const idx = next.findIndex(i => i.slug === slug && optionsKey(i.options) === wantKey)
  if (idx >= 0) {
    next[idx] = { slug, qty, options }
  } else {
    next.push({ slug, qty, options })
  }
  return next
}

function countItems(items: SiteCartItem[] | null): number {
  if (!Array.isArray(items)) return 0
  return items.reduce((a, i) => a + (typeof i?.qty === 'number' && i.qty > 0 ? i.qty : 0), 0)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
