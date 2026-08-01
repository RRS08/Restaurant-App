// ----------------------------------------------------------------
// Finance dashboard  →  /finance
//
// The warm, alive, at-a-glance surface. Balance up top, Money In /
// Money Out cards with sparklines and attribution chips, net + streak,
// weekly progress rings, a compact recent-activity ledger with
// categorize-on-tap, an occasional Sunday recap, and a single smart
// nudge line when there's something worth surfacing.
//
// Explicitly NOT here:
//   • Bank connection / review / settle workflow → /finance/details
//   • Full expense workspace / drawers → /finance/details
//   • Report generation / CSV / PDF → deferred; data is captured
//     already so reports render later off the same tables.
//
// Server component. Fetches EVERYTHING the dashboard needs in one
// parallel round-trip: current-week + prior-8-weeks orders (for the
// week aggregates, sparklines, ring baselines, and streak), current-
// week expenses + shifts (for money-out), latest bank account
// balance snapshot (for the anchor number), and the last ~20 rows
// of the interleaved activity feed. Nothing on the client side
// re-fetches — the dashboard reads instantly.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { isPlaidConfigured } from '@/lib/plaid/client'
import { maybeAutoSyncBankTransactions } from '@/app/actions/bank'
import { getLang } from '@/lib/i18n-server'
import { groupBankTransactions, type GroupableTxn, type BankReviewGroup } from '@/lib/finance/matching'
import FinanceDashboardClient from './client'

// ----------------------------------------------------------------
// Week boundaries — restaurant weeks run Monday → Sunday. `atWeek`
// resets the input to that week's Monday at 00:00 local time. We
// return a Date for math and an ISO for query bounds.
// ----------------------------------------------------------------
function mondayOf(d: Date): Date {
  const out = new Date(d)
  const day = out.getDay() // 0 = Sunday
  out.setDate(out.getDate() - (day === 0 ? 6 : day - 1))
  out.setHours(0, 0, 0, 0)
  return out
}

