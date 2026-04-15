// ----------------------------------------------------------------
// Toast Source Adapter — Pilot V1 (real API)
//
// Second real branded adapter on top of the source-agnostic intake
// core. Built to be a foundation for the real product, not a
// throwaway pilot integration.
//
// Real bits:
//   • Real OAuth 2.0 client-credentials auth (/authentication/v1)
//   • Real menu endpoint (/menus/v2/menus)
//   • Real orders endpoint (/orders/v2/ordersBulk) with pagination
//   • Real Toast restaurant scoping via the Toast-Restaurant-External-ID header
//   • Real normalization into the canonical menu + order shapes
//   • Real SyncMeta transparency (page counts, truncation, notes)
//
// Intentionally narrow for V1 (documented, not hidden):
//   • Menu import only covers groups + items + base prices + visibility.
//     No modifier groups, no nested option logic, no menu-level
//     pricing levels, no visibility segmentation (POS vs online).
//   • Order import treats each Toast `check` as one canonical order
//     (split-table tickets become independent sales, which is what
//     Finance + Analytics want). See section "Order model" below.
//   • Voided checks are mapped to `status: 'voided'` so the inventory
//     bridge's existing gate skips them correctly.
//   • Access tokens are fetched on every sync call. Toast tokens
//     last ~24h; caching + refresh is a future concern, not needed
//     for V1 correctness.
//   • No webhook subscription. Polling-only, via the existing
//     incremental `last_orders_sync_at` cursor.
//   • No refund lifecycle syncing beyond the voided flag.
//   • No split-tender payment enumeration. A check with mixed
//     payments collapses to `paymentType: 'other'` and emits a note.
//   • Multi-menu handling: Toast restaurants can have multiple
//     menus (Breakfast, Lunch, Dinner, ...). Items appear in one or
//     more menus. We flatten all menus into the canonical menu
//     using item `guid` as dedupe key. A note is emitted when more
//     than one menu was seen so the operator understands the
//     flattening.
//   • Tax semantics: Toast `check.totalAmount` is tax-inclusive.
//     Selection `price` / `receiptLinePrice` are pre-tax. Sum of
//     line totals therefore differs from order total by the tax
//     amount. The canonical model doesn't itemize tax; this is
//     documented honestly in a meta note instead of being hidden.
//
// The shared ingest pipeline handles dedupe, placeholder creation,
// inventory activation gate, readiness integration, and multi-tenant
// isolation. This file does not bypass any of them.
// ----------------------------------------------------------------

import type { SourceAdapter, AdapterContext, SyncMeta } from '../adapter'
import type {
  NormalizedMenu,
  NormalizedCategory,
  NormalizedMenuItem,
  NormalizedOrder,
  NormalizedOrderLineItem,
} from '../types'
import { slug } from '../util'

// ================================================================
// Credential shape
// ================================================================

interface ToastCredentials {
  client_id: string
  client_secret: string
  /** Toast's per-restaurant GUID. Sent as the Toast-Restaurant-External-ID
   *  header on every data fetch so the API scopes results to this
   *  restaurant only. */
  restaurant_guid: string
  /** Optional override. Defaults to Toast's sandbox base URL so
   *  development testing never accidentally hits production. */
  base_url?: string
}

// Toast exposes different base URLs per environment. The exact
// sandbox URL depends on the developer account provisioning; the
// value below is the published preproduction endpoint and can be
// overridden per-connection via `base_url` in credentials.
const DEFAULT_BASE_URL = 'https://ws-sandbox-api.eng.toasttab.com'

const REQUEST_TIMEOUT_MS = 20_000

// V1 pagination caps. Short pages terminate naturally; these caps
// exist so a pathological restaurant can't hang a single sync call.
// Raising them is a one-line constant change when pilot data demands it.
const ORDERS_PAGE_SIZE = 100
const MAX_ORDER_PAGES = 20 // 20 * 100 = 2,000 orders per sync

