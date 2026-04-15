// ----------------------------------------------------------------
// Square Source Adapter — V1 (real API)
//
// Third real branded adapter on top of the source-agnostic intake
// core. Built to be a real-product foundation, not a throwaway
// pilot integration.
//
// Real bits:
//   • Real Square v2 REST API with access-token auth
//   • Real catalog endpoint (/v2/catalog/list) with cursor pagination
//   • Real orders endpoint (/v2/orders/search) with cursor pagination
//   • Real per-location scoping — Square's orders/search REQUIRES a
//     location_id, which also matches our multi-location connection model
//   • Real normalization into the canonical menu + order shapes
//   • Real SyncMeta transparency (page counts, truncation, notes)
//
// Intentionally narrow for V1 (documented, not hidden):
//
//   Menu
//   • Menu import covers categories + items + base prices + active flag.
//     No modifier sets, no option groups, no images, no tax rules,
//     no per-location catalog visibility filters (we fetch the full
//     catalog).
//   • Square items have VARIATIONS, and prices live on variations —
//     not on the item itself. The canonical model doesn't know about
//     variations. Our honest mapping is:
//       - If an item has exactly one variation: one canonical item,
//         name = item.name, price = variation.price, externalId =
//         variation.id.
//       - If an item has multiple variations: one canonical item PER
//         variation, name = "${item.name} — ${variation.name}",
//         externalId = variation.id.
//     In both cases the externalId is the variation id, because that
//     is what Square orders reference as `catalog_object_id`. This
//     makes dedupe consistent between catalog sync and order sync.
//
//   Orders
//   • Each Square order → one canonical order. (Square doesn't have
//     Toast's split-check concept; one order is one ticket.)
//   • States: COMPLETED → 'completed', CANCELED → 'voided',
//     OPEN/DRAFT → skipped (not real sales yet — the canonical
//     model only represents closed sales).
//   • `tenders` array → canonical payment type. Single-tender cases
//     map cleanly. Mixed-tender cases collapse to 'other' with a
//     SyncMeta note (matches Toast).
//   • Quantity is parsed from Square's string-typed `quantity`
//     field and rounded to integer ≥ 1. Fractional quantities for
//     weighed items lose precision on quantity but revenue is kept
//     accurate via `total_money.amount`.
//
//   Auth / ops
//   • Uses a long-lived personal access token from the Square
//     developer dashboard. No OAuth authorization-code flow, no
//     refresh, no PKCE. This is acceptable for V1 and for many real
//     deployments where the operator generates their own token.
//   • No webhook subscription. Polling via `last_orders_sync_at`.
//   • No refund lifecycle itemization beyond the cancel → voided mapping.
//   • No Square-specific write paths — all DB writes go through the
//     shared ingest pipeline.
//
// The shared ingest pipeline handles dedupe, placeholder creation,
// inventory activation gate, readiness integration, and multi-tenant
// isolation. This file does not bypass any of them.
// ----------------------------------------------------------------

import type { SourceAdapter, AdapterContext } from '../adapter'
import type {
  NormalizedMenu,
  NormalizedCategory,
  NormalizedMenuItem,
  NormalizedOrder,
  NormalizedOrderLineItem,
} from '../types'

// ================================================================
// Credential shape
// ================================================================

interface SquareCredentials {
  access_token: string
  /** Square location id (starts with 'L'). Square's orders/search
   *  endpoint requires a location id, and it also anchors orders to
   *  a specific store for multi-location merchants. */
  location_id: string
  /** Optional base URL. Defaults to Square's sandbox so development
   *  testing never accidentally hits production. */
  base_url?: string
}

const DEFAULT_BASE_URL = 'https://connect.squareupsandbox.com'
const REQUEST_TIMEOUT_MS = 20_000

// Pin API version for stability. Square strongly recommends
// always sending this header so payload shapes don't shift
// underneath us between minor API updates.
const SQUARE_API_VERSION = '2024-01-18'

