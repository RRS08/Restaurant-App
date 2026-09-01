// ----------------------------------------------------------------
// GET /finance/report/csv?days=30
//
// Streams every movement in the window as a CSV. Meant for Excel /
// Sheets / accountant hand-off. Header row matches the columns a
// bookkeeper expects; transfers show both accounts in one row.
// ----------------------------------------------------------------

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { listMovements } from '@/lib/finance/data'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse('Unauthorized', { status: 401 })
  const { data: role } = await supabase
    .from('user_roles').select('restaurant_id').eq('user_id', user.id).single()
  if (!role) return new NextResponse('No restaurant', { status: 403 })
  const restaurantId = role.restaurant_id as string

  const url = new URL(req.url)
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') ?? '', 10) || 30))
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  const admin = createAdminClient()
  const movements = await listMovements(admin, restaurantId, { from, to, limit: 10000 })

  const header = [
    'Date', 'Description', 'Category', 'Category kind', 'Direction',
    'Source account', 'Destination account', 'Amount', 'Currency',
    'Origin', 'Origin ref', 'Memo',
  ]
  const rows = movements.map(m => [
    m.occurred_at,
    m.note ?? '',
    m.category?.name ?? '',
    m.category?.kind ?? '',
    m.direction,
    m.source?.name ?? '',
    m.dest?.name ?? '',
    m.amount.toFixed(2),
    'USD',
    m.origin,
    m.origin_ref ?? '',
    m.memo ?? '',
  ])

  const csv = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')
  const filename = `checked-finance-${from.toISOString().slice(0, 10)}_to_${to.toISOString().slice(0, 10)}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

/** Escape one CSV cell — wraps in quotes when the value contains a
 *  delimiter, quote, or newline; doubles any embedded quotes. */
function csvCell(v: string): string {
  const needs = /[",\r\n]/.test(v)
  const escaped = v.replace(/"/g, '""')
  return needs ? `"${escaped}"` : escaped
}
