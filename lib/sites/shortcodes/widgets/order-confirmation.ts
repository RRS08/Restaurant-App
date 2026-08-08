// ----------------------------------------------------------------
// {{order-confirmation}} widget.
//
// Renders the /thanks page body from the order id in the URL. Reads
// the snapshot from site_orders_link (frozen shape the buyer saw)
// so the copy can adapt to what actually happened — pickup vs
// shipping, paid vs pending — while the UI stays minimal.
//
// Buyer-facing surface is intentionally tight: checkmark, "Order
// placed", one reassuring line, back-to-shelf CTA. Order id lives
// in the URL if anyone needs to reference it later.
//
// Falls back to a bare "we got it" render if the order id is
// missing, unknown, or belongs to another site — never leaks
// another site's contents on a URL-tampering attempt.
// ----------------------------------------------------------------

import type { ShortcodeContext } from '../index'
import { createAdminClient } from '@/lib/supabase/admin'
import { escapeHtml } from '../utils'

interface LinkRow {
  cart: {
    delivery?: { key?: string; label?: string; price?: number; sublabel?: string }
  }
  contact: { name?: string } | null
  shipping: { line1?: string } | null
}

export async function renderOrderConfirmation(_args: unknown, ctx: ShortcodeContext): Promise<string> {
  const orderId = typeof ctx.query.order === 'string' ? ctx.query.order : ''
  const isUnpaid = ctx.query.unpaid === '1'

  if (!orderId) return renderShell({ title: 'Order placed', lead: defaultLead() })

  const admin = createAdminClient()
  const { data } = await admin
    .from('site_orders_link')
    .select('cart, contact, shipping')
    .eq('order_id', orderId)
    .eq('site_id', ctx.site.id)
    .maybeSingle()

  const link = (data ?? null) as LinkRow | null
  const firstName = link?.contact?.name ? link.contact.name.split(/\s+/)[0] : ''
  const deliveryPrice = link?.cart?.delivery?.price ?? 0
  const isShipping = deliveryPrice > 0 || !!link?.shipping?.line1

  return renderShell({
    title: firstName ? `Thanks, ${escapeHtml(firstName)}` : 'Order placed',
    lead: leadFor({ isShipping, isUnpaid }),
  })
}

function defaultLead(): string {
  return "We'll be in touch shortly. Thank you for letting us be part of your routine."
}

function leadFor(args: { isShipping: boolean; isUnpaid: boolean }): string {
  if (args.isUnpaid) {
    return "The shop will email a secure payment link within one business day. No action needed on your end yet."
  }
  if (args.isShipping) {
    return "You'll get a shipping update as soon as it goes out. Thank you for letting us be part of your routine."
  }
  return "We'll text you the moment it's ready. Thank you for letting us be part of your routine."
}

function renderShell(args: { title: string; lead: string }): string {
  return `<div class="order-confirm">
  <style>${ORDER_CONFIRM_STYLE}</style>
  <div class="oc-badge" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"/></svg>
  </div>
  <h1>${args.title}</h1>
  <p class="oc-lead">${escapeHtml(args.lead)}</p>
  <a class="oc-cta" href="/shop">Back to the shelf</a>
</div>`
}

const ORDER_CONFIRM_STYLE = `
.order-confirm{max-width:520px;margin:0 auto;padding:64px 24px 96px;text-align:center;color:#253b0e;font-family:inherit}
.order-confirm .oc-badge{width:64px;height:64px;border-radius:50%;background:#d6e8bf;color:#253b0e;display:inline-flex;align-items:center;justify-content:center;margin-bottom:24px}
.order-confirm h1{font-size:36px;margin:0 0 14px;line-height:1.15;font-weight:700;color:#253b0e}
.order-confirm .oc-lead{font-size:15px;line-height:1.6;color:#55723e;margin:0 auto 32px;max-width:420px}
.order-confirm .oc-cta{display:inline-block;padding:14px 32px;background:#253b0e;color:#fff;border-radius:9px;text-decoration:none;font-weight:600;font-size:14px;transition:background .15s ease}
.order-confirm .oc-cta:hover{background:#132304}
@media(max-width:600px){
  .order-confirm{padding:48px 20px 72px}
  .order-confirm h1{font-size:28px}
  .order-confirm .oc-cta{display:block}
}
`
