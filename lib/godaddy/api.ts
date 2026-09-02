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
  // Settlement state. NOT in Poynt's published API reference, but
  // present on every card transaction their /transactions endpoint
  // returns — verified against Hatziri's live prod merchant.
  //
  // Critical quirk: both fields are ABSENT (undefined), not false,
  // on CASH transactions — cash never reaches the processor, so
  // there's nothing to settle. Any "is this unsettled?" test must
  // therefore check for an explicit false/'UNSETTLED' rather than
  // treating falsy-or-missing as pending, or every cash sale in
  // the window lands in the pending-deposit total.
  settled?: boolean
  settlementStatus?: string   // 'SETTLED' | 'UNSETTLED'
  // True once a pre-settlement reversal lands. A voided txn is
  // never deposited, so it must drop out of the pending sum.
  voided?: boolean
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

// ================================================================
// Current batch — the merchant's un-deposited processor balance
// ================================================================
//
// WHY THE TRANSACTIONS PATH AND NOT A SETTLEMENTS ENDPOINT:
//
// Probed live against Hatziri's prod merchant (business
// 7e23a8ae…, scope ALL) on 2026-09-02:
//
//   GET /businesses/{id}/settlements?state=OPEN  -> 404 Not Found
//   GET /businesses/{id}/settlements             -> 404 Not Found
//   GET /businesses/{id}/summary/today           -> 404 Not Found
//   GET /businesses/{id}/summary                 -> 404 Not Found
//   GET /businesses/{id}/batches                 -> 401 UNAUTHORIZED_ACCESS
//   GET /businesses/{id}/transactions            -> 200 OK
//
// The first four simply don't exist on Poynt's merchant-facing
// Cloud API — they're absent from the API reference too. /batches
// is more interesting: it answers 401 rather than 404, so the
// route exists but a merchant-delegated token can't reach it even
// holding scope ALL. That reads as a processor/acquirer-side
// resource, not something an app acting for the merchant can see.
// Re-probing it is pointless without a different principal, so
// don't burn a round-trip on it here.
//
// So we sum unsettled captured card transactions. Poynt hands us
// the settlement state per transaction (`settled` /
// `settlementStatus`), which is enough to reconstruct the open
// batch without a batch resource.
//
// SETTLEMENT RHYTHM (observed, worth knowing): Poynt does NOT
// only settle at a nightly close. On 2026-09-02 a 18:47Z sale
// was already SETTLED while a 19:35Z sale was still UNSETTLED, so
// transactions flip to settled continuously through the day. The
// tile therefore drifts down in steps rather than dropping to
// zero once a night.

/** Result of one current-batch read. All money in CENTS. */
export interface PosBatchSnapshot {
  /** Sum of unsettled captured card transactions, minus refunds. */
  pendingAmountCents: number
  /** How many transactions contributed to that sum. */
  transactionCount: number
  /** createdAt of the oldest unsettled transaction — the effective
   *  "batch opened at". Null when nothing is pending. */
  batchOpenedAt: string | null
  source: 'settlements' | 'transactions_fallback'
  fetchedAt: string
}

interface FetchCurrentBatchArgs {
  restaurantId: string
  /** How far back to look for still-unsettled transactions.
   *  Defaults to 7 days.
   *
   *  This bound is deliberate. Settlement normally completes in
   *  1-2 business days, so a week comfortably spans a holiday
   *  weekend's open batch. Without a bound, any transaction that
   *  gets permanently stuck UNSETTLED (we found declined ones from
   *  2026-08-27 still marked UNSETTLED weeks later) would sit in
   *  the merchant's pending total forever. */
  lookbackDays?: number
}

/** Funding sources that never settle through the processor, so
 *  they can never be "pending deposit". Cash is the one that
 *  actually shows up in Hatziri's data; check is included because
 *  it behaves the same way. */
const NON_SETTLING_FUNDING = new Set(['CASH', 'CHECK'])

