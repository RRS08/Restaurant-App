// ----------------------------------------------------------------
// GoDaddy CSV Source Adapter — manual export intake
//
// A file adapter (kind 'file') that parses a CSV exported from the
// GoDaddy Commerce dashboard — either the in-store POS (Poynt) sales
// export or the online storefront orders export — into the canonical
// `NormalizedOrder[]` shape. Same output as the GoDaddy *API* adapters
// (`adapters/godaddy.ts`), just fed from an uploaded file instead of
// the API, so sales can be ingested TODAY while the developer account
// is still pending.
//
// This adapter is channel-agnostic: it infers payment type + status
// from the data, so the same parser handles both the POS and the
// online export. The calling action decides which provider tag the
// rows land under (godaddy_pos vs godaddy_online) so a CSV backfill
// and the eventual API sync form one unified GoDaddy sales stream and
// dedupe against each other by (provider, order id).
//
// ----------------------------------------------------------------
// RESILIENCE: real exports are messy, so parsing is deliberately
// forgiving and column detection is alias-driven (case- and
// punctuation-insensitive headers). Two export shapes are supported:
//
//   1. Line-item level — one row per item sold, rows grouped by order
//      id. (Common for the online storefront export.)
//   2. Order / transaction level — one row per sale, no per-item
//      breakdown. Each becomes one order with a single synthetic
//      "GoDaddy sale" line so revenue is captured even without item
//      detail. (Common for the POS/Poynt transactions export.)
//
// Handled: $/€ + thousands separators, parenthesised & trailing-minus
// negatives (refunds), multiple date formats (ISO, US M/D/Y, split
// date + time columns), refund/void/cancel statuses, and tax / tip /
// discount columns (netted out of the synthetic line revenue).
//
// PROVISIONAL: the column NAMES below are best-effort guesses at
// GoDaddy's export headers — grep this file for "PROVISIONAL". Once a
// real export is in hand, confirm the alias lists cover its headers
// (adding one is a one-line change). Unknown columns are ignored, and
// a row missing a required field is skipped-and-reported, never fatal
// unless EVERY row fails.
// ----------------------------------------------------------------

import type { SourceAdapter, AdapterContext, SyncMeta } from '../adapter'
import type {
  NormalizedMenu,
  NormalizedCategory,
  NormalizedMenuItem,
  NormalizedOrder,
} from '../types'
import { slug } from '../util'

// ================================================================
// CSV tokenizer (RFC4180-ish) — self-contained, mirrors csv.ts so
// this adapter stays standalone like the other branded adapters.
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
      field += ch; i++; continue
    }
    if (ch === '"' && field.length === 0) { inQuotes = true; i++; continue }
    if (ch === ',') { current.push(field); field = ''; i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') {
      current.push(field)
      if (current.some((c) => c.length > 0) || current.length > 1) rows.push(current)
      current = []; field = ''; i++; continue
    }
    field += ch; i++
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field)
    if (current.some((c) => c.length > 0) || current.length > 1) rows.push(current)
  }
  return rows
}

// ================================================================
// Column resolution via header aliases
//
// Headers are normalized to lowercase alphanumerics ("Order ID",
// "order_id", "Order #" all → "orderid"/"order") before matching, so
// small header variations between exports don't break detection.
// ================================================================

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// PROVISIONAL alias lists — confirm against a real GoDaddy export.
const ALIASES = {
  orderId: ['orderid', 'order', 'ordernumber', 'orderno', 'ordernum', 'transactionid', 'transactionno', 'txnid', 'transaction', 'receiptnumber', 'receiptno', 'receipt', 'referenceid', 'reference', 'invoicenumber', 'invoiceno', 'invoice', 'poyntid'],
  date: ['date', 'orderdate', 'transactiondate', 'datetime', 'createdat', 'created', 'timestamp', 'closedat', 'closed', 'paidat', 'paid', 'purchasedate', 'saledate', 'completedat', 'completed'],
  time: ['time', 'ordertime', 'transactiontime'],
  itemName: ['item', 'itemname', 'product', 'productname', 'name', 'description', 'lineitem', 'lineitemname', 'menuitem', 'title'],
  itemId: ['sku', 'itemid', 'productid', 'variantid', 'itemsku', 'productsku', 'plu', 'barcode'],
  qty: ['qty', 'quantity', 'units', 'unitssold', 'count', 'qtysold'],
  unitPrice: ['unitprice', 'price', 'itemprice', 'priceeach', 'unitcost', 'rate', 'unitamount'],
  lineTotal: ['linetotal', 'lineamount', 'itemtotal', 'extendedprice', 'lineitemtotal', 'extendedamount', 'linesubtotal'],
  orderTotal: ['ordertotal', 'totalamount', 'grandtotal', 'amountpaid', 'amountcollected', 'totalcollected', 'netsales', 'nettotal', 'totalpaid', 'paymentamount', 'totalsale', 'saletotal', 'total'],
  tax: ['tax', 'taxamount', 'salestax', 'taxtotal', 'taxes'],
  discount: ['discount', 'discountamount', 'discounts', 'discounttotal'],
  tip: ['tip', 'tipamount', 'gratuity', 'gratuityamount'],
  payment: ['paymenttype', 'paymentmethod', 'tender', 'tendertype', 'cardtype', 'method', 'payment', 'paymentbrand', 'cardbrand', 'fundingsource'],
  status: ['status', 'orderstatus', 'paymentstatus', 'state', 'transactiontype', 'type', 'transactionstatus'],
} as const

