// ----------------------------------------------------------------
// Plaid server client
//
// Single source of truth for the server-side Plaid SDK client.
// Lives under lib/plaid/ so nothing on the browser can import it —
// the file reads PLAID_SECRET from process.env and returns an
// authenticated `PlaidApi` instance configured for Sandbox.
//
// Scope rules (Pilot V1):
//   • Sandbox only. PLAID_ENV must be 'sandbox'. Production/dev
//     environments are intentionally out of scope for this phase.
//   • Transactions product only — no liabilities, investments,
//     auth, identity, or income. Keep the integration narrow.
//   • Checking/savings (depository) focus. Other account types
//     land in the raw table but aren't surfaced in Finance.
// ----------------------------------------------------------------

import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'

let cached: PlaidApi | null = null

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
  const env = (process.env.PLAID_ENV ?? 'sandbox').toLowerCase()
  return Boolean(clientId && secret) && env === 'sandbox'
}

export function getPlaidClient(): PlaidApi {
  if (cached) return cached

  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  const env = (process.env.PLAID_ENV ?? 'sandbox').toLowerCase()

  if (!clientId || !secret) {
    throw new Error(
      'Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in your environment.'
    )
  }
  if (env !== 'sandbox') {
    // Hard stop — this phase is sandbox-only by design. When a later
    // phase adds production, this guard comes out in the same patch
    // that introduces the production credential handling.
    throw new Error(`Plaid env '${env}' is not supported yet. Use PLAID_ENV=sandbox.`)
  }

  const configuration = new Configuration({
    basePath: PlaidEnvironments.sandbox,
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
