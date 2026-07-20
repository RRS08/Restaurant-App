// ----------------------------------------------------------------
// GoDaddy Commerce Source Adapter — V1 (two channels, one core)
//
// GoDaddy's commerce stack (both the in-store POS and the online
// storefront checkout) runs on the Poynt platform GoDaddy acquired.
// A single OAuth2-authenticated REST surface backs both, so this one
// file produces TWO source adapters from a shared core:
//
//   godaddyPosSourceAdapter     id 'godaddy_pos'      — register sales
//   godaddyOnlineSourceAdapter  id 'godaddy_online'   — storefront sales
//
// They differ only in `channel`, which controls:
//   • how orders are filtered (in-store vs. web) when GoDaddy tells
//     us the order's origin, and
//   • how the canonical paymentType is inferred (a POS ticket can be
//     cash or card; a storefront order defaults to card).
// Everything else — auth, host, fetch, pagination, normalization —
// is shared. This mirrors the file-per-provider convention while
// staying DRY across two genuinely-related sources.
//
// ----------------------------------------------------------------
// STATUS: built ahead of a live GoDaddy developer account.
//
// Verified from GoDaddy/Poynt docs:
//   • OAuth2 token endpoint: POST /v2/oauth2/token, grant_type=
//     client_credentials (credentials + scopes).           [verified]
//   • Commerce host + namespace: https://api.godaddy.com,
//     /v2/commerce/stores/{storeId}/...                     [verified]
//
// PROVISIONAL — confirm against live payloads once keys exist:
//   • Orders list path + query params (the incremental `startAt`
//     window, cursor field name).
//   • Exact order/line-item/transaction JSON field names. These are
//     modeled on the well-known Poynt order object (amounts / items /
//     transactions[].fundingSource / context.source) and READ
//     DEFENSIVELY with fallbacks — the same hedging the Square and
//     Clover adapters already use — so a minor field rename degrades
//     to a skipped record, never a crash. Grep this file for
//     "PROVISIONAL" to find every spot to double-check.
//
// Auth is intentionally STUBBED, not faked: with no credentials the
// adapter throws a clear "not configured yet" error and hits nothing.
// Supply either a pre-issued `access_token` OR `client_id` +
// `client_secret` (the adapter runs the real client_credentials
// exchange) and it goes live with no code change. No secrets are
// ever hardcoded; the base URL is configurable per environment.
//
// The shared ingest pipeline handles dedupe, placeholder creation,
// the inventory gate, readiness, and multi-tenant isolation. This
// file does not bypass any of them.
// ----------------------------------------------------------------

import type { SourceAdapter, AdapterContext, SourceId } from '../adapter'
import type {
  NormalizedMenu,
  NormalizedCategory,
  NormalizedMenuItem,
  NormalizedOrder,
  NormalizedOrderLineItem,
} from '../types'

// ================================================================
// Channel + credential shapes
// ================================================================

type GodaddyChannel = 'pos' | 'online'

interface GodaddyCredentials {
  /** GoDaddy Commerce store id (a.k.a. business/store identifier the
   *  orders + products endpoints anchor on). */
  store_id: string
  /** Pre-issued bearer token. When present it's used directly and no
   *  token exchange happens — handy for early testing with a token
   *  pasted from the dashboard. */
  access_token?: string
  /** OAuth2 client credentials. When `access_token` is absent but
   *  these are present, the adapter runs the client_credentials
   *  grant to mint a short-lived token per sync. */
  client_id?: string
  client_secret?: string
  /** Optional space-delimited OAuth scopes for the token request. */
  scope?: string
  /** Commerce API base URL. Defaults to production GoDaddy Commerce.
   *  Overridable so a sandbox/staging host can be pointed at without
   *  a code change. */
  base_url?: string
}

const DEFAULT_BASE_URL = 'https://api.godaddy.com'
const TOKEN_PATH = '/v2/oauth2/token'
const REQUEST_TIMEOUT_MS = 20_000

// V1 pagination caps — a short/absent cursor terminates naturally;
// these stop a pathological store from hanging a single sync call.
const PAGE_LIMIT = 100
const MAX_ORDER_PAGES = 20 // 20 × 100 = 2,000 orders per sync
const MAX_MENU_PAGES = 10  // 10 × 100 = 1,000 products per sync

