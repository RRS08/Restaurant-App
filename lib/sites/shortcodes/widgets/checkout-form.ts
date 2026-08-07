// ----------------------------------------------------------------
// {{checkout-form}} widget — 3-step progressive-reveal checkout.
//
// Layout is a two-column grid on desktop: form on the left, order
// summary on the right. Three form panels are stacked in the DOM;
// a client-side script hides all but the current one and shifts
// the progress indicator's active step on Continue / Back. On
// final submit the whole form POSTs to /api/site-cart/checkout in
// one go — the server sees every field at once and doesn't need
// draft state.
//
//   Step 1 Contact   email · first name · last name · phone
//                    + optional marketing opt-in
//   Step 2 Delivery  radio list from sites.config.delivery_options
//                    (each carries key/label/sublabel/note/price/
//                     requires_address/default). When the selected
//                    option needs an address, address fields reveal
//                    inline. Order summary's Shipping + Total update
//                    live on selection change.
//   Step 3 Payment   NO card fields — capturing PAN on our origin
//                    is a PCI-compliance failure. Screen shows the
//                    honest "we'll email a payment link" message
//                    + optional "note to shop" + billing-same
//                    checkbox + Place order.
//
// Attributes:
//   empty-title, empty-cta, empty-cta-href  — empty-state copy
//   payment-message                          — copy for step 3's
//                                              deferred-payment block
//   marketing-label                          — label next to the
//                                              opt-in checkbox
// ----------------------------------------------------------------

import type { ShortcodeArgs, ShortcodeContext } from '../index'
import { loadCartWithItems } from '../../cart'
import type { SiteDeliveryOption } from '../../types'
import { escapeAttr, escapeHtml } from '../utils'

