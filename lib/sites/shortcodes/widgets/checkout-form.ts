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
import { loadCollectConfigForSite, type CollectClientConfig } from '@/lib/godaddy/collect'

export async function renderCheckoutForm(args: ShortcodeArgs, ctx: ShortcodeContext): Promise<string> {
  const snap = await loadCartWithItems(ctx.site.id, ctx.sessionId)
  if (snap.items.length === 0) return renderEmpty(args)

  const config = (ctx.site.config ?? {}) as Record<string, unknown>
  const deliveryOptions = readDeliveryOptions(config)
  const deliveryNotice = typeof config.delivery_notice === 'string' ? config.delivery_notice : ''

  // Resolve the Poynt Collect config for this merchant if the site's
  // payment_provider is godaddy. Env comes from the site's own
  // config (sites.config.payment_env) — a site opts into sandbox
  // without ever affecting another site's live integration. Null
  // when merchant hasn't linked a token for this env yet or when
  // GODADDY_POYNT_APP_ID is unset — widget falls back to the
  // deferred-payment "email a link" copy on step 3.
  const paymentEnv: 'prod' | 'ote' = config.payment_env === 'ote' ? 'ote' : 'prod'
  const collect = readPaymentProvider(config) === 'godaddy'
    ? await loadCollectConfigForSite({ restaurantId: ctx.site.restaurant_id, env: paymentEnv })
    : null

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
  // Tax is applied to (subtotal + delivery) — matches Texas rules
  // (shipping charges are taxable when the underlying items are).
  // taxRate is a decimal in sites.config (e.g. 0.0825 for McAllen).
  // Absent config = 0 = no tax line shown, existing sites unchanged.
  const taxRate = readTaxRate(config)
  const initialTax = round2((snap.subtotal + defaultDeliveryPrice) * taxRate)
  const initialTotal = round2(snap.subtotal + defaultDeliveryPrice + initialTax)

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

      <div class="co-cards-accepted">
        <span class="co-cards-label">We accept</span>
        <div class="co-brands">
          <span class="co-brand co-brand-visa" aria-label="Visa">VISA</span>
          <span class="co-brand co-brand-mc" aria-label="Mastercard">Mastercard</span>
          <span class="co-brand co-brand-amex" aria-label="American Express">AMEX</span>
          <span class="co-brand co-brand-disc" aria-label="Discover">Discover</span>
        </div>
      </div>

      <div class="co-field">
        <label for="co-cardholder">Name on card</label>
        <input id="co-cardholder" name="cardholder_name" type="text" placeholder="As shown on the card" autocomplete="cc-name" required>
      </div>

      ${renderPaymentBlock(collect, paymentMessage)}

      <label class="co-check">
        <input type="checkbox" name="billing_same" value="1" checked data-billing-toggle>
        <span>Billing address is the same as delivery</span>
      </label>

      <div class="co-billing" data-billing hidden>
        <div class="co-field">
          <label for="co-bill-line1">Billing street address</label>
          <input id="co-bill-line1" name="billing_line1" type="text" autocomplete="billing address-line1">
        </div>
        <div class="co-field">
          <label for="co-bill-line2">Apt / Suite <span class="opt">(optional)</span></label>
          <input id="co-bill-line2" name="billing_line2" type="text" autocomplete="billing address-line2">
        </div>
        <div class="co-row-3">
          <div class="co-field">
            <label for="co-bill-city">City</label>
            <input id="co-bill-city" name="billing_city" type="text" autocomplete="billing address-level2">
          </div>
          <div class="co-field">
            <label for="co-bill-state">State</label>
            <input id="co-bill-state" name="billing_state" type="text" placeholder="TX" maxlength="2" autocomplete="billing address-level1">
          </div>
          <div class="co-field">
            <label for="co-bill-postal">ZIP</label>
            <input id="co-bill-postal" name="billing_postal" type="text" inputmode="numeric" autocomplete="billing postal-code">
          </div>
        </div>
      </div>

      <div class="co-field">
        <label for="co-notes">Note to the shop <span class="opt">(optional)</span></label>
        <textarea id="co-notes" name="notes" rows="4" placeholder="Anything we should know?"></textarea>
      </div>
      <div class="co-actions">
        <button type="submit" class="btn btn-dark co-submit" data-initial-total="${initialTotal}">Place order · <span data-summary-total-btn>${escapeHtml(formatPrice(initialTotal))}</span></button>
        <button type="button" class="co-back-link" data-back="2">← Back</button>
      </div>
    </section>
  </form>

  <aside class="co-summary">
    <div class="co-summary-title">Order summary</div>
    <div class="co-sum-lines">
${summaryLines}
    </div>
    <div class="co-sum-totals" data-tax-rate="${taxRate}" data-subtotal="${snap.subtotal}">
      <div class="row"><span>Subtotal</span><span data-summary-subtotal>${escapeHtml(subtotalStr)}</span></div>
      <div class="row"><span data-summary-delivery-label>${escapeHtml(defaultDeliveryPrice === 0 ? 'Pickup' : 'Shipping')}</span><span data-summary-shipping>${escapeHtml(defaultDeliveryPrice === 0 ? (defaultOption?.sublabel ?? 'In store') : formatPrice(defaultDeliveryPrice))}</span></div>
      ${taxRate > 0
        ? `<div class="row"><span>Tax</span><span data-summary-tax>${escapeHtml(formatPrice(initialTax))}</span></div>`
        : `<div class="row muted"><span>Tax</span><span>Not applied</span></div>`}
    </div>
    <div class="co-total"><span>Total</span><strong data-summary-total>${escapeHtml(formatPrice(initialTotal))}</strong></div>
    <div class="cart-note">Card payments handled securely by Poynt</div>
  </aside>

  <script>${CHECKOUT_SCRIPT}</script>
  ${renderCollectBootstrap(collect)}
</div>`
}

/** Step 3 body: real Collect iframe when the merchant is wired,
 *  falls back to the "email a link" copy when it isn't. Card
 *  input styling lives in CHECKOUT_STYLE under .co-card-mount. */
function renderPaymentBlock(collect: CollectClientConfig | null, fallbackMessage: string): string {
  if (!collect) {
    return `<div class="co-payment-message">
        <strong>You'll get a secure payment link by email.</strong>
        <p>${escapeHtml(fallbackMessage)}</p>
      </div>`
  }
  const sandboxBadge = collect.isSandbox
    ? '<div class="co-sandbox-badge">Sandbox mode — use Poynt test cards</div>'
    : ''
  // No wrapping label here — Poynt now renders per-field labels
  // (Card number / Expiry / CVC) inside the iframe via displayComponents.
  return `<div id="poynt-card-mount" class="co-card-mount"></div>
      <input type="hidden" name="poynt_collect_nonce" value="">
      <div class="co-card-error" data-collect-error hidden></div>
      ${sandboxBadge}`
}

/** Inline SDK loader + tokenizer bootstrap. Only emitted when
 *  Collect is available for this site — otherwise the fallback
 *  message goes out and no external script is loaded. */
function renderCollectBootstrap(collect: CollectClientConfig | null): string {
  if (!collect) return ''
  const cfg = JSON.stringify({
    sdkUrl: collect.sdkUrl,
    businessId: collect.businessId,
    applicationId: collect.applicationId,
  })
  return `<script src="${escapeAttr(collect.sdkUrl)}" async></script>
<script>${COLLECT_SCRIPT_PREAMBLE}
window.__checkoutCollectBoot(${cfg});
</script>`
}

function readPaymentProvider(config: Record<string, unknown>): string | null {
  const v = config.payment_provider
  return typeof v === 'string' ? v : null
}

function renderDeliveryOption(opt: SiteDeliveryOption, forceDefault: boolean): string {
  const isDefault = opt.default === true || forceDefault
  const priceLabel = opt.price === 0 ? 'Free' : formatPrice(opt.price)
  const requires = opt.requires_address === true ? '1' : '0'

  return `        <label class="co-delivery-opt${isDefault ? ' is-selected' : ''}">
          <input type="radio" name="delivery_option" value="${escapeAttr(opt.key)}" data-price="${opt.price}" data-requires-address="${requires}" data-label="${escapeAttr(opt.label)}" data-sublabel="${escapeAttr(opt.sublabel ?? '')}"${isDefault ? ' checked' : ''}>
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

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Site's sales-tax rate as a decimal (0.0825 = 8.25%). Missing or
 *  invalid config = 0 = no tax applied. Callers apply this to
 *  (subtotal + delivery) — matches Texas convention where shipping
 *  is taxable when the underlying items are. Sites in other states
 *  can either set a blended rate or we'll extend later with a
 *  tax_base config knob. */
function readTaxRate(config: Record<string, unknown>): number {
  const raw = config.tax_rate
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  if (typeof raw === 'string') {
    const parsed = parseFloat(raw)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return 0
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
.co-card-field{display:flex;flex-direction:column;gap:8px}
.co-card-field label{font-size:12px;font-weight:600;color:#445b2f}
/* Wrapper around Poynt's iframe. Height is driven by the iframe
   itself (via iframe_height_change) — Poynt renders Card number on
   its own row and Expiry + CVC as a two-column row below, with our
   customCss styling matching the surrounding form. Their inline
   error text is hidden via customCss.errorText.base — validation
   errors surface via our own [data-collect-error] below the mount,
   so the container never balloons on a validation fail. */
/* Container height is driven live by iframe_height_change — the
   iframe reports its full content height and we mirror it, so
   neither the iframe nor the container ever needs a scrollbar.
   The iframe height:100% rule forces Poynt's iframe to obey the
   container height instead of its inline HTML height attribute,
   which was leaving an inner scroll on the CVV row when their
   default height was shorter than the stacked content. */
.co-card-mount{background:transparent;min-height:56px;transition:height .15s ease}
.co-card-mount iframe{width:100%;height:100%;border:0;display:block}
.co-card-error{background:#ffe3e3;color:#8a2320;border-radius:9px;padding:12px;font-size:13.5px;line-height:1.5}
.co-sandbox-badge{align-self:flex-start;background:#fff3cd;color:#653a00;font-size:11.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:5px 10px;border-radius:6px}
/* "We accept" card brand row — sits above the Name on card + iframe
   to reassure the buyer the site takes their card before they get
   into the fields. Text-based pills with brand colors — no images,
   no CDN dependency, renders in any browser. */
.co-cards-accepted{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:2px 0 4px}
.co-cards-label{font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#55723e}
.co-brands{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.co-brand{display:inline-flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:800;letter-spacing:.06em;padding:6px 10px;border-radius:6px;color:#fff;font-family:system-ui,sans-serif;min-width:44px;text-align:center}
.co-brand-visa{background:#1a1f71}
.co-brand-mc{background:#eb001b;position:relative}
.co-brand-amex{background:#006fcf}
.co-brand-disc{background:#ff6000;color:#fff}
/* Billing address reveal block — hidden by default (billing_same
   checkbox is checked at load); slides in when the buyer unchecks
   to enter a separate billing address for card verification. */
.co-billing{display:flex;flex-direction:column;gap:12px;padding-top:4px;padding-left:14px;border-left:2px solid #d4e7c7;margin-left:4px}
.co-billing[hidden]{display:none}
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
    // Re-apply the current delivery selection whenever a panel
    // becomes visible. Cheap safety net for the "Place order · $0.00"
    // symptom on step 3 — the button label + summary numbers get
    // recomputed from the currently-checked radio every time,
    // instead of relying on a single init-time apply.
    var r = root.querySelector('input[name="delivery_option"]:checked')
         || root.querySelector('input[name="delivery_option"]');
    if (r) applyDelivery(r);
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
  // reveal/hide address block, update Delivery/Tax/Total lines
  // and the "Place order · $X" button label.
  var subtotalEl = root.querySelector('[data-summary-subtotal]');
  var deliveryLabelEl = root.querySelector('[data-summary-delivery-label]');
  var shippingEl = root.querySelector('[data-summary-shipping]');
  var taxEl = root.querySelector('[data-summary-tax]');
  var totalEl = root.querySelector('[data-summary-total]');
  var totalBtnEl = root.querySelector('[data-summary-total-btn]');
  var submitBtn = root.querySelector('.co-submit');
  var totalsEl = root.querySelector('.co-sum-totals');
  // Both taxRate and subtotal come from data attributes — server-
  // side ground truth, immutable, no DOM-text parsing fragility.
  // Fixes the $6.00 button symptom where currentSubtotal() from
  // DOM textContent was returning something weird under some race.
  var taxRate = totalsEl ? (parseFloat(totalsEl.dataset.taxRate || '0') || 0) : 0;
  var subtotalRaw = totalsEl ? (parseFloat(totalsEl.dataset.subtotal || '0') || 0) : 0;
  var addressBlock = root.querySelector('[data-address]');
  var addressInputs = addressBlock ? addressBlock.querySelectorAll('input[name="address_line1"], input[name="city"], input[name="state"], input[name="postal"]') : [];
  var billingToggle = root.querySelector('[data-billing-toggle]');
  var billingBlock = root.querySelector('[data-billing]');

  function money(n){ return '$' + (Math.round(n * 100) / 100).toFixed(2); }
  function round2(n){ return Math.round(n * 100) / 100; }
  function currentSubtotal(){ return subtotalRaw; }
  // Single source of truth for the button label. Any time totalEl
  // gets updated, syncButton() runs — no separate math, no chance
  // of button drifting from the summary Total row.
  function syncButton() {
    if (!totalBtnEl || !totalEl) return;
    totalBtnEl.textContent = totalEl.textContent || '';
  }

  // Billing address toggle. When "Billing address is the same as
  // delivery" is UNCHECKED, reveal the billing fields so the buyer
  // can enter a separate address for card verification.
  function applyBillingToggle() {
    if (!billingToggle || !billingBlock) return;
    if (billingToggle.checked) billingBlock.setAttribute('hidden', '');
    else billingBlock.removeAttribute('hidden');
  }
  if (billingToggle) {
    billingToggle.addEventListener('change', applyBillingToggle);
    applyBillingToggle();
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
    // update summary numbers — tax applies to (subtotal + delivery),
    // matching TX rules and the server-side calculation.
    var sub = currentSubtotal();
    var tax = round2((sub + price) * taxRate);
    var total = round2(sub + price + tax);
    // Row label + value swap: pickup shows the store address instead
    // of "Free"; shipping shows the price. Everything sourced from
    // the radio's own data-attrs so future delivery options don't
    // need widget changes.
    var sublabel = radio.dataset.sublabel || '';
    if (deliveryLabelEl) deliveryLabelEl.textContent = price === 0 ? 'Pickup' : 'Shipping';
    if (shippingEl) shippingEl.textContent = price === 0 ? (sublabel || 'In store') : money(price);
    if (taxEl) taxEl.textContent = money(tax);
    if (totalEl) totalEl.textContent = money(total);
    // Button always mirrors the Total row. No independent math, no
    // "total > 0" guard — a zero cart never gets here (checkout blocks
    // empty carts server-side) and syncing textContent keeps the
    // button and summary from ever disagreeing.
    syncButton();
  }

  root.addEventListener('change', function(e){
    if (e.target && e.target.name === 'delivery_option') applyDelivery(e.target);
  });

  // Kick off with whichever radio is initially checked, falling
  // back to the first radio if the server's default-checked marker
  // didn't stick for any reason. Guarantees the button label + totals
  // reflect a real delivery choice from first paint.
  var checkedRadio = root.querySelector('input[name="delivery_option"]:checked')
                  || root.querySelector('input[name="delivery_option"]');
  if (checkedRadio) applyDelivery(checkedRadio);
})();
`

// Poynt Collect bootstrap. Runs when Collect config is available
// for the merchant. Waits for the async-loaded SDK, mounts the
// card iframe into #poynt-card-mount, subscribes to the nonce
// event, and intercepts the form submit — first submit collects
// the nonce, populates the hidden field, then re-submits the form
// so the server sees it in the normal POST body.
//
// Wrapped in a function that runs the config object we serialize
// into the inline call site — keeps the SDK URL / businessId /
// applicationId out of a global.
const COLLECT_SCRIPT_PREAMBLE = `
window.__checkoutCollectBoot = window.__checkoutCollectBoot || function(cfg) {
  var form = document.querySelector('.co-form[data-checkout]');
  if (!form) return;
  var nonceField = form.querySelector('[name="poynt_collect_nonce"]');
  var errorBox = form.querySelector('[data-collect-error]');
  var tokenizer = null;
  var awaitingSubmit = false;
  // Flipped true when Poynt fires iframe_ready — used by the submit
  // interceptor so a click during the load window shows the right
  // "still loading" message instead of falsely reporting a failure.
  var iframeReady = false;

  function showError(msg) {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.removeAttribute('hidden');
  }
  function clearError() {
    if (errorBox) errorBox.setAttribute('hidden', '');
  }

  // Individually try/catch each subscribe. Poynt's TokenizeJs
  // silently ignores unknown event names on some SDK versions but
  // throws on others — subscribing to a name Poynt doesn't
  // recognize (e.g. iframe_ready on the wrong version) would kill
  // the whole init chain if we shared one try block. This shape
  // keeps mount + the essential 'nonce' handler alive even if
  // optional subscribes fail.
  function safeSubscribe(evt, fn) {
    if (!tokenizer) return;
    try { tokenizer.subscribe(evt, fn); }
    catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[checkout] Poynt subscribe rejected event', evt, err);
      }
    }
  }

  function initTokenizer() {
    if (tokenizer || !window.TokenizeJs) return;
    try {
      tokenizer = new window.TokenizeJs(cfg.businessId, cfg.applicationId);
      // Mount options — the whole point here is (a) turn on Poynt's
      // per-field labels so the iframe renders "Card number / Expiry
      // / CVC" as three distinct rows, (b) style each row + input
      // to match the surrounding Hatziri form, and (c) hide Poynt's
      // inline error text so their validation panel doesn't blow the
      // iframe out to 250px+ of empty space (see [data-collect-error]
      // outside the iframe for our own error surface).
      //
      // Layout trick: setting container to display:flex + flex-wrap
      // lets rowCardNumber take 100% width and rowExpiration + rowCVV
      // sit side-by-side underneath at 50% each.
      // Layout: three inputs stacked vertically — Card number, then
      // Expiry, then CVV — each full-width, no field labels (the
      // placeholders inside each input already say what it is).
      // Our external "Name on card" input sits above the iframe.
      tokenizer.mount('poynt-card-mount', document, {
        displayComponents: { labels: false },
        customCss: {
          container: 'display:block;font-family:inherit;padding:0;margin:0;background:transparent;',
          rowCardNumber: 'display:block;width:100%;margin:0 0 12px 0;padding:0;',
          rowExpiration: 'display:block;width:100%;margin:0 0 12px 0;padding:0;',
          rowCVV: 'display:block;width:100%;margin:0;padding:0;',
          inputDefault: 'width:100%;box-sizing:border-box;background:#f4f8f2;border:1px solid #d4e7c7;border-radius:9px;padding:12px 14px;font-size:15px;color:#1a2010;font-family:inherit;line-height:1.35;outline:none;transition:border-color .15s ease,box-shadow .15s ease;',
          input: {
            cardNumber: 'width:100%;',
            expiryDate: 'width:100%;',
            cvc: 'width:100%;',
          },
          fieldWrapper: { errored: 'border-color:#c53131;' },
          inputWrapper: { errored: 'border-color:#c53131;' },
          errorText: { base: 'display:none;' },
        },
      });
    } catch (err) {
      var msg = err && err.message ? String(err.message) : 'Card entry failed to load. Refresh and try again.';
      showError(msg);
      if (typeof console !== 'undefined' && console.error) {
        console.error('[checkout] TokenizeJs constructor/mount failed', err);
      }
      return;
    }
    // Mount succeeded — the card iframe should now be visible in
    // #poynt-card-mount. Wire the mandatory 'nonce' + 'error'
    // handlers, then attempt the optional resize handler. Missing
    // resize just means the iframe won't auto-grow on validation
    // errors; it doesn't block submission.
    safeSubscribe('nonce', function(e) {
      var n = e && e.data && e.data.nonce;
      if (nonceField) nonceField.value = n || '';
      clearError();
      if (awaitingSubmit && form) {
        awaitingSubmit = false;
        form.submit();
      }
    });
    safeSubscribe('error', function(e) {
      awaitingSubmit = false;
      var msg = (e && e.data && (e.data.message || e.data.reason)) || 'Please check your card details and try again.';
      showError(msg);
    });
    safeSubscribe('iframe_height_change', function(e) {
      var mount = document.getElementById('poynt-card-mount');
      var h = e && e.data && e.data.height;
      if (mount && typeof h === 'number' && h > 0) {
        mount.style.height = h + 'px';
      }
    });
    // If we got here, mount didn't throw — mark ready so submit
    // works without waiting for an event Poynt may not dispatch.
    iframeReady = true;
    clearError();
  }

  if (window.TokenizeJs) initTokenizer();
  else {
    var tries = 0;
    var poll = setInterval(function() {
      tries += 1;
      if (window.TokenizeJs) { clearInterval(poll); initTokenizer(); }
      else if (tries > 60) { clearInterval(poll); showError('Card entry failed to load. Refresh and try again.'); }
    }, 200);
  }

  form.addEventListener('submit', function(e) {
    if (nonceField && nonceField.value) return; // already have nonce, native submit
    if (!tokenizer || !iframeReady) {
      e.preventDefault();
      showError('Card entry still loading — try again in a moment.');
      return;
    }
    e.preventDefault();
    clearError();
    awaitingSubmit = true;
    try { tokenizer.getNonce(); } catch (err) { awaitingSubmit = false; showError('Card entry error. Refresh and try again.'); }
  });
};
`
