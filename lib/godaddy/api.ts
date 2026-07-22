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
  // In Poynt's WEB storefront payloads, `id` is a NUMERIC line-
  // item index within the order (1, 2, 3…), not a stable
  // product identifier. Type it as number|string here so the
  // normalizer's String() coercion + trim doesn't blow up when
  // it's a number.
  id?: string | number
  productId?: string
  // The stable product identifier we actually want as the
  // externalItemId. Poynt WEB orders always carry sku; POS
  // orders may too, and we fall back to externalId if not.
  sku?: string
  externalId?: string
  name?: string
  quantity?: number
  unitPrice?: number
  unitPriceCurrency?: string
  status?: string
  // Variant / modifier detail. Poynt's transaction detail page
  // shows things like "1oz-Loose", "45g - Organic" beneath the
  // item name — those live on the ordered variant. We fold them
  // into the display name at normalize time so the receipt in
  // Checked matches what the merchant sees on Poynt.
  selectedVariants?: Array<{
    name?: string
    value?: string
    variantId?: string
  }>
}

export interface PoyntCustomer {
  firstName?: string
  lastName?: string
  emails?: Array<string | { address?: string }>
  phones?: Array<string | { number?: string }>
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
  customer?: PoyntCustomer
  // Poynt embeds the payment leg(s) directly on the order object
  // when the sale was tendered on their terminal or via storefront
  // checkout. This lets ingest lift card brand + last 4 without
  // a second /transactions fetch. When absent (rare — sale not
  // yet captured, or an unlinked draft), the fields stay null.
  transactions?: PoyntTransaction[]
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
  //
  // Poynt returns orders in ASCENDING (oldest-first) order and
  // paginates via HATEOAS `next` links. If we cap at N and the
  // merchant has more than N orders in the window, we get the
  // OLDEST N and miss the most recent ones — which is the
  // opposite of what a manager wants when they hit "Sync now."
  // Two mitigations:
  //   1. Raise the default cap from 200 → 1000 so a busy 30-day
  //      history fits in a single sync.
  //   2. Also raise the hard page ceiling from 20 → 120 so the
  //      cap can actually be reached at 10 orders/page.
  // Future work: pull most-recent-first by iterating the window
  // in reverse chunks (endAt=now → walk backward). Not needed
  // for Pilot V1 volumes.
  const startingQuery = new URLSearchParams()
  const startAtIso =
    args.startAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  startingQuery.set('startAt', startAtIso)
  const startingUrl =
    `${baseUrl()}/businesses/${encodeURIComponent(tok.businessId)}/orders?${startingQuery.toString()}`

  const cap = args.maxOrders ?? 1000
  const orders: PoyntOrder[] = []

