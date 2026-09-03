// ----------------------------------------------------------------
// POST /api/plaid/webhook
//
// Plaid POSTs here whenever an Item's data changes — new tx
// available, an item error, a permission revoked, etc. We
// authenticate the request via Plaid's JWT signature scheme
// (plaid-verification header), look up which restaurant owns the
// item_id, and dispatch to the existing sync pipeline.
//
// Signature verification steps (per Plaid docs):
//   1. Read `plaid-verification` header (a JWT with ES256).
//   2. Pull the JWT's `kid` from the header.
//   3. Fetch the JWK for that kid via /webhook_verification_key/get.
//      Rotate: cache is intentionally not implemented at pilot
//      scale — a couple extra calls per webhook is cheap and keeps
//      key-rotation transparent.
//   4. Verify the JWT signature against that JWK.
//   5. SHA-256 hash the raw request body; compare against the
//      JWT's request_body_sha256 claim. Mismatch = reject.
//   6. Reject JWTs older than 5 minutes to block replay attacks.
//
// Dispatch: syncPlaidItem + materializeFinanceMovements. Errors
// during dispatch DO NOT re-throw to Plaid — we always 200 so
// Plaid stops retrying, and log the failure for our own review.
// The 30-minute safety cron will re-catch anything we drop.
// ----------------------------------------------------------------

import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose'
import { createAdminClient } from '@/lib/supabase/admin'
import { getPlaidClient, isPlaidConfigured } from '@/lib/plaid/client'
import { syncPlaidItem } from '@/lib/bank/providers/plaid'
import { materializeFinanceMovements } from '@/lib/finance/materialize'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_JWT_AGE_MS = 5 * 60 * 1000  // Plaid recommends 5 min

export async function POST(req: Request) {
  if (!isPlaidConfigured()) {
    // Return 200 so Plaid stops retrying against an unconfigured env.
    return NextResponse.json({ ok: false, reason: 'plaid-not-configured' })
  }

  const raw = await req.text()

  // -------- Signature verify ---------------------------------------
  const jwt = req.headers.get('plaid-verification')
  if (!jwt) {
    return NextResponse.json({ ok: false, reason: 'missing-verification' }, { status: 401 })
  }

  let kid: string | undefined
  try {
    const header = decodeProtectedHeader(jwt)
    kid = header.kid
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad-jwt-header' }, { status: 401 })
  }
  if (!kid) return NextResponse.json({ ok: false, reason: 'no-kid' }, { status: 401 })

  let jwk: JWK
  try {
    const plaid = getPlaidClient()
    const keyRes = await plaid.webhookVerificationKeyGet({ key_id: kid })
    jwk = keyRes.data.key as unknown as JWK
  } catch (err) {
    console.error('[plaid:webhook] key fetch failed', err)
    return NextResponse.json({ ok: false, reason: 'key-fetch-failed' }, { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    const key = await importJWK(jwk, 'ES256')
    const verified = await jwtVerify(jwt, key, {
      algorithms: ['ES256'],
      maxTokenAge: `${MAX_JWT_AGE_MS / 1000}s`,
    })
    payload = verified.payload as Record<string, unknown>
  } catch (err) {
    console.error('[plaid:webhook] jwt verify failed', err)
    return NextResponse.json({ ok: false, reason: 'bad-signature' }, { status: 401 })
  }

  const bodyHash = createHash('sha256').update(raw).digest('hex')
  if (payload.request_body_sha256 !== bodyHash) {
    return NextResponse.json({ ok: false, reason: 'body-hash-mismatch' }, { status: 401 })
  }

  // -------- Parse + dispatch ---------------------------------------
  let event: PlaidWebhookBody
  try {
    event = JSON.parse(raw) as PlaidWebhookBody
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad-json' }, { status: 400 })
  }

  // Only transactions-family codes trigger a sync. Item errors log
  // for now — a future pass will surface a re-link banner in the UI.
  const isTxCode =
    event.webhook_type === 'TRANSACTIONS' &&
    (event.webhook_code === 'SYNC_UPDATES_AVAILABLE' ||
     event.webhook_code === 'DEFAULT_UPDATE' ||
     event.webhook_code === 'HISTORICAL_UPDATE' ||
     event.webhook_code === 'INITIAL_UPDATE' ||
     event.webhook_code === 'TRANSACTIONS_REMOVED')

  if (!isTxCode) {
    if (event.webhook_type === 'ITEM') {
      console.log('[plaid:webhook] item event', event.webhook_code, event.item_id)
    }
    return NextResponse.json({ ok: true, ignored: true })
  }

  if (!event.item_id) {
    return NextResponse.json({ ok: false, reason: 'no-item-id' }, { status: 400 })
  }

  // Look up which restaurant owns this item. bank_provider_secrets
  // is the authoritative map (item_id → restaurant_id) since the
  // secret is created at exchange time.
  const admin = createAdminClient()
  const { data: secret } = await admin
    .from('bank_provider_secrets')
    .select('restaurant_id')
    .eq('provider', 'plaid')
    .eq('provider_item_id', event.item_id)
    .maybeSingle()

  if (!secret?.restaurant_id) {
    // Item we don't recognize — possibly a stale webhook after a
    // /item/remove. Return 200 so Plaid stops retrying.
    return NextResponse.json({ ok: true, unknown: true })
  }

  try {
    const sync = await syncPlaidItem(admin, secret.restaurant_id as string, event.item_id)
    if (sync.error) console.error('[plaid:webhook] sync error', event.item_id, sync.error)
    const mat = await materializeFinanceMovements(admin, secret.restaurant_id as string, 'webhook')
    if (mat.error) console.error('[plaid:webhook] materialize error', mat.error)
  } catch (err) {
    console.error('[plaid:webhook] dispatch failed', event.item_id, err)
  }

  // Always 200 — the cron will retry anything we missed.
  return NextResponse.json({ ok: true })
}

interface PlaidWebhookBody {
  webhook_type?: string
  webhook_code?: string
  item_id?: string
  error?: unknown
}