export async function renderCheckoutForm(args: ShortcodeArgs, ctx: ShortcodeContext): Promise<string> {
  const snap = await loadCartWithItems(ctx.site.id, ctx.sessionId)
  if (snap.items.length === 0) return renderEmpty(args)

  const config = (ctx.site.config ?? {}) as Record<string, unknown>
  const deliveryOptions = readDeliveryOptions(config)
  const deliveryNotice = typeof config.delivery_notice === 'string' ? config.delivery_notice : ''

  const errorMsg = typeof ctx.query.checkout_error === 'string' ? ctx.query.checkout_error : ''
  const errorBlock = errorMsg
    ? `<div class="co-error">${escapeHtml(errorMsg)}</div>`
    : ''

  const paymentMessage = typeof args['payment-message'] === 'string'
    ? args['payment-message']
    : "We'll email a secure payment link to you within one business day. Your order is locked in — no card details needed here yet."
  const marketingLabel = typeof args['marketing-label'] === 'string'
    ? args['marketing-label']
    : 'Send me new blends and shop news'

  const subtotalStr = formatPrice(snap.subtotal)
  const defaultOption = deliveryOptions.find(o => o.default) ?? deliveryOptions[0]
  const defaultDeliveryPrice = defaultOption?.price ?? 0
  const initialTotal = snap.subtotal + defaultDeliveryPrice

  const summaryLines = snap.items.map(i => `      <div class="co-sum-line">
        <div class="co-sum-thumb"><img src="${escapeAttr(i.image_url ?? '')}" alt="${escapeAttr(i.name)}"></div>
        <div class="co-sum-info">
          <div class="co-sum-name">${escapeHtml(i.name)}</div>
          <div class="co-sum-meta">Qty ${i.qty}${i.unit ? ` · ${escapeHtml(i.unit)}` : ''}</div>
        </div>
        <div class="co-sum-line-total">${escapeHtml(formatPrice(i.line_total))}</div>
      </div>`).join('\n')

  const deliveryRadios = deliveryOptions.map((opt, idx) => renderDeliveryOption(opt, idx === 0 && !defaultOption)).join('\n')
  const deliveryNoticeBlock = deliveryNotice
    ? `<div class="co-delivery-notice">${escapeHtml(deliveryNotice)}</div>`
    : ''

  return `<div class="co-layout">
  <style>${CHECKOUT_STYLE}</style>

  <form class="co-form" method="post" action="/api/site-cart/checkout" data-checkout>
    ${errorBlock}

    <ol class="co-progress" data-current-step="1">
      <li class="co-step is-active" data-step-marker="1"><span class="co-step-num">1</span><span class="co-step-label">Contact</span></li>
      <li class="co-step" data-step-marker="2"><span class="co-step-num">2</span><span class="co-step-label">Delivery</span></li>
      <li class="co-step" data-step-marker="3"><span class="co-step-num">3</span><span class="co-step-label">Payment</span></li>
    </ol>

    <!-- Step 1 Contact -->
    <section class="co-panel" data-panel="1">
      <div class="co-eyebrow">Who's it for</div>
      <div class="co-field">
        <label for="co-email">Email</label>
        <input id="co-email" name="email" type="email" placeholder="you@email.com" required>
      </div>
      <div class="co-row-2">
        <div class="co-field">
          <label for="co-fn">First name</label>
          <input id="co-fn" name="first_name" type="text" required>
        </div>
        <div class="co-field">
          <label for="co-ln">Last name</label>
          <input id="co-ln" name="last_name" type="text" required>
        </div>
      </div>
      <div class="co-field">
        <label for="co-phone">Phone</label>
        <input id="co-phone" name="phone" type="tel" placeholder="(956) 000-0000">
      </div>
      <p class="co-hint">We'll text you when your order is ready. No marketing unless you opt in below.</p>
      <label class="co-check">
        <input type="checkbox" name="opt_in_marketing" value="1">
        <span>${escapeHtml(marketingLabel)}</span>
      </label>
      <div class="co-actions">
        <button type="button" class="btn btn-dark" data-continue="2">Continue to delivery</button>
        <a class="co-back-link" href="/cart">← Back to cart</a>
      </div>
    </section>

    <!-- Step 2 Delivery -->
    <section class="co-panel" data-panel="2" hidden>
      <div class="co-eyebrow">How you'll get it</div>
      <div class="co-delivery" role="radiogroup">
${deliveryRadios}
      </div>
      ${deliveryNoticeBlock}
      <div class="co-address" data-address hidden>
        <div class="co-field">
          <label for="co-line1">Street address</label>
          <input id="co-line1" name="address_line1" type="text" placeholder="123 Main St">
        </div>
        <div class="co-field">
          <label for="co-line2">Apt / Suite <span class="opt">(optional)</span></label>
          <input id="co-line2" name="address_line2" type="text">
        </div>
        <div class="co-row-3">
          <div class="co-field">
            <label for="co-city">City</label>
            <input id="co-city" name="city" type="text">
          </div>
          <div class="co-field">
            <label for="co-state">State</label>
            <input id="co-state" name="state" type="text" placeholder="TX" maxlength="2">
          </div>
          <div class="co-field">
            <label for="co-postal">ZIP</label>
            <input id="co-postal" name="postal" type="text" inputmode="numeric">
          </div>
        </div>
        <input type="hidden" name="country" value="US">
      </div>
      <div class="co-actions">
        <button type="button" class="btn btn-dark" data-continue="3">Continue to payment</button>
        <button type="button" class="co-back-link" data-back="1">← Back</button>
      </div>
    </section>

    <!-- Step 3 Payment -->
    <section class="co-panel" data-panel="3" hidden>
      <div class="co-eyebrow">Payment</div>
      <div class="co-payment-message">
        <strong>You'll get a secure payment link by email.</strong>
        <p>${escapeHtml(paymentMessage)}</p>
      </div>
      <label class="co-check">
        <input type="checkbox" name="billing_same" value="1" checked>
        <span>Billing address is the same</span>
      </label>
      <div class="co-field">
        <label for="co-notes">Note to the shop <span class="opt">(optional)</span></label>
        <textarea id="co-notes" name="notes" rows="4" placeholder="Anything we should know?"></textarea>
      </div>
      <div class="co-actions">
        <button type="submit" class="btn btn-dark co-submit">Place order · <span data-summary-total-btn>${escapeHtml(formatPrice(initialTotal))}</span></button>
        <button type="button" class="co-back-link" data-back="2">← Back</button>
      </div>
    </section>
  </form>

  <aside class="co-summary">
    <div class="co-summary-title">Order summary</div>
    <div class="co-sum-lines">
${summaryLines}
    </div>
    <div class="co-sum-totals">
      <div class="row"><span>Subtotal</span><span data-summary-subtotal>${escapeHtml(subtotalStr)}</span></div>
      <div class="row"><span>Shipping</span><span data-summary-shipping>${escapeHtml(defaultDeliveryPrice === 0 ? 'Free' : formatPrice(defaultDeliveryPrice))}</span></div>
      <div class="row muted"><span>Tax</span><span>Calculated next</span></div>
    </div>
    <div class="co-total"><span>Total</span><strong data-summary-total>${escapeHtml(formatPrice(initialTotal))}</strong></div>
    <div class="cart-note">Card payments handled securely by Poynt</div>
  </aside>

  <script>${CHECKOUT_SCRIPT}</script>
</div>`
}