  let nextUrl: string | null = startingUrl
  let safety = 120 // hard page cap — 120 pages × ~10 orders covers ~1200 orders

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

// ================================================================
// Products — Poynt merchant catalog
// ================================================================
//
// The merchant's actual product list lives at
// GET /businesses/{id}/products. Same HATEOAS pagination as
// /orders — response has a `links[].rel='next'` for the next
// page. This is the source of truth for what a merchant sells;
// once ingested into menu_items, the order/transaction ingest
// finds line items already have a canonical menu row instead
// of spawning noisy placeholders per SKU per sale.
//
// The Product model in Poynt's docs is not fully rendered on
// the public API reference page, so we type only the small
// slice we read. Everything else on the response passes
// through untouched. Fields we care about:
//   • id       — Poynt's stable product identifier
//   • sku      — the SKU line items reference. Same value we
//                use as external_id on menu_items so orders join.
//   • shortName / name — display name
//   • price    — integer cents (per Poynt's ORDER amount convention
//                which we've already validated on the orders side)
//   • status   — 'ACTIVE' / 'INACTIVE' / similar; maps to
//                menu_items.active

export interface PoyntProduct {
  id?: string
  sku?: string
  name?: string
  shortName?: string
  description?: string
  status?: string
  // Price can arrive under a few different keys depending on
  // whether variants exist. Read all defensively; normalizer
  // picks the first present one.
  price?: number
  unitPrice?: number
  amount?: number
  pricing?: {
    price?: number
    listPrice?: number
    amount?: number
  }
  // Some products have variants each with their own SKU / price.
  // We ingest the parent record only (uses its own sku); variant
  // handling is a phase 2 concern.
  variants?: Array<{
    sku?: string
    price?: number
  }>
}

export interface PoyntProductList {
  products?: PoyntProduct[]
  links?: PoyntLink[]
  count?: number
}

interface FetchProductsArgs {
  restaurantId: string
  maxProducts?: number
}

/** Pull the merchant's full product catalog. Same HATEOAS shape
 *  as fetchPoyntOrders; caller supplies restaurantId, we resolve
 *  a valid token internally. Default cap of 5000 comfortably
 *  covers any Pilot V1 merchant (Hatziri has ~400). */
export async function fetchPoyntProducts(args: FetchProductsArgs): Promise<
  | { businessId: string; products: PoyntProduct[] }
  | { error: string }
> {
  const tok = await getValidAccessToken(args.restaurantId)
  if ('error' in tok) return { error: tok.error }

  // limit=100 (Poynt's max per doc) so a 400-product merchant
  // finishes in ~4 pages of ~150ms each = well under Vercel's
  // function timeout.
  const startingUrl =
    `${baseUrl()}/businesses/${encodeURIComponent(tok.businessId)}/products?limit=100`

  const cap = args.maxProducts ?? 5000
  const products: PoyntProduct[] = []
  let nextUrl: string | null = startingUrl
  let safety = 100

  while (nextUrl && products.length < cap && safety > 0) {
    safety--
    console.info('[godaddy/api] GET products', { url: nextUrl, businessId: tok.businessId })
    const page: { data: PoyntProductList } | { error: string } =
      await getJson<PoyntProductList>(nextUrl, tok.accessToken)
    if ('error' in page) return { error: page.error }
    const pageProducts = page.data.products ?? []
    console.info('[godaddy/api] products page', {
      count: page.data.count,
      onPage: pageProducts.length,
      hasLinks: (page.data.links ?? []).length > 0,
    })
    for (const p of pageProducts) {
      products.push(p)
      if (products.length >= cap) break
    }
    const next: PoyntLink | undefined = (page.data.links ?? []).find(
      (l: PoyntLink) => (l.rel ?? '').toLowerCase() === 'next' && !!l.href,
    )
    const rawHref: string | null = next?.href ?? null
    if (rawHref) {
      try { nextUrl = new URL(rawHref, baseUrl()).toString() } catch { nextUrl = null }
    } else {
      nextUrl = null
    }
  }

  return { businessId: tok.businessId, products }
}

// ================================================================
// Transactions — Poynt terminal / Virtual Terminal sales
// ================================================================
//
// Merchants who take card payments on a Poynt terminal don't
// necessarily create Order objects for those sales — the payment
// leg lives in /transactions instead. Hatziri's real business
// uses the terminal heavily; without this endpoint we'd miss all
// his in-person sales.
//
// A Transaction carries: amount (integer cents), status
// (AUTHORIZED / CAPTURED / VOIDED / REFUNDED), tender info, and
// context.source (INSTORE / MOTO / etc.). It usually doesn't
// carry line-item detail — for that we'd need to also fetch the
// linked Order if one exists. For Pilot V1 we synthesize a
// single "In-person sale" line item so the sale isn't lost.

export interface PoyntTransaction {
  id?: string
  amounts?: {
    orderAmount?: number
    tipAmount?: number
    transactionAmount?: number
    currency?: string
  }
  status?: string     // e.g. 'CAPTURED', 'AUTHORIZED', 'VOIDED', 'REFUNDED'
  action?: string     // e.g. 'SALE', 'REFUND', 'AUTHORIZE'
  fundingSource?: {
    type?: string     // 'CREDIT_DEBIT', 'CASH', 'CHECK', etc.
    card?: {
      type?: string          // 'VISA' / 'MASTERCARD' / 'AMEX' / 'DISCOVER'
      numberLast4?: string   // Poynt returns as string; we store as text.
      numberFirst6?: string
      cardHolderFirstName?: string
      cardHolderLastName?: string
    }
    entryDetails?: {
      // 'SWIPE' / 'EMV' / 'CONTACTLESS' / 'MANUAL' — useful later
      // for reporting but not persisted yet.
      entryMode?: string
    }
  }
  context?: PoyntOrderContext
  createdAt?: string
  updatedAt?: string
  parentId?: string   // set on refunds — points to original SALE
  orderId?: string    // some transactions link back to an Order
  references?: Array<{ type?: string; id?: string; customType?: string }>
}

export interface PoyntTransactionList {
  transactions?: PoyntTransaction[]
  links?: PoyntLink[]
  count?: number
}

interface FetchTransactionsArgs {
  restaurantId: string
  startAt?: string
  maxTransactions?: number
}

/** Pull terminal / MOTO transactions for the connected merchant.
 *  Mirrors fetchPoyntOrders but against /transactions. Same
 *  HATEOAS pagination + windowing model; caller supplies the
 *  same restaurantId. */
export async function fetchPoyntTransactions(args: FetchTransactionsArgs): Promise<
  | { businessId: string; transactions: PoyntTransaction[] }
  | { error: string }
> {
  const tok = await getValidAccessToken(args.restaurantId)
  if ('error' in tok) return { error: tok.error }

  const startingQuery = new URLSearchParams()
  const startAtIso =
    args.startAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  startingQuery.set('startAt', startAtIso)
  const startingUrl =
    `${baseUrl()}/businesses/${encodeURIComponent(tok.businessId)}/transactions?${startingQuery.toString()}`

  const cap = args.maxTransactions ?? 1000
  const transactions: PoyntTransaction[] = []
  let nextUrl: string | null = startingUrl
  let safety = 120

  while (nextUrl && transactions.length < cap && safety > 0) {
    safety--
    console.info('[godaddy/api] GET transactions', { url: nextUrl, businessId: tok.businessId })
    const page: { data: PoyntTransactionList } | { error: string } =
      await getJson<PoyntTransactionList>(nextUrl, tok.accessToken)
    if ('error' in page) return { error: page.error }
    const pageTxs = page.data.transactions ?? []
    console.info('[godaddy/api] transactions page returned', {
      count: page.data.count,
      onPage: pageTxs.length,
      hasLinks: (page.data.links ?? []).length > 0,
    })
    for (const t of pageTxs) {
      transactions.push(t)
      if (transactions.length >= cap) break
    }
    const next: PoyntLink | undefined = (page.data.links ?? []).find(
      (l: PoyntLink) => (l.rel ?? '').toLowerCase() === 'next' && !!l.href,
    )
    const rawHref: string | null = next?.href ?? null
    if (rawHref) {
      try { nextUrl = new URL(rawHref, baseUrl()).toString() } catch { nextUrl = null }
    } else {
      nextUrl = null
    }
  }

  return { businessId: tok.businessId, transactions }
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
