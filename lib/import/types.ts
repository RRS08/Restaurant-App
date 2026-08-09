// ----------------------------------------------------------------
// Canonical External Intake Model
//
// The single shape every source adapter must normalize into. Once
// data reaches this shape, the shared ingest pipeline does the rest —
// nothing downstream needs to know whether the data came from a POS
// API, a CSV upload, a custom JSON feed, or a homemade exporter.
//
// These shapes are intentionally narrow. They contain only the
// fields Pilot V1 actually reads, and nothing that would over-fit
// to a single provider's schema. New fields should only be added
// when the core app needs them, not when a specific provider
// happens to expose them.
// ----------------------------------------------------------------

// ================================================================
// Menu
// ================================================================

export interface NormalizedCategory {
  /** Stable per-source identifier. Combined with the source id and
   *  location, it forms the dedupe key. Must not be reused for
   *  different categories within the same source. */
  externalId: string
  name: string
  /** Display order within the menu. Optional — omit for sources
   *  that don't expose ordering. */
  sortOrder?: number
}

export interface NormalizedMenuItem {
  externalId: string
  name: string
  /** Unit price in the restaurant's base currency. */
  price: number
  /** Foreign key to NormalizedCategory.externalId, or null when the
   *  source doesn't know the category. Items with a null or unknown
   *  category get inserted with `category_id = null` — they surface
   *  in the "Awaiting a section" band on /menu so the manager can
   *  drag them into the right chip or assign one via the drawer. */
  categoryExternalId: string | null
  active: boolean
}

export interface NormalizedMenu {
  categories: NormalizedCategory[]
  items: NormalizedMenuItem[]
}

// ================================================================
// Orders
// ================================================================

export interface NormalizedOrderLineItem {
  /** Stable per-source identifier of the menu item sold. If the
   *  ingest layer has never seen this id before, it creates a
   *  placeholder menu item (source='imported') so the sale is
   *  never lost. */
  externalItemId: string
  /** Fallback name used when the item hasn't been imported yet —
   *  lets the placeholder carry a human-readable name. */
  itemName: string
  /** Variant / modifier subline, when the source exposes it
   *  (Poynt's selectedVariants[].value). Rendered on its own
   *  subline in the sales drawer, e.g. "1oz-Loose" beneath the
   *  product name. Optional — most sources leave it undefined. */
  variantLabel?: string
  quantity: number
  unitPrice: number
  totalPrice: number
}

export interface NormalizedOrder {
  /** Stable per-source identifier for the order. Scoped to
   *  `(restaurant_id, location_id, source, external_id)` for
   *  dedupe — two internal locations using the same source
   *  can safely share the same `externalId`. */
  externalId: string
  /** ISO-8601 timestamp of when the sale closed. */
  postedAt: string
  totalAmount: number
  status?: 'completed' | 'voided'
  paymentType?: 'cash' | 'card' | 'other'
  /** Imported sales truth. Adapters that know the real paid state
   *  should forward it here (Toast/Square/Clover all expose this).
   *  When the source genuinely can't tell — e.g. a legacy CSV that
   *  doesn't include payment status — leave it undefined and the
   *  shared ingest pipeline falls back to a safe default of 'paid'
   *  (closed tickets in an export are overwhelmingly paid in
   *  practice). The point is: adapters no longer _have_ to lie. */
  paymentStatus?: 'paid' | 'unpaid'
  /** Receipt-shaped breakdown. All optional — an adapter that
   *  can't tell (legacy CSV, transaction-only ingest) should
   *  leave them undefined rather than fabricate zeros. Ingest
   *  writes null to the DB when undefined. */
  subtotal?: number
  discountTotal?: number
  taxTotal?: number
  /** Card details from the payment leg, when the sale was card-
   *  tendered and the adapter exposed the funding source. */
  cardBrand?: string     // 'VISA' / 'MASTERCARD' / 'AMEX' / …
  cardLast4?: string
  /** Combined display name from the source's customer record,
   *  when present. */
  customerName?: string
  /** Raw upstream channel string (Poynt: 'WEB' / 'INSTORE' /
   *  'MOBILE' / 'CALLIN'). Kept alongside the SourceId routing
   *  since the SourceId collapses several Poynt values into
   *  godaddy_pos / godaddy_online. */
  channelSource?: string
  /** Sub-identifiers from inside the upstream order — for Poynt,
   *  the ids of the transactions attached to the order. Used by
   *  the ingest dedup pass to catch orders we already inserted
   *  through a different key namespace (e.g. our web checkout
   *  stores the Poynt transaction id in external_id, while the
   *  sync stores the Poynt order id — these two never collide on
   *  external_id alone but the transaction id inside the order's
   *  transactions[] bridges them). Adapters that don't have a
   *  sub-id concept leave it undefined. */
  transactionIds?: string[]
  lineItems: NormalizedOrderLineItem[]
}