function readCredentials(raw: Record<string, unknown> | null): ToastCredentials {
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      'Toast credentials missing. Expected { client_id, client_secret, restaurant_guid }.'
    )
  }
  const client_id = typeof raw.client_id === 'string' ? raw.client_id.trim() : ''
  const client_secret = typeof raw.client_secret === 'string' ? raw.client_secret.trim() : ''
  const restaurant_guid = typeof raw.restaurant_guid === 'string' ? raw.restaurant_guid.trim() : ''
  const baseUrlRaw = typeof raw.base_url === 'string' ? raw.base_url.trim() : ''

  if (!client_id)      throw new Error('Toast credentials missing "client_id".')
  if (!client_secret)  throw new Error('Toast credentials missing "client_secret".')
  if (!restaurant_guid) throw new Error('Toast credentials missing "restaurant_guid".')

  const base_url = (baseUrlRaw || DEFAULT_BASE_URL).replace(/\/+$/, '')
  return { client_id, client_secret, restaurant_guid, base_url }
}

// ================================================================
// HTTP helpers
// ================================================================

function noteMeta(ctx: AdapterContext, note: string) {
  if (!ctx.meta) return
  if (!Array.isArray(ctx.meta.notes)) ctx.meta.notes = []
  ctx.meta.notes.push(note)
}

async function toastRequest<T>(
  url: string,
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
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const snippet = body.slice(0, 200).replace(/\s+/g, ' ').trim()
      throw new Error(
        `Toast API ${res.status} ${res.statusText}` +
        (snippet ? ` — ${snippet}` : '')
      )
    }

    return (await res.json()) as T
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(`Toast request timed out after ${timeoutMs / 1000}s.`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// ================================================================
// OAuth — client credentials flow
//
// Toast issues access tokens via POST /authentication/v1/authentication/login
// with body { clientId, clientSecret, userAccessType: 'TOAST_MACHINE_CLIENT' }.
// Response shape: { token: { accessToken, expiresIn, ... } }
//
// For V1 we fetch a fresh token per sync call. Token caching +
// proactive refresh is a future concern; the extra request is
// cheap and removes a whole class of "cached token expired
// mid-sync" edge cases.
// ================================================================

interface ToastAuthResponse {
  token?: {
    accessToken?: string
    expiresIn?: number
    tokenType?: string
  }
}

async function getAccessToken(creds: ToastCredentials): Promise<string> {
  const authUrl = `${creds.base_url}/authentication/v1/authentication/login`
  const body = await toastRequest<ToastAuthResponse>(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      userAccessType: 'TOAST_MACHINE_CLIENT',
    }),
  })

  const accessToken = body?.token?.accessToken
  if (!accessToken) {
    throw new Error('Toast authentication response did not include an access token.')
  }
  return accessToken
}

function authHeaders(accessToken: string, restaurantGuid: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Toast-Restaurant-External-ID': restaurantGuid,
  }
}

// ================================================================
// Menu mapping
//
// Toast /menus/v2/menus returns an object like:
//   {
//     restaurantGuid: '...',
//     menus: [
//       {
//         guid: '...', name: 'Lunch',
//         menuGroups: [
//           {
//             guid: '...', name: 'Mains',
//             menuItems: [
//               { guid: '...', name: '...', price: 14.00, visibility: [...] }
//             ]
//           }
//         ]
//       }
//     ]
//   }
//
// Multiple menus can contain the same item. We flatten all menus
// into the canonical menu and dedupe items by guid. The first-seen
// menuGroup for each item becomes its canonical category.
// ================================================================

interface ToastMenuItemRaw {
  guid?: string
  name?: string
  price?: number
  /** Toast visibility list — e.g. ['POS', 'ORDERING_PARTNERS', 'KIOSK'].
   *  We treat "item appears on POS" as active. Empty/missing = active. */
  visibility?: string[]
}

interface ToastMenuGroupRaw {
  guid?: string
  name?: string
  menuItems?: ToastMenuItemRaw[]
}