/** Largest page size Poynt actually honors on /transactions. */
const PAGE_LIMIT = 100

/** Max pages to walk before we refuse to answer. See the
 *  truncation guard below for why exhausting this is an error and
 *  not a partial result. */
const MAX_PAGES = 40

/** Read the merchant's current un-deposited processor balance.
 *
 *  Mirrors fetchPoyntTransactions: same restaurantId-in /
 *  token-resolution-inside shape, same HATEOAS pagination, same
 *  `{ ... } | { error }` return so a caller can't forget to
 *  handle failure.
 *
 *  Parsing is deliberately defensive — different Poynt merchants
 *  return slightly different transaction shapes, and the
 *  settlement fields are undocumented, so every field access here
 *  tolerates absence. */
export async function fetchPoyntCurrentBatch(args: FetchCurrentBatchArgs): Promise<
  | (PosBatchSnapshot & { businessId: string })
  | { error: string }
> {
  const tok = await getValidAccessToken(args.restaurantId)
  if ('error' in tok) return { error: tok.error }

  const lookbackDays = args.lookbackDays ?? 7
  const startAtIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()
  const startingQuery = new URLSearchParams()
  startingQuery.set('startAt', startAtIso)
  // PAGE_LIMIT is 100 on purpose. Poynt's default page size is 10,
  // and `limit` is honored only up to 100 — pass 200 or 500 and it
  // silently reverts to 10 rather than clamping or erroring. 100 is
  // the largest value that actually takes effect.
  startingQuery.set('limit', String(PAGE_LIMIT))
  const startingUrl =
    `${baseUrl()}/businesses/${encodeURIComponent(tok.businessId)}/transactions?${startingQuery.toString()}`

  let pendingAmountCents = 0
  let transactionCount = 0
  let oldestUnsettledMs: number | null = null
  let batchOpenedAt: string | null = null

  let nextUrl: string | null = startingUrl
  let pagesWalked = 0

  while (nextUrl && pagesWalked < MAX_PAGES) {
    pagesWalked++
    const page: { data: PoyntTransactionList } | { error: string } =
      await getJson<PoyntTransactionList>(nextUrl, tok.accessToken)
    if ('error' in page) return { error: page.error }

    // Some Poynt deployments answer with a bare array instead of
    // the `{ transactions, links }` envelope — accept both.
    const raw: unknown = page.data
    const pageTxs: PoyntTransaction[] = Array.isArray(raw)
      ? (raw as PoyntTransaction[])
      : (page.data.transactions ?? [])

    for (const t of pageTxs) {
      if (!isUnsettledCardCapture(t)) continue
      const amount = pendingContribution(t)
      if (amount === 0) continue
      pendingAmountCents += amount
      transactionCount++
      const createdMs = Date.parse(t.createdAt ?? '')
      if (Number.isFinite(createdMs) && (oldestUnsettledMs === null || createdMs < oldestUnsettledMs)) {
        oldestUnsettledMs = createdMs
        batchOpenedAt = t.createdAt ?? null
      }
    }

    const next: PoyntLink | undefined = (Array.isArray(raw) ? [] : (page.data.links ?? [])).find(
      (l: PoyntLink) => (l.rel ?? '').toLowerCase() === 'next' && !!l.href,
    )
    const rawHref: string | null = next?.href ?? null
    if (rawHref) {
      try { nextUrl = new URL(rawHref, baseUrl()).toString() } catch { nextUrl = null }
    } else {
      nextUrl = null
    }
  }

  // TRUNCATION GUARD — do not remove.
  //
  // Poynt returns /transactions OLDEST-FIRST, so a page cap doesn't
  // trim the tail of the result, it trims the RECENT end — exactly
  // where every unsettled transaction lives. A truncated walk
  // therefore doesn't under-report slightly; it reports $0.00, which
  // looks like a legitimately closed batch and is indistinguishable
  // from "the merchant has been paid out."
  //
  // This is not hypothetical: with Poynt's default page size of 10,
  // a 30-day window on Hatziri is 45 pages, and the pre-`limit`
  // version of this function returned a confident $0.00 while $81.00
  // was actually pending. Refuse to answer instead.
  if (nextUrl) {
    console.warn('[godaddy/api] current batch truncated — refusing to report', {
      businessId: tok.businessId,
      pagesWalked,
      lookbackDays,
    })
    return {
      error:
        `Poynt returned more than ${MAX_PAGES} pages of transactions for the last ` +
        `${lookbackDays}d window; refusing to report a partial batch total.`,
    }
  }

  console.info('[godaddy/api] current batch computed', {
    businessId: tok.businessId,
    pendingAmountCents,
    transactionCount,
    batchOpenedAt,
    pagesWalked,
    lookbackDays,
  })

  return {
    businessId: tok.businessId,
    // A batch can legitimately go negative for a moment if a refund
    // is captured before the sale it reverses has settled. Clamping
    // would misreport; we surface what Poynt actually implies.
    pendingAmountCents,
    transactionCount,
    batchOpenedAt,
    source: 'transactions_fallback',
    fetchedAt: new Date().toISOString(),
  }
}

