// ----------------------------------------------------------------
// GET /api/cron/godaddy-sync
//
// Sync poker for every merchant with an active GoDaddy Poynt
// connection. Called on a schedule by an external cron (currently
// GitHub Actions, .github/workflows/godaddy-sync.yml, */15 min).
// Vercel's built-in cron is not used — the Hobby plan caps
// vercel.json crons to once per day. When the project moves to
// Pro, this route can also be scheduled via vercel.json without
// changing the handler.
//
// Auth model: caller signs the request with
// `Authorization: Bearer {CRON_SECRET}`. Anything without that
// header 401s. The env var is set in Vercel Production + used
// by the GitHub Actions workflow via secrets.CRON_SECRET.
//
// Belt & suspenders on runtime + timing:
//   • runtime: 'nodejs' — needs Node built-ins (crypto for the
//     JWT signer downstream, plus admin-client init).
//   • maxDuration: 60 — a full sync across a few busy merchants
//     shouldn't exceed this, but on a Hobby plan the platform
//     default is 10s which would time out. Every merchant's
//     work is wrapped in try/catch so one slow shop doesn't
//     starve the rest. Hobby's ceiling still wins over this
//     value until the project moves to Pro.
// ----------------------------------------------------------------

import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runSyncForRestaurant } from '@/app/actions/godaddy-sync'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : ''
  if (!expected || auth !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const { data: connections, error } = await admin
    .from('godaddy_poynt_tokens')
    .select('restaurant_id, business_id')

  if (error) {
    console.error('[cron/godaddy-sync] failed to list connections', error)
    return NextResponse.json({ ok: false, error: 'list-connections-failed' }, { status: 500 })
  }

  const rows = connections ?? []
  console.info('[cron/godaddy-sync] starting', { merchants: rows.length })

  const perMerchant: Array<{
    restaurantId: string; businessId: string
    inserted: number; skipped: number; failed: number; notes: string[]
    error: string | null
  }> = []

  for (const row of rows) {
    const restaurantId = row.restaurant_id as string
    const businessId = row.business_id as string
    try {
      const r = await runSyncForRestaurant(restaurantId)
      perMerchant.push({
        restaurantId,
        businessId,
        inserted: r.ordersInserted,
        skipped: r.ordersSkipped,
        failed: r.ordersFailed,
        notes: r.notes,
        error: r.error,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[cron/godaddy-sync] merchant threw', { restaurantId, businessId, err: msg })
      perMerchant.push({
        restaurantId, businessId,
        inserted: 0, skipped: 0, failed: 0, notes: [],
        error: `threw: ${msg}`,
      })
    }
  }

  const totalInserted = perMerchant.reduce((sum, m) => sum + m.inserted, 0)
  console.info('[cron/godaddy-sync] done', {
    merchants: perMerchant.length,
    totalInserted,
    withErrors: perMerchant.filter((m) => m.error).length,
  })

  return NextResponse.json({ ok: true, merchants: perMerchant.length, totalInserted })
}
