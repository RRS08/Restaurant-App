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
//   1. Read the raw body once for signature verification.
//   2. Parse the envelope to pull { businessId, resourceId, eventType }.
//   3. Look up which restaurant this businessId belongs to.
//   4. Verify the SHA1 HMAC against the per-merchant secret we
//      generated at registration time. Constant-time compare.
//   5. Fetch the full order from Poynt's Cloud API (the envelope
//      only carries an id + links, per spec §8).
//   6. Ingest via the shared normalize/ingest path — same code
//      the manual "Sync now" button runs.
//
// Contract with Poynt:
//   • Respond with HTTP 200 within ~2 seconds or Poynt retries.
//     We do the work synchronously since single-order fetch +
//     ingest is well within 2s, but longer async paths would
//     want to enqueue and return 200 fast.
//   • Any 4xx we return counts as a "signal to Poynt to give up
//     on this event." We use 200 even for signature failures so
//     an attacker can't distinguish rejected vs accepted; the
//     bad payload just gets dropped without acting on it.
// ----------------------------------------------------------------

import { NextResponse, type NextRequest } from 'next/server'
import { fetchSinglePoyntOrder } from '@/lib/godaddy/api'
import {
  parseWebhookPayload,
  verifyWebhookSignature,
  findByBusinessId,
} from '@/lib/godaddy/webhooks'
import { ingestSinglePoyntOrder } from '@/lib/godaddy/ingest'

// Vercel edge runtime doesn't expose crypto's timingSafeEqual /
// createHmac in the shape we need; pin to Node.
export const runtime = 'nodejs'

// Snapshot of every header on the incoming request, minus anything
// Authorization-shaped so we don't dump credentials into logs. Used
// for diagnosis when a webhook drops silently — the exact header
// name Poynt uses for its signature has been a moving target.
function snapshotHeaders(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    if (k === 'authorization' || k.includes('cookie') || k.includes('token')) return
    out[k] = value.length > 200 ? value.slice(0, 200) + '…' : value
  })
  return out
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  // Truncated body for diagnostic logs. Kept small enough not to
  // blow up log volume but big enough to see the envelope shape.
  const bodySnippet = rawBody.length > 800 ? rawBody.slice(0, 800) + '…' : rawBody
  const headerSnapshot = snapshotHeaders(req)

  console.info('[godaddy/webhooks] hit', {
    contentLength: rawBody.length,
    contentType: req.headers.get('content-type'),
    headerKeys: Object.keys(headerSnapshot),
  })

  let json: unknown = null
  try {
    json = JSON.parse(rawBody)
  } catch {
    console.warn('[godaddy/webhooks] DROP: unparseable body', {
      body: bodySnippet,
      headers: headerSnapshot,
    })
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  const parsed = parseWebhookPayload(json)
  console.info('[godaddy/webhooks] event', {
    eventType: parsed.eventType,
    hasBusinessId: !!parsed.businessId,
    hasResourceId: !!parsed.resourceId,
    businessIdSample: parsed.businessId?.slice(0, 8),
  })

  if (!parsed.businessId || !parsed.resourceId || !parsed.eventType) {
    console.warn('[godaddy/webhooks] DROP: payload missing required fields', {
      parsed,
      body: bodySnippet,
      headers: headerSnapshot,
    })
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  const conn = await findByBusinessId(parsed.businessId)
  if (!conn) {
    console.warn('[godaddy/webhooks] DROP: no linked restaurant for businessId', {
      businessId: parsed.businessId,
      body: bodySnippet,
    })
    return NextResponse.json({ ok: true }, { status: 200 })
  }
  if (!conn.webhookSecret) {
    console.warn('[godaddy/webhooks] DROP: merchant has no webhook_secret on file — registration likely failed at install', {
      restaurantId: conn.restaurantId,
    })
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  // Signature verification. Poynt's docs describe SHA1 HMAC over
  // the raw body. Header name isn't fully specified in the doc
  // snippet — check the common variants.
  const sigHeader =
    req.headers.get('x-hook-signature')
    ?? req.headers.get('x-poynt-signature')
    ?? req.headers.get('poynt-signature')
    ?? req.headers.get('x-signature')
  const valid = verifyWebhookSignature({
    rawBody,
    signatureHeader: sigHeader,
    secret: conn.webhookSecret,
  })
  if (!valid) {
    // Signature mismatch — could be a wrong header name (Poynt sends
    // under a name we don't check), a wrong algorithm (SHA256 instead
    // of SHA1), or a stale secret from a re-register. Log the header
    // snapshot so next time we can spot the actual name.
    console.warn('[godaddy/webhooks] DROP: signature mismatch', {
      hasHeader: !!sigHeader,
      headerSample: sigHeader?.slice(0, 20),
      headers: headerSnapshot,
      body: bodySnippet,
    })
    // 200 deliberately — see contract comment above.
    return NextResponse.json({ ok: true }, { status: 200 })
  }

  // Fetch the full order + ingest. All errors are swallowed to a
  // 200 so Poynt doesn't retry endlessly on our-side failures.
  try {
    const fetched = await fetchSinglePoyntOrder({
      restaurantId: conn.restaurantId,
      orderId: parsed.resourceId,
    })
    if ('error' in fetched) {
      console.error('[godaddy/webhooks] order fetch failed', fetched.error)
      return NextResponse.json({ ok: true }, { status: 200 })
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
  } catch (err) {
    console.error('[godaddy/webhooks] handler threw', err)
  }

  return NextResponse.json({ ok: true }, { status: 200 })
}

// A GET on this path is handy for Poynt's admin UI (some hook
// providers hit GET as a liveness check before registration) and
// for our own debugging in the browser. Returns a tiny status
// blob and never leaks anything.
export async function GET() {
  return NextResponse.json({ ok: true, service: 'godaddy-webhooks' }, { status: 200 })
}
