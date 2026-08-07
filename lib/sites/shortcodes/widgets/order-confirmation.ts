// ----------------------------------------------------------------
// {{order-confirmation}} widget.
//
// Renders the /thanks page body from the order id in the URL. Reads
// the snapshot from site_orders_link.cart — that's the frozen shape
// the buyer saw when they placed the order, so a later price edit
// on site_products doesn't rewrite historical receipts.
//
// Falls back to a bare "we got it" message if the order id is
// missing, unknown, or belongs to another site — never leak another
// site's contents on a URL-tampering attempt.
// ----------------------------------------------------------------

import type { ShortcodeContext } from '../index'
import { createAdminClient } from '@/lib/supabase/admin'
import { escapeHtml } from '../utils'

interface CartLine {
  slug: string
  qty: number
  name: string
  price: number
  unit?: string | null
  line_total: number
}

interface LinkRow {
  cart: { items?: CartLine[]; subtotal?: number }
  contact: { name?: string; email?: string; phone?: string } | null
}

export async function renderOrderConfirmation(_args: unknown, ctx: ShortcodeContext): Promise<string> {
  const orderId = typeof ctx.query.order === 'string' ? ctx.query.order : ''
  const isUnpaid = ctx.query.unpaid === '1'

  if (!orderId) return bareThanks()

  const admin = createAdminClient()
  const { data } = await admin
    .from('site_orders_link')
    .select('cart, contact')
    .eq('order_id', orderId)
    .eq('site_id', ctx.site.id)
    .maybeSingle()

  if (!data) return bareThanks(orderId)

  const link = data as LinkRow
  const items: CartLine[] = Array.isArray(link.cart?.items) ? link.cart.items : []
  const subtotal = typeof link.cart?.subtotal === 'number'
    ? link.cart.subtotal
    : items.reduce((a, i) => a + (typeof i.line_total === 'number' ? i.line_total : 0), 0)

  const name = link.contact?.name ?? ''
  const email = link.contact?.email ?? ''

  const rows = items.map(i => `      <div class="oc-line">
        <span>${escapeHtml(i.name)}${i.unit ? ` — ${escapeHtml(i.unit)}` : ''}</span>
        <span>×${i.qty}</span>
        <span>$${i.line_total.toFixed(2)}</span>
      </div>`).join('\n')

  const unpaidBlock = isUnpaid ? `<div class="oc-unpaid">
    <strong>Payment pending</strong>
    <p>Our online payment is being wired up right now. You'll receive an email from us with a secure payment link within one business day. Your order is locked in — no action needed on your end yet.</p>
  </div>` : ''

  const emailLine = email
    ? `<p class="oc-lead">A copy is on its way to <strong>${escapeHtml(email)}</strong>.</p>`
    : ''

  return `<div class="order-confirm">
  <h1>Thanks${name ? `, ${escapeHtml(name)}` : ''}.</h1>
  ${emailLine}
  <p class="oc-ref">Order reference · <code>${escapeHtml(orderId)}</code></p>

  ${unpaidBlock}

  <div class="oc-summary">
    <h2>What you ordered</h2>
    <div class="oc-lines">
${rows}
    </div>
    <div class="oc-total">
      <span>Total</span>
      <strong>$${subtotal.toFixed(2)}</strong>
    </div>
  </div>

  <a class="btn btn-dark oc-cta" href="/">Back to the shop</a>
</div>`
}

function bareThanks(orderId?: string): string {
  const ref = orderId
    ? `<p class="oc-ref">Order reference · <code>${escapeHtml(orderId)}</code></p>`
    : ''
  return `<div class="order-confirm">
  <h1>Your order is in.</h1>
  <p class="oc-lead">We'll be in touch shortly.</p>
  ${ref}
  <a class="btn btn-dark oc-cta" href="/">Back to the shop</a>
</div>`
}