function renderDeliveryOption(opt: SiteDeliveryOption, forceDefault: boolean): string {
  const isDefault = opt.default === true || forceDefault
  const priceLabel = opt.price === 0 ? 'Free' : formatPrice(opt.price)
  const requires = opt.requires_address === true ? '1' : '0'

  return `        <label class="co-delivery-opt${isDefault ? ' is-selected' : ''}">
          <input type="radio" name="delivery_option" value="${escapeAttr(opt.key)}" data-price="${opt.price}" data-requires-address="${requires}"${isDefault ? ' checked' : ''}>
          <div class="co-delivery-body">
            <div class="co-delivery-label">${escapeHtml(opt.label)}</div>
            ${opt.sublabel ? `<div class="co-delivery-sub">${escapeHtml(opt.sublabel)}</div>` : ''}
            ${opt.note ? `<div class="co-delivery-note">${escapeHtml(opt.note)}</div>` : ''}
          </div>
          <div class="co-delivery-price">${escapeHtml(priceLabel)}</div>
        </label>`
}

function renderEmpty(args: ShortcodeArgs): string {
  const emptyTitle = typeof args['empty-title'] === 'string' ? args['empty-title'] : 'Nothing to check out yet.'
  const emptyCta = typeof args['empty-cta'] === 'string' ? args['empty-cta'] : 'Browse the shop'
  const emptyCtaHref = typeof args['empty-cta-href'] === 'string' ? args['empty-cta-href'] : '/shop'

  return `<div class="co-empty">
  <p>${escapeHtml(emptyTitle)}</p>
  <a class="btn btn-dark" href="${escapeAttr(emptyCtaHref)}">${escapeHtml(emptyCta)}</a>
</div>`
}

function readDeliveryOptions(config: Record<string, unknown>): SiteDeliveryOption[] {
  const raw = config.delivery_options
  if (!Array.isArray(raw)) return DEFAULT_DELIVERY
  const cleaned: SiteDeliveryOption[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Partial<SiteDeliveryOption>
    if (typeof o.key !== 'string' || typeof o.label !== 'string' || typeof o.price !== 'number') continue
    cleaned.push({
      key: o.key,
      label: o.label,
      sublabel: typeof o.sublabel === 'string' ? o.sublabel : undefined,
      note: typeof o.note === 'string' ? o.note : undefined,
      price: o.price,
      requires_address: o.requires_address === true,
      default: o.default === true,
    })
  }
  return cleaned.length > 0 ? cleaned : DEFAULT_DELIVERY
}

/** Fallback so a site without delivery_options in config still gets a
 *  working (single-option) checkout. */
const DEFAULT_DELIVERY: SiteDeliveryOption[] = [
  { key: 'ship', label: 'Ship to me', price: 0, requires_address: true, default: true },
]

function formatPrice(n: number): string {
  return `$${n.toFixed(2)}`
}