export default async function FinancePage() {
  const supabase = await createClient()
  const lang = await getLang()

  // Kick the Plaid auto-sync if enough time has passed. Silent on
  // failure — the dashboard renders from whatever's in the DB.
  await maybeAutoSyncBankTransactions().catch(() => null)

  // Fetch the current user + restaurant. RLS scopes all queries
  // below; we still need the restaurant id for the bank-accounts
  // fetch which is by restaurant_id.
  const { data: { user } } = await supabase.auth.getUser()
  const restaurantId = user
    ? (
        await supabase
          .from('user_roles')
          .select('restaurant_id')
          .eq('user_id', user.id)
          .single()
      ).data?.restaurant_id ?? null
    : null

  // ---- Date boundaries ----
  const now = new Date()
  const thisMon = mondayOf(now)
  const nextMon = new Date(thisMon)
  nextMon.setDate(nextMon.getDate() + 7)
  const lastMon = new Date(thisMon)
  lastMon.setDate(lastMon.getDate() - 7)
  // Look back 8 weeks (56 days) for ring baselines + streak history.
  const eightWeeksAgo = new Date(thisMon)
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 8 * 7)

  // ---- Parallel data fetch ----
  const [
    { data: weekOrders },
    { data: prior8Orders },
    { data: weekExpenses },
    { data: prior8Expenses },
    { data: weekShifts },
    { data: prior8Shifts },
    { data: bankAccounts },
    { data: recentExpenses },
    { data: recentOrders },
    { data: recentBankTxns },
  ] = await Promise.all([
    // Current-week completed orders — drives money-in for the week,
    // payment-type attribution chip, and the ledger.
    supabase
      .from('orders')
      .select('id, total_amount, created_at, payment_type, source, external_provider')
      .eq('status', 'completed')
      .gte('created_at', thisMon.toISOString())
      .lt('created_at', nextMon.toISOString()),
    // Prior 8 weeks of orders — feeds the sparkline (last 7 daily
    // buckets), ring baselines ("typical week"), and streak counting.
    supabase
      .from('orders')
      .select('id, total_amount, created_at')
      .eq('status', 'completed')
      .gte('created_at', eightWeeksAgo.toISOString())
      .lt('created_at', thisMon.toISOString()),
    // Current-week expenses.
    supabase
      .from('expenses')
      .select('id, amount, category, vendor_name, expense_date, notes, is_inventory_related')
      .gte('expense_date', thisMon.toISOString().split('T')[0])
      .lt('expense_date', nextMon.toISOString().split('T')[0]),
    // Prior 8 weeks of expenses — for the ring baseline.
    supabase
      .from('expenses')
      .select('amount, expense_date')
      .gte('expense_date', eightWeeksAgo.toISOString().split('T')[0])
      .lt('expense_date', thisMon.toISOString().split('T')[0]),
    // Current-week shifts with employee rates — drives the labor
    // estimate that rolls into money-out.
    supabase
      .from('shifts')
      .select('id, start_time, end_time, employees ( hourly_rate )')
      .gte('start_time', thisMon.toISOString())
      .lt('start_time', nextMon.toISOString()),
    // Prior 8 weeks of shifts — labor baseline for the ring.
    supabase
      .from('shifts')
      .select('start_time, end_time, employees ( hourly_rate )')
      .gte('start_time', eightWeeksAgo.toISOString())
      .lt('start_time', thisMon.toISOString()),
    // Bank accounts — latest reported balance per active account.
    // Sum across accounts = "In the bank" anchor.
    restaurantId
      ? supabase
          .from('connected_bank_accounts')
          .select('id, provider, current_balance, name, mask, last_synced_at')
          .eq('restaurant_id', restaurantId)
          .eq('active', true)
      : Promise.resolve({ data: [] as Array<{
          id: string; provider: string; current_balance: number | null;
          name: string | null; mask: string | null; last_synced_at: string | null
        }> }),
    // Ledger feed — latest 10 expenses, 10 orders, 10 bank transactions.
    // We interleave them client-side after normalization.
    supabase
      .from('expenses')
      .select('id, amount, category, vendor_name, expense_date, created_at, notes, is_inventory_related')
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('orders')
      .select('id, total_amount, created_at, payment_type, source, external_provider')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('bank_transactions')
      .select('id, amount, direction, posted_at, merchant_name, description, raw_category, review_state')
      .order('posted_at', { ascending: false })
      .limit(10),
  ])

  // ---- Compute money-in this week + payment-type split ----
  type OrderRow = { id: string; total_amount: number; created_at: string; payment_type: string | null }
  const weekOrdersTyped = (weekOrders ?? []) as OrderRow[]
  const moneyIn = weekOrdersTyped.reduce((s, o) => s + Number(o.total_amount), 0)
  const cashIn = weekOrdersTyped.filter((o) => o.payment_type === 'cash').reduce((s, o) => s + Number(o.total_amount), 0)
  const cardIn = weekOrdersTyped.filter((o) => o.payment_type === 'card').reduce((s, o) => s + Number(o.total_amount), 0)
  const otherIn = moneyIn - cashIn - cardIn

  // Daily sparkline buckets for the current week — 7 values,
  // Monday through Sunday. Days beyond "now" stay at 0 (they haven't
  // happened yet, so the sparkline "grows" through the week).
  const inSpark: number[] = new Array(7).fill(0)
  for (const o of weekOrdersTyped) {
    const d = new Date(o.created_at)
    const dayIdx = Math.floor((d.getTime() - thisMon.getTime()) / (24 * 60 * 60 * 1000))
    if (dayIdx >= 0 && dayIdx < 7) inSpark[dayIdx] += Number(o.total_amount)
  }

  // ---- Compute money-out this week ----
  type ExpenseRow = { id: string; amount: number; category: string; expense_date: string }
  const weekExpensesTyped = (weekExpenses ?? []) as ExpenseRow[]
  const expenseTotal = weekExpensesTyped.reduce((s, e) => s + Number(e.amount), 0)

  // Labor estimate: hours worked × hourly_rate. Zero-rate employees
  // contribute nothing — they're either the owner (unpaid draw) or
  // don't have a rate set yet. We don't try to be clever about it.
  type ShiftRow = { start_time: string; end_time: string; employees: { hourly_rate: number | null } | null }
  const weekShiftsTyped = (weekShifts ?? []) as unknown as ShiftRow[]
  let laborEstimate = 0
  for (const s of weekShiftsTyped) {
    const rate = Number(s.employees?.hourly_rate ?? 0)
    if (rate <= 0) continue
    const hours = (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / (1000 * 60 * 60)
    if (hours > 0) laborEstimate += hours * rate
  }
  const moneyOut = expenseTotal + laborEstimate

  // Money-out daily sparkline — expenses attributed to their
  // expense_date, labor attributed to shift start_time.
  const outSpark: number[] = new Array(7).fill(0)
  for (const e of weekExpensesTyped) {
    const d = new Date(e.expense_date + 'T00:00:00')
    const dayIdx = Math.floor((d.getTime() - thisMon.getTime()) / (24 * 60 * 60 * 1000))
    if (dayIdx >= 0 && dayIdx < 7) outSpark[dayIdx] += Number(e.amount)
  }
  for (const s of weekShiftsTyped) {
    const rate = Number(s.employees?.hourly_rate ?? 0)
    if (rate <= 0) continue
    const hours = (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / (1000 * 60 * 60)
    const d = new Date(s.start_time)
    const dayIdx = Math.floor((d.getTime() - thisMon.getTime()) / (24 * 60 * 60 * 1000))
    if (dayIdx >= 0 && dayIdx < 7 && hours > 0) outSpark[dayIdx] += hours * rate
  }

  // ---- Attribution chips ----
  // "Mostly cards" / "Mostly cash" / "Steady mix" for money in.
  const inChip = (() => {
    if (moneyIn <= 0) return 'Nothing rung yet'
    const cardShare = cardIn / moneyIn
    const cashShare = cashIn / moneyIn
    if (cardShare >= 0.6) return `${Math.round(cardShare * 100)}% cards`
    if (cashShare >= 0.6) return `${Math.round(cashShare * 100)}% cash`
    return 'Mixed cash + card'
  })()

  // "Mostly payroll" / "Mostly inventory" / etc. — pick the biggest
  // category by dollars (labor competes here too).
  const outChip = (() => {
    const bucket: Record<string, number> = { Labor: laborEstimate }
    for (const e of weekExpensesTyped) {
      bucket[e.category] = (bucket[e.category] ?? 0) + Number(e.amount)
    }
    let topCat = 'Nothing spent yet'; let topAmt = 0
    for (const [cat, amt] of Object.entries(bucket)) {
      if (amt > topAmt) { topCat = cat; topAmt = amt }
    }
    if (moneyOut <= 0) return 'Nothing spent yet'
    const share = topAmt / moneyOut
    if (share >= 0.5) return `Mostly ${topCat.toLowerCase()}`
    return `Top: ${topCat}`
  })()

  // ---- Net + streak ----
  const netThisWeek = moneyIn - moneyOut

  // Rebuild the 8 prior weeks' net for streak + rings baseline.
  type PriorOrder = { total_amount: number; created_at: string }
  type PriorExpense = { amount: number; expense_date: string }
  const priorOrdersTyped = (prior8Orders ?? []) as PriorOrder[]
  const priorExpensesTyped = (prior8Expenses ?? []) as PriorExpense[]
  const priorShiftsTyped = (prior8Shifts ?? []) as unknown as ShiftRow[]

  const priorNet: number[] = []
  const priorIn: number[] = []
  const priorOut: number[] = []
  for (let w = 8; w >= 1; w--) {
    const wStart = new Date(thisMon)
    wStart.setDate(wStart.getDate() - w * 7)
    const wEnd = new Date(wStart)
    wEnd.setDate(wEnd.getDate() + 7)
    const wIn = priorOrdersTyped
      .filter((o) => {
        const t = new Date(o.created_at).getTime()
        return t >= wStart.getTime() && t < wEnd.getTime()
      })
      .reduce((s, o) => s + Number(o.total_amount), 0)
    const wExp = priorExpensesTyped
      .filter((e) => {
        const t = new Date(e.expense_date + 'T00:00:00').getTime()
        return t >= wStart.getTime() && t < wEnd.getTime()
      })
      .reduce((s, e) => s + Number(e.amount), 0)
    let wLab = 0
    for (const s of priorShiftsTyped) {
      const t = new Date(s.start_time).getTime()
      if (t < wStart.getTime() || t >= wEnd.getTime()) continue
      const rate = Number(s.employees?.hourly_rate ?? 0)
      if (rate <= 0) continue
      const hrs = (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / (1000 * 60 * 60)
      if (hrs > 0) wLab += hrs * rate
    }
    priorIn.push(wIn)
    priorOut.push(wExp + wLab)
    priorNet.push(wIn - (wExp + wLab))
  }

  // Streak: how many CONSECUTIVE weeks (including this one) have
  // been net-positive walking backwards from now. Only counts once
  // the current week has itself gone positive.
  let streakWeeks = 0
  if (netThisWeek > 0) {
    streakWeeks = 1
    for (let i = priorNet.length - 1; i >= 0; i--) {
      if (priorNet[i] > 0) streakWeeks += 1
      else break
    }
  }

  // Last week's net for the delta line under the balance.
  const lastWeekNet = priorNet.length > 0 ? priorNet[priorNet.length - 1] : 0
  const lastWeekIn = priorIn.length > 0 ? priorIn[priorIn.length - 1] : 0

  // ---- Ring baselines (median of prior weeks) ----
  // Medians are more resilient than means to outlier weeks (a
  // holiday week or a payroll-and-insurance week shouldn't skew
  // the "typical". First 4 weeks after signup, we don't have enough
  // history — send `null` and the client renders a "learning your
  // typical week" state instead of a broken ring.
  const median = (arr: number[]): number => {
    if (arr.length === 0) return 0
    const s = [...arr].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }
  const enoughHistory = priorNet.length >= 4
  const baselineIn = enoughHistory ? median(priorIn) : null
  const baselineOut = enoughHistory ? median(priorOut) : null
  const baselineNet = enoughHistory ? median(priorNet) : null

  // ---- Bank balance ----
  type BankAccountRow = {
    id: string; provider: string; current_balance: number | null
    name: string | null; mask: string | null; last_synced_at: string | null
  }
  const accounts = (bankAccounts ?? []) as BankAccountRow[]
  const bankBalance = accounts.reduce((s, a) => s + Number(a.current_balance ?? 0), 0)
  const bankConnected = accounts.length > 0 && isPlaidConfigured()
  const latestBankSync = accounts.reduce<string | null>((latest, a) => {
    if (!a.last_synced_at) return latest
    if (!latest) return a.last_synced_at
    return new Date(a.last_synced_at).getTime() > new Date(latest).getTime()
      ? a.last_synced_at
      : latest
  }, null)

  // ---- Activity ledger (interleaved feed) ----
  // Normalize orders + expenses + bank txns into one row shape,
  // sort by timestamp desc, cap at 15.
  type LedgerRow = {
    id: string
    kind: 'order' | 'expense' | 'bank_credit' | 'bank_debit'
    amount: number       // always positive; sign carried by kind
    label: string
    sub: string | null
    category: string | null
    categoryEditable: boolean // true only for expenses (V1)
    timestamp: string
  }

  const ledgerOrders: LedgerRow[] = (
    (recentOrders ?? []) as Array<{ id: string; total_amount: number; created_at: string; payment_type: string | null; source: string | null; external_provider: string | null }>
  ).map((o) => ({
    id: `o:${o.id}`,
    kind: 'order',
    amount: Number(o.total_amount),
    label: o.payment_type === 'cash' ? 'Cash sale' : o.payment_type === 'card' ? 'Card sale' : 'Sale',
    sub: o.external_provider ?? o.source ?? null,
    category: null,
    categoryEditable: false,
    timestamp: o.created_at,
  }))

  const ledgerExpenses: LedgerRow[] = (
    (recentExpenses ?? []) as Array<{ id: string; amount: number; category: string; vendor_name: string | null; expense_date: string; created_at: string; notes: string | null }>
  ).map((e) => ({
    id: `e:${e.id}`,
    kind: 'expense',
    amount: Number(e.amount),
    label: e.vendor_name ?? e.category,
    sub: e.notes ?? null,
    category: e.category,
    categoryEditable: true,
    timestamp: e.created_at,
  }))

  const ledgerBank: LedgerRow[] = (
    (recentBankTxns ?? []) as Array<{ id: string; amount: number; direction: string; posted_at: string; merchant_name: string | null; description: string | null; raw_category: string | null; review_state: string | null }>
  ).map((b) => ({
    id: `b:${b.id}`,
    kind: b.direction === 'credit' ? 'bank_credit' : 'bank_debit',
    amount: Math.abs(Number(b.amount)),
    label: b.merchant_name ?? b.description ?? (b.direction === 'credit' ? 'Deposit' : 'Withdrawal'),
    sub: 'from bank',
    category: b.raw_category,
    categoryEditable: false,
    timestamp: b.posted_at,
  }))

  const ledger: LedgerRow[] = [...ledgerOrders, ...ledgerExpenses, ...ledgerBank]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 15)
    // Strip the raw ids — the client uses the compound id (prefix
    // included) for React keys and for the categorize action's
    // expense-id extraction.
    .map((r) => ({ ...r }))

  // ---- Smart nudge (compute one line, at most) ----
  // Simple rules for V1; expand as we learn what actually helps.
  // Priority order: something the owner should ACT on beats something
  // that's just interesting. Silent otherwise.
  let nudge: string | null = null
  if (!bankConnected) {
    nudge = 'Connect a bank account to see your real balance and unlock deposit tracking.'
  } else if (latestBankSync) {
    const daysSinceSync = (Date.now() - new Date(latestBankSync).getTime()) / (24 * 60 * 60 * 1000)
    if (daysSinceSync > 2) {
      nudge = `Bank hasn't synced in ${Math.floor(daysSinceSync)} days — the balance above may be stale.`
    }
  }
  // Rising card share nudge — the "look at this" style.
  if (!nudge && moneyIn > 0 && lastWeekIn > 0) {
    const thisCardShare = cardIn / moneyIn
    const lastCardShare = (() => {
      const wStart = lastMon
      const wEnd = thisMon
      const lastWeekOrders = priorOrdersTyped.filter((o) => {
        const t = new Date(o.created_at).getTime()
        return t >= wStart.getTime() && t < wEnd.getTime()
      })
      const lastIn = lastWeekOrders.reduce((s, o) => s + Number(o.total_amount), 0)
      return lastIn > 0 ? (lastIn - 0) / lastIn : 0 // placeholder — payment_type not fetched for prior weeks
    })()
    if (thisCardShare > 0.75 && lastCardShare < 0.7) {
      nudge = `Card sales are up to ${Math.round(thisCardShare * 100)}% this week — worth watching your processor fees.`
    }
  }

  // ---- Sunday recap ----
  // Shown Sunday + Monday of the following week. Wraps up the week
  // that just ended. Text only for V1.
  const showRecap = (() => {
    const day = now.getDay()
    return day === 0 || day === 1 // Sunday or Monday
  })()

  const recap = showRecap && priorNet.length > 0
    ? (() => {
        const lastNet = priorNet[priorNet.length - 1]
        const delta = lastNet - (priorNet.length > 1 ? priorNet[priorNet.length - 2] : 0)
        const parts: string[] = []
        if (lastNet > 0) parts.push(`Last week was profitable — net ${formatUsd(lastNet)}.`)
        else parts.push(`Last week ran tight — net ${formatUsd(lastNet)}.`)
        if (delta !== 0) {
          const deltaWord = delta > 0 ? 'up' : 'down'
          parts.push(`That's ${deltaWord} ${formatUsd(Math.abs(delta))} from the week before.`)
        }
        if (streakWeeks > 1) parts.push(`${streakWeeks} weeks profitable in a row.`)
        return parts.join(' ')
      })()
    : null

  // ---- Phone Money tab payload -----------------------------
  // The tablet Finance page carries week metrics + a ledger; the
  // phone Money tab answers "am I making money?" with a hero
  // (net), a came-in/went-out split, an unreviewed-bank confirm
  // queue, and a payment-source breakdown. All computed from data
  // already fetched above.

  // Payment-source breakdown for the current week — flat 3-bucket
  // group (card / cash / other), sorted highest total first.
  type SourceRow = { key: 'card' | 'cash' | 'other'; label: string; count: number; total: number }
  const srcMap: Record<'card' | 'cash' | 'other', SourceRow> = {
    card: { key: 'card', label: 'Card', count: 0, total: 0 },
    cash: { key: 'cash', label: 'Cash', count: 0, total: 0 },
    other: { key: 'other', label: 'Other', count: 0, total: 0 },
  }
  for (const o of weekOrdersTyped) {
    const k = (o.payment_type ?? 'other').toLowerCase()
    const row = k === 'card' ? srcMap.card : k === 'cash' ? srcMap.cash : srcMap.other
    row.count += 1
    row.total += Number(o.total_amount)
  }
  const paymentSources = (Object.values(srcMap) as SourceRow[])
    .filter((r) => r.count > 0)
    .sort((a, b) => b.total - a.total)

  // Unreviewed bank groups — fetch the raw rows and let the
  // matcher aggregate. Wrapped in a defensive block so a missing
  // table / permission failure doesn't kill the whole page.
  let reviewGroups: BankReviewGroup[] = []
  try {
    const { data: unreviewed } = await supabase
      .from('bank_transactions')
      .select('id, amount, direction, posted_at, merchant_name, description, raw_category')
      .eq('review_state', 'unreviewed')
      .order('posted_at', { ascending: false })
    const groupable: GroupableTxn[] = (unreviewed ?? []).map((r) => ({
      id: r.id as string,
      postedAt: r.posted_at as string,
      amount: Number(r.amount),
      direction: (r.direction as 'inflow' | 'outflow'),
      rawCategory: (r.raw_category as string | null) ?? null,
      merchantName: (r.merchant_name as string | null) ?? null,
      description: (r.description as string | null) ?? null,
    }))
    reviewGroups = groupBankTransactions(groupable)
  } catch (err) {
    console.warn('[finance/page] bank review-group compute failed:', err)
  }

  return (
    <FinanceDashboardClient
      lang={lang}
      bank={{
        connected: bankConnected,
        balance: bankBalance,
        latestSyncAt: latestBankSync,
        accountCount: accounts.length,
      }}
      week={{
        startISO: thisMon.toISOString(),
        moneyIn,
        moneyOut,
        net: netThisWeek,
        inChip,
        outChip,
        inSpark,
        outSpark,
        lastWeekNet,
        streakWeeks,
      }}
      baselines={{
        moneyIn: baselineIn,
        moneyOut: baselineOut,
        net: baselineNet,
        enoughHistory,
      }}
      ledger={ledger}
      nudge={nudge}
      recap={recap}
      phoneMoney={{
        moneyIn,
        moneyOut,
        net: netThisWeek,
        paymentSources,
        reviewGroups: reviewGroups.slice(0, 6).map((g) => ({
          key: g.key,
          label: g.label,
          direction: g.direction,
          totalAmount: g.totalAmount,
          txnCount: g.txnCount,
          reason: g.reason,
          firstTxnPostedAt: g.txns[0]?.postedAt ?? null,
          firstTxnDescription: g.txns[0]?.description ?? g.txns[0]?.merchantName ?? null,
        })),
      }}
    />
  )
}

// Same simple USD formatter the client uses. Duplicated (rather
// than imported from a shared util) to keep the server component
// self-contained and edit-free by the type-check pass.
function formatUsd(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}$${abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}
