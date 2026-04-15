// ----------------------------------------------------------------
// CSV Source Adapter — Pilot V1
//
// Parses raw CSV text into the canonical normalized shapes in
// `../types.ts`. Does NOT write anything — all DB writes go through
// the shared ingest pipeline (`../ingest.ts`) just like every other
// adapter.
//
// Supports two CSV shapes:
//
//   1. Menu CSV
//      Required columns: item_name, price
//      Optional columns: category_name, active,
//                        external_id, external_category_id
//
//      When external_id / external_category_id are omitted, stable
//      slug-based ids are derived from the names so re-imports
//      dedupe cleanly through the existing ingest pipeline.
//
//      Example:
//        category_name,item_name,price,active
//        Appetizers,Crispy Fries,5.50,true
//        Appetizers,Buffalo Wings,9.00,true
//        Mains,House Burger,14.00,
//        ,Daily Special,18.00,true
//
//   2. Orders CSV
//      One row per line item. Rows sharing the same `order_id` are
//      grouped into a single normalized order.
//
//      Required columns: order_id, posted_at, quantity, unit_price, total_price
//                        and (item_id OR item_name)
//      Optional columns: total_amount, payment_type, status, item_name
//
//      Order-level fields (posted_at, total_amount, payment_type,
//      status) are taken from the first row seen for each order_id.
//      Additional rows append line items.
//
//      Example:
//        order_id,posted_at,total_amount,payment_type,status,item_id,item_name,quantity,unit_price,total_price
//        ord_0001,2026-04-12T13:00:00Z,19.50,card,completed,itm_burger,House Burger,1,14.00,14.00
//        ord_0001,2026-04-12T13:00:00Z,19.50,card,completed,itm_fries,Crispy Fries,1,5.50,5.50
//        ord_0002,2026-04-12T14:00:00Z,12.50,cash,completed,itm_wings,Buffalo Wings,1,9.00,9.00
//        ord_0002,2026-04-12T14:00:00Z,12.50,cash,completed,itm_cola,Cola,1,3.50,3.50
//
// Failure philosophy:
//   • Missing required columns or empty input → throw. No partial writes.
//   • Malformed numeric / timestamp → collect row-level errors,
//     then throw a single summary error listing the first several.
//   • Payment type / status outside the allowed enums → coerced to
//     defaults ('other' / 'completed'). Rare in practice; logged.
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
// Tiny RFC4180-ish CSV parser
// ================================================================

function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let current: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < input.length) {
    const ch = input[i]

    if (inQuotes) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i += 2; continue }
      if (ch === '"') { inQuotes = false; i++; continue }
      field += ch
      i++
      continue
    }

    if (ch === '"' && field.length === 0) { inQuotes = true; i++; continue }
    if (ch === ',') { current.push(field); field = ''; i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') {
      current.push(field)
      if (current.some((c) => c.length > 0) || current.length > 1) rows.push(current)
      current = []
      field = ''
      i++
      continue
    }

    field += ch
    i++
  }

  // Flush trailing row
  if (field.length > 0 || current.length > 0) {
    current.push(field)
    if (current.some((c) => c.length > 0) || current.length > 1) rows.push(current)
  }

  return rows
}

// ================================================================
// Utilities
// ================================================================

function parseBool(raw: string | undefined, fallback = true): boolean {
  const s = (raw ?? '').trim().toLowerCase()
  if (s === '' ) return fallback
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false
  return fallback
}

function parseNumber(raw: string | undefined): number | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const n = Number(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

function parseIso(raw: string | undefined): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const t = Date.parse(s)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}

/**
 * Builds a lowercased header → index map from the first row of CSV
 * data. Throws on missing required headers so the adapter can bail
 * before touching any row data.
 */
function headerIndex(rows: string[][], required: string[]): Record<string, number> {
  if (rows.length === 0) {
    throw new Error('CSV input is empty.')
  }
  const header = rows[0].map((c) => c.trim().toLowerCase())
  const index: Record<string, number> = {}
  header.forEach((col, i) => { if (col) index[col] = i })

  const missing = required.filter((r) => !(r in index))
  if (missing.length > 0) {
    throw new Error(
      `Missing required CSV column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. ` +
      `Found: ${header.filter(Boolean).join(', ') || '(none)'}`
    )
  }
  return index
}

function cell(row: string[], idx: number | undefined): string | undefined {
  if (idx === undefined) return undefined
  return row[idx]
}

