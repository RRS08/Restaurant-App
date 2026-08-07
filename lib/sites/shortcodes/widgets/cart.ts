// ----------------------------------------------------------------
// {{cart}} widget.
//
// Renders the cart page body. Two branches:
//   1. Empty state — no session, no items, or every cart item's
//      product has since disappeared. Emits .cart-empty with the
//      customizable copy from attrs.
//   2. Populated state — .cart-layout with .cart-lines rows and
//      the .cart-summary block. Stepper +/- and Remove are wired
//      by the header widget's global click handler; the endpoint
//      is /api/site-cart/set, and for v1 the response triggers a
//      full page reload so the server's row is always the source
//      of truth (no client-side reconciliation to get wrong).
//
// Attributes (all copy, all optional):
//   empty-title      headline on the empty state
//   empty-cta        empty-state CTA button text
//   empty-cta-href   empty-state CTA target
//   checkout-note    line under the checkout button in the summary
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
  const subtotalStr = formatPrice(subtotal)
  const lines = items.map(renderLine).join('\n')

  return `<div class="cart-layout">
  <div class="cart-lines">
${lines}
  </div>
  <div class="cart-summary">
    <div class="row"><span>Subtotal</span><span><strong>${escapeHtml(subtotalStr)}</strong></span></div>
    <div class="row muted"><span>Shipping &amp; tax</span><span>Calculated at checkout</span></div>
    <a class="btn btn-dark" href="/checkout">Checkout · ${escapeHtml(subtotalStr)}</a>
    <div class="cart-note">${escapeHtml(checkoutNote)}</div>
  </div>
</div>`
}

function renderLine(item: EnrichedCartItem): string {
  const meta = item.unit
    ? `${formatPrice(item.price)} · ${escapeHtml(item.unit)}`
    : formatPrice(item.price)

  return `    <div class="cart-line" data-slug="${escapeAttr(item.slug)}">
      <div class="cart-thumb"><img src="${escapeAttr(item.image_url ?? '')}" alt="${escapeAttr(item.name)}"></div>
      <div class="cart-info">
        <div class="cart-name">${escapeHtml(item.name)}</div>
        <div class="cart-meta">${escapeHtml(meta)}</div>
      </div>
      <div class="stepper">
        <button type="button" data-cart-step="down" data-slug="${escapeAttr(item.slug)}" aria-label="Decrease quantity">–</button>
        <output>${item.qty}</output>
        <button type="button" data-cart-step="up" data-slug="${escapeAttr(item.slug)}" aria-label="Increase quantity">+</button>
      </div>
      <div class="cart-line-total">${escapeHtml(formatPrice(item.line_total))}</div>
      <button class="cart-remove" type="button" data-cart-remove data-slug="${escapeAttr(item.slug)}">Remove</button>
    </div>`
}

function formatPrice(n: number): string {
  return `$${n.toFixed(2)}`
}