const CHECKOUT_STYLE = `
.co-layout{display:grid;grid-template-columns:1fr;gap:32px}
.co-error{background:#ffe3e3;color:#8a2320;border-radius:9px;padding:14px;font-size:14px;line-height:1.5;margin-bottom:20px}
/* Dividers flex-grow to fill remaining space instead of being
   fixed 56px each — that overflowed narrow mobile viewports and
   clipped step 3's label. Now the whole strip spans the container
   naturally at any width. */
.co-progress{list-style:none;padding:0;margin:0 0 28px;display:flex;align-items:center;font-size:12.5px}
.co-progress .co-step{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-width:0}
.co-progress .co-step + .co-step::before{content:"";display:block;height:1px;background:#d4e7c7;flex:1;min-width:16px;margin:0 10px}
@media(max-width:600px){
  .co-progress{font-size:11px}
  .co-progress .co-step{gap:6px}
  .co-progress .co-step + .co-step::before{margin:0 6px;min-width:8px}
  .co-step-num{width:24px;height:24px;font-size:11px}
}
.co-step-num{width:28px;height:28px;border-radius:50%;border:1.5px solid #d4e7c7;color:#55723e;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;background:#fff}
.co-step.is-active .co-step-num{background:#253b0e;color:#fff;border-color:#253b0e}
.co-step.is-done .co-step-num{background:#253b0e;color:#fff;border-color:#253b0e}
.co-step-label{color:#55723e;font-weight:500}
.co-step.is-active .co-step-label,.co-step.is-done .co-step-label{color:#253b0e}
.co-eyebrow{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#55723e;margin:0 0 16px}
.co-panel{display:flex;flex-direction:column;gap:14px}
/* Explicit display value clobbers the browser default
   [hidden]{display:none}. Attribute selector has higher
   specificity than the class rule above so it wins on the two
   panels we hide via the hidden attribute. Same for the
   conditional address block on step 2. */
.co-panel[hidden],.co-address[hidden]{display:none}
.co-field{display:flex;flex-direction:column;gap:6px}
.co-field label{font-size:12px;font-weight:600;color:#445b2f}
.co-field label .opt{font-weight:400;color:#55723e}
.co-field input,.co-field textarea{width:100%;background:#f4f8f2;border:1px solid #d4e7c7;border-radius:9px;padding:13px;font:inherit;font-size:14px;color:#253b0e}
.co-field input::placeholder,.co-field textarea::placeholder{color:#758969}
.co-field input:focus,.co-field textarea:focus{outline:2px solid #536f3b;outline-offset:1px;border-color:transparent}
.co-field textarea{resize:vertical;min-height:96px}
.co-row-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.co-row-3{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px}
.co-hint{font-size:12.5px;color:#55723e;margin:0;line-height:1.55}
.co-check{display:flex;align-items:center;gap:10px;font-size:13.5px;color:#445b2f;cursor:pointer}
.co-check input{width:16px;height:16px;accent-color:#253b0e}
.co-actions{display:flex;align-items:center;gap:20px;margin-top:12px;flex-wrap:wrap}
.co-actions .btn{padding:14px 26px}
.co-back-link{font-size:13.5px;color:#55723e;background:none;border:0;padding:0;cursor:pointer;text-decoration:none}
.co-back-link:hover{color:#253b0e}
.co-delivery{display:flex;flex-direction:column;gap:12px}
.co-delivery-opt{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;padding:16px 18px;border:1.5px solid #d4e7c7;border-radius:14px;cursor:pointer;transition:border-color .18s ease}
.co-delivery-opt.is-selected{border-color:#253b0e;box-shadow:inset 0 0 0 1px #253b0e}
.co-delivery-opt input[type=radio]{width:18px;height:18px;accent-color:#253b0e;margin:0}
.co-delivery-label{font-size:15px;font-weight:600;color:#253b0e}
.co-delivery-sub{font-size:13px;color:#55723e;margin-top:3px;line-height:1.5}
.co-delivery-note{font-size:12.5px;color:#55723e;margin-top:2px}
.co-delivery-price{font-size:14px;font-weight:600;color:#253b0e;white-space:nowrap}
.co-delivery-notice{background:#e7f4de;color:#445b2f;font-size:13px;line-height:1.6;padding:14px 16px;border-radius:12px}
.co-address{display:flex;flex-direction:column;gap:12px;padding-top:4px}
.co-payment-message{background:#e7f4de;color:#354d1c;border-radius:14px;padding:18px}
.co-payment-message strong{display:block;margin-bottom:6px;font-size:14.5px;font-weight:600}
.co-payment-message p{font-size:13.5px;line-height:1.65;color:#445b2f;margin:0}
.co-summary{background:#f4ebd5;border-radius:16px;padding:22px;align-self:start}
.co-summary-title{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#55723e;margin:0 0 14px}
.co-sum-lines{display:flex;flex-direction:column;gap:14px;padding-bottom:16px;border-bottom:1px solid #e6d8b2;margin-bottom:14px}
.co-sum-line{display:grid;grid-template-columns:52px 1fr auto;gap:12px;align-items:center}
.co-sum-thumb{background:#fff;border-radius:10px;padding:6px}
.co-sum-thumb img{width:100%;aspect-ratio:1;object-fit:contain}
.co-sum-name{font-size:14px;font-weight:600;color:#253b0e}
.co-sum-meta{font-size:12px;color:#55723e;margin-top:2px}
.co-sum-line-total{font-size:14px;font-weight:600;color:#253b0e}
.co-sum-totals{display:flex;flex-direction:column;gap:8px}
.co-sum-totals .row{display:flex;justify-content:space-between;font-size:14px;color:#253b0e}
.co-sum-totals .row.muted{color:#55723e;font-size:13px}
.co-total{display:flex;justify-content:space-between;align-items:baseline;margin-top:14px;padding-top:14px;border-top:1px solid #e6d8b2}
.co-total strong{font-size:22px;font-weight:600}
.cart-note{font-size:11.5px;color:#55723e;text-align:center;margin-top:12px}
.co-empty{text-align:center;padding:32px 0}
.co-empty p{font-size:16px;color:#55723e;margin-bottom:16px}
.co-empty .btn{display:inline-block;padding:14px 32px}
@media(min-width:1024px){
  .co-layout{grid-template-columns:1fr 380px;gap:56px}
  .co-summary{position:sticky;top:24px}
  .co-actions{gap:26px}
}
`