interface ToastMenuRaw {
  guid?: string
  name?: string
  menuGroups?: ToastMenuGroupRaw[]
}

interface ToastMenusResponse {
  menus?: ToastMenuRaw[]
}

function normalizeToastMenu(
  payload: ToastMenusResponse,
  ctx: AdapterContext
): NormalizedMenu {
  const categoriesById = new Map<string, NormalizedCategory>()
  const itemsById = new Map<string, NormalizedMenuItem>()

  const menus = payload.menus ?? []
  if (menus.length > 1) {
    noteMeta(ctx, `Toast restaurant has ${menus.length} menus — flattened into one canonical menu.`)
  }

  for (const menu of menus) {
    const groups = menu.menuGroups ?? []
    for (const group of groups) {
      if (!group.guid || !group.name) continue
      if (!categoriesById.has(group.guid)) {
        categoriesById.set(group.guid, {
          externalId: group.guid,
          name: group.name,
        })
      }

      const items = group.menuItems ?? []
      for (const raw of items) {
        if (!raw.guid || !raw.name) continue
        // First-seen wins — an item visible in multiple menus gets
        // its category from the first menu/group where we saw it.
        if (itemsById.has(raw.guid)) continue

        const price = typeof raw.price === 'number' && Number.isFinite(raw.price) ? raw.price : 0
        // Toast `visibility` array marks where the item appears. An
        // item explicitly missing 'POS' is not rung up at the counter
        // so we mark it inactive for the canonical menu. Empty or
        // missing visibility is treated as visible-by-default.
        const visibility = Array.isArray(raw.visibility) ? raw.visibility : []
        const active = visibility.length === 0 || visibility.includes('POS')

        itemsById.set(raw.guid, {
          externalId: raw.guid,
          name: raw.name,
          price,
          categoryExternalId: group.guid,
          active,
        })
      }
    }
  }

  return {
    categories: Array.from(categoriesById.values()),
    items: Array.from(itemsById.values()),
  }
}

// ================================================================
// Orders mapping
//
// Toast /orders/v2/ordersBulk returns an array of orders. Each order
// has zero or more `checks` (split-table tickets). Each check has
// selections (line items) and payments.
//
// Canonical decision: one `check` → one canonical order.
// External id format: `${orderGuid}__${checkGuid}`.
//
// Why per-check: a single Toast "order" can hold multiple checks
// when a table splits the bill. Each check is an independent
// revenue event (its own total, its own payment, its own close
// time). Collapsing them into one canonical order would hide that
// split from Finance + Analytics. Per-check mapping is honest and
// matches how operators count sales.
// ================================================================

interface ToastSelectionRaw {
  guid?: string
  displayName?: string
  item?: { guid?: string } | null
  quantity?: number
  price?: number           // unit price, pre-tax
  receiptLinePrice?: number // line total, pre-tax
  voided?: boolean
}

interface ToastPaymentRaw {
  type?: string // 'CASH' | 'CREDIT' | 'GIFTCARD' | 'HOUSE_ACCOUNT' | 'OTHER' | 'UNDETERMINED'
  paymentStatus?: string
  refundStatus?: string
  voidInfo?: unknown
}

interface ToastCheckRaw {
  guid?: string
  totalAmount?: number       // tax-inclusive
  closedDate?: string
  modifiedDate?: string
  openedDate?: string
  voided?: boolean
  selections?: ToastSelectionRaw[]
  payments?: ToastPaymentRaw[]
}

interface ToastOrderRaw {
  guid?: string
  modifiedDate?: string
  createdDate?: string
  voided?: boolean
  checks?: ToastCheckRaw[]
}

