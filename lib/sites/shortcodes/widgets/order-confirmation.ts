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
  cart: {
    items?: CartLine[]
    subtotal?: number
    delivery?: { key?: string; label?: string; price?: number; sublabel?: string }
    notes?: string
  }
  contact: { name?: string; email?: string; phone?: string } | null
  shipping: { line1?: string; line2?: string; city?: string; state?: string; postal?: string } | null
}

interface OrderRow {
  total_amount: number | string | null
  tax_total: number | string | null
  card_brand: string | null
  card_last4: string | null
}

function money(n: number): string {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`
}
function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') { const p = parseFloat(v); return Number.isFinite(p) ? p : 0 }
  return 0
}

export async function renderOrderConfirmation(_args: unknown, ctx: ShortcodeContext): Promise<string> {
  const orderId = typeof ctx.query.order === 'string' ? ctx.query.order : ''
  const isUnpaid = ctx.query.unpaid === '1'

  if (!orderId) return bareThanks()

  const admin = createAdminClient()
  // Pull link (cart snapshot + buyer contact + shipping) AND the
  // matching orders row (real charged total, tax, card meta) in
  // parallel — the link is scoped by site_id so a tampered order
  // id from another site returns null and falls through to the
  // bare "we got it" copy.
  const [linkRes, orderRes] = await Promise.all([
    admin
      .from('site_orders_link')
      .select('cart, contact, shipping')
      .eq('order_id', orderId)
      .eq('site_id', ctx.site.id)
      .maybeSingle(),
    admin
      .from('orders')
      .select('total_amount, tax_total, card_brand, card_last4')
      .eq('id', orderId)
      .eq('restaurant_id', ctx.site.restaurant_id)
      .maybeSingle(),
  ])

  const linkData = linkRes.data as LinkRow | null
  if (!linkData) return bareThanks(orderId)
  const orderData = (orderRes.data ?? null) as OrderRow | null

  const items: CartLine[] = Array.isArray(linkData.cart?.items) ? linkData.cart.items : []
  const subtotal = typeof linkData.cart?.subtotal === 'number'
    ? linkData.cart.subtotal
    : items.reduce((a, i) => a + (typeof i.line_total === 'number' ? i.line_total : 0), 0)

  const delivery = linkData.cart?.delivery ?? null
  const deliveryPrice = delivery && typeof delivery.price === 'number' ? delivery.price : 0
  const isShipping = deliveryPrice > 0 || (linkData.shipping && !!linkData.shipping.line1)
  const deliveryLabelRaw = delivery?.label ?? ''
  const deliverySublabel = delivery?.sublabel ?? ''

  const tax = orderData ? num(orderData.tax_total) : 0
  const total = orderData ? num(orderData.total_amount) : round2(subtotal + deliveryPrice + tax)

  const cardBrand = orderData?.card_brand ?? null
  const cardLast4 = orderData?.card_last4 ?? null

  const name = linkData.contact?.name ?? ''
  const email = linkData.contact?.email ?? ''
  const phone = linkData.contact?.phone ?? ''

  const rows = items.map(i => `      <div class="oc-line">
        <span>${escapeHtml(i.name)}${i.unit ? ` — ${escapeHtml(i.unit)}` : ''}</span>
        <span>×${i.qty}</span>
        <span>${money(i.line_total)}</span>
      </div>`).join('\n')

  const unpaidBlock = isUnpaid ? `<div class="oc-unpaid">
    <strong>Payment pending</strong>
    <p>Online payment isn't wired up yet for this shop. The merchant will follow up with a secure payment link within one business day — your order is locked in on their end.</p>
  </div>` : ''

  const contactBlock = (email || phone) ? `<div class="oc-contact">
    ${email ? `<div><span class="oc-k">Email</span><span class="oc-v">${escapeHtml(email)}</span></div>` : ''}
    ${phone ? `<div><span class="oc-k">Phone</span><span class="oc-v">${escapeHtml(phone)}</span></div>` : ''}
  </div>` : ''

  const fulfillmentBlock = isShipping && linkData.shipping
    ? renderShippingBlock(linkData.shipping)
    : renderPickupBlock(deliveryLabelRaw || 'Pickup', deliverySublabel)

  const paymentBlock = (cardBrand || cardLast4)
    ? `<div class="oc-payment">
        <span class="oc-k">Paid with</span>
        <span class="oc-v">${escapeHtml(cardBrand ? cardBrand.toUpperCase() : 'Card')}${cardLast4 ? ` ending ${escapeHtml(cardLast4)}` : ''}</span>
      </div>`
    : ''

  // Cost breakdown — always show subtotal + total; show shipping
  // only when non-zero; show tax only when non-zero. Delivery cost
  // is included in the buyer's charged total (Poynt receives it as
  // amounts.transactionAmount) so we surface it here for parity.
  const shippingRow = deliveryPrice > 0
    ? `<div class="oc-cost"><span>Shipping</span><span>${money(deliveryPrice)}</span></div>`
    : ''
  const taxRow = tax > 0
    ? `<div class="oc-cost"><span>Tax</span><span>${money(tax)}</span></div>`
    : ''

  return `<div class="order-confirm">
  <style>${ORDER_CONFIRM_STYLE}</style>
  <h1>Thanks${name ? `, ${escapeHtml(name.split(/\s+/)[0])}` : ''}.</h1>
  <p class="oc-lead">Your order is in. Save this page for your records — the shop will follow up with pickup or delivery details.</p>
  <p class="oc-ref">Order reference · <code>${escapeHtml(orderId)}</code></p>

  ${unpaidBlock}

  ${fulfillmentBlock}
  ${contactBlock}
  ${paymentBlock}

  <div class="oc-summary">
    <h2>What you ordered</h2>
    <div class="oc-lines">
${rows}
    </div>
    <div class="oc-costs">
      <div class="oc-cost"><span>Subtotal</span><span>${money(subtotal)}</span></div>
      ${shippingRow}
      ${taxRow}
    </div>
    <div class="oc-total">
      <span>Total</span>
      <strong>${money(total)}</strong>
    </div>
  </div>

  <a class="btn btn-dark oc-cta" href="/">Back to the shop</a>
</div>`
}

function renderPickupBlock(label: string, sublabel: string): string {
  // Drop the "Store Name · " prefix from the sublabel — same
  // treatment the checkout summary applies. Address alone reads
  // cleaner as a receipt line than "Store · Address".
  let address = sublabel
  const sep = sublabel.indexOf(' · ')
  if (sep >= 0) address = sublabel.slice(sep + 3).trim()
  return `<div class="oc-fulfillment">
    <div class="oc-fulfillment-title">Pickup — ${escapeHtml(label)}</div>
    ${address ? `<div class="oc-fulfillment-body">${escapeHtml(address)}</div>` : ''}
    <div class="oc-fulfillment-note">The shop will message you when your order is ready.</div>
  </div>`
}

function renderShippingBlock(s: LinkRow['shipping']): string {
  if (!s) return ''
  const line1 = (s.line1 || '').trim()
  const line2 = (s.line2 || '').trim()
  const city = (s.city || '').trim()
  const state = (s.state || '').trim()
  const postal = (s.postal || '').trim()
  const street = [line1, line2].filter(Boolean).join(', ')
  const stateZip = [state, postal].filter(Boolean).join(' ')
  const cityLine = [city, stateZip].filter(Boolean).join(', ')
  const address = [street, cityLine].filter(Boolean).join(' · ')
  return `<div class="oc-fulfillment">
    <div class="oc-fulfillment-title">Shipping to</div>
    ${address ? `<div class="oc-fulfillment-body">${escapeHtml(address)}</div>` : ''}
    <div class="oc-fulfillment-note">You'll get a tracking update once the shop hands it to the carrier.</div>
  </div>`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

const ORDER_CONFIRM_STYLE = `
.order-confirm{max-width:640px;margin:0 auto;padding:32px 20px 64px;color:#253b0e;font-family:inherit}
.order-confirm h1{font-size:32px;margin:0 0 10px;line-height:1.15;color:#253b0e}
.order-confirm h2{font-size:14px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#55723e;margin:0 0 12px}
.order-confirm .oc-lead{font-size:15px;line-height:1.55;color:#445b2f;margin:0 0 8px}
.order-confirm .oc-ref{font-size:12.5px;color:#55723e;margin:0 0 24px}
.order-confirm .oc-ref code{background:#f4f8f2;color:#253b0e;padding:2px 8px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.order-confirm .oc-unpaid{background:#fff3cd;color:#653a00;border-radius:12px;padding:16px 18px;margin-bottom:20px}
.order-confirm .oc-unpaid strong{display:block;font-size:14.5px;margin-bottom:4px}
.order-confirm .oc-unpaid p{margin:0;font-size:13.5px;line-height:1.6}
.order-confirm .oc-fulfillment{background:#f4ebd5;border-radius:14px;padding:16px 18px;margin-bottom:14px}
.order-confirm .oc-fulfillment-title{font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#55723e;margin-bottom:4px}
.order-confirm .oc-fulfillment-body{font-size:15px;font-weight:500;color:#253b0e;line-height:1.4;margin-bottom:6px}
.order-confirm .oc-fulfillment-note{font-size:12.5px;color:#55723e;line-height:1.5}
.order-confirm .oc-contact,.order-confirm .oc-payment{background:#f4f8f2;border:1px solid #e4eeda;border-radius:12px;padding:12px 16px;margin-bottom:10px;display:flex;flex-direction:column;gap:6px}
.order-confirm .oc-contact>div,.order-confirm .oc-payment{display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.order-confirm .oc-k{font-size:12px;color:#55723e;text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.order-confirm .oc-v{font-size:13.5px;color:#253b0e;text-align:right}
.order-confirm .oc-summary{margin-top:24px;padding:20px;background:#fff;border:1px solid #e4eeda;border-radius:14px}
.order-confirm .oc-lines{display:flex;flex-direction:column;gap:8px;padding-bottom:14px;border-bottom:1px solid #e4eeda}
.order-confirm .oc-line{display:grid;grid-template-columns:1fr auto auto;gap:16px;align-items:baseline;font-size:14px;color:#253b0e}
.order-confirm .oc-line>span:nth-child(2){font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#55723e}
.order-confirm .oc-costs{display:flex;flex-direction:column;gap:6px;padding:14px 0}
.order-confirm .oc-cost{display:flex;justify-content:space-between;font-size:14px;color:#253b0e}
.order-confirm .oc-total{display:flex;justify-content:space-between;align-items:baseline;padding-top:14px;border-top:1px solid #e4eeda}
.order-confirm .oc-total strong{font-size:22px;font-weight:600}
.order-confirm .oc-cta{display:inline-block;margin-top:28px;padding:14px 28px;background:#253b0e;color:#fff;border-radius:9px;text-decoration:none;font-weight:600;font-size:14px}
.order-confirm .oc-cta:hover{background:#132304}
@media(max-width:600px){
  .order-confirm{padding:20px 16px 48px}
  .order-confirm h1{font-size:26px}
  .order-confirm .oc-cta{display:block;text-align:center}
}
`


function bareThanks(orderId?: string): string {
  const ref = orderId
    ? `<p class="oc-ref">Order reference · <code>${escapeHtml(orderId)}</code></p>`
    : ''
  return `<div class="order-confirm">
  <style>${ORDER_CONFIRM_STYLE}</style>
  <h1>Your order is in.</h1>
  <p class="oc-lead">We'll be in touch shortly.</p>
  ${ref}
  <a class="btn btn-dark oc-cta" href="/">Back to the shop</a>
</div>`
}