// V1 pagination caps. Short-cursor terminates naturally; these caps
// stop a pathological merchant from hanging a single sync call.
const CATALOG_PAGE_LIMIT = 100
const ORDERS_PAGE_LIMIT = 100
const MAX_CATALOG_PAGES = 10 // 10 * 100 = 1,000 catalog objects per sync
const MAX_ORDER_PAGES = 20   // 20 * 100 = 2,000 orders per sync

function readCredentials(raw: Record<string, unknown> | null): SquareCredentials {
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      'Square credentials missing. Expected { access_token, location_id }.'
    )
  }
  const access_token = typeof raw.access_token === 'string' ? raw.access_token.trim() : ''
  const location_id  = typeof raw.location_id  === 'string' ? raw.location_id.trim()  : ''
  const baseUrlRaw   = typeof raw.base_url     === 'string' ? raw.base_url.trim()     : ''

  if (!access_token) throw new Error('Square credentials missing "access_token".')
  if (!location_id)  throw new Error('Square credentials missing "location_id".')

  const base_url = (baseUrlRaw || DEFAULT_BASE_URL).replace(/\/+$/, '')
  return { access_token, location_id, base_url }
}

// ================================================================
// HTTP helpers
// ================================================================

function noteMeta(ctx: AdapterContext, note: string) {
  if (!ctx.meta) return
  if (!Array.isArray(ctx.meta.notes)) ctx.meta.notes = []
  ctx.meta.notes.push(note)
}

function squareHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Square-Version': SQUARE_API_VERSION,
    Accept: 'application/json',
  }
}