function readCredentials(raw: Record<string, unknown> | null): GodaddyCredentials {
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      'GoDaddy is not configured yet. Add a store_id plus either an ' +
      'access_token or client_id + client_secret once your developer ' +
      'account is live.'
    )
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

  const store_id = str(raw.store_id)
  const access_token = str(raw.access_token)
  const client_id = str(raw.client_id)
  const client_secret = str(raw.client_secret)
  const scope = str(raw.scope)
  const baseUrlRaw = str(raw.base_url)

  if (!store_id) throw new Error('GoDaddy credentials missing "store_id".')

  // Auth stub: fail loudly until real credentials exist. The adapter
  // never invents a token or silently hits the API unauthenticated.
  if (!access_token && !(client_id && client_secret)) {
    throw new Error(
      'GoDaddy credentials incomplete. Provide an "access_token", or ' +
      'both "client_id" and "client_secret" for the OAuth2 exchange.'
    )
  }

  const base_url = (baseUrlRaw || DEFAULT_BASE_URL).replace(/\/+$/, '')
  return {
    store_id,
    access_token: access_token || undefined,
    client_id: client_id || undefined,
    client_secret: client_secret || undefined,
    scope: scope || undefined,
    base_url,
  }
}

// ================================================================
// Meta helper (same shape/behavior as the other API adapters)
// ================================================================

function noteMeta(ctx: AdapterContext, note: string) {
  if (!ctx.meta) return
  if (!Array.isArray(ctx.meta.notes)) ctx.meta.notes = []
  ctx.meta.notes.push(note)
}

// ================================================================
// Auth — resolve a bearer token
//
// If a token was supplied, use it. Otherwise run the OAuth2
// client_credentials grant against POST {base}/v2/oauth2/token.
// (GoDaddy/Poynt also documents a JWT-bearer assertion variant; the
// client_credentials grant is the documented default and the one
// modeled here.)
// ================================================================

interface TokenResponse {
  access_token?: string
  token_type?: string
  expires_in?: number
}

async function resolveAccessToken(creds: GodaddyCredentials): Promise<string> {
  if (creds.access_token) return creds.access_token

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.client_id as string,
    client_secret: creds.client_secret as string,
  })
  if (creds.scope) body.set('scope', creds.scope)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${creds.base_url}${TOKEN_PATH}`, {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim()
      throw new Error(
        `GoDaddy OAuth token request failed (${res.status} ${res.statusText})` +
        (snippet ? ` — ${snippet}` : '')
      )
    }

    const json = (await res.json().catch(() => null)) as TokenResponse | null
    const token = json?.access_token?.trim()
    if (!token) {
      throw new Error('GoDaddy OAuth token response did not include an access_token.')
    }
    return token
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(`GoDaddy token request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// ================================================================
// Authed JSON fetch
// ================================================================

