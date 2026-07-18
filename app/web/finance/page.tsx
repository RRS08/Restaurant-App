// ----------------------------------------------------------------
// Web-native Finance  →  /web/finance
//
// V1 display: last 7 days revenue + expenses + labor estimate, plus
// the recent expense feed. Bank-account connections, expense
// editing, and the bank-review settlement workflow stay in the
// classic route.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import WebFinanceClient from './client'

export default async function WebFinancePage() {
  const supabase = await createClient()
  const lang = await getLang()

  const now = new Date()
  const sevenDaysAgo = new Date(now)
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6)
  sevenDaysAgo.setHours(0, 0, 0, 0)

  const day = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
  monday.setHours(0, 0, 0, 0)
  const sundayEnd = new Date(monday)
  sundayEnd.setDate(monday.getDate() + 7)

  const [
    { data: recentExpenses },
    { data: periodExpenses },
    { data: periodOrders },
    { data: weekShifts },
  ] = await Promise.all([
    supabase
      .from('expenses')
      .select('id, category, amount, expense_date, vendor_name, notes, is_inventory_related')
      .order('expense_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('expenses')
      .select('amount, is_inventory_related')
      .gte('expense_date', sevenDaysAgo.toISOString().split('T')[0]),
    supabase
      .from('orders')
      .select('total_amount')
      .eq('status', 'completed')
      .gte('created_at', sevenDaysAgo.toISOString()),
    supabase
      .from('shifts')
      .select('start_time, end_time, employees ( hourly_rate )')
      .gte('start_time', monday.toISOString())
      .lt('start_time', sundayEnd.toISOString()),
  ])

  const expenses = periodExpenses ?? []
  const expenseTotal7d = expenses.reduce((s, e) => s + Number(e.amount), 0)
  const inventorySpend7d = expenses.filter((e) => e.is_inventory_related).reduce((s, e) => s + Number(e.amount), 0)
  const revenue7d = (periodOrders ?? []).reduce((s, o) => s + Number(o.total_amount), 0)

  type RawShift = { start_time: string; end_time: string; employees: { hourly_rate: number | null } | null }
  let laborEstimate7d = 0
  for (const s of ((weekShifts ?? []) as unknown as RawShift[])) {
    const rate = Number(s.employees?.hourly_rate ?? 0)
    if (rate <= 0) continue
    const hours = (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / (1000 * 60 * 60)
    if (hours > 0) laborEstimate7d += hours * rate
  }

  const recentList = (recentExpenses ?? []).map((e) => ({
    id: e.id,
    category: e.category,
    amount: Number(e.amount),
    expenseDate: e.expense_date,
    vendorName: e.vendor_name,
    notes: e.notes,
    isInventoryRelated: e.is_inventory_related,
  }))

  return (
    <WebFinanceClient
      lang={lang}
      revenue7d={revenue7d}
      expenseTotal7d={expenseTotal7d}
      inventorySpend7d={inventorySpend7d}
      laborEstimate7d={laborEstimate7d}
      recentExpenses={recentList}
    />
  )
}
