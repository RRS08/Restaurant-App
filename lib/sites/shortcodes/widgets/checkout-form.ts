// ----------------------------------------------------------------
// {{checkout-form}} widget.
//
// Renders the /checkout page's form. Two branches:
//   Cart empty        → a short "nothing to check out" state that
//                        links back to /shop.
//   Cart populated    → contact + shipping fields, a read-only
//                        order summary, and a "Place order · $X"
//                        submit that POSTs to
//                        /api/site-cart/checkout.
//
// When the checkout endpoint redirects back with
// ?checkout_error=… (validation, payment adapter refusal, session
// expired), the message renders as a red band at the top of the
// form so the buyer sees WHY they're back on this page.
//
// No page-specific JS: the browser's native form submit handles
// the POST; the endpoint issues a 303 to /thanks on success or
// back to /checkout with the error in the URL on failure.
// ----------------------------------------------------------------

import type { ShortcodeContext } from '../index'
import { loadCartWithItems } from '../../cart'
import { escapeHtml } from '../utils'

export async function renderCheckoutForm(_args: unknown, ctx: ShortcodeContext): Promise<string> {
  const snap = await loadCartWithItems(ctx.site.id, ctx.sessionId)
  if (snap.items.length === 0) {
    return `<div class="co-empty">
  <p>Nothing to check out yet.</p>
  <a class="btn btn-dark" href="/shop">Browse the shop</a>
</div>`
  }

  const errorMsg = typeof ctx.query.checkout_error === 'string' ? ctx.query.checkout_error : ''
  const errorBlock = errorMsg
    ? `<div class="co-error">${escapeHtml(errorMsg)}</div>`
    : ''

  const summaryLines = snap.items.map(i => `      <div class="co-sum-line">
        <span>${escapeHtml(i.name)} × ${i.qty}</span>
        <span>$${i.line_total.toFixed(2)}</span>
      </div>`).join('\n')

  const subtotalStr = `$${snap.subtotal.toFixed(2)}`

  return `<form class="co-form" method="post" action="/api/site-cart/checkout">
  ${errorBlock}

  <section class="co-section">
    <h2>Contact</h2>
    <div class="co-field">
      <label for="co-name">Name</label>
      <input id="co-name" name="name" type="text" placeholder="Your name" required>
    </div>
    <div class="co-field">
      <label for="co-email">Email</label>
      <input id="co-email" name="email" type="email" placeholder="you@email.com" required>
    </div>
    <div class="co-field">
      <label for="co-phone">Phone <span class="opt">(optional)</span></label>
      <input id="co-phone" name="phone" type="tel" placeholder="(956) 000-0000">
    </div>
  </section>

  <section class="co-section">
    <h2>Shipping</h2>
    <div class="co-field">
      <label for="co-line1">Street address</label>
      <input id="co-line1" name="address_line1" type="text" placeholder="123 Main St" required>
    </div>
    <div class="co-field">
      <label for="co-line2">Apt / Suite <span class="opt">(optional)</span></label>
      <input id="co-line2" name="address_line2" type="text">
    </div>
    <div class="co-row">
      <div class="co-field">
        <label for="co-city">City</label>
        <input id="co-city" name="city" type="text" required>
      </div>
      <div class="co-field">
        <label for="co-state">State</label>
        <input id="co-state" name="state" type="text" placeholder="TX" maxlength="2" required>
      </div>
      <div class="co-field">
        <label for="co-postal">ZIP</label>
        <input id="co-postal" name="postal" type="text" inputmode="numeric" required>
      </div>
    </div>
    <input type="hidden" name="country" value="US">
  </section>

  <section class="co-section co-summary">
    <h2>Your order</h2>
    <div class="co-sum-lines">
${summaryLines}
    </div>
    <div class="co-total">
      <span>Total</span>
      <strong>${subtotalStr}</strong>
    </div>
  </section>

  <section class="co-section co-payment">
    <h2>Payment</h2>
    <p class="co-payment-note">A secure payment link will be emailed to you after we review your order — usually within one business day.</p>
  </section>

  <button type="submit" class="btn btn-dark co-submit">Place order · ${subtotalStr}</button>
</form>`
}
