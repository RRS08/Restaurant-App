// ----------------------------------------------------------------
// Custom JSON Source Adapter — Pilot V1
//
// Parses raw JSON text into the canonical normalized shapes in
// `../types.ts`. Intended for homemade POS systems, local exports,
// lightweight bridge scripts, and one-off custom feeds. Does NOT
// write anything — all DB writes go through the shared ingest
// pipeline, same as every other adapter.
//
// --------------------------------------------------------------
// Expected MENU JSON shape (top-level object)
// --------------------------------------------------------------
//   {
//     "categories": [
//       { "id": "cat_apps",  "name": "Appetizers", "sortOrder": 1 },
//       { "id": "cat_mains", "name": "Mains",      "sortOrder": 2 }
//     ],
//     "items": [
//       { "id": "itm_fries",   "name": "Crispy Fries",  "price": 5.50, "categoryId": "cat_apps",  "active": true },
//       { "id": "itm_burger",  "name": "House Burger",  "price": 14.00,"categoryId": "cat_mains", "active": true },
//       { "id": "itm_special", "name": "Daily Special", "price": 18.00 }
//     ]
//   }
//
//   • Top level MUST be an object with an `items` array.
//   • `categories` is optional; items can omit `categoryId` or
//     reference a category that wasn't declared — the shared ingest
//     pipeline routes them to the "Imported · Uncategorized" bucket.
//   • Each item requires `id`, `name`, `price`. `categoryId` and
//     `active` are optional. `active` defaults to true.
//   • Each category requires `id`, `name`. `sortOrder` is optional.
//
// --------------------------------------------------------------
// Expected ORDERS JSON shape
// --------------------------------------------------------------
// Either a top-level array:
//   [
//     {
//       "id": "ord_0001",
//       "postedAt": "2026-04-12T13:00:00Z",
//       "totalAmount": 19.50,
//       "paymentType": "card",
//       "status": "completed",
//       "lineItems": [
//         { "itemId": "itm_burger", "itemName": "House Burger", "quantity": 1, "unitPrice": 14.00, "totalPrice": 14.00 },
//         { "itemId": "itm_fries",  "itemName": "Crispy Fries", "quantity": 1, "unitPrice": 5.50,  "totalPrice": 5.50 }
//       ]
//     }
//   ]
//
// Or a top-level object wrapper:
//   { "orders": [ ...same as above... ] }
//
//   • Each order requires `id`, `postedAt`, `lineItems` (non-empty).
//   • `totalAmount`, `paymentType`, `status` are optional.
//   • `paymentType` defaults to 'other' when missing / unknown.
//   • `status` defaults to 'completed' when missing / unknown.
//   • `totalAmount` is summed from line items when missing / zero.
//   • Each line item requires at least one of `itemId` / `itemName`,
//     plus `quantity`, `unitPrice`, `totalPrice`.
//
// --------------------------------------------------------------
// Failure philosophy
// --------------------------------------------------------------
//   • Unparseable JSON              → throw with the JSON error.
//   • Wrong top-level shape         → throw with a clear message.
//   • Missing required fields       → collect row-level errors,
//                                      throw a single summary.
//   • Enum-like fields (paymentType,
//     status) outside the allowed set → coerced to defaults.
//
// Result: no partial writes. If any row is malformed, the whole
// batch aborts before the ingest pipeline runs.
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
// Shared helpers
// ================================================================

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asBool(v: unknown, fallback = true): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true
    if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false
  }
  return fallback
}

function asIso(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}

function summarize(kind: 'menu' | 'orders', errors: string[]): string {
  const MAX = 5
  const head = errors.slice(0, MAX).join(' | ')
  const extra = errors.length > MAX ? ` (+${errors.length - MAX} more)` : ''
  return `Custom JSON ${kind} import failed with ${errors.length} error${errors.length === 1 ? '' : 's'}: ${head}${extra}`
}

function safeParse(input: string): unknown {
  const trimmed = (input ?? '').replace(/^\uFEFF/, '').trim()
  if (!trimmed) throw new Error('JSON input is empty.')
  try {
    return JSON.parse(trimmed)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid JSON'
    throw new Error(`Input is not valid JSON: ${msg}`)
  }
}

/**
 * Push validation outcomes into the optional meta bucket so the
 * calling action can surface them. Shared cap keeps response
 * payloads small even for messy files.
 */
const MAX_META_NOTES = 5

