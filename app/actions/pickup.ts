'use server'

// ----------------------------------------------------------------
// Pickup workflow actions — advances a web pickup order through
// its fulfillment states from the POS bubble or the /orders drawer.
//
//   markReady    'new' → 'ready'    (fires buyer email)
//   markCompleted 'ready' | 'new' → 'completed'
//
// Guardrails:
//   • Every action verifies the order belongs to the operator's
//     restaurant before writing — a cross-tenant POST can't touch
//     someone else's ledger.
//   • State transitions are one-way (the check constraint on
//     orders.fulfillment_state stays out of it; the action itself
//     refuses to walk backwards so a stray double-click can't
//     un-mark a completed pickup).
//   • Email dispatch is deferred to `after()` so the POS bubble
//     resolves instantly even if Resend is slow.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { queuePickupReadyEmail } from '@/lib/sites/pickup-ready-email'
import type { SiteRow } from '@/lib/sites/types'

type Result = { ok: true } | { error: string }

export async function markReady(formData: FormData): Promise<Result> {
  const orderId = (formData.get('order_id') as string | null)?.trim()
  if (!orderId) return { error: 'Missing order id.' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role) return { error: 'No restaurant.' }

  // Verify the order and read what we need for the buyer email in
  // one round-trip. Admin client used so RLS never trips over the
  // site_orders_link join.
  const admin = createAdminClient()
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, restaurant_id, location_id, source, status, fulfillment_state, customer_name')
    .eq('id', orderId)
    .maybeSingle()
  if (orderErr || !order) return { error: 'Order not found.' }
  if (order.restaurant_id !== role.restaurant_id) return { error: 'Order not found.' }
  if (order.source !== 'web') return { error: 'Not a web order.' }
  if (order.status === 'voided') return { error: 'Order is voided.' }
  if (order.fulfillment_state === 'ready' || order.fulfillment_state === 'completed') {
    // Idempotent — a stray double-click is a no-op, not an error.
    return { ok: true }
  }

  // Flip state + stamp ready_at. Guarded by the current state so
  // two operators racing the same order collapse to one write.
  const { error: updateErr } = await admin
    .from('orders')
    .update({ fulfillment_state: 'ready', ready_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('fulfillment_state', 'new')
  if (updateErr) {
    console.error('[markReady] update failed', updateErr)
    return { error: 'Could not mark ready.' }
  }

  // Fetch what the email needs: buyer contact + site + location.
  const { data: link } = await admin
    .from('site_orders_link')
    .select('site_id, contact')
    .eq('order_id', orderId)
    .maybeSingle()

  if (link?.site_id) {
    const { data: site } = await admin
      .from('sites')
      .select('*')
      .eq('id', link.site_id)
      .maybeSingle()

    // Optional pickup line — the restaurant may only carry a name;
    // fall back to that if no address is available. Nice-to-have,
    // not required.
    const { data: location } = order.location_id
      ? await admin
          .from('locations')
          .select('name, address')
          .eq('id', order.location_id)
          .maybeSingle()
      : { data: null as { name?: string; address?: string } | null }

    const pickupLine = location
      ? [location.name, location.address].filter(Boolean).join(' · ')
      : null

    const contact = (link.contact ?? {}) as { email?: unknown; name?: unknown }
    const buyerEmail = typeof contact.email === 'string' ? contact.email : ''
    const buyerName = typeof contact.name === 'string'
      ? contact.name
      : (order.customer_name ?? '')

    if (site && buyerEmail) {
      queuePickupReadyEmail({
        site: site as SiteRow,
        orderId,
        buyerEmail,
        buyerName,
        pickupLine,
      })
    }
  }

  // Refresh every surface that shows pickup queue or state chips.
  revalidatePath('/pos')
  revalidatePath('/orders')
  revalidatePath('/dashboard')
  return { ok: true }
}
