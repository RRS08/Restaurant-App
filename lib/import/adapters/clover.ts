// ----------------------------------------------------------------
// Clover Source Adapter — Pilot V1 (real API)
//
// First real branded adapter on top of the source-agnostic intake
// core. Hits Clover's v3 REST API using an app / merchant token
// stored in `provider_credentials`, normalizes the response into
// the canonical shapes, and hands the result to the shared ingest
// pipeline — same as every other adapter.
//
// Docs: https://docs.clover.com/reference/merchant-overview
//
// Endpoints used:
//   GET /v3/merchants/{mId}/categories
//   GET /v3/merchants/{mId}/items?expand=categories
//   GET /v3/merchants/{mId}/orders?filter=modifiedTime>=<ms>
//        &expand=lineItems,payments&limit=100
//
// Pilot V1 intentionally limits scope:
//   • No modifiers / option groups
//   • No refunds / voids sync
//   • No tips / split tenders
//   • No customer data
//   • No OAuth flow — uses a long-lived API token the dev pastes
//
// Pagination (this pass):
//   • Orders: offset-paginated with PAGE_SIZE=100, capped at
//             MAX_ORDER_PAGES=20 pages per sync (2,000 orders max).
//   • Items : offset-paginated with PAGE_SIZE=100, capped at
//             MAX_ITEM_PAGES=10 pages (1,000 items max).
//   • Categories: single page (menu categories are small and
//                 realistic pilot catalogs never exceed 100).
//   • When any page cap is hit, the adapter sets `ctx.meta.truncated`
//     so the calling action can surface the warning — sync becomes
//     transparent about partial imports instead of silently stopping.
//
// Everything else (dedupe, placeholder creation, inventory gate,
// multi-location, readiness) comes for free from the shared pipeline.
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

interface CloverCredentials {
  api_token: string
  merchant_id: string
  /** Optional Clover base URL. Defaults to the sandbox so
   *  development testing doesn't accidentally hit production. */
  base_url?: string
}

const DEFAULT_BASE_URL = 'https://apisandbox.dev.clover.com'
const REQUEST_TIMEOUT_MS = 15_000

// Clover's default page size for list endpoints is 100 and max is
// 1,000. We stay at 100 to keep each HTTP call fast and predictable;
// pagination walks more pages as needed.
const PAGE_SIZE = 100

// Safety caps on the number of pages the adapter will walk in a
// single sync call. When we hit a cap, `ctx.meta.truncated` is set
// so the calling action can warn the operator. These numbers are
// Pilot V1 defaults — generous for a typical pilot merchant, small
// enough that a pathological merchant can't DoS a sync request.
const MAX_ORDER_PAGES = 20   // 20 × 100 = 2,000 orders per sync
const MAX_ITEM_PAGES  = 10   // 10 × 100 = 1,000 items per sync

function readCredentials(raw: Record<string, unknown> | null): CloverCredentials {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Clover credentials missing. Expected an object with api_token + merchant_id.')
  }
  const apiToken = typeof raw.api_token === 'string' ? raw.api_token.trim() : ''
  const merchantId = typeof raw.merchant_id === 'string' ? raw.merchant_id.trim() : ''
  const baseUrlRaw = typeof raw.base_url === 'string' ? raw.base_url.trim() : ''

  if (!apiToken) throw new Error('Clover credentials missing "api_token".')
  if (!merchantId) throw new Error('Clover credentials missing "merchant_id".')

  const baseUrl = (baseUrlRaw || DEFAULT_BASE_URL).replace(/\/+$/, '')

  return { api_token: apiToken, merchant_id: merchantId, base_url: baseUrl }
}

// ================================================================
// HTTP helper
// ================================================================

