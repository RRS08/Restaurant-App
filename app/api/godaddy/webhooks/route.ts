// ----------------------------------------------------------------
// POST /api/godaddy/webhooks
//
// Real-time push receiver for Poynt Cloud events. Every merchant
// who installs our app has a webhook registered to this URL (see
// lib/godaddy/webhooks.ts#registerMerchantWebhook). Poynt POSTs
// here whenever a subscribed event fires:
//
//   • ORDER_COMPLETED   → new sale to ingest
//   • ORDER_CANCELLED   → void — the ingest pipeline handles it
//   • ORDER_UPDATED     → refund / edit — re-ingest picks up the
//                         current state
//
// Flow:
//   1. Read the raw body.
//   2. Schedule the heavy work (parse → verify → fetch → ingest
//      → audit) in `after()` so the response goes back fast.
//   3. Return 200 immediately.
//
// Why `after()`: Poynt's docs (§9) require a 200 within 2 seconds
// or they retry. The synchronous path was hitting 1-2.5 s under
// normal load (Poynt API roundtrip + ingest DB writes) and
// exceeding on any latency spike or Vercel cold start — that's
// the "inconsistent" behavior the pilot merchant saw (some sales
// arrive in 2 min, others in 2 h when only a lucky cron finally
// catches them). Deferring the heavy work drops the response
// time to ~50 ms and gives us the full Vercel function budget
// (~30 s via waitUntil) for the actual work.
//
// Every hit records a row in `webhook_events` regardless of
// outcome (success, drop, error) so we have a persistent audit
// trail independent of Vercel's log retention. Query with:
//
//   select received_at, event_type, drop_reason, error_msg
//   from webhook_events
//   order by received_at desc
//   limit 20;
//
// Contract with Poynt:
//   • Respond with HTTP 200 within ~2 seconds or Poynt retries.
//   • Any 4xx we return counts as a "signal to Poynt to give up
//     on this event." We use 200 even for signature failures so
//     an attacker can't distinguish rejected vs accepted; the
//     bad payload just gets dropped without acting on it.
// ----------------------------------------------------------------

import { NextResponse, type NextRequest, after } from 'next/server'
import { fetchSinglePoyntOrder } from '@/lib/godaddy/api'
import {
  parseWebhookPayload,
  verifyWebhookSignature,
  findByBusinessId,
} from '@/lib/godaddy/webhooks'
import { ingestSinglePoyntOrder } from '@/lib/godaddy/ingest'
import { createAdminClient } from '@/lib/supabase/admin'

// Vercel edge runtime doesn't expose crypto's timingSafeEqual /
// createHmac in the shape we need; pin to Node.
export const runtime = 'nodejs'

// Snapshot of every header on the incoming request, minus anything
// Authorization-shaped so we don't dump credentials into logs. Used
// for diagnosis when a webhook drops silently — the exact header
// name Poynt uses for its signature has been a moving target.
function snapshotHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (k === 'authorization' || k.includes('cookie') || k.includes('token')) return
    out[k] = value.length > 200 ? value.slice(0, 200) + '…' : value
  })
  return out
}

// Enum of drop-reason slugs written to webhook_events.drop_reason.
// Keeping them as string literals rather than a real enum so the
// migration doc + this file stay in sync visually.
type DropReason =
  | 'unparseable_body'
  | 'payload_missing_required_fields'
  | 'no_linked_restaurant'
  | 'no_webhook_secret'
  | 'signature_mismatch'
  | 'order_fetch_failed'
  | 'handler_threw'

interface AuditEntry {
  business_id: string | null
  restaurant_id: string | null
  event_type: string | null
  http_status: number
  drop_reason: DropReason | null
  raw_body: string | null
  header_keys: string[]
  error_msg: string | null
}

/** Persist a webhook_events row. Never throws — audit failures
 *  must not affect the response to Poynt. Truncates raw_body to
 *  2000 chars as a size + safety guardrail. */
async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const admin = createAdminClient()
    await admin.from('webhook_events').insert({
      provider: 'godaddy_poynt',
      business_id: entry.business_id,
      restaurant_id: entry.restaurant_id,
      event_type: entry.event_type,
      http_status: entry.http_status,
      drop_reason: entry.drop_reason,
      raw_body: entry.raw_body ? entry.raw_body.slice(0, 2000) : null,
      header_keys: entry.header_keys,
      error_msg: entry.error_msg ? entry.error_msg.slice(0, 500) : null,
    })
  } catch (err) {
    console.warn('[godaddy/webhooks] audit insert failed (non-fatal)', err)
  }
}

/** All the work that used to be synchronous. Now runs in the
 *  after() callback so the response can ack Poynt in <100 ms.
 *  Sets audit.drop_reason to null on success, otherwise a slug. */
