// ----------------------------------------------------------------
// {{cart}} widget.
//
// Renders the cart page body. Server-side cart state doesn't exist
// yet — the design's cart is client-only, primed by the add buttons
// on /shop and the PDP via fetch. Until the server cart lands, this
// widget always emits the .cart-empty block; the with-items branch
// exists as scaffolding for when the state model arrives.
//
// Attributes (all optional, all soaked up as free-form copy):
//   empty-title      headline shown when the cart is empty
//   empty-cta        CTA button text
//   empty-cta-href   CTA target
//   checkout-note    line under the checkout button in the summary
//                    (unused right now — surfaces once with-items
//                    lands)
// ----------------------------------------------------------------

import type { ShortcodeArgs } from '../index'
import { escapeAttr, escapeHtml } from '../utils'

export function renderCart(args: ShortcodeArgs): string {
  const emptyTitle = typeof args['empty-title'] === 'string'
    ? args['empty-title']
    : 'Your cart is empty.'
  const emptyCta = typeof args['empty-cta'] === 'string'
    ? args['empty-cta']
    : 'Browse the shop'
  const emptyCtaHref = typeof args['empty-cta-href'] === 'string'
    ? args['empty-cta-href']
    : '/shop'

  return `<div class="cart-empty">
  <img src="/assets/logo-tree.png" alt="">
  <p>${escapeHtml(emptyTitle)}</p>
  <a class="btn btn-dark" href="${escapeAttr(emptyCtaHref)}">${escapeHtml(emptyCta)}</a>
</div>`
}
