// ----------------------------------------------------------------
// Bank Provider Abstraction — intake foundation only.
//
// This is NOT a universal integration layer. It is a narrow,
// intentionally small contract so the rest of the system can talk
// to "a bank provider" without caring which one.
//
// V1 ships with a `mock` provider so the ingest pipeline can be
// tested end-to-end before a real provider is wired up. When we
// integrate Plaid / Stripe / Teller, each becomes its own file in
// `lib/bank/providers/` implementing `BankProvider`.
//
// Goals:
//   • Keep the contract tight enough that a real provider can be
//     dropped in without touching Finance pages, DB writes, or RLS.
//   • Keep the shape close to how most bank providers already
//     normalize transactions (canonical amount + direction, posted
//     timestamp, provider ids for upsert safety).
// ----------------------------------------------------------------

export type BankProviderId = 'plaid' | 'stripe' | 'teller' | 'manual' | 'mock'

export type TransactionDirection = 'inflow' | 'outflow'

export interface NormalizedBankAccount {
  providerAccountId: string
  providerItemId?: string | null
  accountName?: string | null
  accountMask?: string | null
  accountType?: string | null
  accountSubtype?: string | null
  institutionName?: string | null
  currency?: string
}

export interface NormalizedBankTransaction {
  providerTransactionId: string
  amount: number           // Always positive. Direction carries the sign.
  direction: TransactionDirection
  currency: string
  description: string | null
  merchantName: string | null
  rawCategory: string | null
  postedAt: string         // ISO timestamp
  pending: boolean
  providerMetadata: Record<string, unknown> | null
}

/**
 * Cursor returned by incremental sync. Callers store it on
 * `connected_bank_accounts.last_sync_cursor` and pass it back on the
 * next `syncTransactions` call.
 */
export interface SyncResult {
  transactions: NormalizedBankTransaction[]
  nextCursor: string | null
  hasMore: boolean
}

export interface BankProvider {
  id: BankProviderId

  /**
   * Fetch account metadata for a linked item. Called right after the
   * user first connects so we can insert a `connected_bank_accounts`
   * row with the provider's stable account id.
   */
  listAccounts(providerItemId: string): Promise<NormalizedBankAccount[]>

  /**
   * Incremental transaction sync. V1 expects each provider to support
   * cursor-based pagination (Plaid's `/transactions/sync`, Stripe's
   * paged list, etc.). Providers that don't support cursors can
   * implement this as a posted-since window and return `nextCursor`
   * as the latest timestamp they've seen.
   */
  syncTransactions(
    providerAccountId: string,
    opts: { cursor?: string | null }
  ): Promise<SyncResult>
}

// ----------------------------------------------------------------
// Mock provider — lets us exercise the ingest pipeline without any
// real credentials. Swap to a real provider in `getBankProvider()`
// when the actual integration lands.
// ----------------------------------------------------------------

export const mockProvider: BankProvider = {
  id: 'mock',

  async listAccounts(providerItemId) {
    return [
      {
        providerAccountId: `${providerItemId}-acct-1`,
        providerItemId,
        accountName: 'Operating checking (mock)',
        accountMask: '0000',
        accountType: 'depository',
        accountSubtype: 'checking',
        institutionName: 'Mock Bank',
        currency: 'USD',
      },
    ]
  },

  async syncTransactions() {
    return { transactions: [], nextCursor: null, hasMore: false }
  },
}

/**
 * Resolve a provider implementation by id. New real providers get
 * added here as separate files under `lib/bank/providers/` and
 * imported lazily. Kept as a simple switch for V1 — no plugin
 * loader, no service locator.
 */
export function getBankProvider(id: BankProviderId): BankProvider {
  switch (id) {
    case 'mock':
      return mockProvider
    // case 'plaid':  return plaidProvider   // wired when Plaid lands
    // case 'stripe': return stripeProvider
    // case 'teller': return tellerProvider
    default:
      throw new Error(`Bank provider '${id}' is not implemented yet.`)
  }
}
