// ----------------------------------------------------------------
// Source Adapter Abstraction — provider-agnostic external intake.
//
// A "source" is anything that can produce canonical menus/orders:
//
//   api       — a branded POS API (Square, Toast, Clover, ...)
//   file      — a CSV / XLSX / JSON upload (homemade exports, etc.)
//   custom    — a bespoke JSON feed from a custom integration
//   mock      — the Pilot V1 sample source used for testing
//
// Each concrete adapter is a separate file under `lib/import/adapters/`
// and implements `SourceAdapter`. The ingest pipeline doesn't care
// what kind of source produced the data — once normalized to the
// shapes in `./types.ts`, everything downstream is the same.
//
// Intentionally narrow for Pilot V1:
//   • Two methods: listMenu, listOrders.
//   • Both accept a single `AdapterContext` so file-based adapters
//     can receive raw input payloads alongside API credentials.
//   • No sync-cursor plumbing (the connection row carries
//     last_orders_sync_at for incremental APIs; file adapters ignore it).
// ----------------------------------------------------------------

import type { NormalizedMenu, NormalizedOrder } from './types'
import { mockSourceAdapter } from './adapters/mock'
import { csvSourceAdapter } from './adapters/csv'
import { customJsonSourceAdapter } from './adapters/custom-json'
import { cloverSourceAdapter } from './adapters/clover'
import { toastSourceAdapter } from './adapters/toast'
import { squareSourceAdapter } from './adapters/square'
import { godaddyPosSourceAdapter, godaddyOnlineSourceAdapter } from './adapters/godaddy'
import { godaddyCsvSourceAdapter } from './adapters/godaddy-csv'

// ================================================================
// Source identity
// ================================================================

export type SourceId =
  | 'mock'
  // API adapters (not implemented yet — stubs will land per provider)
  | 'square'
  | 'toast'
  | 'clover'
  // GoDaddy Commerce — one provider, two channels (see adapters/godaddy.ts)
  | 'godaddy_pos'
  | 'godaddy_online'
  // File / custom adapters (not implemented yet)
  | 'csv'
  | 'custom_json'
  // GoDaddy manual CSV export parser (one-shot file import; see
  // adapters/godaddy-csv.ts). Never a connection provider — the
  // import action tags rows as godaddy_pos / godaddy_online so a CSV
  // backfill and the eventual API sync share one sales stream.
  | 'godaddy_csv'

export type SourceKind = 'api' | 'file' | 'custom' | 'mock'

// ================================================================
// Adapter contract
// ================================================================

export interface AdapterContext {
  /** Credentials the user stored on their external_pos_connections
   *  row. API adapters read tokens here; file adapters typically
   *  ignore this. */
  credentials: Record<string, unknown> | null

  /** Incremental window for orders. API adapters should return
   *  only orders posted at-or-after this timestamp. File adapters
   *  can ignore it (the whole file is processed each upload). */
  since: Date | null

  /** Raw payload for file / custom adapters — CSV contents, JSON
   *  blob, etc. API adapters should ignore this. The ingest layer
   *  hands this through verbatim from whatever triggered the sync. */
  input?: string | null

  /** Optional mutable meta bucket. Adapters may write into this
   *  object during a sync to surface page counts, truncation, or
   *  free-form notes back to the calling action. Calling actions
   *  create a fresh `{}` per connection, pass it in, and read it
   *  after the adapter resolves — so one connection's meta never
   *  leaks into another's. Existing adapters that don't care about
   *  transparency can simply ignore this field. */
  meta?: SyncMeta
}

/**
 * Adapter-populated meta surfaced by the calling action in sync
 * results. Everything is optional so adapters can fill in only
 * what's cheap to report.
 *
 *   pagesFetched    - How many HTTP pages (or chunks) were pulled.
 *   recordsFetched  - Raw count the adapter *saw* before validation.
 *                     For CSV/JSON this is the row count or object
 *                     count, including ones it dropped.
 *   recordsSkipped  - How many raw records the adapter dropped due
 *                     to validation. File adapters populate this
 *                     when individual rows/objects fail per-record
 *                     validation; valid records are preserved.
 *                     Difference (fetched - skipped) is what was
 *                     handed to the shared ingest pipeline.
 *   truncated       - True when the adapter hit an internal cap and
 *                     stopped paginating early. Sync results should
 *                     be transparent about this — Pilot V1 trusts
 *                     "partial truth, made explicit" over "silent
 *                     completeness".
 *   notes           - Free-form human-readable markers for the UI.
 *                     File adapters use this to surface specific
 *                     per-row rejection reasons (capped to a few so
 *                     messages stay short).
 */
export interface SyncMeta {
  pagesFetched?: number
  recordsFetched?: number
  recordsSkipped?: number
  truncated?: boolean
  notes?: string[]
}

export interface SourceAdapter {
  id: SourceId
  kind: SourceKind
  /** Human-readable label for Settings / logs. */
  label: string

  /**
   * Return the full canonical menu. Pilot V1 uses full-upsert on
   * every call — the ingest pipeline handles dedupe. Providers that
   * support incremental menu sync can simply ignore the semantics
   * and return everything; the shared ingest is idempotent.
   */
  listMenu(ctx: AdapterContext): Promise<NormalizedMenu>

  /**
   * Return orders from this source. API adapters should honor the
   * `ctx.since` window. File adapters process the whole payload.
   */
  listOrders(ctx: AdapterContext): Promise<NormalizedOrder[]>
}

// ================================================================
// Registry — keep the switch narrow. New adapters land as their
// own files under `lib/import/adapters/` and get registered here.
// ================================================================

export function getSourceAdapter(id: SourceId): SourceAdapter {
  switch (id) {
    case 'mock':
      return mockSourceAdapter
    case 'csv':
      return csvSourceAdapter
    case 'custom_json':
      return customJsonSourceAdapter
    case 'clover':
      return cloverSourceAdapter
    case 'toast':
      return toastSourceAdapter
    case 'square':
      return squareSourceAdapter
    case 'godaddy_pos':
      return godaddyPosSourceAdapter
    case 'godaddy_online':
      return godaddyOnlineSourceAdapter
    case 'godaddy_csv':
      return godaddyCsvSourceAdapter
    default:
      throw new Error(`Source adapter '${id}' is not implemented yet.`)
  }
}

export function isKnownSourceId(id: string): id is SourceId {
  return (
    id === 'mock' ||
    id === 'square' ||
    id === 'toast' ||
    id === 'clover' ||
    id === 'godaddy_pos' ||
    id === 'godaddy_online' ||
    id === 'csv' ||
    id === 'custom_json'
  )
}
