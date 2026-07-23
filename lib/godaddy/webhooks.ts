// ----------------------------------------------------------------
// GoDaddy Poynt — webhook helpers
//
// Two-way street with Poynt for the "live" leg of the ingest:
//
//   • registerMerchantWebhook — called from the OAuth callback
//     after we successfully exchange the code for tokens.
//     Generates a per-merchant secret, POSTs the delivery URL +
//     event types to Poynt, and stores the webhook id + secret
//     alongside the token row. Fire-and-forget: if the registration
//     fails, we log and move on so the connect flow still lands
//     the merchant in "Connected" state. Manual "Sync now" still
//     works; we'll surface a "re-register webhook" affordance in
//     Settings later.
//
//   • verifyWebhookSignature — validates the SHA1 HMAC on each
//     incoming event using the per-merchant secret. Poynt's spec
//     §8 says events come signed and must be validated; we bail
//     on any mismatch (constant-time compare).
//
//   • parseWebhookPayload — normalizes the several possible
//     shapes Poynt uses for the push envelope so the route
//     handler can pull { businessId, resourceId, eventType }
//     without repeating a defensive walk.
//
// The exact registration endpoint isn't nailed down in the doc
// snippet we have — "POST to the hooks endpoint." We POST to
// /businesses/{businessId}/hooks (per-business scoping matches
// how Poynt's other endpoints are shaped). If the actual path is
// different, the error surfaces clearly in Vercel Logs and we
// adjust — the manual sync path keeps working meanwhile.
// ----------------------------------------------------------------

import { createHmac, timingSafeEqual, randomBytes, randomUUID } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'

const API_VERSION = '1.2'

function baseUrl(): string {
  return process.env.GODADDY_POYNT_BASE_URL || 'https://services.poynt.net'
}

// Events we care about — completed sales flow into ingest;
// cancellations reverse via the void path; updates cover partial
// refunds / edits. `ORDER_OPENED` is intentionally omitted: we
// don't want to import a half-typed cart before the merchant
// closes it out.
const SUBSCRIBED_EVENTS = ['ORDER_COMPLETED', 'ORDER_CANCELLED', 'ORDER_UPDATED'] as const

interface RegisterHookResponse {
  id?: string
  hookId?: string
}

/** Register the delivery URL with Poynt for a specific merchant.
 *  Persists the returned hook id + our locally-generated secret
 *  alongside the token row so the incoming events can be verified
 *  and, later, the hook can be rotated/deleted.
 *
 *  Endpoint: POST /hooks (app-level, NOT /businesses/{id}/hooks —
 *  that path 404s). Body carries both applicationId AND businessId
 *  so Poynt scopes the hook to (app, merchant). Per Poynt's
 *  webhooks docs. */
export async function registerMerchantWebhook(args: {
  restaurantId: string
  businessId: string
  accessToken: string
  deliveryUrl: string
}): Promise<{ ok: true } | { error: string }> {
  const applicationId = process.env.GODADDY_POYNT_APP_ID
  if (!applicationId) {
    return { error: 'GODADDY_POYNT_APP_ID env var is not set — cannot register a webhook.' }
  }
  const secret = randomBytes(32).toString('hex')

  const body = {
    applicationId,
    businessId: args.businessId,
    deliveryUrl: args.deliveryUrl,
    secret,
    eventTypes: [...SUBSCRIBED_EVENTS],
  }

  try {
    const res = await fetch(
      `${baseUrl()}/hooks`,
      {
        method: 'POST',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json;charset=UTF-8',
          'api-version': API_VERSION,
          'Poynt-Request-Id': randomUUID(),
          Authorization: `BEARER ${args.accessToken}`,
        },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        error: `Poynt hook registration failed (${res.status} ${res.statusText}) — ${text.slice(0, 300)}`,
      }
    }
    const json = (await res.json().catch(() => null)) as RegisterHookResponse | null
    const hookId = (json?.id ?? json?.hookId ?? '').trim() || null

    // Persist the secret regardless of whether we got a hook id
    // back — if Poynt did register but returned an unexpected
    // shape, incoming events will still validate. Missing hookId
    // just means we can't cleanly delete the hook later.
    const admin = createAdminClient()
    const { error } = await admin
      .from('godaddy_poynt_tokens')
      .update({ webhook_id: hookId, webhook_secret: secret, updated_at: new Date().toISOString() })
      .eq('restaurant_id', args.restaurantId)
      .eq('business_id', args.businessId)
    if (error) return { error: `Persisting webhook secret failed: ${error.message}` }

    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `Poynt hook registration threw: ${msg}` }
  }
}