type ColKey = keyof typeof ALIASES

function resolveColumns(header: string[]): Record<ColKey, number | undefined> {
  // normalized header → first index it appears at
  const byNorm = new Map<string, number>()
  header.forEach((h, i) => {
    const n = normalizeHeader(h)
    if (n && !byNorm.has(n)) byNorm.set(n, i)
  })

  const out = {} as Record<ColKey, number | undefined>
  for (const key of Object.keys(ALIASES) as ColKey[]) {
    out[key] = undefined
    for (const alias of ALIASES[key]) {
      const idx = byNorm.get(alias)
      if (idx !== undefined) { out[key] = idx; break }
    }
  }
  return out
}

function cell(row: string[], idx: number | undefined): string {
  if (idx === undefined) return ''
  return (row[idx] ?? '').trim()
}

// ================================================================
// Forgiving value parsers
// ================================================================

/**
 * Parse a currency/number cell. Handles `$`, currency codes/letters,
 * thousands separators, whitespace, parenthesised negatives `(1.50)`,
 * and trailing/leading minus. Assumes a `.` decimal separator (US
 * export convention — PROVISIONAL). Returns null when not numeric.
 */
function parseMoney(raw: string): number | null {
  let s = (raw ?? '').trim()
  if (!s) return null

  let negative = false
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1) }
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1) }
  if (s.startsWith('-')) { negative = true; s = s.slice(1) }

  // Strip everything that isn't a digit or decimal point (removes
  // $, £, €, letters like "USD", commas, spaces).
  s = s.replace(/[^0-9.]/g, '')
  if (s === '' || s === '.') return null

  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

function parseQuantity(raw: string): number {
  const n = parseMoney(raw)
  if (n === null || n < 1) return 1
  return Math.round(n)
}

/**
 * Parse a timestamp from a date cell plus an optional separate time
 * cell. Relies on the engine's Date parser, which covers ISO-8601,
 * US `M/D/YYYY [h:mm AM/PM]`, and `Mon D, YYYY`. Ambiguous
 * `D/M/YYYY` inputs are read as US `M/D` (PROVISIONAL).
 */
function parseTimestamp(dateRaw: string, timeRaw: string): string | null {
  const d = (dateRaw ?? '').trim()
  if (!d) return null
  const combined = timeRaw && timeRaw.trim() ? `${d} ${timeRaw.trim()}` : d
  let t = Date.parse(combined)
  if (Number.isNaN(t)) t = Date.parse(d)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}

type SaleState = 'completed' | 'voided' | 'skip'

/** Map a free-text status/type cell to a canonical sale state. */
function mapStatus(raw: string): SaleState {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return 'completed' // completed-sales exports often omit status
  if (/refund|return|void|charge\s?back|reversed|credited|credit\b/.test(s)) return 'voided'
  if (/cancel/.test(s)) return 'voided'
  if (/decline|failed|fail|error|denied/.test(s)) return 'skip'
  if (/open|pending|draft|unpaid|authoriz|in\s?progress|incomplete|abandon|hold/.test(s)) return 'skip'
  return 'completed'
}

function mapPayment(raw: string): NormalizedOrder['paymentType'] {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return 'other'
  if (/cash/.test(s)) return 'cash'
  if (/card|credit|debit|visa|master|amex|american\s?express|discover|chip|tap|swipe|contactless|emv/.test(s)) return 'card'
  return 'other' // gift, check, ebt, wallet, paypal, etc.
}

// ================================================================
// Meta helper (matches csv.ts behavior)
// ================================================================

const MAX_META_NOTES = 5

