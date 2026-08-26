// ----------------------------------------------------------------
// Sales Page  →  /sales
//
// Day-scoped ledger — the page renders sales for ONE calendar day
// (in the restaurant's local timezone) at a time. The day is
// controlled by the ?date=YYYY-MM-DD search param; missing means
// today. A prev/next navigator in the client lets the manager
// walk back through history without pagination.
//
// Why per-day (from the pilot merchant): daily close-of-shift is
// how restaurant + retail operators actually think about sales.
// The eventual "close the day" report will read from this same
// day scope, so wiring the ledger to it now is the natural setup.
//
// Server-side filter is on `orders.business_date` — a DATE column
// stamped at ingest time in the restaurant's timezone (see
// lib/sales/business-date.ts). RLS scopes to the caller's
// restaurant automatically.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import { getOperatingMode } from '@/lib/readiness'
import { businessDateInTimezone } from '@/lib/sales/business-date'
import { resolveActivePlace } from '@/lib/places'
import SalesClient from './client'

interface SalesPageProps {
  // Next.js 16 passes searchParams as a Promise on server pages;
  // must await before destructuring.
  searchParams?: Promise<{ date?: string }>
}

export default async function SalesPage({ searchParams }: SalesPageProps) {
  const supabase = await createClient()
  const lang = await getLang()

  // Resolve the caller's restaurant + primary location's timezone
  // in parallel. Timezone drives "today" resolution below so the
  // default day matches what the owner sees on their wall clock.
  const { data: { user } } = await supabase.auth.getUser()
  let operatingMode: 'native_pos' | 'external_pos' | null = null
  let restaurantId: string | null = null
  let timezone: string | null = null
  // The Sales ledger is scoped to the active place — a manager on
  // Mercado sees only orders that landed at Mercado's location,
  // not web orders sitting at the online location. Without this
  // scope, the places pivot leaks web orders back into retail.
  let activePlaceId: string | null = null
  let activePlaceTimezone: string | null = null
  if (user) {
    const { data: role } = await supabase
      .from('user_roles')
      .select('restaurant_id')
      .eq('user_id', user.id)
      .single()
    if (role?.restaurant_id) {
      restaurantId = role.restaurant_id as string
      const [{ data: loc }, mode, place] = await Promise.all([
        supabase
          .from('locations')
          .select('timezone')
          .eq('restaurant_id', restaurantId)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle(),
        getOperatingMode(supabase, restaurantId),
        resolveActivePlace(supabase, restaurantId),
      ])
      timezone = (loc?.timezone as string | null) ?? null
      operatingMode = mode
      if (place) {
        activePlaceId = place.id
        activePlaceTimezone = place.timezone
      }
    }
  }
  // Prefer the active place's timezone for the "today" default —
  // the ledger day should match whatever clock the operator's
  // physical location is on. Falls back to the first-location tz.
  const tzForToday = activePlaceTimezone ?? timezone

  // Today (in the active place's timezone) is the default day, and
  // also the "today" reference the client uses to decide whether
  // to render the "Jump to today" affordance.
  const today = businessDateInTimezone(new Date(), tzForToday)

  // Requested day: ?date=YYYY-MM-DD, sanitized. Anything malformed
  // falls back to today so a stray URL can't crash the page.
  const rawDate = (await searchParams)?.date
  const requestedDate =
    typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : today

  // Order fetch scoped to the requested business_date. 500 cap kept
  // as a safety belt — a single day rarely produces that many rows
  // in pilot volumes, and a busy Costco-style day would still fit.
  //
  // NOTE: site_orders_link is fetched SEPARATELY below (not as a
  // PostgREST embed) to prevent one broken relationship / RLS block
  // on the child table from nuking the entire orders list. When we
  // embedded it here, a schema-cache / RLS hiccup on
  // site_orders_link silently returned zero orders on /sales while
  // the dashboard (no such embed) kept working — user-visible bug
  // where the sales page was empty for a merchant with 21 real sales.
  let ordersQuery = supabase
    .from('orders')
    .select(`
      id, total_amount, created_at,
      source, payment_type, payment_status, status, note,
      subtotal, discount_total, tax_total,
      card_brand, card_last4, customer_name, channel_source,
      location_id,
      locations ( name ),
      order_items ( id, quantity, unit_price, total_price, variant_label, menu_items ( name ) )
    `)
    .eq('business_date', requestedDate)
    .order('created_at', { ascending: false })
    .limit(500)
  // Scope to the active place. Retail Sales shows only orders that
  // landed at the physical shop; web orders (now routed to the
  // online location) surface in Online > Orders instead. Without
  // a place selected (edge case — cookie missing on first render),
  // we deliberately return nothing rather than leak a cross-place
  // view.
  if (activePlaceId) {
    ordersQuery = ordersQuery.eq('location_id', activePlaceId)
  } else {
    // No place picked = no results. Layout will redirect to /places
    // before this even renders in practice, but guard anyway so a
    // stale render can't leak.
    ordersQuery = ordersQuery.eq('id', '00000000-0000-0000-0000-000000000000')
  }
  const { data: orders } = await ordersQuery

  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const strOrNull = (v: unknown): string | null => {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    return s.length > 0 ? s : null
  }

  // Fetch web-order details in a separate query, only for the
  // handful of web orders in this day. Failure here degrades the
  // drawer (no email/shipping/etc.) but does NOT hide any orders —
  // the main list stays intact.
  type WebLink = {
    cart: unknown
    contact: unknown
    shipping: unknown
    payment_provider: string | null
    payment_reference: string | null
  }
  const webOrderIds = (orders ?? [])
    .filter((o) => (o.source ?? 'manual') === 'web')
    .map((o) => o.id as string)
  const webLinksById = new Map<string, WebLink>()
  if (webOrderIds.length > 0) {
    const { data: links } = await supabase
      .from('site_orders_link')
      .select('order_id, cart, contact, shipping, payment_provider, payment_reference')
      .in('order_id', webOrderIds)
    for (const row of (links ?? []) as Array<WebLink & { order_id: string }>) {
      webLinksById.set(row.order_id, {
        cart: row.cart,
        contact: row.contact,
        shipping: row.shipping,
        payment_provider: row.payment_provider,
        payment_reference: row.payment_reference,
      })
    }
  }

  const normalized = (orders ?? []).map((o) => {
    const link = webLinksById.get(o.id as string) ?? null
    return {
      id: o.id,
      total: Number(o.total_amount),
      createdAt: o.created_at,
      source: (o.source ?? 'manual') as 'manual' | 'native_pos' | 'external_pos' | 'web',
      paymentType: (o.payment_type ?? 'cash') as 'cash' | 'card' | 'other',
      paymentStatus: (o.payment_status ?? 'paid') as 'paid' | 'unpaid',
      status: (o.status ?? 'completed') as 'completed' | 'voided',
      note: o.note ?? null,
      subtotal:      numOrNull(o.subtotal),
      discountTotal: numOrNull(o.discount_total),
      taxTotal:      numOrNull(o.tax_total),
      cardBrand:     strOrNull(o.card_brand),
      cardLast4:     strOrNull(o.card_last4),
      customerName:  strOrNull(o.customer_name),
      channelSource: strOrNull(o.channel_source),
      locationName: (o.locations as unknown as { name: string } | null)?.name ?? null,
      lineItems: ((o.order_items as unknown as Array<{
        id: string; quantity: number; unit_price: number; total_price: number
        variant_label: string | null
        menu_items: { name: string } | null
      }>) ?? []).map((li) => ({
        id: li.id,
        name: li.menu_items?.name ?? '—',
        variantLabel: strOrNull(li.variant_label),
        quantity: li.quantity,
        unitPrice: Number(li.unit_price),
        totalPrice: Number(li.total_price),
      })),
      webDetail: link ? {
        contact: (link.contact as Record<string, unknown> | null) ?? null,
        shipping: (link.shipping as Record<string, unknown> | null) ?? null,
        cart: (link.cart as Record<string, unknown> | null) ?? null,
        paymentProvider: link.payment_provider ?? null,
        paymentReference: link.payment_reference ?? null,
      } : null,
    }
  })

  return (
    <SalesClient
      lang={lang}
      orders={normalized}
      operatingMode={operatingMode}
      date={requestedDate}
      today={today}
    />
  )
}