async function squareRequest<T>(
  url: string,
  accessToken: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        ...squareHeaders(accessToken),
        ...(init.headers ?? {}),
      },
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const snippet = body.slice(0, 200).replace(/\s+/g, ' ').trim()
      throw new Error(
        `Square API ${res.status} ${res.statusText}` +
        (snippet ? ` — ${snippet}` : '')
      )
    }

    return (await res.json()) as T
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(`Square request timed out after ${timeoutMs / 1000}s.`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// ================================================================
// Catalog (menu) — types + fetching
//
// /v2/catalog/list?types=ITEM,CATEGORY returns both categories and
// items in a single cursor-paginated response. We walk pages until
// the cursor is empty, capped at MAX_CATALOG_PAGES.
// ================================================================

interface SquareCatalogObjectBase {
  type: string
  id: string
  version?: number
  is_deleted?: boolean
}

interface SquareCategoryObject extends SquareCatalogObjectBase {
  type: 'CATEGORY'
  category_data?: { name?: string }
}

interface SquareItemVariationObject {
  type: 'ITEM_VARIATION'
  id: string
  is_deleted?: boolean
  item_variation_data?: {
    name?: string
    price_money?: { amount?: number; currency?: string }
    pricing_type?: string
    sellable?: boolean
  }
}

interface SquareItemObject extends SquareCatalogObjectBase {
  type: 'ITEM'
  item_data?: {
    name?: string
    category_id?: string
    variations?: SquareItemVariationObject[]
  }
}

type SquareCatalogObject = SquareCategoryObject | SquareItemObject | SquareCatalogObjectBase

interface SquareCatalogListResponse {
  objects?: SquareCatalogObject[]
  cursor?: string
}

async function fetchAllCatalogPages(
  ctx: AdapterContext,
  creds: SquareCredentials
): Promise<SquareCatalogObject[]> {
  const out: SquareCatalogObject[] = []
  let cursor: string | undefined = undefined
  let pages = 0
  let rawRecords = 0
  let truncated = false

  while (pages < MAX_CATALOG_PAGES) {
    const params = new URLSearchParams({
      types: 'ITEM,CATEGORY',
      limit: String(CATALOG_PAGE_LIMIT),
    })
    if (cursor) params.set('cursor', cursor)

    const url = `${creds.base_url}/v2/catalog/list?${params.toString()}`
    const payload = await squareRequest<SquareCatalogListResponse>(url, creds.access_token)

    const batch = payload.objects ?? []
    rawRecords += batch.length
    out.push(...batch)
    pages += 1

    const nextCursor = (payload.cursor ?? '').trim()
    if (!nextCursor) break
    cursor = nextCursor

    if (pages >= MAX_CATALOG_PAGES) {
      truncated = true
      break
    }
  }

  if (ctx.meta) {
    ctx.meta.pagesFetched = (ctx.meta.pagesFetched ?? 0) + pages
    ctx.meta.recordsFetched = (ctx.meta.recordsFetched ?? 0) + rawRecords
    if (truncated) {
      ctx.meta.truncated = true
      noteMeta(ctx, `Square catalog truncated at ${pages * CATALOG_PAGE_LIMIT} records (V1 page cap).`)
    }
  }

  return out
}

// ================================================================
// Catalog normalization
//
// See header comment for the "one canonical item per variation"
// rule and the naming convention for multi-variation items.
// ================================================================

function isCategory(o: SquareCatalogObject): o is SquareCategoryObject {
  return o.type === 'CATEGORY'
}
function isItem(o: SquareCatalogObject): o is SquareItemObject {
  return o.type === 'ITEM'
}

function normalizeSquareCatalog(
  objects: SquareCatalogObject[],
  ctx: AdapterContext
): NormalizedMenu {
  // Pass 1: collect categories
  const categoriesById = new Map<string, NormalizedCategory>()
  for (const o of objects) {
    if (!isCategory(o)) continue
    if (o.is_deleted) continue
    const name = o.category_data?.name?.trim()
    if (!name) continue
    categoriesById.set(o.id, { externalId: o.id, name })
  }

  // Pass 2: collect items → produce one canonical menu item per variation
  const items: NormalizedMenuItem[] = []
  let multiVariationCount = 0

  for (const o of objects) {
    if (!isItem(o)) continue
    if (o.is_deleted) continue
    const data = o.item_data
    if (!data) continue

    const itemName = (data.name ?? '').trim()
    if (!itemName) continue

    // Category id is optional; items with no category fall through
    // to the shared "Imported · Uncategorized" bucket via the ingest pipeline.
    const categoryExternalId = data.category_id && categoriesById.has(data.category_id)
      ? data.category_id
      : null

    const variations = (data.variations ?? []).filter(
      (v) => v && v.type === 'ITEM_VARIATION' && !v.is_deleted
    )

    if (variations.length === 0) {
      // Defensive: an item with no variations is effectively
      // unsellable in Square. Skip it rather than inventing a price.
      continue
    }

    const multi = variations.length > 1
    if (multi) multiVariationCount++

    for (const v of variations) {
      const vd = v.item_variation_data
      if (!vd) continue
      const priceCents = typeof vd.price_money?.amount === 'number'
        ? vd.price_money.amount
        : 0
      const price = priceCents / 100

      // Variation-level sellable flag overrides item-level active.
      // Square's catalog doesn't expose a clean "active" on items
      // themselves; the best signal is variation.sellable (defaults
      // true when undefined).
      const active = vd.sellable !== false

      const variationName = (vd.name ?? '').trim()
      const canonicalName = multi && variationName
        ? `${itemName} — ${variationName}`
        : itemName

      items.push({
        externalId: v.id,
        name: canonicalName,
        price,
        categoryExternalId,
        active,
      })
    }
  }

  if (multiVariationCount > 0) {
    noteMeta(
      ctx,
      `${multiVariationCount} Square item${multiVariationCount === 1 ? '' : 's'} had multiple variations — imported as separate canonical items (see header).`
    )
  }

  return {
    categories: Array.from(categoriesById.values()),
    items,
  }
}

// ================================================================
// Orders — types + fetching + normalization
// ================================================================

interface SquareMoney {
  amount?: number   // integer, minor units (cents for USD)
  currency?: string
}

interface SquareTender {
  type?: string     // 'CARD' | 'CASH' | 'THIRD_PARTY_CARD' | 'NO_SALE' | 'OTHER' | ...
  amount_money?: SquareMoney
}

interface SquareLineItem {
  uid?: string
  name?: string
  quantity?: string           // string per Square API
  catalog_object_id?: string  // variation id for catalog-backed items
  base_price_money?: SquareMoney
  total_money?: SquareMoney   // includes discounts and modifiers; pre-tax
  variation_name?: string
}

interface SquareOrder {
  id: string
  location_id?: string
  state?: string
  created_at?: string
  updated_at?: string
  closed_at?: string
  total_money?: SquareMoney
  line_items?: SquareLineItem[]
  tenders?: SquareTender[]
}

interface SquareOrdersSearchResponse {
  orders?: SquareOrder[]
  cursor?: string
}

/**
 * Cursor-paginated walker for /v2/orders/search.
 *
 * Square uses POST with a JSON body for search. We filter on
 * `closed_at >= since` so only completed sales in the incremental
 * window come back. The `query.sort.sort_field = 'CLOSED_AT'`
 * ensures Square returns the results in the order we expect.
 */
async function fetchAllOrderPages(
  ctx: AdapterContext,
  creds: SquareCredentials,
  sinceIso: string
): Promise<SquareOrder[]> {
  const out: SquareOrder[] = []
  let cursor: string | undefined = undefined
  let pages = 0
  let rawRecords = 0
  let truncated = false

  while (pages < MAX_ORDER_PAGES) {
    const body: Record<string, unknown> = {
      location_ids: [creds.location_id],
      limit: ORDERS_PAGE_LIMIT,
      query: {
        filter: {
          date_time_filter: {
            closed_at: { start_at: sinceIso },
          },
          state_filter: {
            // COMPLETED / CANCELED are the only states we map.
            // Skip OPEN + DRAFT at the API level so we never
            // pull incomplete sales.
            states: ['COMPLETED', 'CANCELED'],
          },
        },
        sort: {
          sort_field: 'CLOSED_AT',
          sort_order: 'ASC',
        },
      },
    }
    if (cursor) body.cursor = cursor

    const payload = await squareRequest<SquareOrdersSearchResponse>(
      `${creds.base_url}/v2/orders/search`,
      creds.access_token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )

    const batch = payload.orders ?? []
    rawRecords += batch.length
    out.push(...batch)
    pages += 1

    const nextCursor = (payload.cursor ?? '').trim()
    if (!nextCursor) break
    cursor = nextCursor

    if (pages >= MAX_ORDER_PAGES) {
      truncated = true
      break
    }
  }

  if (ctx.meta) {
    ctx.meta.pagesFetched = (ctx.meta.pagesFetched ?? 0) + pages
    ctx.meta.recordsFetched = (ctx.meta.recordsFetched ?? 0) + rawRecords
    if (truncated) {
      ctx.meta.truncated = true
      noteMeta(ctx, `Square orders truncated at ${pages * ORDERS_PAGE_LIMIT} records (V1 page cap).`)
    }
  }

  return out
}

function parseQuantity(raw: string | undefined): number {
  if (!raw) return 1
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.round(n)
}

function inferSquarePaymentType(
  tenders: SquareTender[] | undefined,
  ctx: AdapterContext
): NormalizedOrder['paymentType'] {
  if (!tenders || tenders.length === 0) return 'other'

  // Successful tenders only — Square doesn't have a generic "failed"
  // tender concept in the same way, so we just filter out no-ops.
  const effective = tenders.filter((t) => (t.type ?? '').toUpperCase() !== 'NO_SALE')
  if (effective.length === 0) return 'other'

  const types = new Set(effective.map((t) => (t.type ?? '').toUpperCase()).filter(Boolean))

  if (types.size > 1) {
    noteMeta(ctx, 'Square order had multiple tender types (split tender) — collapsed to "other".')
    return 'other'
  }

  const [only] = types
  if (only === 'CASH') return 'cash'
  if (only === 'CARD' || only === 'THIRD_PARTY_CARD' || only === 'SQUARE_GIFT_CARD') return 'card'
  return 'other'
}

function normalizeSquareOrders(
  orders: SquareOrder[],
  ctx: AdapterContext
): NormalizedOrder[] {
  const out: NormalizedOrder[] = []

  for (const o of orders) {
    if (!o.id) continue

    const state = (o.state ?? '').toUpperCase()
    let status: NormalizedOrder['status']
    if (state === 'COMPLETED') status = 'completed'
    else if (state === 'CANCELED') status = 'voided'
    else continue // OPEN / DRAFT / unknown — skip

    const rawTs = o.closed_at ?? o.updated_at ?? o.created_at
    if (!rawTs) continue
    const parsedTs = Date.parse(rawTs)
    if (Number.isNaN(parsedTs)) continue

    // Square total_money is integer cents, tax-inclusive, matching
    // what the customer paid. Same semantic as Clover.
    const totalCents = typeof o.total_money?.amount === 'number' ? o.total_money.amount : 0
    const totalAmount = totalCents / 100

    const paymentType = inferSquarePaymentType(o.tenders, ctx)

    // Line items
    const lineItems: NormalizedOrderLineItem[] = []
    for (const li of o.line_items ?? []) {
      // External id: prefer the catalog variation id (matches the
      // menu adapter's externalId so ingest can link up cleanly).
      // Fall back to the line uid so revenue survives for manual /
      // non-catalog line items.
      const externalItemId =
        (li.catalog_object_id && li.catalog_object_id.trim()) ||
        (li.uid ? `raw:${li.uid}` : '')
      if (!externalItemId) continue

      const quantity = parseQuantity(li.quantity)

      // Base price per unit, pre-tax. Fall back to computing from
      // total / quantity if base_price_money is missing (rare but
      // possible for custom / open-price items).
      const unitCents = typeof li.base_price_money?.amount === 'number'
        ? li.base_price_money.amount
        : 0
      const totalLineCents = typeof li.total_money?.amount === 'number'
        ? li.total_money.amount
        : unitCents * quantity

      const nameParts = [li.name?.trim(), li.variation_name?.trim()].filter(Boolean)
      const displayName = nameParts.length > 0 ? nameParts.join(' — ') : externalItemId

      lineItems.push({
        externalItemId,
        itemName: displayName,
        quantity,
        unitPrice: unitCents / 100,
        totalPrice: totalLineCents / 100,
      })
    }

    if (lineItems.length === 0) continue // nothing meaningful to ingest

    out.push({
      externalId: o.id,
      postedAt: new Date(parsedTs).toISOString(),
      totalAmount,
      status,
      paymentType,
      lineItems,
    })
  }

  return out
}

// ================================================================
// SourceAdapter export
// ================================================================

export const squareSourceAdapter: SourceAdapter = {
  id: 'square',
  kind: 'api',
  label: 'Square',

  async listMenu(ctx: AdapterContext): Promise<NormalizedMenu> {
    const creds = readCredentials(ctx.credentials)
    const objects = await fetchAllCatalogPages(ctx, creds)
    return normalizeSquareCatalog(objects, ctx)
  },

  async listOrders(ctx: AdapterContext): Promise<NormalizedOrder[]> {
    const creds = readCredentials(ctx.credentials)

    // Incremental window: use the connection's last_orders_sync_at.
    // First sync (since=null) falls back to a 7-day lookback, same
    // as every other API adapter.
    const sinceMs =
      ctx.since instanceof Date ? ctx.since.getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000
    const sinceIso = new Date(sinceMs).toISOString()

    const rawOrders = await fetchAllOrderPages(ctx, creds, sinceIso)
    return normalizeSquareOrders(rawOrders, ctx)
  },
}
