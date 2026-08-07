// ----------------------------------------------------------------
// Payment adapter registry.
//
// Sites declare a `payment_provider` in config; this resolver maps
// the string to an adapter. Returns null when the site has no
// provider set or the string doesn't match a known one — the
// checkout endpoint surfaces that as a hard error rather than
// silently letting an order through unpaid.
//
// Add a provider by dropping a file next to `./godaddy.ts` that
// default-exports an object matching PaymentAdapter, then register
// it here.
// ----------------------------------------------------------------

import type { PaymentAdapter } from './types'
import { godaddyAdapter } from './godaddy'

const ADAPTERS: Record<string, PaymentAdapter> = {
  godaddy: godaddyAdapter,
}

export function resolvePaymentAdapter(name: string | null | undefined): PaymentAdapter | null {
  if (!name) return null
  return ADAPTERS[name] ?? null
}

export type {
  PaymentAdapter,
  PaymentAuthorizeRequest,
  PaymentAuthorizeResult,
  PaymentAuthorizeBuyer,
  PaymentAuthorizeCartItem,
  HostedCheckoutRequest,
  HostedCheckoutResult,
} from './types'