/** Is this transaction money the processor is holding for the
 *  merchant but hasn't paid out yet?
 *
 *  Requires an EXPLICIT unsettled marker. Cash sales carry neither
 *  `settled` nor `settlementStatus`, so a `!t.settled` test would
 *  sweep every cash sale in the window into the pending total —
 *  44 of the 210 transactions in Hatziri's 14-day window are cash. */
function isUnsettledCardCapture(t: PoyntTransaction): boolean {
  const explicitlyUnsettled =
    t.settled === false ||
    (t.settlementStatus ?? '').toUpperCase() === 'UNSETTLED'
  if (!explicitlyUnsettled) return false

  // Declined authorizations keep settlementStatus 'UNSETTLED'
  // permanently — they never settle because they never captured.
  // Only CAPTURED money is genuinely awaiting deposit.
  if ((t.status ?? '').toUpperCase() !== 'CAPTURED') return false

  // A void is a pre-settlement reversal: nothing gets deposited.
  if (t.voided === true) return false

  // Exclude the funding types that never route through the
  // processor. Checked by exclusion rather than requiring
  // 'CREDIT_DEBIT' so an unfamiliar card-like type from another
  // merchant's configuration still counts.
  const funding = (t.fundingSource?.type ?? '').toUpperCase()
  if (NON_SETTLING_FUNDING.has(funding)) return false

  return true
}

/** Signed cents this transaction adds to the pending balance.
 *  Refunds reduce what the processor will deposit. */