function applyMetaFromParse(
  meta: SyncMeta | undefined,
  rawCount: number,
  errors: string[]
) {
  if (!meta) return
  meta.recordsFetched = (meta.recordsFetched ?? 0) + rawCount
  meta.recordsSkipped = (meta.recordsSkipped ?? 0) + errors.length
  if (errors.length === 0) return
  if (!Array.isArray(meta.notes)) meta.notes = []
  meta.notes.push(...errors.slice(0, MAX_META_NOTES))
  if (errors.length > MAX_META_NOTES) {
    meta.notes.push(`(+${errors.length - MAX_META_NOTES} more validation issue${errors.length - MAX_META_NOTES === 1 ? '' : 's'})`)
  }
}

// ================================================================
// Menu JSON → NormalizedMenu
// ================================================================

function parseMenuJson(input: string, meta?: SyncMeta): NormalizedMenu {
  const parsed = safeParse(input)

  // Top-level shape checks are fatal: without them we have nothing
  // to iterate. Per-node validation below uses the preserve-good-
  // drop-bad pattern so one bad item doesn't kill the import.
  if (!isObject(parsed)) {
    throw new Error('Menu JSON must be an object with an "items" array.')
  }

  const itemsRaw = parsed.items
  if (!Array.isArray(itemsRaw)) {
    throw new Error('Menu JSON is missing required field: "items" (array).')
  }

  const errors: string[] = []
  let rawCount = 0

  // ---- Categories (optional) ----
  const categories: NormalizedCategory[] = []
  const categoriesRaw = parsed.categories
  if (categoriesRaw !== undefined) {
    if (!Array.isArray(categoriesRaw)) {
      throw new Error('"categories" must be an array when provided.')
    }
    categoriesRaw.forEach((raw, idx) => {
      rawCount++
      const human = `categories[${idx}]`
      if (!isObject(raw)) { errors.push(`${human}: must be an object.`); return }

      const id = asString(raw.id) ?? asString(raw.externalId)
      const name = asString(raw.name)
      if (!id)   { errors.push(`${human}: "id" is required.`);   return }
      if (!name) { errors.push(`${human}: "name" is required.`); return }

      const sortOrderNum = raw.sortOrder !== undefined ? asNumber(raw.sortOrder) : null
      categories.push({
        externalId: id,
        name,
        ...(sortOrderNum !== null ? { sortOrder: sortOrderNum } : {}),
      })
    })
  }

  // ---- Items (required) ----
  const items: NormalizedMenuItem[] = []
  itemsRaw.forEach((raw, idx) => {
    rawCount++
    const human = `items[${idx}]`
    if (!isObject(raw)) { errors.push(`${human}: must be an object.`); return }

    const id = asString(raw.id) ?? asString(raw.externalId)
    const name = asString(raw.name)
    const price = asNumber(raw.price)
    if (!id)   { errors.push(`${human}: "id" is required.`);   return }
    if (!name) { errors.push(`${human}: "name" is required.`); return }
    if (price === null || price < 0) {
      errors.push(`${human}: "price" must be a non-negative number.`); return
    }

    const categoryId = asString(raw.categoryId) ?? asString(raw.externalCategoryId)
    const active = raw.active === undefined ? true : asBool(raw.active, true)

    items.push({
      externalId: id,
      name,
      price,
      categoryExternalId: categoryId,
      active,
    })
  })

  applyMetaFromParse(meta, rawCount, errors)

  // Fatal only when every node was bad. An empty payload (zero
  // items, zero errors) is handled upstream by the calling action.
  if (items.length === 0 && categories.length === 0 && errors.length > 0) {
    throw new Error(summarize('menu', errors))
  }

  return { categories, items }
}

// ================================================================
// Orders JSON → NormalizedOrder[]
// ================================================================

