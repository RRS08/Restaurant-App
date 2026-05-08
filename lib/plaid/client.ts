// ----------------------------------------------------------------
// Plaid server client
//
// Single source of truth for the server-side Plaid SDK client.
// Lives under lib/plaid/ so nothing on the browser can import it —
// the file reads PLAID_SECRET from process.env and returns an
// authenticated `PlaidApi` instance configured for the env named
// in PLAID_ENV.
//
// Scope:
//   • PLAID_ENV ∈ { 'sandbox', 'production' } (default 'sandbox')
//   • Transactions product only — no liabilities, investments,
//     auth, identity, or income. Keep the integration narrow.
//   • Checking/savings (depository) focus. Other account types
//     land in the raw table but aren't surfaced in Finance.
//
// Sandbox-only affordances (e.g. /sandbox/transactions/create
// inside the External money drawer's dev panel) will reject in
// production — that's intentional, not a bug.
// ----------------------------------------------------------------

import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'

type PlaidEnvName = 'sandbox' | 'production'

let cached: PlaidApi | null = null

function readEnv(): PlaidEnvName {
  const raw = (process.env.PLAID_ENV ?? 'sandbox').toLowerCase()
  return raw === 'production' ? 'production' : 'sandbox'
}

// ----------------------------------------------------------------
// isPlaidConfigured
//
// Server-safe "is the Plaid integration usable right now?" check.
// Returns a plain boolean so server components + server actions can
// branch without touching Plaid SDK code and without surfacing any
// env values to the client. Never throws — an unconfigured app is a
// valid boot state, not an error.
// ----------------------------------------------------------------
export function isPlaidConfigured(): boolean {
  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  return Boolean(clientId && secret)
}

/** True only when PLAID_ENV is sandbox. Used by sandbox-only
 *  affordances (e.g. the dev "create rent transaction" button) to
 *  hide themselves automatically in production. */
export function isPlaidSandbox(): boolean {
  return readEnv() === 'sandbox'
}

export function getPlaidClient(): PlaidApi {
  if (cached) return cached

  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  const env = readEnv()

  if (!clientId || !secret) {
    throw new Error(
      'Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in your environment.'
    )
  }

  const configuration = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
        'Plaid-Version': '2020-09-14',
      },
    },
  })

  cached = new PlaidApi(configuration)
  return cached
}

// Products + country codes used when creating Link tokens. Kept
// narrow — `transactions` is the only product this phase needs.
export const PLAID_PRODUCTS = ['transactions'] as const
export const PLAID_COUNTRY_CODES = ['US'] as const