function pendingContribution(t: PoyntTransaction): number {
  // transactionAmount already includes tip; it's the figure that
  // actually moves to the bank. Fall back to orderAmount + tip
  // when a merchant's payload omits it.
  const amounts = t.amounts ?? {}
  const raw =
    typeof amounts.transactionAmount === 'number' ? amounts.transactionAmount
      : typeof amounts.orderAmount === 'number'
        ? amounts.orderAmount + (typeof amounts.tipAmount === 'number' ? amounts.tipAmount : 0)
        : 0
  if (!Number.isFinite(raw)) return 0
  const cents = Math.round(raw)
  const action = (t.action ?? '').toUpperCase()
  const status = (t.status ?? '').toUpperCase()
  if (action === 'REFUND' || status === 'REFUNDED') return -Math.abs(cents)
  return cents
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

// ================================================================
// Notifications — Poynt's authoritative event log
// ================================================================
//
// Poynt keeps a 30-day record of every event they'd fire via
// webhooks, exposed at GET /notifications. This is our real
// backstop against three failure modes at once:
//
//   1. Webhook is registered but the delivery URL was returning
//      307 (proxy misconfig, since fixed) — Poynt gave up
//      delivering; the notifications record still exists.
//   2. Webhook is registered but subscribed to the wrong event
//      types — no delivery attempted, but the notifications
//      record is there.
//   3. /orders LIST endpoint has read-side lag — an order
//      created at T might not appear in LIST for hours; the
//      notifications entry is created immediately.
//
// The notification-replay leg in godaddy-sync.ts lists these,
// diffs against orders.external_id, and fetches missing
// resources via fetchSinglePoyntOrder → ingestSinglePoyntOrder.
// The endpoint's shape isn't fully documented in the spec
// snippet we have; empirically it matches:
//   [ { id, businessId, applicationId, eventType, resourceUri,
//       resourceId?, createdAt, ... }, ... ]
// We only need the identifying fields — everything else is
// forwarded through to the ingest side without inspection.

export interface PoyntNotification {
  id?: string
  eventType?: string
  resourceId?: string
  resourceUri?: string
  businessId?: string
  createdAt?: string | number
  updatedAt?: string | number
}

interface FetchNotificationsArgs {
  restaurantId: string
  /** ISO timestamp — lower bound on createdAt. Defaults to 48h
   *  ago when omitted. Beyond ~30d is pointless — Poynt purges
   *  older notifications. */
  startAt?: string
  /** Cap per invocation. Notification volume is bounded (one
   *  per event Poynt would have fired) so 500 is plenty. */
  maxNotifications?: number
}

/** Pull Poynt notifications for the merchant with pagination.
 *
 *  Endpoint shape (per Poynt's docs):
 *    GET /businesses/{businessId}/notifications?startAt={iso}
 *  Response is either a bare array or `{ notifications: [], links: [] }`.
 *  We accept both — bare-array response happens on some Poynt
 *  deployments and pagination-shape happens on others. */
export async function fetchPoyntNotifications(args: FetchNotificationsArgs): Promise<
  | { businessId: string; notifications: PoyntNotification[] }
  | { error: string }
> {
  const tok = await getValidAccessToken(args.restaurantId)
  if ('error' in tok) return { error: tok.error }

  const startAtIso =
    args.startAt ?? new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const cap = args.maxNotifications ?? 500

  const q = new URLSearchParams()
  q.set('startAt', startAtIso)
  const startingUrl =
    `${baseUrl()}/businesses/${encodeURIComponent(tok.businessId)}/notifications?${q.toString()}`

  const notifications: PoyntNotification[] = []
  let nextUrl: string | null = startingUrl
  let safety = 60 // hard page cap — 60 × ~10 = ~600 notifications

  while (nextUrl && notifications.length < cap && safety > 0) {
    safety--
    console.info('[godaddy/api] GET notifications', { url: nextUrl, businessId: tok.businessId })
    const page = await getJson<unknown>(nextUrl, tok.accessToken)
    if ('error' in page) return { error: page.error }

    // Normalize the two response shapes we've seen.
    const body = page.data as unknown
    let pageItems: PoyntNotification[] = []
    let pageLinks: PoyntLink[] = []
    if (Array.isArray(body)) {
      pageItems = body as PoyntNotification[]
    } else if (body && typeof body === 'object') {
      const b = body as { notifications?: PoyntNotification[]; items?: PoyntNotification[]; links?: PoyntLink[] }
      pageItems = b.notifications ?? b.items ?? []
      pageLinks = b.links ?? []
    }

    console.info('[godaddy/api] notifications page', {
      shape: Array.isArray(body) ? 'array' : 'object',
      itemsOnPage: pageItems.length,
      hasLinks: pageLinks.length > 0,
    })

    for (const n of pageItems) {
      notifications.push(n)
      if (notifications.length >= cap) break
    }

    const next: PoyntLink | undefined = pageLinks.find(
      (l) => (l.rel ?? '').toLowerCase() === 'next' && !!l.href,
    )
    const rawHref = next?.href ?? null
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

  return { businessId: tok.businessId, notifications }
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
