// ----------------------------------------------------------------
// {{cart}} widget.
//
// Renders the cart page body. Two branches:
//   Empty     — no session or all items gone: .cart-empty CTA to /shop
//   Populated — .cart-layout with lines + summary, matches Design's
//               structure:
//                 · Remove sits UNDER the product name (inside
//                   .cart-info) instead of trailing after the line
//                 · "← Continue shopping" link below the last line
//                 · Summary carries an "ORDER SUMMARY" eyebrow, a
//                   short "At checkout" instead of "Calculated at
//                   checkout", and an optional pickup-note under
//                   the Poynt line
//
// Widget ships its own inline <style> so the layout changes travel
// with the widget — no coupled edits to the /cart page's CSS row.
//
// Attributes (all copy, all optional):
//   empty-title      headline on the empty state
//   empty-cta        empty-state CTA button text
//   empty-cta-href   empty-state CTA target
//   checkout-note    small line under the checkout button
//                    ("Card payments handled securely by Poynt")
//   pickup-note      longer line below the Poynt one — surfaces a
//                    fulfillment option like "Local pickup at the
//                    Mercado District shop is free — choose it at
//                    checkout." Skipped when absent.
//   continue-href    where "Continue shopping" points (default /shop)
//   continue-label   its label (default "← Continue shopping")
// ----------------------------------------------------------------

import type { ShortcodeArgs, ShortcodeContext } from '../index'
import { loadCartWithItems, type EnrichedCartItem } from '../../cart'
import { escapeAttr, escapeHtml } from '../utils'

export async function renderCart(args: ShortcodeArgs, ctx: ShortcodeContext): Promise<string> {
  const snap = await loadCartWithItems(ctx.site.id, ctx.sessionId)
  if (snap.items.length === 0) return renderEmpty(args)
  return renderPopulated(args, snap.items, snap.subtotal)
}

function renderEmpty(args: ShortcodeArgs): string {
  const emptyTitle = typeof args['empty-title'] === 'string' ? args['empty-title'] : 'Your cart is empty.'
  const emptyCta = typeof args['empty-cta'] === 'string' ? args['empty-cta'] : 'Browse the shop'
  const emptyCtaHref = typeof args['empty-cta-href'] === 'string' ? args['empty-cta-href'] : '/shop'

  return `<div class="cart-empty">
  <img src="/assets/logo-tree.png" alt="">
  <p>${escapeHtml(emptyTitle)}</p>
  <a class="btn btn-dark" href="${escapeAttr(emptyCtaHref)}">${escapeHtml(emptyCta)}</a>
</div>`
}

function renderPopulated(args: ShortcodeArgs, items: EnrichedCartItem[], subtotal: number): string {
  const checkoutNote = typeof args['checkout-note'] === 'string'
    ? args['checkout-note']
    : 'Card payments handled securely'
  const pickupNote = typeof args['pickup-note'] === 'string' ? args['pickup-note'] : ''
  const continueHref = typeof args['continue-href'] === 'string' ? args['continue-href'] : '/shop'
  const continueLabel = typeof args['continue-label'] === 'string' ? args['continue-label'] : '← Continue shopping'

  const subtotalStr = formatPrice(subtotal)
  const lines = items.map(renderLine).join('\n')
  const pickupBlock = pickupNote
    ? `<div class="cart-pickup">${escapeHtml(pickupNote)}</div>`
    : ''

  return `<div class="cart-layout">
  <style>${CART_STYLE}</style>
  <div class="cart-lines">
${lines}
    <a class="cart-continue" href="${escapeAttr(continueHref)}">${escapeHtml(continueLabel)}</a>
  </div>
  <div class="cart-summary">
    <div class="cart-summary-title">Order summary</div>
    <div class="row"><span>Subtotal</span><span><strong>${escapeHtml(subtotalStr)}</strong></span></div>
    <div class="row muted"><span>Shipping &amp; tax</span><span>At checkout</span></div>
    <a class="btn btn-dark" href="/checkout">Checkout · ${escapeHtml(subtotalStr)}</a>
    <div class="cart-note">${escapeHtml(checkoutNote)}</div>
    ${pickupBlock}
  </div>
</div>`
}

function renderLine(item: EnrichedCartItem): string {
  // When the product has a picker, the variant label ("Tea bags ·
  // 30 ct") IS the size string — dropping .unit avoids doubling.
  // Products with no picker keep the .unit suffix as before.
  const sizeStr = item.variant_label || (item.unit ?? '')
  const meta = sizeStr
    ? `${formatPrice(item.price)} · ${escapeHtml(sizeStr)}`
    : formatPrice(item.price)
  // data-options identifies WHICH line to update on the stepper /
  // remove buttons — same slug can appear multiple times with
  // different options. Serialized as JSON so client JS parses
  // once with JSON.parse.
  const optsAttr = item.options
    ? ` data-options="${escapeAttr(JSON.stringify(item.options))}"`
    : ''

  // Remove sits inside .cart-info under the meta line — Design's
  // shape. Was previously trailing after the line as a 5th grid
  // child, which the grid didn't allocate a track for and pushed
  // to a separate row.
  return `    <div class="cart-line" data-slug="${escapeAttr(item.slug)}"${optsAttr}>
      <div class="cart-thumb"><img src="${escapeAttr(item.image_url ?? '')}" alt="${escapeAttr(item.name)}"></div>
      <div class="cart-info">
        <div class="cart-name">${escapeHtml(item.name)}</div>
        <div class="cart-meta">${escapeHtml(meta)}</div>
        <button class="cart-remove" type="button" data-cart-remove data-slug="${escapeAttr(item.slug)}">Remove</button>
      </div>
      <div class="stepper stepper-plain">
        <button type="button" data-cart-step="down" data-slug="${escapeAttr(item.slug)}" aria-label="Decrease quantity">–</button>
        <output>${item.qty}</output>
        <button type="button" data-cart-step="up" data-slug="${escapeAttr(item.slug)}" aria-label="Increase quantity">+</button>
      </div>
      <div class="cart-line-total">${escapeHtml(formatPrice(item.line_total))}</div>
    </div>`
}

function formatPrice(n: number): string {
  return `$${n.toFixed(2)}`
}

// Widget-local CSS overrides the /cart page's page-specific rules
// so the structural change (Remove inside .cart-info, no trailing
// 5th grid child) doesn't require an SQL edit to the page row.
const CART_STYLE = `
.cart-line{grid-template-columns:66px 1fr}
.cart-info{display:flex;flex-direction:column;gap:4px}
.cart-info .cart-remove{align-self:flex-start;margin-top:6px}
.cart-continue{display:inline-block;margin-top:20px;font-size:13.5px;color:#55723e;border-bottom:1px solid transparent}
.cart-continue:hover{color:#253b0e;border-bottom-color:#cdd3c4}
.cart-summary-title{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#55723e;margin:0 0 14px}
.cart-pickup{font-size:12.5px;color:#55723e;line-height:1.6;margin-top:14px;text-wrap:pretty}
/* Plain stepper — no pill border. Just the -, output, + with
   generous hit targets, matching Design's minimal cart stepper. */
.stepper-plain{display:inline-flex;align-items:center;border:0;gap:2px}
.stepper-plain button{width:32px;height:32px;background:none;border:0;font-size:18px;color:#253b0e;cursor:pointer;padding:0}
.stepper-plain output{min-width:22px;text-align:center;font-size:14.5px;font-weight:500}
@media(min-width:1024px){
  .cart-line{grid-template-columns:96px 1fr auto auto;gap:32px;align-items:center}
  .cart-info{gap:4px}
  .stepper-plain button{width:34px;height:34px}
}
`