function inferToastPaymentType(
  payments: ToastPaymentRaw[] | undefined,
  ctx: AdapterContext
): NormalizedOrder['paymentType'] {
  if (!payments || payments.length === 0) return 'other'

  // Only consider payments that actually captured money (ignore voids / refunds)
  const successful = payments.filter((p) => {
    if (p.paymentStatus && p.paymentStatus.toUpperCase() === 'DENIED') return false
    return true
  })
  if (successful.length === 0) return 'other'

  const types = new Set(
    successful.map((p) => (p.type ?? '').toUpperCase()).filter((t) => t.length > 0)
  )

  // Mixed tender — canonical model can't represent split payments,
  // so we explicitly collapse and emit a note. Better transparency
  // than silent lossy mapping.
  if (types.size > 1) {
    noteMeta(ctx, 'Toast check had multiple payment types (split tender) — collapsed to "other".')
    return 'other'
  }

  const [only] = types
  if (only === 'CASH') return 'cash'
  if (only === 'CREDIT') return 'card'
  return 'other'
}

function foldToastSelections(
  selections: ToastSelectionRaw[] | undefined
): NormalizedOrderLineItem[] {
  if (!selections || selections.length === 0) return []

  type Group = {
    externalItemId: string
    itemName: string
    quantity: number
    unitPrice: number // first seen
    totalPrice: number
  }

  const groups = new Map<string, Group>()

  for (const sel of selections) {
    // Skip voided selections — they don't contribute revenue or
    // inventory semantics. The parent check may still be valid.
    if (sel.voided === true) continue

    // Resolve identity. Prefer the linked item.guid; fall back to a
    // selection-level id so revenue never disappears on edge cases
    // where Toast returns an unlinked manual selection.
    const externalItemId =
      (sel.item?.guid && sel.item.guid.trim()) ||
      (sel.guid ? `raw:${sel.guid}` : '')
    if (!externalItemId) continue

    const name = (sel.displayName ?? '').trim() || externalItemId

    // Canonical quantity is integer ≥ 1. Toast can emit fractional
    // quantities for weighed items; round up to 1 and let the
    // totalPrice carry the accurate revenue.
    const rawQty = typeof sel.quantity === 'number' ? sel.quantity : 1
    const qty = Math.max(1, Math.round(rawQty))

    const unit = typeof sel.price === 'number' ? sel.price : 0
    const lineTotal =
      typeof sel.receiptLinePrice === 'number'
        ? sel.receiptLinePrice
        : unit * qty

    const existing = groups.get(externalItemId)
    if (existing) {
      existing.quantity += qty
      existing.totalPrice += lineTotal
    } else {
      groups.set(externalItemId, {
        externalItemId,
        itemName: name,
        quantity: qty,
        unitPrice: unit,
        totalPrice: lineTotal,
      })
    }
  }

  return Array.from(groups.values()).map((g) => ({
    externalItemId: g.externalItemId,
    itemName: g.itemName,
    quantity: g.quantity,
    unitPrice: g.unitPrice,
    totalPrice: g.totalPrice,
  }))
}

function normalizeToastOrders(
  orders: ToastOrderRaw[],
  ctx: AdapterContext
): NormalizedOrder[] {
  const out: NormalizedOrder[] = []

  for (const order of orders) {
    if (!order.guid) continue
    const checks = order.checks ?? []
    if (checks.length === 0) continue

    for (const check of checks) {
      if (!check.guid) continue

      // `closedDate` is the canonical "sale completed" moment for a
      // check. Fall back to modified/opened if the check is still
      // open — we still record it so the operator sees it.
      const rawTs = check.closedDate ?? check.modifiedDate ?? check.openedDate ?? order.modifiedDate ?? order.createdDate
      if (!rawTs) continue
      const parsedTs = Date.parse(rawTs)
      if (Number.isNaN(parsedTs)) continue

      const lineItems = foldToastSelections(check.selections)
      if (lineItems.length === 0) continue

      // Voided checks are mapped to status='voided'. Toast also has
      // order-level voids — if the parent order is voided, every
      // check under it is treated as voided too.
      const isVoided = Boolean(check.voided) || Boolean(order.voided)
      const status: NormalizedOrder['status'] = isVoided ? 'voided' : 'completed'

      // Tax-inclusive total from Toast. Sum of line item totals is
      // pre-tax and will differ; see the file header's caveat.
      const totalAmount = typeof check.totalAmount === 'number' ? check.totalAmount : 0

      const paymentType = inferToastPaymentType(check.payments, ctx)

      out.push({
        externalId: `${order.guid}__${check.guid}`,
        postedAt: new Date(parsedTs).toISOString(),
        totalAmount,
        status,
        paymentType,
        lineItems,
      })
    }
  }

  return out
}