/**
 * Push validation outcomes into the optional meta bucket so the
 * calling action can surface them in its result message. Caps the
 * per-adapter note list so huge bad files don't produce huge
 * response payloads.
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
// Menu CSV → NormalizedMenu
// ================================================================

function parseMenuCsv(input: string, meta?: SyncMeta): NormalizedMenu {
  const raw = (input ?? '').replace(/^\uFEFF/, '') // strip BOM
  if (!raw.trim()) throw new Error('CSV input is empty.')

  const rows = parseCsv(raw)
  // Header validation is fatal — without it we can't read any row
  // safely, so "preserve what we can" doesn't apply.
  const idx = headerIndex(rows, ['item_name', 'price'])

  const categoriesByExternalId = new Map<string, NormalizedCategory>()
  const items: NormalizedMenuItem[] = []
  const errors: string[] = []
  let rawCount = 0

  // data rows start at index 1 (skip header)
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    // Skip fully-blank lines entirely — don't count them as rows.
    if (row.every((c) => (c ?? '').trim() === '')) continue
    rawCount++
    const humanRow = r + 1 // 1-based for user-facing messages

    const itemName = (cell(row, idx.item_name) ?? '').trim()
    const priceRaw = cell(row, idx.price)
    const price = parseNumber(priceRaw)

    // Per-row validation: a bad row is skipped and reported, NOT
    // fatal. The shared ingest pipeline still receives the valid
    // rows. This matches the Pilot V1 principle: "preserve good
    // data, reject bad data safely, make the distinction visible."
    if (!itemName) { errors.push(`Row ${humanRow}: item_name is required.`); continue }
    if (price === null || price < 0) {
      errors.push(`Row ${humanRow}: price "${priceRaw ?? ''}" is not a valid number.`)
      continue
    }

    const categoryName = (cell(row, idx.category_name) ?? '').trim()
    const explicitCategoryId = (cell(row, idx.external_category_id) ?? '').trim()
    const explicitItemId = (cell(row, idx.external_id) ?? '').trim()
    const activeRaw = cell(row, idx.active)
    const active = parseBool(activeRaw, true)

    // Category resolution
    let categoryExternalId: string | null = null
    if (explicitCategoryId) {
      categoryExternalId = explicitCategoryId
    } else if (categoryName) {
      categoryExternalId = slug(categoryName) || null
    }

    if (categoryExternalId && categoryName && !categoriesByExternalId.has(categoryExternalId)) {
      categoriesByExternalId.set(categoryExternalId, {
        externalId: categoryExternalId,
        name: categoryName,
      })
    }

    const itemExternalId = explicitItemId || slug(itemName)
    if (!itemExternalId) {
      errors.push(`Row ${humanRow}: could not derive external id for item "${itemName}".`)
      continue
    }

    items.push({
      externalId: itemExternalId,
      name: itemName,
      price,
      categoryExternalId,
      active,
    })
  }

  applyMetaFromParse(meta, rawCount, errors)

  // Fatal only when the file had rows but NONE of them were valid.
  // (All-skipped is indistinguishable from a broken file and the
  // user deserves a clear error rather than an empty success.)
  if (items.length === 0 && errors.length > 0) {
    throw new Error(summarize('menu', errors))
  }

  return {
    categories: Array.from(categoriesByExternalId.values()),
    items,
  }
}

// ================================================================
// Orders CSV → NormalizedOrder[]
// ================================================================

function parseOrdersCsv(input: string, meta?: SyncMeta): NormalizedOrder[] {
  const raw = (input ?? '').replace(/^\uFEFF/, '')
  if (!raw.trim()) throw new Error('CSV input is empty.')

  const rows = parseCsv(raw)
  // Header + item column checks are fatal — can't map rows without them.
  const idx = headerIndex(rows, ['order_id', 'posted_at', 'quantity', 'unit_price', 'total_price'])

  if (idx.item_id === undefined && idx.item_name === undefined) {
    throw new Error('Orders CSV must include either an "item_id" or "item_name" column.')
  }

  const orderMap = new Map<string, NormalizedOrder>()
  const errors: string[] = []
  let rawCount = 0

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.every((c) => (c ?? '').trim() === '')) continue
    rawCount++
    const humanRow = r + 1

    const orderId = (cell(row, idx.order_id) ?? '').trim()
    if (!orderId) { errors.push(`Row ${humanRow}: order_id is required.`); continue }

    const postedAtRaw = cell(row, idx.posted_at)
    const postedAt = parseIso(postedAtRaw)
    if (!postedAt) {
      errors.push(`Row ${humanRow}: posted_at "${postedAtRaw ?? ''}" is not a valid ISO timestamp.`)
      continue
    }

    const quantityRaw = cell(row, idx.quantity)
    const quantity = parseNumber(quantityRaw)
    if (quantity === null || quantity < 1) {
      errors.push(`Row ${humanRow}: quantity "${quantityRaw ?? ''}" must be a number >= 1.`)
      continue
    }

    const unitPriceRaw = cell(row, idx.unit_price)
    const unitPrice = parseNumber(unitPriceRaw)
    if (unitPrice === null || unitPrice < 0) {
      errors.push(`Row ${humanRow}: unit_price "${unitPriceRaw ?? ''}" is not a valid number.`)
      continue
    }

    const totalPriceRaw = cell(row, idx.total_price)
    const totalPrice = parseNumber(totalPriceRaw)
    if (totalPrice === null || totalPrice < 0) {
      errors.push(`Row ${humanRow}: total_price "${totalPriceRaw ?? ''}" is not a valid number.`)
      continue
    }

    // Item identity
    const explicitItemId = (cell(row, idx.item_id) ?? '').trim()
    const itemName = (cell(row, idx.item_name) ?? '').trim()
    const externalItemId = explicitItemId || slug(itemName)
    if (!externalItemId) {
      errors.push(`Row ${humanRow}: either item_id or item_name is required.`)
      continue
    }

    const line: NormalizedOrderLineItem = {
      externalItemId,
      itemName: itemName || externalItemId,
      quantity: Math.round(quantity),
      unitPrice,
      totalPrice,
    }

    // Order-level fields — first-seen row wins
    let order = orderMap.get(orderId)
    if (!order) {
      const totalAmountRaw = cell(row, idx.total_amount)
      const explicitTotal = totalAmountRaw !== undefined ? parseNumber(totalAmountRaw) : null

      const paymentRaw = (cell(row, idx.payment_type) ?? '').trim().toLowerCase()
      const paymentType: NormalizedOrder['paymentType'] =
        paymentRaw === 'cash' || paymentRaw === 'card' || paymentRaw === 'other'
          ? paymentRaw
          : 'other'

      const statusRaw = (cell(row, idx.status) ?? '').trim().toLowerCase()
      const status: NormalizedOrder['status'] =
        statusRaw === 'completed' || statusRaw === 'voided' ? statusRaw : 'completed'

      order = {
        externalId: orderId,
        postedAt,
        totalAmount: explicitTotal ?? 0, // provisional; finalized below
        status,
        paymentType,
        lineItems: [],
      }
      orderMap.set(orderId, order)
    }
    order.lineItems.push(line)
  }

  // Finalize totals — if the CSV didn't provide a total_amount on the
  // first-seen row of an order, sum the line items. Orders that ended
  // up with zero valid line items are dropped here (every row for
  // that order was skipped during validation).
  const orders: NormalizedOrder[] = []
  for (const order of orderMap.values()) {
    if (order.lineItems.length === 0) continue
    if (!order.totalAmount || order.totalAmount <= 0) {
      order.totalAmount = order.lineItems.reduce((s, li) => s + li.totalPrice, 0)
    }
    orders.push(order)
  }

  applyMetaFromParse(meta, rawCount, errors)

  // Fatal only when every row was bad.
  if (orders.length === 0 && errors.length > 0) {
    throw new Error(summarize('orders', errors))
  }

  return orders
}

// ================================================================
// Error summarization — keeps error messages readable.
// ================================================================

function summarize(kind: 'menu' | 'orders', errors: string[]): string {
  const MAX = 5
  const head = errors.slice(0, MAX).join(' | ')
  const extra = errors.length > MAX ? ` (+${errors.length - MAX} more)` : ''
  return `CSV ${kind} import failed with ${errors.length} error${errors.length === 1 ? '' : 's'}: ${head}${extra}`
}

// ================================================================
// SourceAdapter export
//
// The adapter uses `ctx.input` for the raw CSV payload. Callers
// decide which payload goes to `listMenu` vs `listOrders` based on
// what the dev selected in the UI — there's no single "is this
// menu or orders CSV?" auto-detection, and we don't want one.
// ================================================================

const NOT_AVAILABLE = 'CSV adapter needs raw input. Call ingest directly or pass `ctx.input`.'

export const csvSourceAdapter: SourceAdapter = {
  id: 'csv',
  kind: 'file',
  label: 'CSV upload',

  async listMenu(ctx: AdapterContext): Promise<NormalizedMenu> {
    if (ctx.input == null || ctx.input.length === 0) throw new Error(NOT_AVAILABLE)
    return parseMenuCsv(ctx.input, ctx.meta)
  },

  async listOrders(ctx: AdapterContext): Promise<NormalizedOrder[]> {
    if (ctx.input == null || ctx.input.length === 0) throw new Error(NOT_AVAILABLE)
    return parseOrdersCsv(ctx.input, ctx.meta)
  },
}
