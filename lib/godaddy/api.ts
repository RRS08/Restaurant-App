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

  const startingQuery = new URLSearchParams()
  if (args.startAt) startingQuery.set('startAt', args.startAt)
  const startingUrl =
    `${baseUrl()}/businesses/${encodeURIComponent(tok.businessId)}/orders` +
    (startingQuery.toString() ? `?${startingQuery.toString()}` : '')

  const cap = args.maxOrders ?? 500
  const orders: PoyntOrder[] = []

  let nextUrl: string | null = startingUrl
  let safety = 20 // hard page cap — 20 pages × default page size covers a busy month

  while (nextUrl && orders.length < cap && safety > 0) {
    safety--
    const page: { data: PoyntOrderList } | { error: string } =
      await getJson<PoyntOrderList>(nextUrl, tok.accessToken)
    if ('error' in page) return { error: page.error }
    const pageOrders = page.data.orders ?? []
    for (const o of pageOrders) {
      orders.push(o)
      if (orders.length >= cap) break
    }
    // Look for a `next` link. Poynt's rel values are lowercase in
    // the docs example; be defensive and match case-insensitively.
    const next: PoyntLink | undefined = (page.data.links ?? []).find(
      (l: PoyntLink) => (l.rel ?? '').toLowerCase() === 'next' && !!l.href,
    )
    nextUrl = next?.href ?? null
  }

  return { businessId: tok.businessId, orders }
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
    const data = (await res.json().catch(() => null)) as T | null
    if (data === null) return { error: 'Poynt API returned invalid JSON.' }
    return { data }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `Poynt API request failed: ${msg}` }
  }
}