const CHECKOUT_SCRIPT = `
(function(){
  var root = document.querySelector('[data-checkout]');
  if (!root) return;
  var progress = root.querySelector('.co-progress');
  var panels = root.querySelectorAll('.co-panel');
  var stepMarkers = root.querySelectorAll('[data-step-marker]');

  function show(step){
    panels.forEach(function(p){
      if (p.dataset.panel === String(step)) p.removeAttribute('hidden');
      else p.setAttribute('hidden','');
    });
    stepMarkers.forEach(function(m){
      var n = parseInt(m.dataset.stepMarker, 10);
      m.classList.remove('is-active','is-done');
      if (n < step) m.classList.add('is-done');
      else if (n === step) m.classList.add('is-active');
    });
    if (progress) progress.dataset.currentStep = String(step);
  }

  function requiredInputsIn(panel){
    return panel.querySelectorAll('input[required], textarea[required]');
  }
  function validatePanel(step){
    var panel = root.querySelector('[data-panel="' + step + '"]');
    if (!panel) return true;
    var ok = true;
    requiredInputsIn(panel).forEach(function(el){
      if (!el.reportValidity()) ok = false;
    });
    return ok;
  }

  root.addEventListener('click', function(e){
    var cont = e.target.closest && e.target.closest('[data-continue]');
    if (cont) {
      var current = parseInt(progress.dataset.currentStep, 10) || 1;
      if (!validatePanel(current)) return;
      show(parseInt(cont.dataset.continue, 10));
      window.scrollTo({top: 0, behavior: 'smooth'});
      return;
    }
    var back = e.target.closest && e.target.closest('[data-back]');
    if (back) {
      show(parseInt(back.dataset.back, 10));
      window.scrollTo({top: 0, behavior: 'smooth'});
      return;
    }
  });

  // Delivery selection: keep .is-selected on the chosen option,
  // reveal/hide address block, update Shipping + Total lines and
  // the "Place order · $X" button label.
  var subtotalEl = root.querySelector('[data-summary-subtotal]');
  var shippingEl = root.querySelector('[data-summary-shipping]');
  var totalEl = root.querySelector('[data-summary-total]');
  var totalBtnEl = root.querySelector('[data-summary-total-btn]');
  var addressBlock = root.querySelector('[data-address]');
  var addressInputs = addressBlock ? addressBlock.querySelectorAll('input[name="address_line1"], input[name="city"], input[name="state"], input[name="postal"]') : [];

  function money(n){ return '$' + (Math.round(n * 100) / 100).toFixed(2); }
  function currentSubtotal(){
    if (!subtotalEl) return 0;
    var s = subtotalEl.textContent || '';
    return parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
  }

  function applyDelivery(radio){
    var price = parseFloat(radio.dataset.price || '0') || 0;
    var needsAddr = radio.dataset.requiresAddress === '1';
    // paint selection state on all cards
    root.querySelectorAll('.co-delivery-opt').forEach(function(l){ l.classList.remove('is-selected'); });
    var wrapper = radio.closest('.co-delivery-opt');
    if (wrapper) wrapper.classList.add('is-selected');
    // toggle address block + required attrs (required-address so
    // browser validation fires on Continue if fields are empty)
    if (addressBlock) {
      if (needsAddr) addressBlock.removeAttribute('hidden');
      else addressBlock.setAttribute('hidden','');
    }
    addressInputs.forEach(function(inp){
      if (needsAddr) inp.setAttribute('required','');
      else inp.removeAttribute('required');
    });
    // update summary numbers
    var sub = currentSubtotal();
    var total = sub + price;
    if (shippingEl) shippingEl.textContent = price === 0 ? 'Free' : money(price);
    if (totalEl) totalEl.textContent = money(total);
    if (totalBtnEl) totalBtnEl.textContent = money(total);
  }

  root.addEventListener('change', function(e){
    if (e.target && e.target.name === 'delivery_option') applyDelivery(e.target);
  });

  // Kick off with whichever radio is initially checked so the
  // address block + summary numbers match the default selection.
  var checkedRadio = root.querySelector('input[name="delivery_option"]:checked');
  if (checkedRadio) applyDelivery(checkedRadio);
})();
`
