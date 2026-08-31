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

  // Weekly window — Monday 00:00 of the current week through now,
  // in the restaurant's tz. The header's "in this week / out"
  // numbers derive from movements in this window.
  const now = new Date()
  const weekStart = startOfWeek(now)

  const [accounts, categories, movements] = await Promise.all([
    listAccounts(admin, restaurantId, { locationId: activePlace?.id ?? null }),
    listCategories(admin, restaurantId),
    listMovements(admin, restaurantId, { from: weekStart, limit: 200 }),
  ])

  const cash = cashOnHand(accounts)
  const io = inOutTotals(movements)

  const lang = await getLang()

  return (
    <FinanceClient
      lang={lang}
      accounts={accounts}
      categories={categories}
      movements={movements}
      cashOnHand={cash}
      weekIn={io.in}
      weekOut={io.out}
      activePlaceId={activePlace?.id ?? null}
      plaidConfigured={isPlaidConfigured()}
    />
  )
}

/** Monday 00:00 of the week that contains `d`, local time. Not
 *  timezone-aware yet — v1 uses the browser / server local tz
 *  which is fine for the pilot. Move to the active place's tz
 *  when the ledger grows date-range navigation. */
function startOfWeek(d: Date): Date {
  const day = d.getDay() // 0 = Sun
  const diff = (day + 6) % 7 // Monday-based
  const out = new Date(d)
  out.setDate(d.getDate() - diff)
  out.setHours(0, 0, 0, 0)
  return out
}
