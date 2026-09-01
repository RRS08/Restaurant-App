// ----------------------------------------------------------------
// /finance — cash-flow dashboard.
//
// v1 surface: adaptive tile row (one per configured account) +
// header (cash on hand, weekly in/out) + "Every movement" ledger
// + Add expense drawer. Every account is owner-defined; two are
// auto-seeded on first visit (POS + Register per retail location).
//
// Read-only for now; POS batch settlement events will land as
// auto movements in v1.5. Plaid connection for live account
// balances lands in v1.5 too, wiring into the existing
// lib/bank/provider.ts abstraction.
//
// Scoped to the active place — Mercado's Finance sees Mercado's
// register + shop-wide POS/bank; Online's Finance sees the
// online-scoped accounts (which today = POS-deposits-pending
// only).
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveActivePlace } from '@/lib/places'
import { ensureFinanceSeeds } from '@/lib/finance/seed'
import { listAccounts, listCategories, listMovements, cashOnHand, inOutTotals } from '@/lib/finance/data'
import { getLang } from '@/lib/i18n-server'
import { isPlaidConfigured } from '@/lib/plaid/client'
import FinanceClient from './client'
import ComingSoon from '@/components/coming-soon'

export const metadata = { title: 'Finance · Checked' }

export default async function FinancePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return <ComingSoon eyebrow="FINANCE" title="Sign in required" body="You need to be signed in to view finance." />

  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role) return <ComingSoon eyebrow="FINANCE" title="No restaurant" body="Finish onboarding to see finance." />

  const restaurantId = role.restaurant_id as string
  const admin = createAdminClient()

  // First-visit seeding — idempotent. Ensures the operator lands
  // with the starter categories + auto-seeded POS/Register
  // accounts, so an empty ledger doesn't feel broken.
  await ensureFinanceSeeds(admin, restaurantId)

  const activePlace = await resolveActivePlace(supabase, restaurantId)

  // 90-day window feeds every tab: Overview reads 12 weeks, the
  // Transactions ledger scopes to whatever the operator picks, and
  // Recurring detection needs enough history to spot ≥2 charges at
  // a monthly cadence. The header's "this month" numbers are
  // derived from a subset below.
  //
  // Finance is a monthly heartbeat, not a weekly one — rent,
  // payroll, subscriptions, and every recurring obligation cycles
  // monthly, so a merchant's "am I ahead or behind" only reads
  // right on a month scope.
  const now = new Date()
  const monthStart = startOfMonth(now)
  const windowStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)

  const [accounts, categories, movements] = await Promise.all([
    listAccounts(admin, restaurantId, { locationId: activePlace?.id ?? null }),
    listCategories(admin, restaurantId),
    listMovements(admin, restaurantId, { from: windowStart, limit: 2000 }),
  ])

  const cash = cashOnHand(accounts)
  const io = inOutTotals(movements.filter(m => new Date(m.occurred_at) >= monthStart))

  const lang = await getLang()

  return (
    <FinanceClient
      lang={lang}
      accounts={accounts}
      categories={categories}
      movements={movements}
      cashOnHand={cash}
      periodIn={io.in}
      periodOut={io.out}
      periodStart={monthStart.toISOString()}
      activePlaceId={activePlace?.id ?? null}
      plaidConfigured={isPlaidConfigured()}
    />
  )
}

/** First of the month, local time, 00:00. Same tz caveat as the
 *  sales page — pilot works in browser/server local tz. */
function startOfMonth(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), 1)
  out.setHours(0, 0, 0, 0)
  return out
}