async function cloverFetch<T>(url: string, apiToken: string): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const snippet = body.slice(0, 200).replace(/\s+/g, ' ').trim()
      throw new Error(
        `Clover API ${res.status} ${res.statusText}` +
        (snippet ? ` — ${snippet}` : '')
      )
    }

    return (await res.json()) as T
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(`Clover request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// ================================================================
// Menu mapping
// ================================================================

interface CloverCategoriesResponse {
  elements?: Array<{
    id: string
    name?: string
    sortOrder?: number
  }>
}

interface CloverItemsResponse {
  elements?: Array<{
    id: string
    name?: string
    /** Clover prices are integer cents. */
    price?: number
    hidden?: boolean
    available?: boolean
    categories?: { elements?: Array<{ id: string }> }
  }>
}

function parseCloverMenu(
  categories: CloverCategoriesResponse,
  items: CloverItemsResponse
): NormalizedMenu {
  const normalizedCategories: NormalizedCategory[] = (categories.elements ?? [])
    .filter((c) => c && c.id && c.name)
    .map((c) => ({
      externalId: c.id,
      name: c.name as string,
      ...(typeof c.sortOrder === 'number' ? { sortOrder: c.sortOrder } : {}),
    }))

  const normalizedItems: NormalizedMenuItem[] = (items.elements ?? [])
    .filter((i) => i && i.id && i.name)
    .map((i) => {
      const cents = typeof i.price === 'number' ? i.price : 0
      const price = cents / 100

      // First declared category id, if any
      const catId = i.categories?.elements?.[0]?.id ?? null

      // Clover "hidden" hides from the register; "available" is also
      // consulted when present. Default to active unless one of these
      // explicitly says otherwise.
      let active = true
      if (typeof i.hidden === 'boolean') active = !i.hidden
      if (typeof i.available === 'boolean') active = active && i.available

      return {
        externalId: i.id,
        name: i.name as string,
        price,
        categoryExternalId: catId,
        active,
      }
    })

  return { categories: normalizedCategories, items: normalizedItems }
}

// ================================================================
// Orders mapping
// ================================================================

interface CloverLineItem {
  id: string
  name?: string
  /** Clover line item unit price in cents. */
  price?: number
  /** Set for weighted / bulk items (in thousandths). Unit items omit it. */
  unitQty?: number
  item?: { id?: string } | null
}

interface CloverPayment {
  tender?: { labelKey?: string; label?: string } | null
  result?: string
}

interface CloverOrder {
  id: string
  state?: string
  total?: number
  modifiedTime?: number
  createdTime?: number
  lineItems?: { elements?: CloverLineItem[] }
  payments?: { elements?: CloverPayment[] }
}

interface CloverOrdersResponse {
  elements?: CloverOrder[]
  href?: string
}

/**
 * Infer a canonical payment type from the order's first successful
 * payment tender. Clover's tender label keys look like:
 *   com.clover.tender.cash         → 'cash'
 *   com.clover.tender.credit_card  → 'card'
 *   com.clover.tender.external_payment → 'other'
 * Anything else or missing → 'other'.
 */
function inferPaymentType(payments: CloverPayment[] | undefined): NormalizedOrder['paymentType'] {
  if (!payments || payments.length === 0) return 'other'
  const successful = payments.find((p) => !p.result || p.result === 'SUCCESS') ?? payments[0]
  const labelKey = (successful.tender?.labelKey ?? '').toLowerCase()
  const label = (successful.tender?.label ?? '').toLowerCase()

  if (labelKey.includes('cash') || label === 'cash') return 'cash'
  if (labelKey.includes('credit') || labelKey.includes('debit') || labelKey.includes('card') || label.includes('card')) {
    return 'card'
  }
  return 'other'
}

/**
 * Group Clover line items by item id → canonical line items with
 * correct quantity counts.
 *
 * Clover's historical data model: for a customer ordering 3 burgers,
 * the POS creates 3 separate line items each referencing the same
 * item. We collapse those into one canonical line with quantity=3.
 * Weighted items (unitQty set) are treated as quantity=1 — Pilot V1
 * doesn't track fractional units. Revenue is preserved either way
 * because `totalPrice` is summed from the raw cents.
 */
function foldLineItems(lineItems: CloverLineItem[] | undefined): NormalizedOrderLineItem[] {
  if (!lineItems || lineItems.length === 0) return []

  type Group = {
    externalItemId: string
    itemName: string
    count: number
    unitPriceCents: number // first seen
    totalCents: number
  }

  const groups = new Map<string, Group>()

  for (const li of lineItems) {
    if (!li) continue
    const itemId = li.item?.id ?? `raw:${li.id}` // fall back to line id so revenue is kept
    const name = (li.name ?? '').trim() || itemId
    const priceCents = typeof li.price === 'number' ? li.price : 0

    const existing = groups.get(itemId)
    if (existing) {
      existing.count += 1
      existing.totalCents += priceCents
    } else {
      groups.set(itemId, {
        externalItemId: itemId,
        itemName: name,
        count: 1,
        unitPriceCents: priceCents,
        totalCents: priceCents,
      })
    }
  }

  return Array.from(groups.values()).map((g) => ({
    externalItemId: g.externalItemId,
    itemName: g.itemName,
    quantity: Math.max(1, g.count),
    unitPrice: g.unitPriceCents / 100,
    totalPrice: g.totalCents / 100,
  }))
}

function parseCloverOrders(payload: CloverOrdersResponse): NormalizedOrder[] {
  const orders = payload.elements ?? []
  const normalized: NormalizedOrder[] = []

  for (const o of orders) {
    if (!o || !o.id) continue

    // Use modifiedTime as the canonical timestamp (matches the sync
    // filter). Fall back to createdTime if modifiedTime is missing.
    const ms = o.modifiedTime ?? o.createdTime
    if (typeof ms !== 'number') continue
    const postedAt = new Date(ms).toISOString()

    const totalCents = typeof o.total === 'number' ? o.total : 0
    const totalAmount = totalCents / 100

    const lineItems = foldLineItems(o.lineItems?.elements)
    if (lineItems.length === 0) continue // skip orders with no items — nothing meaningful to import

    // Pilot V1 treats every synced order as completed. Clover has
    // richer lifecycle (open/locked/paid) but the shared pipeline
    // only needs a binary completed/voided signal. Refunds/voids
    // are intentionally out of scope for this phase.
    const status: NormalizedOrder['status'] = 'completed'

    const paymentType = inferPaymentType(o.payments?.elements)

    normalized.push({
      externalId: o.id,
      postedAt,
      totalAmount,
      status,
      paymentType,
      lineItems,
    })
  }

  return normalized
}

// ================================================================
// Pagination helpers
// ================================================================

/**
 * Records a note into the optional meta bucket so the calling
 * action can show it in the sync result message. No-op when the
 * caller didn't pass a meta bucket.
 */
function noteMeta(ctx: AdapterContext, note: string) {
  if (!ctx.meta) return
  if (!Array.isArray(ctx.meta.notes)) ctx.meta.notes = []
  ctx.meta.notes.push(note)
}

/**
 * Offset-paginate a Clover list endpoint until a short page comes
 * back (signals end-of-data) or the page cap is reached. Each page
 * is converted through `normalize` and the results are appended to
 * a running array. Populates `ctx.meta` with page/record counts and
 * sets `truncated=true` when the cap fires.
 *
 * Why a short-page check instead of reading `href`/`next`: Clover's
 * list responses don't include a reliable "hasMore" flag, so the
 * canonical trick is "if the page came back smaller than the
 * requested limit, we're done." It works for every v3 list endpoint.
 */
async function fetchPaginated<TPayload extends { elements?: Array<unknown> }, TOut>(
  ctx: AdapterContext,
  urlFor: (offset: number) => string,
  apiToken: string,
  maxPages: number,
  normalize: (payload: TPayload) => TOut[],
  kind: string
): Promise<TOut[]> {
  const out: TOut[] = []
  let offset = 0
  let pages = 0
  let rawRecords = 0
  let truncated = false

  while (pages < maxPages) {
    const payload = await cloverFetch<TPayload>(urlFor(offset), apiToken)
    const batch = normalize(payload)
    const returned = payload.elements?.length ?? 0

    out.push(...batch)
    rawRecords += returned
    pages += 1

    // End of data: fewer than a full page means we've reached the tail.
    if (returned < PAGE_SIZE) break

    offset += PAGE_SIZE

    // Cap reached with a full last page — more data almost certainly
    // remains on the provider side. Flag for the caller.
    if (pages >= maxPages) {
      truncated = true
      break
    }
  }

  if (ctx.meta) {
    ctx.meta.pagesFetched = (ctx.meta.pagesFetched ?? 0) + pages
    ctx.meta.recordsFetched = (ctx.meta.recordsFetched ?? 0) + rawRecords
    if (truncated) {
      ctx.meta.truncated = true
      noteMeta(ctx, `${kind} truncated at ${pages * PAGE_SIZE} records (Pilot V1 page cap).`)
    }
  }

  return out
}

// ================================================================
// SourceAdapter export
// ================================================================

export const cloverSourceAdapter: SourceAdapter = {
  id: 'clover',
  kind: 'api',
  label: 'Clover',

  async listMenu(ctx: AdapterContext): Promise<NormalizedMenu> {
    const { api_token, merchant_id, base_url } = readCredentials(ctx.credentials)

    // Categories first (small dataset — pilot catalogs don't exceed
    // 100 categories in practice). We intentionally don't paginate
    // this endpoint; if that assumption ever breaks, the same
    // `fetchPaginated` helper can wrap it in one line.
    const categoriesPayload = await cloverFetch<CloverCategoriesResponse>(
      `${base_url}/v3/merchants/${merchant_id}/categories`,
      api_token
    )
    if (ctx.meta) {
      ctx.meta.pagesFetched = (ctx.meta.pagesFetched ?? 0) + 1
      ctx.meta.recordsFetched = (ctx.meta.recordsFetched ?? 0) + (categoriesPayload.elements?.length ?? 0)
    }

    // Items are paginated — realistic pilot merchants can easily
    // exceed 100 SKUs once combos / sides / drinks are all in one
    // catalog. Walking multiple pages keeps the menu import truthful.
    const itemsElements: NonNullable<CloverItemsResponse['elements']> = await fetchPaginated<
      CloverItemsResponse,
      NonNullable<CloverItemsResponse['elements']>[number]
    >(
      ctx,
      (offset) =>
        `${base_url}/v3/merchants/${merchant_id}/items` +
        `?expand=categories&limit=${PAGE_SIZE}&offset=${offset}`,
      api_token,
      MAX_ITEM_PAGES,
      (payload) => payload.elements ?? [],
      'menu items'
    )

    return parseCloverMenu(categoriesPayload, { elements: itemsElements })
  },

  async listOrders(ctx: AdapterContext): Promise<NormalizedOrder[]> {
    const { api_token, merchant_id, base_url } = readCredentials(ctx.credentials)

    // Incremental window: use the connection's last_orders_sync_at.
    // First sync (since=null) falls back to a 7-day lookback.
    const sinceMs =
      ctx.since instanceof Date ? ctx.since.getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000

    // Pagination walks all pages up to MAX_ORDER_PAGES. Each page is
    // normalized independently through parseCloverOrders and flattened
    // into a single array — the shared ingest pipeline doesn't care
    // how many pages we pulled, only the final normalized list.
    return fetchPaginated<CloverOrdersResponse, NormalizedOrder>(
      ctx,
      (offset) =>
        `${base_url}/v3/merchants/${merchant_id}/orders` +
        `?filter=modifiedTime>=${sinceMs}` +
        `&expand=lineItems,payments` +
        `&limit=${PAGE_SIZE}` +
        `&offset=${offset}`,
      api_token,
      MAX_ORDER_PAGES,
      (payload) => parseCloverOrders(payload),
      'orders'
    )
  },
}