async function processWebhook(args: {
  rawBody: string
  headers: Headers
  audit: AuditEntry
}): Promise<void> {
  const { rawBody, headers, audit } = args
  const bodySnippet = rawBody.length > 800 ? rawBody.slice(0, 800) + '…' : rawBody
  const headerSnapshot = snapshotHeaders(headers)

  let json: unknown = null
  try {
    json = JSON.parse(rawBody)
  } catch {
    audit.drop_reason = 'unparseable_body'
    console.warn('[godaddy/webhooks] DROP: unparseable body', {
      body: bodySnippet,
      headers: headerSnapshot,
    })
    return
  }

  const parsed = parseWebhookPayload(json)
  audit.event_type = parsed.eventType
  audit.business_id = parsed.businessId

  console.info('[godaddy/webhooks] event', {
    eventType: parsed.eventType,
    hasBusinessId: !!parsed.businessId,
    hasResourceId: !!parsed.resourceId,
    businessIdSample: parsed.businessId?.slice(0, 8),
  })

  if (!parsed.businessId || !parsed.resourceId || !parsed.eventType) {
    audit.drop_reason = 'payload_missing_required_fields'
    console.warn('[godaddy/webhooks] DROP: payload missing required fields', {
      parsed,
      body: bodySnippet,
      headers: headerSnapshot,
    })
    return
  }

  const conn = await findByBusinessId(parsed.businessId)
  if (!conn) {
    audit.drop_reason = 'no_linked_restaurant'
    console.warn('[godaddy/webhooks] DROP: no linked restaurant for businessId', {
      businessId: parsed.businessId,
      body: bodySnippet,
    })
    return
  }
  audit.restaurant_id = conn.restaurantId

  if (!conn.webhookSecret) {
    audit.drop_reason = 'no_webhook_secret'
    console.warn('[godaddy/webhooks] DROP: merchant has no webhook_secret on file — registration likely failed at install', {
      restaurantId: conn.restaurantId,
    })
    return
  }

  // Signature verification. Poynt sends `Poynt-Webhook-Signature`
  // per their webhooks doc §7 — the exact header name we missed
  // in the first pass, which caused every real webhook to drop
  // as `signature_mismatch`. Fallback names are kept for other
  // less-common webhook shapes (Poynt has multiple product lines
  // and the terminal SDK historically used different names).
  const sigHeader =
    headers.get('poynt-webhook-signature')
    ?? headers.get('x-poynt-webhook-signature')
    ?? headers.get('x-hook-signature')
    ?? headers.get('poynt-signature')
  const valid = verifyWebhookSignature({
    rawBody,
    signatureHeader: sigHeader,
    secret: conn.webhookSecret,
  })
  if (!valid) {
    audit.drop_reason = 'signature_mismatch'
    console.warn('[godaddy/webhooks] DROP: signature mismatch', {
      hasHeader: !!sigHeader,
      headerSample: sigHeader?.slice(0, 20),
      headers: headerSnapshot,
      body: bodySnippet,
    })
    return
  }

  // Fetch the full order + ingest.
  try {
    const fetched = await fetchSinglePoyntOrder({
      restaurantId: conn.restaurantId,
      orderId: parsed.resourceId,
    })
    if ('error' in fetched) {
      audit.drop_reason = 'order_fetch_failed'
      audit.error_msg = fetched.error
      console.error('[godaddy/webhooks] order fetch failed', fetched.error)
      return
    }

    const result = await ingestSinglePoyntOrder({
      restaurantId: conn.restaurantId,
      order: fetched.order,
    })
    console.info('[godaddy/webhooks] ingested', {
      eventType: parsed.eventType,
      orderId: parsed.resourceId,
      inserted: result.ordersInserted,
      skipped: result.ordersSkipped,
      failed: result.ordersFailed,
    })
    // drop_reason stays null → success.
  } catch (err) {
    audit.drop_reason = 'handler_threw'
    audit.error_msg = err instanceof Error ? err.message : String(err)
    console.error('[godaddy/webhooks] handler threw', err)
  }
}

export async function POST(req: NextRequest) {
  // Read body up front — needed for both the ack path and the
  // deferred processing. Cloning is not enough because the raw
  // bytes must be preserved verbatim for signature verification.
  const rawBody = await req.text()

  // Capture the header set NOW while the request is live. `after()`
  // outlives the request context, so `req.headers` inside the
  // callback may be unsafe to read on some runtimes. Cloning to
  // a fresh Headers object keeps us safe.
  const headers = new Headers(req.headers)

  console.info('[godaddy/webhooks] hit', {
    contentLength: rawBody.length,
    contentType: headers.get('content-type'),
    headerKeys: Array.from(headers.keys()),
  })

  const audit: AuditEntry = {
    business_id: null,
    restaurant_id: null,
    event_type: null,
    http_status: 200,
    drop_reason: null,
    raw_body: rawBody,
    header_keys: Array.from(headers.keys()),
    error_msg: null,
  }

  // Schedule the heavy work AFTER the response is sent. On Vercel
  // this uses waitUntil under the hood — the function keeps
  // running for up to ~30 s while the client already has its 200.
  // If processing throws, the finally always records an audit
  // row so we see what happened.
  after(async () => {
    try {
      await processWebhook({ rawBody, headers, audit })
    } catch (err) {
      audit.drop_reason = 'handler_threw'
      audit.error_msg = err instanceof Error ? err.message : String(err)
      console.error('[godaddy/webhooks] processWebhook threw', err)
    } finally {
      await recordAudit(audit)
    }
  })

  // Ack Poynt immediately. We haven't done the work yet, but the
  // work is scheduled and the retry contract is satisfied.
  return NextResponse.json({ ok: true }, { status: 200 })
}

// A GET on this path is handy for Poynt's admin UI (some hook
// providers hit GET as a liveness check before registration) and
// for our own debugging in the browser. Returns a tiny status
// blob and never leaks anything.
export async function GET() {
  return NextResponse.json({ ok: true, service: 'godaddy-webhooks' }, { status: 200 })
}