async function godaddyGet<T>(url: string, accessToken: string): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim()
      throw new Error(
        `GoDaddy API ${res.status} ${res.statusText}` +
        (snippet ? ` — ${snippet}` : '')
      )
    }

    return (await res.json()) as T
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(`GoDaddy request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// ================================================================
// Money helpers — GoDaddy Commerce amounts are integer minor units
// (cents). Fields can appear as a bare number or a { amount, currency }
// object depending on the resource; read both defensively.  [PROVISIONAL]
// ================================================================

function readCents(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v)
  if (v && typeof v === 'object') {
    const amount = (v as { amount?: unknown }).amount
    if (typeof amount === 'number' && Number.isFinite(amount)) return Math.round(amount)
  }
  return 0
}

function centsToUnits(cents: number): number {
  return cents / 100
}

function parseTimestamp(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw // epoch ms
  if (typeof raw === 'string') {
    const ms = Date.parse(raw)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

// ================================================================
// Wire shapes (PROVISIONAL — modeled on the Poynt order object)
// ================================================================

interface GodaddyOrderItem {
  id?: string
  sku?: string
  name?: string
  quantity?: number
  unitPrice?: number | { amount?: number }
  /** Line total when the API provides it; else computed. */
  total?: number | { amount?: number }
  status?: string
}

interface GodaddyFundingSource {
  type?: string   // 'CASH' | 'CREDIT_DEBIT' | 'CREDIT' | 'DEBIT' | 'CARD' | ...
  method?: string
}

interface GodaddyTransaction {
  action?: string
  status?: string // 'CAPTURED' | 'COMPLETED' | 'SUCCESS' | ...
  fundingSource?: GodaddyFundingSource
}

interface GodaddyOrder {
  id?: string
  createdAt?: string | number
  updatedAt?: string | number
  status?: string
  /** Some payloads nest the lifecycle state under `statuses`. */
  statuses?: { status?: string }
  amounts?: {
    subTotal?: number | { amount?: number }
    totalAmount?: number | { amount?: number }
    netTotal?: number | { amount?: number }
    currency?: string
  }
  /** Primary line-item collection; `orderItems` accepted as an alias. */
  items?: GodaddyOrderItem[]
  orderItems?: GodaddyOrderItem[]
  transactions?: GodaddyTransaction[]
  /** Origin of the order — used to keep POS vs. storefront separate. */
  context?: { source?: string; storeId?: string; businessId?: string }
  channel?: string
}

interface GodaddyOrdersResponse {
  orders?: GodaddyOrder[]
  /** Cursor for the next page under whichever name the API returns. */
  cursor?: string
  nextPageToken?: string
  paging?: { cursor?: string; next?: string }
}

// ================================================================
// Order channel filter
//
// GoDaddy tags an order's origin (in-store vs. web) when it can. We
// use it to keep the two adapters' data separate WITHOUT dropping
// data we can't classify:
//   • Origin clearly the OTHER channel  → skip.
//   • Origin absent or unrecognized     → keep (the store scoping +
//     the per-location connection already narrow it, and dropping
//     unknown-origin sales would silently lose revenue).
// ================================================================

const POS_HINTS = ['INSTORE', 'IN_STORE', 'IN-STORE', 'POS', 'REGISTER', 'TERMINAL']
const WEB_HINTS = ['WEB', 'ONLINE', 'ECOM', 'E-COMMERCE', 'ECOMMERCE', 'STOREFRONT', 'INTERNET']

function orderMatchesChannel(order: GodaddyOrder, channel: GodaddyChannel): boolean {
  const src = (order.context?.source ?? order.channel ?? '').toString().toUpperCase()
  if (!src) return true // can't tell — trust the store/connection scoping

  const looksPos = POS_HINTS.some((h) => src.includes(h))
  const looksWeb = WEB_HINTS.some((h) => src.includes(h))

  if (channel === 'pos') return looksPos || !looksWeb
  return looksWeb || !looksPos
}

// ================================================================
// Payment-type inference
// ================================================================

function inferPaymentType(
  transactions: GodaddyTransaction[] | undefined,
  channel: GodaddyChannel,
  ctx: AdapterContext
): NormalizedOrder['paymentType'] {
  const fallback: NormalizedOrder['paymentType'] = channel === 'online' ? 'card' : 'other'

  if (!transactions || transactions.length === 0) return fallback

  // Only count transactions that look successful (or don't say).
  const effective = transactions.filter((t) => {
    const s = (t.status ?? '').toUpperCase()
    return s === '' || s === 'SUCCESS' || s === 'CAPTURED' || s === 'COMPLETED' || s === 'AUTHORIZED'
  })
  if (effective.length === 0) return fallback

  const types = new Set(
    effective
      .map((t) => (t.fundingSource?.type ?? '').toUpperCase())
      .filter(Boolean)
  )
  if (types.size === 0) return fallback

  if (types.size > 1) {
    noteMeta(ctx, 'GoDaddy order had multiple tender types (split tender) — collapsed to "other".')
    return 'other'
  }

  const [only] = types
  if (only.includes('CASH')) return 'cash'
  if (only.includes('CREDIT') || only.includes('DEBIT') || only.includes('CARD')) return 'card'
  return channel === 'online' ? 'card' : 'other'
}

// ================================================================
// Order normalization
// ================================================================

function foldLineItems(order: GodaddyOrder): NormalizedOrderLineItem[] {
  const rawItems = order.items ?? order.orderItems ?? []
  const out: NormalizedOrderLineItem[] = []

  rawItems.forEach((li, index) => {
    if (!li) return
    // External id: prefer sku (stable across the catalog), then the
    // line id; fall back to a positional id so revenue is never lost.
    const externalItemId =
      (li.sku && li.sku.trim()) ||
      (li.id && li.id.trim()) ||
      `raw:${order.id ?? 'order'}:${index}`

    const quantity = (() => {
      const n = typeof li.quantity === 'number' ? li.quantity : 1
      if (!Number.isFinite(n) || n < 1) return 1
      return Math.round(n)
    })()

    const unitCents = readCents(li.unitPrice)
    const lineTotalCents = li.total != null ? readCents(li.total) : unitCents * quantity

    const name = (li.name ?? '').trim() || externalItemId

    out.push({
      externalItemId,
      itemName: name,
      quantity,
      unitPrice: centsToUnits(unitCents),
      totalPrice: centsToUnits(lineTotalCents),
    })
  })

  return out
}

function normalizeOrders(
  orders: GodaddyOrder[],
  channel: GodaddyChannel,
  ctx: AdapterContext
): NormalizedOrder[] {
  const out: NormalizedOrder[] = []

  for (const o of orders) {
    if (!o || !o.id) continue
    if (!orderMatchesChannel(o, channel)) continue

    const rawState = (o.status ?? o.statuses?.status ?? '').toUpperCase()
    let status: NormalizedOrder['status']
    if (['COMPLETED', 'CAPTURED', 'FULFILLED', 'PAID', 'CLOSED'].includes(rawState)) {
      status = 'completed'
    } else if (['CANCELLED', 'CANCELED', 'VOIDED', 'REFUNDED'].includes(rawState)) {
      status = 'voided'
    } else {
      // OPENED / DRAFT / PENDING / unknown — not a closed sale yet.
      continue
    }

    const tsMs = parseTimestamp(o.updatedAt) ?? parseTimestamp(o.createdAt)
    if (tsMs == null) continue

    const lineItems = foldLineItems(o)
    if (lineItems.length === 0) continue // nothing meaningful to ingest

    // Prefer the API's declared total; fall back to summing line
    // items so a $0/absent total never wipes real revenue (same
    // guard the Clover adapter uses).
    const declaredCents = readCents(o.amounts?.totalAmount ?? o.amounts?.netTotal)
    const declaredTotal = centsToUnits(declaredCents)
    const lineTotal = lineItems.reduce((sum, li) => sum + li.totalPrice, 0)
    const totalAmount = declaredTotal > 0 ? declaredTotal : lineTotal

    out.push({
      externalId: o.id,
      postedAt: new Date(tsMs).toISOString(),
      totalAmount,
      status,
      paymentType: inferPaymentType(o.transactions, channel, ctx),
      lineItems,
    })
  }

  return out
}

// ================================================================
// Orders fetching — cursor-paginated walk
// ================================================================

function readCursor(payload: GodaddyOrdersResponse): string {
  return (
    payload.cursor ??
    payload.nextPageToken ??
    payload.paging?.cursor ??
    payload.paging?.next ??
    ''
  ).trim()
}

async function fetchAllOrders(
  ctx: AdapterContext,
  creds: GodaddyCredentials,
  accessToken: string,
  sinceIso: string
): Promise<GodaddyOrder[]> {
  const out: GodaddyOrder[] = []
  let cursor = ''
  let pages = 0
  let rawRecords = 0
  let truncated = false

  while (pages < MAX_ORDER_PAGES) {
    const params = new URLSearchParams({
      // PROVISIONAL: incremental window on the order's updated time.
      startAt: sinceIso,
      limit: String(PAGE_LIMIT),
    })
    if (cursor) params.set('cursor', cursor)

    const url =
      `${creds.base_url}/v2/commerce/stores/${encodeURIComponent(creds.store_id)}/orders` +
      `?${params.toString()}`
    const payload = await godaddyGet<GodaddyOrdersResponse>(url, accessToken)

    const batch = payload.orders ?? []
    rawRecords += batch.length
    out.push(...batch)
    pages += 1

    const next = readCursor(payload)
    if (!next) break
    cursor = next

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
      noteMeta(ctx, `GoDaddy orders truncated at ${pages * PAGE_LIMIT} records (V1 page cap — run sync again to fetch the rest).`)
    }
  }

  return out
}

// ================================================================
// Catalog (menu) — PROVISIONAL
//
// The one commerce resource surfaced in the public docs is
// /v2/commerce/stores/{storeId}/products. Menu import is secondary to
// sales for this integration; it's mapped modestly and defensively so
// it degrades gracefully rather than blocking an orders sync.
// ================================================================

interface GodaddyProduct {
  id?: string
  sku?: string
  name?: string
  price?: number | { amount?: number }
  status?: string
  available?: boolean
  category?: { id?: string; name?: string }
  categoryId?: string
  categoryName?: string
}

interface GodaddyProductsResponse {
  products?: GodaddyProduct[]
  cursor?: string
  nextPageToken?: string
  paging?: { cursor?: string; next?: string }
}

async function fetchAllProducts(
  ctx: AdapterContext,
  creds: GodaddyCredentials,
  accessToken: string
): Promise<GodaddyProduct[]> {
  const out: GodaddyProduct[] = []
  let cursor = ''
  let pages = 0
  let rawRecords = 0
  let truncated = false

  while (pages < MAX_MENU_PAGES) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) })
    if (cursor) params.set('cursor', cursor)

    const url =
      `${creds.base_url}/v2/commerce/stores/${encodeURIComponent(creds.store_id)}/products` +
      `?${params.toString()}`
    const payload = await godaddyGet<GodaddyProductsResponse>(url, accessToken)

    const batch = payload.products ?? []
    rawRecords += batch.length
    out.push(...batch)
    pages += 1

    const next = (payload.cursor ?? payload.nextPageToken ?? payload.paging?.cursor ?? payload.paging?.next ?? '').trim()
    if (!next) break
    cursor = next

    if (pages >= MAX_MENU_PAGES) {
      truncated = true
      break
    }
  }

  if (ctx.meta) {
    ctx.meta.pagesFetched = (ctx.meta.pagesFetched ?? 0) + pages
    ctx.meta.recordsFetched = (ctx.meta.recordsFetched ?? 0) + rawRecords
    if (truncated) {
      ctx.meta.truncated = true
      noteMeta(ctx, `GoDaddy products truncated at ${pages * PAGE_LIMIT} records (V1 page cap).`)
    }
  }

  return out
}

function normalizeProducts(products: GodaddyProduct[]): NormalizedMenu {
  const categoriesById = new Map<string, NormalizedCategory>()
  const items: NormalizedMenuItem[] = []

  for (const p of products) {
    if (!p) continue
    const externalId = (p.id && p.id.trim()) || (p.sku && p.sku.trim()) || ''
    const name = (p.name ?? '').trim()
    if (!externalId || !name) continue

    // Category is optional — unknown/absent lands with `category_id
    // = null` (surfaces in the "Awaiting a section" band on /menu).
    const catId = (p.category?.id ?? p.categoryId ?? '').trim()
    const catName = (p.category?.name ?? p.categoryName ?? '').trim()
    let categoryExternalId: string | null = null
    if (catId) {
      categoryExternalId = catId
      if (!categoriesById.has(catId)) {
        categoriesById.set(catId, { externalId: catId, name: catName || catId })
      }
    }

    let active = true
    if (typeof p.available === 'boolean') active = p.available
    if (typeof p.status === 'string') active = active && p.status.toUpperCase() !== 'INACTIVE'

    items.push({
      externalId,
      name,
      price: centsToUnits(readCents(p.price)),
      categoryExternalId,
      active,
    })
  }

  return { categories: Array.from(categoriesById.values()), items }
}

