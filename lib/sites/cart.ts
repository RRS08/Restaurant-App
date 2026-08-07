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

export const CART_COOKIE_NAME = 'site_cart_session'
export const CART_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export interface EnrichedCartItem {
  slug: string
  qty: number
  name: string
  price: number
  image_url: string | null
  unit: string | null
  line_total: number
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
    .select('slug, name, price, image_url, unit')
    .eq('site_id', siteId)
    .eq('status', 'live')
    .in('slug', slugs)

  type ProductRow = {
    slug: string
    name: string
    price: number | string
    image_url: string | null
    unit: string | null
  }
  const productMap = new Map<string, ProductRow>((products ?? []).map(p => [(p as ProductRow).slug, p as ProductRow]))

  const enriched: EnrichedCartItem[] = []
  for (const i of valid) {
    const p = productMap.get(i.slug)
    if (!p) continue
    const priceNum = typeof p.price === 'number' ? p.price : parseFloat(String(p.price))
    if (!Number.isFinite(priceNum)) continue
    enriched.push({
      slug: i.slug,
      qty: i.qty,
      name: p.name,
      price: priceNum,
      image_url: p.image_url,
      unit: p.unit,
      line_total: round2(priceNum * i.qty),
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
 *  so the endpoint can set the cookie on response. */
export async function addToCart(
  siteId: string,
  sessionId: string | null,
  slug: string,
  qty: number,
): Promise<CartMutationResult> {
  if (!Number.isInteger(qty) || qty <= 0) return { error: 'quantity must be a positive integer' }
  if (!(await verifyProductExists(siteId, slug))) return { error: 'unknown product' }

  const effective = sessionId ?? randomUUID()
  const admin = createAdminClient()
  const existing = await fetchRow(admin, siteId, effective)
  const items = mergeAdd(existing?.items ?? [], slug, qty)
  await persist(admin, siteId, effective, existing?.id ?? null, items)
  return { sessionId: effective, count: countItems(items) }
}

/** Set (or remove) `qty` for `slug` in the session's cart. qty=0
 *  removes the line. Creates the session lazily so a stepper
 *  action from a fresh visitor still works — an edge case, but
 *  the code is simpler this way. */
export async function setCartItem(
  siteId: string,
  sessionId: string | null,
  slug: string,
  qty: number,
): Promise<CartMutationResult> {
  if (!Number.isInteger(qty) || qty < 0) return { error: 'quantity must be a non-negative integer' }
  if (qty > 0 && !(await verifyProductExists(siteId, slug))) return { error: 'unknown product' }

  const effective = sessionId ?? randomUUID()
  const admin = createAdminClient()
  const existing = await fetchRow(admin, siteId, effective)
  const items = mergeSet(existing?.items ?? [], slug, qty)
  await persist(admin, siteId, effective, existing?.id ?? null, items)
  return { sessionId: effective, count: countItems(items) }
}

// ---- internals -------------------------------------------------

type Admin = ReturnType<typeof createAdminClient>

async function verifyProductExists(siteId: string, slug: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('site_products')
    .select('slug')
    .eq('site_id', siteId)
    .eq('slug', slug)
    .eq('status', 'live')
    .maybeSingle()
  return !!data
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

function mergeAdd(items: SiteCartItem[], slug: string, qty: number): SiteCartItem[] {
  const next = [...items]
  const idx = next.findIndex(i => i.slug === slug)
  if (idx >= 0) {
    next[idx] = { slug, qty: next[idx].qty + qty }
  } else {
    next.push({ slug, qty })
  }
  return next
}

function mergeSet(items: SiteCartItem[], slug: string, qty: number): SiteCartItem[] {
  if (qty === 0) return items.filter(i => i.slug !== slug)
  const next = [...items]
  const idx = next.findIndex(i => i.slug === slug)
  if (idx >= 0) {
    next[idx] = { slug, qty }
  } else {
    next.push({ slug, qty })
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