function parseOrdersJson(input: string, meta?: SyncMeta): NormalizedOrder[] {
  const parsed = safeParse(input)

  // Accept either a bare array or { "orders": [...] }. Fatal if
  // neither — the adapter has nothing to iterate.
  let ordersRaw: unknown
  if (Array.isArray(parsed)) {
    ordersRaw = parsed
  } else if (isObject(parsed) && Array.isArray(parsed.orders)) {
    ordersRaw = parsed.orders
  } else {
    throw new Error('Orders JSON must be an array, or an object with an "orders" array.')
  }

  const orders = ordersRaw as unknown[]
  const errors: string[] = []
  const normalized: NormalizedOrder[] = []
  let rawCount = 0

  orders.forEach((raw, idx) => {
    rawCount++
    const human = `orders[${idx}]`
    if (!isObject(raw)) { errors.push(`${human}: must be an object.`); return }

    const id = asString(raw.id) ?? asString(raw.externalId)
    if (!id) { errors.push(`${human}: "id" is required.`); return }

    const postedAt = asIso(raw.postedAt)
    if (!postedAt) {
      errors.push(`${human}: "postedAt" must be a valid ISO timestamp.`); return
    }

    const lineItemsRaw = raw.lineItems
    if (!Array.isArray(lineItemsRaw) || lineItemsRaw.length === 0) {
      errors.push(`${human}: "lineItems" must be a non-empty array.`); return
    }

    // Per-line validation: bad lines are dropped from this order
    // but the order still imports if at least one good line remains.
    // An order with zero good lines is dropped at the end.
    const lineItems: NormalizedOrderLineItem[] = []
    lineItemsRaw.forEach((liRaw, liIdx) => {
      const liHuman = `${human}.lineItems[${liIdx}]`
      if (!isObject(liRaw)) { errors.push(`${liHuman}: must be an object.`); return }

      const itemId = asString(liRaw.itemId) ?? asString(liRaw.externalItemId)
      const itemName = asString(liRaw.itemName)
      if (!itemId && !itemName) {
        errors.push(`${liHuman}: either "itemId" or "itemName" is required.`); return
      }

      const quantity = asNumber(liRaw.quantity)
      const unitPrice = asNumber(liRaw.unitPrice)
      const totalPrice = asNumber(liRaw.totalPrice)

      if (quantity === null || quantity < 1) {
        errors.push(`${liHuman}: "quantity" must be a number >= 1.`); return
      }
      if (unitPrice === null || unitPrice < 0) {
        errors.push(`${liHuman}: "unitPrice" must be a non-negative number.`); return
      }
      if (totalPrice === null || totalPrice < 0) {
        errors.push(`${liHuman}: "totalPrice" must be a non-negative number.`); return
      }

      // Fall back to slug(name) when only a name was provided.
      // Uses the shared util so CSV and JSON produce the same key.
      const resolvedExternalItemId = itemId || slug(itemName ?? '')
      if (!resolvedExternalItemId) {
        errors.push(`${liHuman}: could not derive an external item id.`); return
      }

      lineItems.push({
        externalItemId: resolvedExternalItemId,
        itemName: itemName || resolvedExternalItemId,
        quantity: Math.round(quantity),
        unitPrice,
        totalPrice,
      })
    })

    if (lineItems.length === 0) {
      // Every line was invalid — record an order-level skip so the
      // user sees it, don't silently drop the whole order.
      errors.push(`${human}: all line items failed validation — order skipped.`)
      return
    }

    // Enum-ish fields — coerced to defaults so harmless typos don't
    // waste a record. Semantics match CSV / Clover.
    const paymentRaw = asString(raw.paymentType)?.toLowerCase() ?? ''
    const paymentType: NormalizedOrder['paymentType'] =
      paymentRaw === 'cash' || paymentRaw === 'card' || paymentRaw === 'other'
        ? paymentRaw
        : 'other'

    const statusRaw = asString(raw.status)?.toLowerCase() ?? ''
    const status: NormalizedOrder['status'] =
      statusRaw === 'completed' || statusRaw === 'voided' ? statusRaw : 'completed'

    // Total: prefer explicit, otherwise sum line items
    const explicitTotal = raw.totalAmount !== undefined ? asNumber(raw.totalAmount) : null
    const totalAmount =
      explicitTotal !== null && explicitTotal > 0
        ? explicitTotal
        : lineItems.reduce((s, li) => s + li.totalPrice, 0)

    normalized.push({
      externalId: id,
      postedAt,
      totalAmount,
      status,
      paymentType,
      lineItems,
    })
  })

  applyMetaFromParse(meta, rawCount, errors)

  // Fatal only when every order was bad.
  if (normalized.length === 0 && errors.length > 0) {
    throw new Error(summarize('orders', errors))
  }
  return normalized
}

// ================================================================
// SourceAdapter export
// ================================================================

const NOT_AVAILABLE = 'Custom JSON adapter needs raw input. Pass `ctx.input`.'

export const customJsonSourceAdapter: SourceAdapter = {
  id: 'custom_json',
  kind: 'custom',
  label: 'Custom JSON',

  async listMenu(ctx: AdapterContext): Promise<NormalizedMenu> {
    if (ctx.input == null || ctx.input.length === 0) throw new Error(NOT_AVAILABLE)
    return parseMenuJson(ctx.input, ctx.meta)
  },

  async listOrders(ctx: AdapterContext): Promise<NormalizedOrder[]> {
    if (ctx.input == null || ctx.input.length === 0) throw new Error(NOT_AVAILABLE)
    return parseOrdersJson(ctx.input, ctx.meta)
  },
}
