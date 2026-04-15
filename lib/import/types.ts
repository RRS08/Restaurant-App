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
   *  category get attached to the "Imported · Uncategorized" bucket
   *  by the shared ingest pipeline. */
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
  lineItems: NormalizedOrderLineItem[]
}