function applyMeta(meta: SyncMeta | undefined, rawCount: number, errors: string[]) {
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

/**
 * Human-readable "which header did each logical column bind to?" map.
 * Surfaced when a file yields no usable rows so the operator can see
 * exactly what was and wasn't recognized instead of a bare "no orders"
 * — the PROVISIONAL alias lists make this the most likely failure.
 */
function describeMapping(header: string[], col: Record<ColKey, number | undefined>): string {
  const interesting: ColKey[] = [
    'orderId', 'date', 'time', 'itemName', 'itemId',
    'qty', 'unitPrice', 'lineTotal', 'orderTotal', 'status', 'payment',
  ]
  return interesting
    .map((k) => {
      const idx = col[k]
      const bound = idx === undefined ? '(not found)' : `"${(header[idx] ?? '').trim()}"`
      return `${k}=${bound}`
    })
    .join(', ')
}

function summarize(errors: string[]): string {
  const MAX = 5
  const head = errors.slice(0, MAX).join(' | ')
  const extra = errors.length > MAX ? ` (+${errors.length - MAX} more)` : ''
  return `GoDaddy CSV import failed with ${errors.length} error${errors.length === 1 ? '' : 's'}: ${head}${extra}`
}

// ================================================================
// Orders CSV → NormalizedOrder[]
// ================================================================

// Stable placeholder item id used for order-level exports that carry
// no per-item breakdown. All such rows fold into one "GoDaddy sale"
// placeholder menu item per provider, so revenue lands without
// inventing fake catalog items.
const SYNTHETIC_ITEM_ID = 'godaddy-sale'

interface WorkingOrder {
  order: NormalizedOrder
  /** Gross total from an explicit order-total column, when present. */
  grossTotal: number | null
  /** True once a synthetic line was added (order-level shape). */
  synthesized: boolean
}

function parseOrdersCsv(input: string, meta?: SyncMeta): NormalizedOrder[] {
  const raw = (input ?? '').replace(/^\uFEFF/, '') // strip BOM
  if (!raw.trim()) throw new Error('CSV input is empty.')

  const rows = parseCsv(raw)
  if (rows.length === 0) throw new Error('CSV input is empty.')

  const header = rows[0]
  const col = resolveColumns(header)

  // Order id + date are the two fields we cannot map a sale without.
  const foundHeaders = header.map((h) => h.trim()).filter(Boolean).join(', ') || '(none)'
  if (col.orderId === undefined) {
    throw new Error(`Could not find an order/transaction id column. Looked for e.g. "Order ID", "Transaction ID". Found: ${foundHeaders}`)
  }
  if (col.date === undefined) {
    throw new Error(`Could not find a date column. Looked for e.g. "Date", "Order Date". Found: ${foundHeaders}`)
  }

  // Line-item shape when the file carries per-item columns; otherwise
  // treat each row as a whole sale (order/transaction level).
  const lineItemMode =
    (col.itemName !== undefined || col.itemId !== undefined) &&
    (col.qty !== undefined || col.unitPrice !== undefined || col.lineTotal !== undefined)

  const orders = new Map<string, WorkingOrder>()
  const errors: string[] = []
  let rawCount = 0

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.every((c) => (c ?? '').trim() === '')) continue // blank line
    rawCount++
    const humanRow = r + 1

    const orderId = cell(row, col.orderId)
    if (!orderId) { errors.push(`Row ${humanRow}: order id is empty.`); continue }

    const postedAt = parseTimestamp(cell(row, col.date), cell(row, col.time))
    if (!postedAt) {
      errors.push(`Row ${humanRow}: could not parse date "${cell(row, col.date)}".`)
      continue
    }

    // Order-level fields — first row seen for an order id wins.
    let wo = orders.get(orderId)
    if (!wo) {
      const grossTotal = col.orderTotal !== undefined ? parseMoney(cell(row, col.orderTotal)) : null
      let state = mapStatus(cell(row, col.status))
      // A negative gross total is a refund/return even if the status
      // column didn't say so.
      if (grossTotal !== null && grossTotal < 0 && state === 'completed') state = 'voided'

      if (state === 'skip') {
        // Not a real sale (declined / open / pending). Record a
        // placeholder so later rows of the same order are also
        // skipped without being counted as errors.
        orders.set(orderId, { order: null as unknown as NormalizedOrder, grossTotal, synthesized: true })
        continue
      }

      wo = {
        order: {
          externalId: orderId,
          postedAt,
          totalAmount: 0, // finalized below
          status: state,
          paymentType: mapPayment(cell(row, col.payment)),
          lineItems: [],
        },
        grossTotal,
        synthesized: false,
      }
      orders.set(orderId, wo)
    }
    if (!wo.order) continue // skipped order (see above)

    if (lineItemMode) {
      const itemName = cell(row, col.itemName)
      const itemId = cell(row, col.itemId)
      const externalItemId = itemId || slug(itemName)
      if (!externalItemId) {
        errors.push(`Row ${humanRow}: line has no item id or name.`)
        continue
      }

      const quantity = parseQuantity(cell(row, col.qty))
      let unit = col.unitPrice !== undefined ? parseMoney(cell(row, col.unitPrice)) : null
      let lineTot = col.lineTotal !== undefined ? parseMoney(cell(row, col.lineTotal)) : null

      if (lineTot === null && unit !== null) lineTot = unit * quantity
      if (unit === null && lineTot !== null) unit = quantity > 0 ? lineTot / quantity : lineTot
      if (unit === null && lineTot === null) {
        errors.push(`Row ${humanRow}: no unit price or line total for "${itemName || externalItemId}".`)
        continue
      }

      // Refund/void lines can be negative; store magnitude and let the
      // order status carry the void signal (matches the API adapters,
      // which keep totals positive).
      wo.order.lineItems.push({
        externalItemId,
        itemName: itemName || externalItemId,
        quantity,
        unitPrice: Math.abs(unit as number),
        totalPrice: Math.abs(lineTot as number),
      })
    } else {
      // Order-level: one synthetic line per order carrying the sale's
      // item revenue (gross minus tax/tip when those columns exist, so
      // the line ≈ pre-tax while order.totalAmount stays gross).
      if (wo.synthesized) continue
      const gross = wo.grossTotal
      if (gross === null) {
        errors.push(`Row ${humanRow}: order ${orderId} has no total amount.`)
        orders.delete(orderId)
        continue
      }
      const tax = col.tax !== undefined ? (parseMoney(cell(row, col.tax)) ?? 0) : 0
      const tip = col.tip !== undefined ? (parseMoney(cell(row, col.tip)) ?? 0) : 0
      const revenue = Math.abs(gross) - Math.abs(tax) - Math.abs(tip)
      const lineRevenue = revenue > 0 ? revenue : Math.abs(gross)

      wo.order.lineItems.push({
        externalItemId: SYNTHETIC_ITEM_ID,
        itemName: 'GoDaddy sale',
        quantity: 1,
        unitPrice: lineRevenue,
        totalPrice: lineRevenue,
      })
      wo.synthesized = true
    }
  }

  // Finalize — drop orders with no usable lines; set totalAmount to the
  // explicit gross when present, else the sum of line revenue.
  const out: NormalizedOrder[] = []
  for (const wo of orders.values()) {
    if (!wo.order) continue
    if (wo.order.lineItems.length === 0) continue
    const lineSum = wo.order.lineItems.reduce((s, li) => s + li.totalPrice, 0)
    const gross = wo.grossTotal !== null ? Math.abs(wo.grossTotal) : 0
    wo.order.totalAmount = gross > 0 ? gross : lineSum
    out.push(wo.order)
  }

  applyMeta(meta, rawCount, errors)

  // Nothing usable came out. Never return an empty array silently —
  // that renders as "the button did nothing". Report what was seen,
  // what each column bound to, and the row-level reasons, so a header
  // mismatch against the PROVISIONAL alias lists is immediately
  // diagnosable from the UI message alone.
  if (out.length === 0) {
    const detail = errors.length > 0 ? ` ${summarize(errors)}` : ''
    throw new Error(
      `No sales rows were recognized. Read ${rawCount} data row${rawCount === 1 ? '' : 's'}. ` +
      `Column mapping: ${describeMapping(header, col)}. ` +
      `Headers found: ${foundHeaders}.${detail}`
    )
  }

  return out
}