/** SHA1 HMAC verification per Poynt's webhooks doc.
 *
 *  Two details that had to be gotten exactly right (both had bugs
 *  in the initial implementation, which is why every webhook was
 *  landing as `signature_mismatch` in the audit):
 *
 *    1. Digest encoding is BASE64, not hex. Poynt's Node SDK
 *       example does `.digest("base64")` and every real payload
 *       header is a base64 string ending in `=`. Our earlier hex
 *       digest would never match a base64 header of any length.
 *
 *    2. Header value is a plain base64 string with no `sha1=`
 *       prefix (unlike GitHub / SES conventions). Kept the
 *       forgiving `^sha1=` strip anyway in case Poynt ever adds
 *       one.
 *
 *  Constant-time compare via timingSafeEqual so a byte-wise probe
 *  can't leak the secret. Any length mismatch bails early — the
 *  buffer comparison would throw on mismatched lengths otherwise. */
export function verifyWebhookSignature(args: {
  rawBody: string
  signatureHeader: string | null
  secret: string
}): boolean {
  if (!args.signatureHeader) return false
  const expected = createHmac('sha1', args.secret).update(args.rawBody).digest('base64')
  const received = args.signatureHeader.replace(/^sha1=/i, '').trim()
  if (received.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch {
    return false
  }
}

export interface ParsedWebhookEvent {
  businessId: string | null
  resourceId: string | null
  eventType: string | null
}

/** Poynt's webhook envelope shape isn't fully specified in the
 *  docs; empirically it varies by event type and by whether the
 *  payload was minted by the Cloud API vs the Terminal SDK.
 *  Common variants seen in the wild:
 *
 *    { eventType, resourceId,  businessId }
 *    { eventType, entityId,    entityBusinessId }
 *    { type,      id,          businessId }
 *    { event,     data: { id, businessId }, ... }
 *    { eventType, resource: { id, businessId } }
 *
 *  Walk all of them. Nested `data` / `resource` win when a
 *  top-level field is missing so a payload that carries the
 *  order under `data.id` still resolves. */
export function parseWebhookPayload(json: unknown): ParsedWebhookEvent {
  if (!json || typeof json !== 'object') {
    return { businessId: null, resourceId: null, eventType: null }
  }
  const o = json as Record<string, unknown>
  const data = (isRecord(o.data) ? o.data : null) as Record<string, unknown> | null
  const resource = (isRecord(o.resource) ? o.resource : null) as Record<string, unknown> | null
  const entity = (isRecord(o.entity) ? o.entity : null) as Record<string, unknown> | null

  const eventType =
    str(o.eventType) ?? str(o.type) ?? str(o.event) ?? str(o.eventName)

  const businessId =
    str(o.businessId)
    ?? str(o.entityBusinessId)
    ?? str(o.merchantBusinessId)
    ?? str(data?.businessId)
    ?? str(resource?.businessId)
    ?? str(entity?.businessId)

  // resourceId can be several things depending on eventType — an
  // order id, transaction id, entity id. Prefer the most specific.
  const resourceId =
    str(o.resourceId)
    ?? str(o.entityId)
    ?? str(o.orderId)
    ?? str(o.id)
    ?? str(data?.id)
    ?? str(data?.orderId)
    ?? str(resource?.id)
    ?? str(entity?.id)

  return { businessId, resourceId, eventType }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/** Look up a stored merchant connection by businessId — used by
 *  the webhook receiver to figure out which restaurant an event
 *  belongs to. */
export async function findByBusinessId(businessId: string): Promise<
  | { restaurantId: string; webhookSecret: string | null }
  | null
> {
  if (!businessId) return null
  const admin = createAdminClient()
  const { data } = await admin
    .from('godaddy_poynt_tokens')
    .select('restaurant_id, webhook_secret')
    .eq('business_id', businessId)
    .maybeSingle()
  if (!data) return null
  return {
    restaurantId: data.restaurant_id as string,
    webhookSecret: (data.webhook_secret as string | null) ?? null,
  }
}