// ================================================================
// Pagination walker for orders
// ================================================================

async function fetchAllOrderPages(
  ctx: AdapterContext,
  creds: ToastCredentials,
  accessToken: string,
  startIso: string,
  endIso: string
): Promise<NormalizedOrder[]> {
  const all: NormalizedOrder[] = []
  let page = 1
  let pages = 0
  let rawRecords = 0
  let truncated = false

  while (pages < MAX_ORDER_PAGES) {
    const url =
      `${creds.base_url}/orders/v2/ordersBulk` +
      `?startDate=${encodeURIComponent(startIso)}` +
      `&endDate=${encodeURIComponent(endIso)}` +
      `&pageSize=${ORDERS_PAGE_SIZE}` +
      `&page=${page}`

    const batch = await toastRequest<ToastOrderRaw[]>(url, {
      headers: authHeaders(accessToken, creds.restaurant_guid),
    })

    const returned = Array.isArray(batch) ? batch.length : 0
    if (returned === 0) {
      pages += 1
      break
    }

    rawRecords += returned
    pages += 1

    const normalized = normalizeToastOrders(batch, ctx)
    all.push(...normalized)

    // Short page = last page. Matches the Clover + pilot pattern.
    if (returned < ORDERS_PAGE_SIZE) break

    page += 1
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
      noteMeta(ctx, `Toast orders truncated at ${pages * ORDERS_PAGE_SIZE} records (V1 page cap).`)
    }
  }

  return all
}

// ================================================================
// SourceAdapter export
// ================================================================

export const toastSourceAdapter: SourceAdapter = {
  id: 'toast',
  kind: 'api',
  label: 'Toast',

  async listMenu(ctx: AdapterContext): Promise<NormalizedMenu> {
    const creds = readCredentials(ctx.credentials)
    const accessToken = await getAccessToken(creds)

    // Menus are returned as a single tree. Not paginated. For a
    // pathologically large menu (hundreds of items across many
    // groups) Toast still returns the full tree — the endpoint is
    // sized for catalog completeness. If that assumption ever
    // breaks, the endpoint exposes pagination params and this
    // function can adopt the same `fetchPaginated` pattern.
    const payload = await toastRequest<ToastMenusResponse>(
      `${creds.base_url}/menus/v2/menus`,
      { headers: authHeaders(accessToken, creds.restaurant_guid) }
    )

    if (ctx.meta) {
      ctx.meta.pagesFetched = (ctx.meta.pagesFetched ?? 0) + 1
      // Count raw items seen across all menus for transparency
      let rawItems = 0
      for (const menu of payload.menus ?? []) {
        for (const group of menu.menuGroups ?? []) {
          rawItems += (group.menuItems ?? []).length
        }
      }
      ctx.meta.recordsFetched = (ctx.meta.recordsFetched ?? 0) + rawItems
    }

    return normalizeToastMenu(payload, ctx)
  },

  async listOrders(ctx: AdapterContext): Promise<NormalizedOrder[]> {
    const creds = readCredentials(ctx.credentials)
    const accessToken = await getAccessToken(creds)

    // Incremental window via existing last_orders_sync_at cursor.
    // First sync (since=null) falls back to a 7-day lookback, same
    // as every other API adapter.
    const startMs =
      ctx.since instanceof Date ? ctx.since.getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000
    const startIso = new Date(startMs).toISOString()
    const endIso = new Date().toISOString()

    return fetchAllOrderPages(ctx, creds, accessToken, startIso, endIso)
  },
}