// ================================================================
// Product-export CSV → NormalizedMenu  (secondary; PROVISIONAL)
//
// Supports importing a GoDaddy product/catalog export so the menu can
// be seeded from a file too. Sales import (above) is the primary path.
// ================================================================

const MENU_ALIASES = {
  name: ['name', 'productname', 'itemname', 'item', 'product', 'title', 'description'],
  price: ['price', 'unitprice', 'amount', 'cost', 'retailprice', 'saleprice'],
  id: ['sku', 'itemid', 'productid', 'id', 'variantid', 'plu'],
  category: ['category', 'categoryname', 'department', 'group', 'type', 'collection'],
  active: ['status', 'active', 'available', 'visible', 'published', 'enabled'],
} as const

function parseMenuCsv(input: string, meta?: SyncMeta): NormalizedMenu {
  const raw = (input ?? '').replace(/^\uFEFF/, '')
  if (!raw.trim()) throw new Error('CSV input is empty.')

  const rows = parseCsv(raw)
  if (rows.length === 0) throw new Error('CSV input is empty.')
  const header = rows[0]

  const byNorm = new Map<string, number>()
  header.forEach((h, i) => { const n = normalizeHeader(h); if (n && !byNorm.has(n)) byNorm.set(n, i) })
  const find = (aliases: readonly string[]) => {
    for (const a of aliases) { const i = byNorm.get(a); if (i !== undefined) return i }
    return undefined
  }
  const nameIdx = find(MENU_ALIASES.name)
  const priceIdx = find(MENU_ALIASES.price)
  const idIdx = find(MENU_ALIASES.id)
  const catIdx = find(MENU_ALIASES.category)
  const activeIdx = find(MENU_ALIASES.active)

  const foundHeaders = header.map((h) => h.trim()).filter(Boolean).join(', ') || '(none)'
  if (nameIdx === undefined || priceIdx === undefined) {
    throw new Error(`GoDaddy product CSV needs a name and a price column. Found: ${foundHeaders}`)
  }

  const categories = new Map<string, NormalizedCategory>()
  const items: NormalizedMenuItem[] = []
  const errors: string[] = []
  let rawCount = 0

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.every((c) => (c ?? '').trim() === '')) continue
    rawCount++
    const humanRow = r + 1

    const name = cell(row, nameIdx)
    if (!name) { errors.push(`Row ${humanRow}: name is required.`); continue }
    const price = parseMoney(cell(row, priceIdx))
    if (price === null || price < 0) {
      errors.push(`Row ${humanRow}: price "${cell(row, priceIdx)}" is not valid.`)
      continue
    }

    const externalId = cell(row, idIdx) || slug(name)
    if (!externalId) { errors.push(`Row ${humanRow}: could not derive id for "${name}".`); continue }

    const catName = cell(row, catIdx)
    let categoryExternalId: string | null = null
    if (catName) {
      categoryExternalId = slug(catName) || null
      if (categoryExternalId && !categories.has(categoryExternalId)) {
        categories.set(categoryExternalId, { externalId: categoryExternalId, name: catName })
      }
    }

    let active = true
    const activeRaw = cell(row, activeIdx).toLowerCase()
    if (activeRaw) {
      if (/inactive|disabled|hidden|unavailable|unpublish|archiv|draft|false|\bno\b|0/.test(activeRaw)) active = false
    }

    items.push({ externalId, name, price, categoryExternalId, active })
  }

  applyMeta(meta, rawCount, errors)

  // Same rule as the orders parser: never hand back an empty result
  // silently — that renders in the UI as "the button did nothing".
  // Report what was read and what each column bound to so a mismatch
  // against the PROVISIONAL alias lists is diagnosable from the error
  // message alone.
  if (items.length === 0) {
    const detail = errors.length > 0 ? ` ${summarize(errors)}` : ''
    const bound = (label: string, idx: number | undefined) =>
      `${label}=${idx === undefined ? '(not found)' : `"${(header[idx] ?? '').trim()}"`}`
    throw new Error(
      `No product rows were recognized. Read ${rawCount} data row${rawCount === 1 ? '' : 's'}. ` +
      `Column mapping: ${[
        bound('name', nameIdx), bound('price', priceIdx), bound('id', idIdx),
        bound('category', catIdx), bound('active', activeIdx),
      ].join(', ')}. Headers found: ${foundHeaders}.${detail}`
    )
  }

  return { categories: Array.from(categories.values()), items }
}

// ================================================================
// SourceAdapter export
// ================================================================

const NOT_AVAILABLE = 'GoDaddy CSV adapter needs raw input — pass `ctx.input`.'

export const godaddyCsvSourceAdapter: SourceAdapter = {
  id: 'godaddy_csv',
  kind: 'file',
  label: 'GoDaddy CSV export',

  async listMenu(ctx: AdapterContext): Promise<NormalizedMenu> {
    if (ctx.input == null || ctx.input.length === 0) throw new Error(NOT_AVAILABLE)
    return parseMenuCsv(ctx.input, ctx.meta)
  },

  async listOrders(ctx: AdapterContext): Promise<NormalizedOrder[]> {
    if (ctx.input == null || ctx.input.length === 0) throw new Error(NOT_AVAILABLE)
    return parseOrdersCsv(ctx.input, ctx.meta)
  },
}
