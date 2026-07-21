// ----------------------------------------------------------------
// GoDaddy Poynt Cloud API — thin authenticated client
//
// Wraps GET /businesses/{businessId}/orders and, later, other
// endpoints we care about. Every call resolves a valid access
// token through `getValidAccessToken` first, so preemptive
// refresh Just Happens.
//
// The Poynt Order shape is well-documented (§6 of the integration
// spec). We type only the fields we actually read; anything else
// on the response object flows through untyped and is dropped at
// the normalization step in the adapter.
//
// Pagination is HATEOAS: `links[].rel === 'next'` carries the
// URL of the next page. We follow it until it stops appearing.
// ----------------------------------------------------------------

import { getValidAccessToken } from './tokens'

const API_VERSION = '1.2'

function baseUrl(): string {
  return process.env.GODADDY_POYNT_BASE_URL || 'https://services.poynt.net'
}

// Minimal types — just what we read. Extra fields pass through
// unchanged; the adapter's normalization step is the type gate.
export interface PoyntOrderAmounts {
  subTotal?: number
  taxTotal?: number
  discountTotal?: number
  feeTotal?: number
  shippingTotal?: number
  netTotal?: number
  currency?: string
}

export interface PoyntOrderItem {
  id?: string
  productId?: string
  name?: string
  quantity?: number
  unitPrice?: number
  unitPriceCurrency?: string
  status?: string
}

export interface PoyntOrderContext {
  source?: string  // channel — INSTORE / WEB / MOBILE / CALLIN
  storeId?: string
  storeDeviceId?: string
  employeeUserId?: number
}

export interface PoyntOrder {
  id?: string
  orderNumber?: string
  amounts?: PoyntOrderAmounts
  items?: PoyntOrderItem[]
  context?: PoyntOrderContext
  createdAt?: string
  updatedAt?: string
  statuses?: {
    status?: string
    transactionStatusSummary?: string
    fulfillmentStatus?: string
  }
  externalId?: string
}

export interface PoyntLink {
  href?: string
  rel?: string
  method?: string
}

export interface PoyntOrderList {
  orders?: PoyntOrder[]
  links?: PoyntLink[]
  count?: number
}

interface FetchOrdersArgs {
  restaurantId: string
  /** ISO timestamp — lower bound (inclusive) on updatedAt/createdAt. */
  startAt?: string
  /** Cap the number of orders pulled across all pages. Safety net
   *  so a first-run sync on a busy merchant can't spin forever. */
  maxOrders?: number
}

/** Pull orders for the connected merchant with automatic
 *  pagination + a per-run cap. Returns the merged list plus the
 *  business id so callers don't have to re-look-up. */
export async function fetchPoyntOrders(args: FetchOrdersArgs): Promise<
  | { businessId: string; orders: PoyntOrder[] }
  | { error: string }
> {
  const tok = await getValidAccessToken(args.restaurantId)
  if ('error' in tok) return { error: tok.error }

  // Default to the last 30 days if the caller didn't supply a
  // window. Poynt's docs don't spell out what /orders returns
  // when neither startAt nor endAt is passed, and empirically an
  // unfiltered call returned 0 orders even against a business
  // with active sales — so we bind a window explicitly.
  const startingQuery = new URLSearchParams()
  const startAtIso =
    args.startAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  startingQuery.set('startAt', startAtIso)
  const startingUrl =
    `${baseUrl()}/businesses/${encodeURIComponent(tok.businessId)}/orders?${startingQuery.toString()}`

  const cap = args.maxOrders ?? 500
  const orders: PoyntOrder[] = []

  let nextUrl: string | null = startingUrl
  let safety = 20 // hard page cap — 20 pages × default page size covers a busy month

  while (nextUrl && orders.length < cap && safety > 0) {
    safety--
    console.info('[godaddy/api] GET orders', { url: nextUrl, businessId: tok.businessId })
    const page: { data: PoyntOrderList } | { error: string } =
      await getJson<PoyntOrderList>(nextUrl, tok.accessToken)
    if ('error' in page) return { error: page.error }
    const pageOrders = page.data.orders ?? []
    console.info('[godaddy/api] page returned', {
      count: page.data.count,
      ordersOnPage: pageOrders.length,
      hasLinks: (page.data.links ?? []).length > 0,
    })
    for (const o of pageOrders) {
      orders.push(o)
      if (orders.length >= cap) break
    }
    // Look for a `next` link. Poynt's rel values are lowercase in
    // the docs example; be defensive and match case-insensitively.
    const next: PoyntLink | undefined = (page.data.links ?? []).find(
      (l: PoyntLink) => (l.rel ?? '').toLowerCase() === 'next' && !!l.href,
    )
    // Poynt returns pagination links as RELATIVE paths (e.g.
    // `/businesses/{id}/orders?startAt=...&endAt=...&startOffset=...`).
    // fetch() requires an absolute URL, so resolve any relative
    // href against our base. Absolute hrefs (rare but possible if
    // Poynt ever changes shape) pass through untouched.
    const rawHref: string | null = next?.href ?? null
    if (rawHref) {
      try {
        nextUrl = new URL(rawHref, baseUrl()).toString()
      } catch {
        nextUrl = null
      }
    } else {
      nextUrl = null
    }
  }

  return { businessId: tok.businessId, orders }
}

/** Fetch a single Poynt order by id. Powers the webhook handler,
 *  which receives a lightweight event payload (§8 of the spec:
 *  event type + resource id + links) and then does a full GET
 *  for the whole order object. */
export async function fetchSinglePoyntOrder(args: {
  restaurantId: string
  orderId: string
}): Promise<
  | { businessId: string; order: PoyntOrder }
  | { error: string }
> {
  const tok = await getValidAccessToken(args.restaurantId)
  if ('error' in tok) return { error: tok.error }

  const url =
    `${baseUrl()}/businesses/${encodeURIComponent(tok.businessId)}/orders/` +
    encodeURIComponent(args.orderId)
  const res = await getJson<PoyntOrder>(url, tok.accessToken)
  if ('error' in res) return { error: res.error }
  return { businessId: tok.businessId, order: res.data }
}

async function getJson<T>(url: string, accessToken: string): Promise<
  | { data: T }
  | { error: string }
> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'api-version': API_VERSION,
        Authorization: `BEARER ${accessToken}`,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim()
      return {
        error: `Poynt API ${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ''}`,
      }
    }
    // Diagnostic: log the raw response body (truncated) on success
    // too so we can see exactly what Poynt sent back. Poynt's
    // `/orders` endpoint has been silently returning empty payloads
    // and there's no other way to see what shape it's actually
    // using without this. Truncated to a safe length — we only
    // care about the first orders + top-level fields.
    const rawText = await res.text().catch(() => '')
    console.info('[godaddy/api] response snippet', {
      url,
      status: res.status,
      length: rawText.length,
      body: rawText.slice(0, 800),
    })
    let data: T | null = null
    try {
      data = JSON.parse(rawText) as T
    } catch {
      return { error: 'Poynt API returned invalid JSON.' }
    }
    if (data === null) return { error: 'Poynt API returned invalid JSON.' }
    return { data }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `Poynt API request failed: ${msg}` }
  }
}
