// ----------------------------------------------------------------
// GET /api/plaid/cron
//
// Safety-net cron for the Plaid pipeline. Runs every 30 minutes
// via Vercel Cron (configured in vercel.json). Iterates every
// active Plaid Item across every restaurant and:
//
//   1. Drains /transactions/sync (catches anything the webhook
//      missed — Plaid can drop the odd delivery under load, and
//      dev webhooks aren't retried once the tunnel dies).
//   2. Materializes fresh raw rows into finance_movements.
//   3. Refreshes live balances so tile totals stay honest even on
//      a quiet day (no tx = no webhook = no sync trigger).
//
// Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
// on every scheduled invocation. Set CRON_SECRET in the env and
// this endpoint refuses anything without a matching header.
// ----------------------------------------------------------------

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getPlaidClient, isPlaidConfigured } from '@/lib/plaid/client'
import { syncPlaidItem } from '@/lib/bank/providers/plaid'
import { materializeFinanceMovements } from '@/lib/finance/materialize'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: Request) {
  const auth = req.headers.get('authorization')
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ ok: false, reason: 'no-secret-configured' }, { status: 500 })
  }
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 })
  }
  if (!isPlaidConfigured()) {
    return NextResponse.json({ ok: false, reason: 'plaid-not-configured' })
  }

  const admin = createAdminClient()

  // Every unique (restaurant, item) pair. Secrets table is
  // authoritative — an item without a secret can't be synced.
  const { data: secrets } = await admin
    .from('bank_provider_secrets')
    .select('restaurant_id, provider_item_id, access_token')
    .eq('provider', 'plaid')
  const items = (secrets ?? []) as Array<{
    restaurant_id: string
    provider_item_id: string
    access_token: string
  }>

  const summary = { items: items.length, synced: 0, materialized: 0, balanceUpdates: 0, errors: 0 }
  const touchedRestaurants = new Set<string>()

  for (const item of items) {
    try {
      const sync = await syncPlaidItem(admin, item.restaurant_id, item.provider_item_id)
      if (sync.error) { summary.errors += 1; continue }
      summary.synced += 1
      touchedRestaurants.add(item.restaurant_id)
    } catch (err) {
      console.error('[plaid:cron] sync failed', item.provider_item_id, err)
      summary.errors += 1
    }
  }

  // Materialize once per touched restaurant — materialize is
  // restaurant-scoped, not item-scoped, so running it per-item
  // would just repeat the same work.
  for (const restaurantId of touchedRestaurants) {
    try {
      const mat = await materializeFinanceMovements(admin, restaurantId)
      if (!mat.error) summary.materialized += mat.inserted
    } catch (err) {
      console.error('[plaid:cron] materialize failed', restaurantId, err)
      summary.errors += 1
    }
  }

  // Balance refresh — quiet days (no tx) still need this. One call
  // per item; results grouped by provider_account_id so we can
  // write back into finance_accounts.
  const plaid = getPlaidClient()
  const balanceByRefByRestaurant = new Map<string, Map<string, number>>()
  await Promise.all(items.map(async (item) => {
    try {
      const res = await plaid.accountsBalanceGet({ access_token: item.access_token })
      const bucket = balanceByRefByRestaurant.get(item.restaurant_id) ?? new Map<string, number>()
      for (const acct of res.data.accounts ?? []) {
        const bal = acct.balances?.available ?? acct.balances?.current
        if (typeof bal === 'number' && Number.isFinite(bal)) {
          bucket.set(acct.account_id, bal)
        }
      }
      balanceByRefByRestaurant.set(item.restaurant_id, bucket)
    } catch (err) {
      console.error('[plaid:cron] balance fetch failed', item.provider_item_id, err)
    }
  }))

  for (const [restaurantId, byRef] of balanceByRefByRestaurant.entries()) {
    if (byRef.size === 0) continue
    const { data: tiles } = await admin
      .from('finance_accounts')
      .select('id, provider_ref')
      .eq('restaurant_id', restaurantId)
      .eq('provider', 'plaid')
      .eq('active', true)
    for (const t of tiles ?? []) {
      const pr = (t as { provider_ref: string | null }).provider_ref
      if (!pr) continue
      const next = byRef.get(pr)
      if (next === undefined) continue
      await admin
        .from('finance_accounts')
        .update({ balance: next, updated_at: new Date().toISOString() })
        .eq('id', (t as { id: string }).id)
      summary.balanceUpdates += 1
    }
  }

  return NextResponse.json({ ok: true, summary })
}
