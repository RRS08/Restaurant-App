'use server'

// ----------------------------------------------------------------
// Clover integration — server actions (owner-only)
//
// Same setup-only surface as the Square actions: configure / test /
// disconnect for the per-location Clover connection. These actions
// never import menu data, never import orders, and never mutate
// internal operational data. Import flows live in
// `app/actions/pos-import.ts` and are a separate operational step.
//
// Storage model (mirrors the Square integration):
//   • One row per (restaurant_id, location_id) in
//     `external_pos_connections` with `provider = 'clover'`.
//   • `provider_credentials` jsonb holds:
//       api_token        — secret, never returned to the browser
//       merchant_id      — Clover merchant identifier
//       base_url         — derived from environment
//       environment      — 'sandbox' | 'production'
//   • `external_store_id` mirrors the Clover merchant id so the
//     dev-tools panel + display surfaces have a non-secret pointer.
//
// Security: identical to the Square pattern — owner-only via
// `requireRestaurantOwner`, the api_token is never serialized into
// a return value or echoed back to the client, and the test action
// is strictly read-only against Clover's merchant endpoint.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { getAuthContext, resolveLocationId } from '@/lib/auth'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'
import { isDevEmail } from '@/lib/dev'
import { createClient } from '@/lib/supabase/server'

// ----------------------------------------------------------------
// Shared types
// ----------------------------------------------------------------

type SaveResult = { error: string } | { ok: true; message: string }
type TestResult = {
  ok: boolean
  message: string
  environment?: string
  merchantName?: string
}
type DisconnectResult = { error: string } | { ok: true; message: string }

type Environment = 'sandbox' | 'production'

const CLOVER_BASE_URLS: Record<Environment, string> = {
  sandbox: 'https://apisandbox.dev.clover.com',
  production: 'https://api.clover.com',
}

const TEST_TIMEOUT_MS = 15_000

async function requireOwnerResult(restaurantId: string): Promise<string | null> {
  try {
    await requireRestaurantOwner(restaurantId)
    return null
  } catch (err) {
    if (err instanceof AuthzError) return err.message
    throw err
  }
}