// ================================================================
// Adapter factory + exports
// ================================================================

function makeGodaddyAdapter(config: {
  id: Extract<SourceId, 'godaddy_pos' | 'godaddy_online'>
  label: string
  channel: GodaddyChannel
}): SourceAdapter {
  return {
    id: config.id,
    kind: 'api',
    label: config.label,

    async listMenu(ctx: AdapterContext): Promise<NormalizedMenu> {
      const creds = readCredentials(ctx.credentials)
      const token = await resolveAccessToken(creds)
      const products = await fetchAllProducts(ctx, creds, token)
      return normalizeProducts(products)
    },

    async listOrders(ctx: AdapterContext): Promise<NormalizedOrder[]> {
      const creds = readCredentials(ctx.credentials)
      const token = await resolveAccessToken(creds)

      // Incremental window: connection's last_orders_sync_at, else a
      // 7-day lookback on first sync — same as every other API adapter.
      const sinceMs =
        ctx.since instanceof Date ? ctx.since.getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000
      const sinceIso = new Date(sinceMs).toISOString()

      const raw = await fetchAllOrders(ctx, creds, token, sinceIso)
      return normalizeOrders(raw, config.channel, ctx)
    },
  }
}

export const godaddyPosSourceAdapter: SourceAdapter = makeGodaddyAdapter({
  id: 'godaddy_pos',
  label: 'GoDaddy POS',
  channel: 'pos',
})

export const godaddyOnlineSourceAdapter: SourceAdapter = makeGodaddyAdapter({
  id: 'godaddy_online',
  label: 'GoDaddy Online Store',
  channel: 'online',
})