// ----------------------------------------------------------------
// saveCloverConfig — create or update the Clover connection for
// the active location. Owner-only.
//
// Form fields:
//   location_id     uuid of the internal location (optional;
//                   falls back via resolveLocationId)
//   environment     'sandbox' | 'production' (defaults to sandbox)
//   merchant_id     Clover merchant identifier (non-secret)
//   api_token       Clover API token (secret — if empty on update,
//                   the previously stored token is preserved)
// ----------------------------------------------------------------
export async function saveCloverConfig(
  prevState: SaveResult | null,
  formData: FormData,
): Promise<SaveResult> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const formLocationId = (formData.get('location_id') as string | null)?.trim() || null
  const { locationId, error: locErr } = await resolveLocationId(ctx, formLocationId)
  if (locErr) return { error: locErr }

  const environmentRaw = ((formData.get('environment') as string | null) ?? 'sandbox').trim()
  if (environmentRaw !== 'sandbox' && environmentRaw !== 'production') {
    return { error: 'Environment must be sandbox or production.' }
  }
  const environment = environmentRaw as Environment

  const apiTokenInput = ((formData.get('api_token') as string | null) ?? '').trim()

  // Same defensive normalization as Square's location id — pasting
  // from web dashboards sometimes carries hidden zero-width chars,
  // non-breaking spaces, or wrapping quotes.
  const merchantIdRaw = (formData.get('merchant_id') as string | null) ?? ''
  const merchantId = merchantIdRaw
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, '')
    .replace(/^['"]+|['"]+$/g, '')
    .trim()

  if (!merchantId) return { error: 'Clover merchant ID is required.' }

  // Edit-without-retyping flow: if no api_token is provided and a
  // connection already exists, keep the previously stored token.
  const { data: existing } = await ctx.supabase
    .from('external_pos_connections')
    .select('provider_credentials')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', 'clover')
    .maybeSingle()

  let apiTokenToStore: string
  if (apiTokenInput.length > 0) {
    apiTokenToStore = apiTokenInput
  } else if (existing) {
    const prev = existing.provider_credentials as { api_token?: string } | null
    apiTokenToStore = (prev?.api_token ?? '').trim()
    if (!apiTokenToStore) {
      return { error: 'Clover API token is required.' }
    }
  } else {
    return { error: 'Clover API token is required.' }
  }

  const credentials = {
    api_token: apiTokenToStore,
    merchant_id: merchantId,
    base_url: CLOVER_BASE_URLS[environment],
    environment,
  }

  const { error } = await ctx.supabase
    .from('external_pos_connections')
    .upsert(
      {
        restaurant_id: ctx.restaurantId,
        location_id: locationId,
        provider: 'clover',
        external_store_id: merchantId,
        provider_credentials: credentials,
        active: true,
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'location_id' },
    )

  if (error) return { error: error.message }

  revalidatePath('/settings')
  return {
    ok: true,
    message: existing
      ? 'Clover configuration updated.'
      : 'Clover connected. Configuration saved — menu and sales import are a separate step.',
  }
}

// ----------------------------------------------------------------
// testCloverConnection — read-only verification that Clover accepts
// the saved credentials and that the configured merchant is reachable.
// Owner-only.
//
// What this does:
//   • GET {base_url}/v3/merchants/{merchant_id}
//   • Returns success / failure with a safe message
//   • Reports environment + merchant name when available
//
// What this does NOT do:
//   • Import menu, catalog, or orders
//   • Mutate Clover data
//   • Mutate any internal operational data
// ----------------------------------------------------------------
export async function testCloverConnection(
  prevState: TestResult | null,
  formData: FormData,
): Promise<TestResult> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { ok: false, message: authError ?? 'Authentication error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { ok: false, message: ownerErr }

  const formLocationId = (formData.get('location_id') as string | null)?.trim() || null
  const { locationId, error: locErr } = await resolveLocationId(ctx, formLocationId)
  if (locErr) return { ok: false, message: locErr }

  const { data: row } = await ctx.supabase
    .from('external_pos_connections')
    .select('provider_credentials, external_store_id')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', 'clover')
    .maybeSingle()

  if (!row) {
    return { ok: false, message: 'Clover is not configured for this location yet.' }
  }

  const creds = row.provider_credentials as {
    api_token?: string
    merchant_id?: string
    base_url?: string
    environment?: Environment
  } | null

  const apiToken = creds?.api_token?.trim() ?? ''
  const merchantId =
    creds?.merchant_id?.trim() ?? (row.external_store_id ?? '').trim()
  const baseUrl = (creds?.base_url ?? CLOVER_BASE_URLS.sandbox).replace(/\/+$/, '')
  const environment: Environment = creds?.environment === 'production' ? 'production' : 'sandbox'

  if (!apiToken || !merchantId) {
    return {
      ok: false,
      message: 'Clover credentials are incomplete. Re-enter them and save.',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    const res = await fetch(
      `${baseUrl}/v3/merchants/${encodeURIComponent(merchantId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
        signal: controller.signal,
      },
    )

    // Surface Clover's own error message when available — for the
    // 401 case the body usually contains a JSON hint like
    // `{"message":"401 Unauthorized"}` or `{"message":"Access denied
    // ...","status":403}` which is far more actionable than just a
    // status code. We trim to 200 chars so a runaway HTML page
    // doesn't blow up the toast.
    const safeBody = async () => {
      try {
        const text = await res.clone().text()
        const trimmed = text.slice(0, 200).replace(/\s+/g, ' ').trim()
        return trimmed ? ` Details: ${trimmed}` : ''
      } catch {
        return ''
      }
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message:
          `Clover rejected the API token (HTTP ${res.status}). Most common cause: ` +
          `the token doesn't have Read permission for Merchant/Inventory/Orders yet — ` +
          `expand "PERMISSIONS" on the token in the Clover sandbox dashboard and grant ` +
          `the read scopes.${await safeBody()}`,
        environment,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Clover merchant not found. Verify the merchant ID and environment.${await safeBody()}`,
        environment,
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        message: `Clover returned HTTP ${res.status}. Verify credentials and try again.${await safeBody()}`,
        environment,
      }
    }

    const body = (await res.json().catch(() => null)) as
      | { id?: string; name?: string }
      | null
    const merchantName = body?.name ?? null

    return {
      ok: true,
      message: merchantName
        ? `Connected. Clover (${environment}) returned merchant "${merchantName}".`
        : `Connected. Clover (${environment}) accepted the credentials.`,
      environment,
      merchantName: merchantName ?? undefined,
    }
  } catch (err) {
    const baseMsg =
      err instanceof Error && err.name === 'AbortError'
        ? 'Clover did not respond in time.'
        : err instanceof Error
          ? err.message
          : 'Unknown network error.'
    return {
      ok: false,
      message: `Could not reach Clover: ${baseMsg}`,
      environment,
    }
  } finally {
    clearTimeout(timer)
  }
}

// ----------------------------------------------------------------
// createCloverTestOrder — dev-only helper that creates an itemized
// order in Clover Sandbox so we can exercise the existing
// `syncExternalPosOrders` pipeline end-to-end without curl/Postman.
//
// What this does:
//   1. Verifies caller is an owner AND a dev account.
//   2. Loads the saved Clover connection (api_token + merchant_id +
//      base_url) for the resolved location.
//   3. Validates that the menu_item belongs to this restaurant and
//      was imported from Clover (so its `external_id` is a real
//      Clover catalog item id we can reference).
//   4. POSTs to Clover: `/v3/merchants/{mid}/orders` — creates an
//      empty order shell. Returns the new order id.
//   5. POSTs to Clover: `/v3/merchants/{mid}/orders/{orderId}/line_items`
//      once per unit of `quantity`. Each call references the
//      catalog item id and lets Clover populate price + name from
//      the catalog. (Clover's line_items endpoint creates one row
//      per request — quantity is handled by repeated calls.)
//
// What this does NOT do:
//   • Insert any rows in `orders`, `order_items`, `sales`,
//     `inventory_transactions`, `payment_intents`, or anything
//     internal. The Clover order is purely upstream until the user
//     clicks "Sync orders now" — which then drives the existing
//     adapter → ingest pipeline.
//   • Add a payment / mark the order as paid. The Clover adapter
//     (lib/import/adapters/clover.ts:328) treats every order with
//     line items as `completed`, so we don't need a tender step
//     for the import to pick the order up. If Clover returns a $0
//     `total` for unpaid orders, we'd see that on the Sales row
//     after sync and could add a payment step later.
// ----------------------------------------------------------------

type CreateTestOrderResult =
  | { error: string; orderId?: string; lineItemIds?: string[] }
  | {
      ok: true
      message: string
      orderId: string
      lineItemIds: string[]
      unitsAdded: number
      totalAmount: number
      paymentId: string | null
      tenderUsed: string | null
      paid: boolean
      environment: Environment
    }

interface CloverOrderCreateResponse {
  id?: string
}

interface CloverLineItemCreateResponse {
  id?: string
  name?: string
  price?: number
}

interface CloverTender {
  id: string
  label?: string
  labelKey?: string
  enabled?: boolean
}

interface CloverTendersResponse {
  elements?: CloverTender[]
}

interface CloverPaymentCreateResponse {
  id?: string
  amount?: number
  tender?: { id?: string; label?: string }
}

// Pick the most "test-friendly" tender on a merchant. Cash is the
// universal first choice; external/custom tenders are next because
// they don't simulate card processing in sandbox. Any enabled tender
// beats nothing if the standards aren't present.
function chooseTender(tenders: CloverTender[]): CloverTender | null {
  if (tenders.length === 0) return null
  const enabled = tenders.filter((t) => t.enabled !== false)
  const pool = enabled.length > 0 ? enabled : tenders

  const cash = pool.find((t) => {
    const key = (t.labelKey ?? '').toLowerCase()
    const label = (t.label ?? '').toLowerCase()
    return key.includes('cash') || label === 'cash'
  })
  if (cash) return cash

  const external = pool.find((t) => {
    const key = (t.labelKey ?? '').toLowerCase()
    const label = (t.label ?? '').toLowerCase()
    return key.includes('external') || label.includes('external') ||
           key.includes('custom') || label.includes('custom')
  })
  if (external) return external

  // Last resort: avoid the card tender (sandbox card flows usually
  // expect a real payment token), but if it's the only option, take it.
  const nonCard = pool.find((t) => {
    const key = (t.labelKey ?? '').toLowerCase()
    const label = (t.label ?? '').toLowerCase()
    return !key.includes('card') && !label.includes('card') &&
           !key.includes('credit') && !label.includes('credit') &&
           !key.includes('debit') && !label.includes('debit')
  })
  return nonCard ?? pool[0]
}

export async function createCloverTestOrder(
  prevState: CreateTestOrderResult | null,
  formData: FormData,
): Promise<CreateTestOrderResult> {
  // Auth + owner + dev gate.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }
  if (!isDevEmail(user.email)) {
    return { error: 'Dev-only action.' }
  }

  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  // Resolve location → load Clover connection for it.
  const formLocationId = (formData.get('location_id') as string | null)?.trim() || null
  const { locationId, error: locErr } = await resolveLocationId(ctx, formLocationId)
  if (locErr) return { error: locErr }

  const { data: connRow } = await ctx.supabase
    .from('external_pos_connections')
    .select('provider_credentials, active')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', 'clover')
    .maybeSingle()
  if (!connRow || !connRow.active) {
    return { error: 'Clover is not configured for this location.' }
  }
  const creds = connRow.provider_credentials as {
    api_token?: string
    merchant_id?: string
    base_url?: string
    environment?: Environment
  } | null
  const apiToken = creds?.api_token?.trim() ?? ''
  const merchantId = creds?.merchant_id?.trim() ?? ''
  const baseUrl = (creds?.base_url ?? CLOVER_BASE_URLS.sandbox).replace(/\/+$/, '')
  const environment: Environment =
    creds?.environment === 'production' ? 'production' : 'sandbox'
  if (!apiToken || !merchantId) {
    return { error: 'Clover credentials are incomplete.' }
  }

  // Validate the menu_item: restaurant-scoped, imported from Clover,
  // has a non-empty external_id.
  const menuItemId = (formData.get('menu_item_id') as string | null)?.trim() ?? ''
  if (!menuItemId) return { error: 'Pick an imported Clover item.' }

  const { data: menuItem } = await ctx.supabase
    .from('menu_items')
    .select('id, name, external_provider, external_id')
    .eq('id', menuItemId)
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle()
  if (!menuItem) return { error: 'Menu item not found in this restaurant.' }
  if (menuItem.external_provider !== 'clover') {
    return { error: 'That menu item was not imported from Clover.' }
  }
  const cloverItemId = (menuItem.external_id as string | null)?.trim() ?? ''
  if (!cloverItemId) return { error: 'Imported item is missing its Clover catalog id.' }

  // Quantity: clamp 1..50 to keep accidental dev-fat-finger orders bounded.
  const qtyRaw = Number(formData.get('quantity'))
  const quantity = Number.isFinite(qtyRaw) ? Math.floor(qtyRaw) : 1
  if (quantity < 1 || quantity > 50) {
    return { error: 'Quantity must be between 1 and 50.' }
  }

  // 1. Create the order shell.
  //
  // We explicitly set `state: "open"`. Without this, Clover creates
  // the order with `state = null`, and the orders LIST endpoint's
  // implicit `state IS NOT NULL` filter (Clover auto-appends it on
  // every list call) silently excludes the order — even though the
  // dashboard still counts it as paid via the attached payment.
  // Real Clover POS flows always set state="open" on order start.
  let orderId: string
  try {
    const res = await fetch(
      `${baseUrl}/v3/merchants/${encodeURIComponent(merchantId)}/orders`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ state: 'open' }),
        cache: 'no-store',
      },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        error:
          `Clover order create failed (HTTP ${res.status}). ` +
          (body ? `Details: ${body.slice(0, 200).replace(/\s+/g, ' ').trim()}` : ''),
      }
    }
    const data = (await res.json()) as CloverOrderCreateResponse
    if (!data.id) return { error: 'Clover did not return an order id.' }
    orderId = data.id
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error.'
    return { error: `Could not reach Clover (order create): ${msg}` }
  }

  // 2. Add line items — one POST per unit. Clover's line_items
  // endpoint creates a single row per call; for quantity > 1 we
  // either repeat or send the body as N requests. Repeating is
  // simpler and matches how the catalog reads later in sync.
  //
  // We also sum the price cents the endpoint echoes back so we know
  // the payment amount without an extra GET /orders/{id} round trip.
  const lineItemIds: string[] = []
  let totalCents = 0
  for (let i = 0; i < quantity; i++) {
    try {
      const res = await fetch(
        `${baseUrl}/v3/merchants/${encodeURIComponent(merchantId)}/orders/${encodeURIComponent(orderId)}/line_items`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ item: { id: cloverItemId } }),
          cache: 'no-store',
        },
      )
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return {
          error:
            `Clover line item add failed at unit ${i + 1}/${quantity} ` +
            `(HTTP ${res.status}). Order ${orderId} was created but only ` +
            `${lineItemIds.length} line item(s) attached. ` +
            (body ? `Details: ${body.slice(0, 200).replace(/\s+/g, ' ').trim()}` : ''),
          orderId,
          lineItemIds,
        }
      }
      const data = (await res.json()) as CloverLineItemCreateResponse
      if (data.id) lineItemIds.push(data.id)
      if (typeof data.price === 'number') totalCents += data.price
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error.'
      return {
        error: `Could not reach Clover (line item ${i + 1}): ${msg}`,
        orderId,
        lineItemIds,
      }
    }
  }

  // 3. Close the order with a payment. Without this, Clover keeps
  // the order in `open` state — it doesn't roll into net sales, and
  // (more importantly for us) the orders search endpoint we sync
  // against doesn't surface it as an importable completed sale.
  //
  // Step 3a: pick a tender. Cash is preferred because it doesn't
  // require any sandbox card processing. We fall back to external /
  // custom / first available if cash isn't on the merchant.
  let tenders: CloverTender[] = []
  try {
    const tRes = await fetch(
      `${baseUrl}/v3/merchants/${encodeURIComponent(merchantId)}/tenders`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
      },
    )
    if (!tRes.ok) {
      const body = await tRes.text().catch(() => '')
      return {
        error:
          `Clover tenders fetch failed (HTTP ${tRes.status}). Order ${orderId} has ` +
          `${lineItemIds.length} line item(s) but is still open. Most common cause: ` +
          `the API token is missing Read permission for Tenders — grant it in the ` +
          `Clover sandbox dashboard. ` +
          (body ? `Details: ${body.slice(0, 200).replace(/\s+/g, ' ').trim()}` : ''),
        orderId,
        lineItemIds,
      }
    }
    const payload = (await tRes.json()) as CloverTendersResponse
    tenders = (payload.elements ?? []) as CloverTender[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error.'
    return {
      error: `Could not reach Clover (tenders fetch): ${msg}`,
      orderId,
      lineItemIds,
    }
  }

  const tender = chooseTender(tenders)
  if (!tender) {
    return {
      error:
        `No usable Clover tenders found on this merchant. Order ${orderId} has ` +
        `${lineItemIds.length} line item(s) but no payment was attached. Add at ` +
        `least one tender (Cash is fine) to the sandbox merchant.`,
      orderId,
      lineItemIds,
    }
  }

  if (totalCents <= 0) {
    return {
      error:
        `Clover line items came back with no price information, so we can't compute ` +
        `a payment amount. Order ${orderId} has ${lineItemIds.length} line item(s) ` +
        `but is still open. The catalog item may have a $0 price in Clover.`,
      orderId,
      lineItemIds,
    }
  }

  // Step 3b: post the payment. Clover treats this as "tender taken
  // for the full order total" and the order becomes paid.
  let paymentId: string | null = null
  try {
    const payRes = await fetch(
      `${baseUrl}/v3/merchants/${encodeURIComponent(merchantId)}/orders/${encodeURIComponent(orderId)}/payments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          tender: { id: tender.id },
          amount: totalCents,
        }),
        cache: 'no-store',
      },
    )
    if (!payRes.ok) {
      const body = await payRes.text().catch(() => '')
      return {
        error:
          `Clover payment create failed (HTTP ${payRes.status}). Order ${orderId} has ` +
          `${lineItemIds.length} line item(s) but no payment was attached. Tender ` +
          `tried: "${tender.label ?? tender.id}". ` +
          (body ? `Details: ${body.slice(0, 200).replace(/\s+/g, ' ').trim()}` : ''),
        orderId,
        lineItemIds,
      }
    }
    const payment = (await payRes.json()) as CloverPaymentCreateResponse
    paymentId = payment.id ?? null
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error.'
    return {
      error: `Could not reach Clover (payment create): ${msg}`,
      orderId,
      lineItemIds,
    }
  }

  // 4. Lock the order. Without this Clover keeps the order in "open"
  // state even after a covering payment is attached, which has two
  // visible consequences in the sync output:
  //   • order.total stays 0 on Clover's side, so the synced sale
  //     records as $0.00 even though line items have prices
  //   • payments expand returns a thin shape that fails our cash/
  //     card tender inference and falls back to "other"
  // Real Clover POS locks the order automatically on tender. The API
  // doesn't, so we mirror the lifecycle here. Failure is best-effort:
  // the order is already paid, line items already attached, and the
  // parser-side fallback will fill in the total — so we surface a
  // warning in the message instead of failing the whole action.
  let lockOk = false
  let lockError: string | null = null
  try {
    const lockRes = await fetch(
      `${baseUrl}/v3/merchants/${encodeURIComponent(merchantId)}/orders/${encodeURIComponent(orderId)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ state: 'locked' }),
        cache: 'no-store',
      },
    )
    if (lockRes.ok) {
      lockOk = true
    } else {
      const body = await lockRes.text().catch(() => '')
      lockError = `HTTP ${lockRes.status}` +
        (body ? ` — ${body.slice(0, 120).replace(/\s+/g, ' ').trim()}` : '')
    }
  } catch (err) {
    lockError = err instanceof Error ? err.message : 'Unknown error.'
  }

  return {
    ok: true,
    message:
      `Created paid Clover order with ${lineItemIds.length} line item${lineItemIds.length === 1 ? '' : 's'} ` +
      `of "${menuItem.name as string}" totaling $${(totalCents / 100).toFixed(2)} ` +
      `via "${tender.label ?? tender.id}". ` +
      (lockOk
        ? 'Order locked.'
        : `Order lock skipped (${lockError ?? 'unknown'}) — parser will sum line items as fallback.`) +
      ' Now click "Sync orders now" to import it.',
    orderId,
    lineItemIds,
    unitsAdded: lineItemIds.length,
    totalAmount: totalCents / 100,
    paymentId,
    tenderUsed: tender.label ?? tender.id,
    paid: true,
    environment,
  }
}

// ----------------------------------------------------------------
// diagnoseCloverOrders — dev-only probe to figure out why a sync
// returns 0 records when paid orders clearly exist in Clover.
//
// Calls Clover's /orders endpoint three ways and reports what each
// returns. This isolates whether the problem is:
//   • encoding of the modifiedTime filter
//   • the time-window itself being too restrictive
//   • a token permission scope issue (closed orders not readable)
//
// What this action does NOT do:
//   • Write anything internal.
//   • Modify any Clover data.
//   • Touch the connection's `last_orders_sync_at`.
// ----------------------------------------------------------------

type DiagnosticProbeResult = {
  label: string
  url: string
  status: number
  elementCount: number
  firstOrderIds: string[]
  /** First ~600 chars of the raw response body. We capture this for
   *  EVERY probe (success or failure) so we can see what Clover is
   *  actually returning when elementCount is 0. The 200/empty-elements
   *  case is the most ambiguous and needs the raw body to debug. */
  bodyPreview?: string
  /** Content-Type header, helps spot HTML error pages or redirects
   *  served with 200. */
  contentType?: string
  errorBody?: string
}

type DiagnoseResult =
  | { error: string }
  | { ok: true; probes: DiagnosticProbeResult[] }

export async function diagnoseCloverOrders(
  prevState: DiagnoseResult | null,
  formData: FormData,
): Promise<DiagnoseResult> {
  // Auth + owner + dev gate (same as createCloverTestOrder).
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }
  if (!isDevEmail(user.email)) return { error: 'Dev-only action.' }

  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const formLocationId = (formData.get('location_id') as string | null)?.trim() || null
  const { locationId, error: locErr } = await resolveLocationId(ctx, formLocationId)
  if (locErr) return { error: locErr }

  const { data: connRow } = await ctx.supabase
    .from('external_pos_connections')
    .select('provider_credentials')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', 'clover')
    .maybeSingle()
  if (!connRow) return { error: 'Clover is not configured for this location.' }
  const creds = connRow.provider_credentials as {
    api_token?: string
    merchant_id?: string
    base_url?: string
  } | null
  const apiToken = creds?.api_token?.trim() ?? ''
  const merchantId = creds?.merchant_id?.trim() ?? ''
  const baseUrl = (creds?.base_url ?? CLOVER_BASE_URLS.sandbox).replace(/\/+$/, '')
  if (!apiToken || !merchantId) {
    return { error: 'Clover credentials are incomplete.' }
  }

  const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000
  const encodedFilter = encodeURIComponent(`modifiedTime>=${sevenDaysAgoMs}`)
  const ordersBase = `${baseUrl}/v3/merchants/${encodeURIComponent(merchantId)}/orders`

  // Each probe has its own auth scheme so we can also test whether
  // the orders endpoint specifically rejects Bearer vs X-Auth-Token.
  // Default: Bearer (matches the rest of the integration).
  const probes: {
    label: string
    url: string
    auth?: 'bearer' | 'xauth' | 'query'
  }[] = [
    // 1. The narrowest "do you even see any orders for this merchant"
    //    probe — no filter, no expand, just a few rows.
    {
      label: 'No filter (limit 5)',
      url: `${ordersBase}?limit=5`,
    },
    // 2. The exact filter shape the sync uses, with a 7-day window.
    {
      label: 'modifiedTime>=7d ago, with expand (sync-shaped)',
      url: `${ordersBase}?filter=${encodedFilter}&expand=lineItems,payments&limit=10&offset=0`,
    },
    // 3. Same as #2 but with the comma in `expand` also encoded —
    //    isolates whether the comma encoding is what breaks Clover.
    {
      label: 'Same filter, expand comma encoded',
      url: `${ordersBase}?filter=${encodedFilter}&expand=${encodeURIComponent('lineItems,payments')}&limit=10&offset=0`,
    },
    // 4. Explicit state filter. Clover's order lifecycle states are
    //    open / locked / paid. Net-sales orders are typically `locked`
    //    or `paid` after a tender. If the bare LIST endpoint silently
    //    only returns `open` orders, this probe will surface them.
    {
      label: 'state=locked filter (paid orders)',
      url: `${ordersBase}?filter=${encodeURIComponent('state=locked')}&limit=5`,
    },
    // 5. X-Auth-Token header instead of Bearer. Some Clover sandbox
    //    tokens authenticate fine for individual merchant resource
    //    fetches via Bearer but expect the legacy X-Auth-Token header
    //    for list endpoints. If this returns elements while #1 does
    //    not, that's the smoking gun.
    {
      label: 'X-Auth-Token header (no filter, limit 5)',
      url: `${ordersBase}?limit=5`,
      auth: 'xauth',
    },
  ]

  const results: DiagnosticProbeResult[] = []
  for (const probe of probes) {
    try {
      const authMode = probe.auth ?? 'bearer'
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (authMode === 'bearer') {
        headers.Authorization = `Bearer ${apiToken}`
      } else if (authMode === 'xauth') {
        headers['X-Auth-Token'] = apiToken
      }

      const res = await fetch(probe.url, {
        method: 'GET',
        headers,
        cache: 'no-store',
      })
      const status = res.status
      const contentType = res.headers.get('content-type') ?? undefined
      let elementCount = 0
      let firstOrderIds: string[] = []
      let bodyPreview: string | undefined
      let errorBody: string | undefined

      // Capture the raw body text first. We always need it — the
      // 200/empty-elements case is exactly the ambiguous one where
      // the parsed view hides the real Clover response.
      const rawText = await res.text().catch(() => '')
      bodyPreview = rawText.slice(0, 600).replace(/\s+/g, ' ').trim()

      if (res.ok) {
        try {
          const payload = JSON.parse(rawText) as {
            elements?: { id?: string }[]
          }
          const elements = payload.elements ?? []
          elementCount = elements.length
          firstOrderIds = elements
            .slice(0, 3)
            .map((e) => e.id ?? '')
            .filter((id) => id.length > 0)
        } catch {
          // Body wasn't JSON — bodyPreview already has the raw text
          // for us to see what Clover sent.
        }
      } else {
        errorBody = rawText.slice(0, 200).replace(/\s+/g, ' ').trim()
      }

      // Redact the merchant id from the URL we return to the client
      // so screenshots don't leak it (it's not strictly a secret but
      // there's no need to splash it across diagnostic UI).
      const safeUrl = probe.url.replace(
        encodeURIComponent(merchantId),
        '{merchant_id}',
      )

      results.push({
        label: probe.label,
        url: safeUrl,
        status,
        elementCount,
        firstOrderIds,
        ...(bodyPreview ? { bodyPreview } : {}),
        ...(contentType ? { contentType } : {}),
        ...(errorBody ? { errorBody } : {}),
      })
    } catch (err) {
      results.push({
        label: probe.label,
        url: probe.url.replace(encodeURIComponent(merchantId), '{merchant_id}'),
        status: 0,
        elementCount: 0,
        firstOrderIds: [],
        errorBody: err instanceof Error ? err.message : 'Unknown error.',
      })
    }
  }

  return { ok: true, probes: results }
}

// ----------------------------------------------------------------
// disconnectClover — removes the Clover configuration for the
// active location. Owner-only. Imported menu/order data stays
// (those rows are identified by provider + external_id and are
// independent of the connection row).
// ----------------------------------------------------------------
export async function disconnectClover(
  prevState: DisconnectResult | null,
  formData: FormData,
): Promise<DisconnectResult> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  const ownerErr = await requireOwnerResult(ctx.restaurantId)
  if (ownerErr) return { error: ownerErr }

  const formLocationId = (formData.get('location_id') as string | null)?.trim() || null
  const { locationId, error: locErr } = await resolveLocationId(ctx, formLocationId)
  if (locErr) return { error: locErr }

  const { error } = await ctx.supabase
    .from('external_pos_connections')
    .delete()
    .eq('restaurant_id', ctx.restaurantId)
    .eq('location_id', locationId)
    .eq('provider', 'clover')

  if (error) return { error: error.message }

  revalidatePath('/settings')
  return { ok: true, message: 'Clover disconnected. Imported menu and sales records were preserved.' }
}
