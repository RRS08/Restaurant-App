// ----------------------------------------------------------------
// {{product}} widget.
//
// Renders a full product detail block for one slug. Attributes:
//
//   slug   the product to render, usually piped in from the route
//          param via `{{product slug="{{params.slug}}"}}`.
//
// Conditional pieces (skipped when the field is null so we don't
// paint empty rules or empty pills):
//   - .pdp-tag         → only if benefit is set
//   - .pdp-en          → only if secondary_name is set
//   - .pdp-facts       → only if ritual OR ingredients is set; the
//                        `.pdp-use` paragraph above always renders
//                        long_description when present
//   - the ritual dt    → uses ritual_label, defaulting to
//                        "How to steep" (tea blends) — set to
//                        "How to use" on ointments in the DB.
//
// A missing slug (typo, unknown product) currently renders an
// inline notice. Ideally the route would 404 on dynamic-path
// resolution when the {{product}} slug doesn't exist; that
// coupling is a follow-up.
// ----------------------------------------------------------------

import { createAdminClient } from '@/lib/supabase/admin'
import type { ShortcodeArgs, ShortcodeContext } from '../index'
import type { SiteProductRow } from '../../types'
import { normalizeGroups } from '../../cart-options'
import { escapeAttr, escapeHtml } from '../utils'

const CATEGORY_LABELS: Record<string, string> = {
  'tea-blends': 'Tea blends',
  'ointments': 'Ointments',
  'accessories': 'Accessories',
}

export async function renderProduct(args: ShortcodeArgs, ctx: ShortcodeContext): Promise<string> {
  const slug = typeof args.slug === 'string' ? args.slug.trim() : ''
  if (!slug) return '<!-- checked-sites: product widget missing slug -->'

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('site_products')
    .select('*')
    .eq('site_id', ctx.site.id)
    .eq('slug', slug)
    .eq('status', 'live')
    .maybeSingle()

  if (error) {
    console.error('[shortcode:product] query failed', error)
    return '<!-- checked-sites: product query failed -->'
  }
  if (!data) return '<!-- checked-sites: product not found -->'
  const p = data as SiteProductRow

  const tag = p.benefit ? `<span class="pdp-tag">${escapeHtml(p.benefit)}</span>` : ''
  const en = p.secondary_name ? `<div class="pdp-en">${escapeHtml(p.secondary_name)}</div>` : ''
  const basePriceNum = parsePrice(p.price)
  const groups = normalizeGroups(p.options)
  // When the product has a picker, the unit-suffix on the price
  // is redundant (each choice's label already carries the size —
  // "Loose leaf · 3 oz" / "Tea bags · 30 ct") and would double-
  // print the size. Drop it in that case; keep it for no-picker
  // products where the price line is the only place size shows.
  const unit = groups.length === 0 && p.unit ? ` <span>· ${escapeHtml(p.unit)}</span>` : ''
  const price = formatPrice(basePriceNum)
  const use = p.long_description ? `<p class="pdp-use">${escapeHtml(p.long_description)}</p>` : ''
  const category = CATEGORY_LABELS[p.category ?? ''] ?? p.category ?? ''

  // Options picker + the tiny script that drives it. Both are
  // omitted entirely when the product has no options so nothing
  // extra renders for mushroom-coffee etc.
  const optionsMarkup = renderOptionGroups(groups, basePriceNum)
  const optionsScript = groups.length > 0 ? PICKER_SCRIPT : ''

  const ritualLabel = p.ritual_label ?? 'How to steep'
  const factsRows: string[] = []
  if (p.ritual) {
    factsRows.push(`    <div><dt>${escapeHtml(ritualLabel)}</dt><dd>${escapeHtml(p.ritual)}</dd></div>`)
  }
  if (p.ingredients) {
    factsRows.push(`    <div><dt>What's in it</dt><dd>${escapeHtml(p.ingredients)}</dd></div>`)
  }
  const facts = factsRows.length > 0
    ? `<dl class="pdp-facts">\n${factsRows.join('\n')}\n  </dl>`
    : ''

  // Optional disclaimer text — small muted paragraph rendered
  // inside the left tile column below the image so the safety /
  // legal copy stays paired with the product image instead of
  // trailing after the whole layout. Pass on the shortcode as
  // disclaimer="Sold as food...". Absent = nothing renders.
  const disclaimerRaw = typeof args.disclaimer === 'string' ? args.disclaimer.trim() : ''
  const disclaimer = disclaimerRaw
    ? `<p class="pdp-disclaimer">${escapeHtml(disclaimerRaw)}</p>`
    : ''

  return `<div class="pdp-grid" data-pdp>
  <div class="pdp-tile-col">
    <div class="pdp-tile">
      ${tag}
      <img src="${escapeAttr(p.image_url ?? '')}" alt="${escapeAttr(p.name)}">
    </div>
    ${disclaimer}
  </div>
  <div class="pdp-body">
    <div class="pdp-cat">${escapeHtml(category)}</div>
    <h1>${escapeHtml(p.name)}</h1>
    ${en}
    <div class="pdp-price" data-pdp-price>${escapeHtml(price)}${unit}</div>
    ${use}
    ${facts}
    ${optionsMarkup}
    <div class="qty-row">
      <div class="stepper">
        <button type="button" data-step="down" aria-label="Decrease quantity">–</button>
        <output>1</output>
        <button type="button" data-step="up" aria-label="Increase quantity">+</button>
      </div>
      <button class="btn-add-lg" type="button" data-slug="${escapeAttr(p.slug)}" data-add-button data-add-label="Add to cart">Add to cart</button>
    </div>
  </div>
</div>${optionsScript}${PICKER_STYLE}${DISCLAIMER_STYLE}`
}

function parsePrice(raw: number | string): number {
  return typeof raw === 'number' ? raw : parseFloat(String(raw))
}

function formatPrice(raw: number | string | null): string {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''))
  if (!Number.isFinite(n)) return ''
  return `$${n.toFixed(2)}`
}

/** Render the pill-style picker for each option group. Skipped
 *  when the product has no groups. Each choice pill carries the
 *  group key + choice key + optional price override as data
 *  attributes so the client script can update the displayed
 *  price and pass the full options object to Add-to-cart. */
function renderOptionGroups(
  groups: import('../../types').SiteProductOptionGroup[],
  basePrice: number,
): string {
  if (groups.length === 0) return ''
  const groupBlocks = groups.map(g => {
    const choices = g.choices.map((c, i) => {
      const priceForChoice = typeof c.price === 'number' ? c.price : basePrice
      // Always stamp the effective price on the radio — the
      // client script uses it to keep the Add-to-cart button
      // label truthful ("Add to cart · $18.00") regardless of
      // whether the choice carries its own override or falls
      // back to the base. Also carries an isBase flag so the
      // server-side pickPrice logic (which needs to know
      // whether an override was set) can distinguish.
      const hasOverride = typeof c.price === 'number'
      const priceAttr = String(priceForChoice)
      const priceStr = formatPrice(priceForChoice)
      const isDefault = i === 0
      return `      <label class="pdp-choice${isDefault ? ' is-active' : ''}">
        <input type="radio" name="pdp-opt-${escapeAttr(g.key)}" value="${escapeAttr(c.key)}"${isDefault ? ' checked' : ''} data-price="${escapeAttr(priceAttr)}"${hasOverride ? ' data-override="1"' : ''}>
        <span class="pdp-choice-label">${escapeHtml(c.label)}</span>
        <span class="pdp-choice-price">${escapeHtml(priceStr)}</span>
      </label>`
    }).join('\n')
    return `  <fieldset class="pdp-optgroup" data-optgroup="${escapeAttr(g.key)}">
    <legend class="pdp-optgroup-label">${escapeHtml(g.label)}</legend>
    <div class="pdp-choices">
${choices}
    </div>
  </fieldset>`
  }).join('\n')
  return `<div class="pdp-options">
${groupBlocks}
</div>`
}

// ----------------------------------------------------------------
// Inline CSS + client script that drives the picker.
//
// CSS mirrors the aesthetic of the existing PDP surface —
// .pdp-tag / .pdp-facts inheritance for the pill borders and the
// mono price ticker. All measurements are relative so the picker
// wraps cleanly on narrow (phone) viewports without any media
// query gymnastics.
//
// Script: on choice change, update .pdp-choice.is-active for the
// active pill in each group, recompute the displayed unit price,
// and stash the full options set on the Add button as a JSON
// data-attribute for the cart-add script to consume. The cart-add
// script (in the site layout) already reads data-slug + qty; a
// tiny hook there also reads data-options if present.
// ----------------------------------------------------------------

// Always-injected small style block. Wraps the tile + optional
// disclaimer in .pdp-tile-col so both stack in the left column
// on desktop and the disclaimer sits directly under the sage
// tile instead of at the bottom of the row (which would happen
// if disclaimer were a sibling grid child — row height stretches
// to match the taller info column, pushing the disclaimer far
// below the tile). Existing .pdp-tile CSS doesn't require it to
// be a direct .pdp-grid child, so the wrapper is safe.
const DISCLAIMER_STYLE = `<style>
.pdp-tile-col { display: flex; flex-direction: column; min-width: 0; }
.pdp-disclaimer {
  margin: 14px 2px 0;
  font-size: 12px;
  line-height: 1.55;
  color: #55723e;
  max-width: 100%;
}
@media (min-width: 1024px) {
  .pdp-disclaimer { font-size: 12.5px; margin-top: 18px; max-width: 440px; }
}
</style>`

const PICKER_STYLE = `<style>
/* Fold the FORM picker INSIDE the same sage-lined container as
   HOW-TO-STEEP + WHAT'S IN IT. .pdp-facts contributes the top
   border and its own internal rhythm; we drop its bottom border
   + padding so the picker below sits inside the same block and
   the .pdp-options bottom border closes the whole section as
   one visual unit. Everything below (qty stepper + Add-to-cart)
   starts fresh beneath that closing line. */
.pdp-facts { border-bottom: 0 !important; padding-bottom: 0 !important; margin-bottom: 0 !important; }
.pdp-options {
  display: flex; flex-direction: column; gap: 10px;
  margin: 15px 0 0;
  padding-top: 0;
  padding-bottom: 18px;
  border-top: 0;
  border-bottom: 1px solid #e2efd9;
}
.pdp-optgroup { border: 0; margin: 0; padding: 0; }
.pdp-optgroup-label {
  display: block; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
  color: #6b6b70; margin: 0 0 8px; padding: 0; font-weight: 500;
}
/* Tab-style choice row — plain text with a 2px underline
   marking the selected option. No pills or rectangles, so
   the picker reads as inline copy rather than another button
   stacked on top of the qty stepper + Add-to-cart button. */
.pdp-choices { display: flex; flex-wrap: wrap; gap: 24px; align-items: baseline; }
.pdp-choice {
  display: inline-flex; align-items: baseline; gap: 8px; cursor: pointer;
  padding: 6px 0 8px; margin: 0;
  border: 0; background: none;
  color: #55723e; font-size: 14px; line-height: 1.2;
  border-bottom: 2px solid transparent;
  transition: color .15s ease, border-color .15s ease;
  user-select: none; position: relative;
}
.pdp-choice input { position: absolute; opacity: 0; pointer-events: none; width: 0; height: 0; }
.pdp-choice-label { font-weight: 500; letter-spacing: -0.005em; }
.pdp-choice-price {
  font-family: 'Geist Mono', ui-monospace, monospace;
  font-size: 12.5px; color: #55723e; font-weight: 500; opacity: .75;
}
.pdp-choice.is-active {
  color: #253b0e; border-bottom-color: #253b0e;
}
.pdp-choice.is-active .pdp-choice-label { font-weight: 600; }
.pdp-choice.is-active .pdp-choice-price { color: #253b0e; opacity: 1; }
.pdp-choice:hover:not(.is-active) { color: #253b0e; }
@media (max-width: 480px) {
  .pdp-choices { gap: 18px; }
  .pdp-choice { font-size: 13.5px; }
}
</style>`

const PICKER_SCRIPT = `<script>
(function(){
  var root = document.querySelector('[data-pdp]');
  if (!root) return;
  var addBtn  = root.querySelector('[data-add-button]');
  if (!addBtn) return;
  var qtyOut = root.querySelector('.stepper output');
  var baseLabel = addBtn.getAttribute('data-add-label') || 'Add to cart';
  function selectedOptions(){
    var out = {};
    root.querySelectorAll('.pdp-optgroup').forEach(function(fs){
      var g = fs.getAttribute('data-optgroup');
      var checked = fs.querySelector('input[type=radio]:checked');
      if (g && checked) out[g] = checked.value;
    });
    return out;
  }
  function pickPrice(){
    // Effective unit price for the current selection. Every
    // choice carries its effective price on data-price (base
    // fallback baked in server-side), so we can always keep the
    // button label truthful. Returns null only if the DOM is
    // malformed.
    var groups = root.querySelectorAll('.pdp-optgroup');
    for (var i = 0; i < groups.length; i++) {
      var checked = groups[i].querySelector('input[type=radio]:checked');
      var raw = checked && checked.getAttribute('data-price');
      if (raw && raw.length > 0) {
        var n = parseFloat(raw);
        if (isFinite(n)) return n;
      }
    }
    return null;
  }
  function currentQty(){
    if (!qtyOut) return 1;
    var n = parseInt(qtyOut.textContent, 10);
    return isFinite(n) && n > 0 ? n : 1;
  }
  function fmt(n){ return '$' + n.toFixed(2); }
  function sync(){
    // Re-paint the pill is-active state per group so keyboard
    // nav + a click both feel snappy. Hero price stays put —
    // the base price is the product's canonical price, and any
    // variant surcharge folds into the Add-to-cart label so
    // the buyer confirms the exact amount before they commit.
    // Label reflects qty × unit price so bumping the stepper
    // updates the button in lockstep.
    root.querySelectorAll('.pdp-optgroup').forEach(function(fs){
      var choices = fs.querySelectorAll('.pdp-choice');
      choices.forEach(function(lbl){
        var inp = lbl.querySelector('input[type=radio]');
        lbl.classList.toggle('is-active', !!(inp && inp.checked));
      });
    });
    var unit = pickPrice();
    if (unit !== null) {
      var qty = currentQty();
      addBtn.textContent = baseLabel + ' · ' + fmt(unit * qty);
    } else {
      addBtn.textContent = baseLabel;
    }
    addBtn.setAttribute('data-options', JSON.stringify(selectedOptions()));
  }
  root.addEventListener('change', function(e){
    if (e.target && e.target.matches && e.target.matches('input[type=radio]')) sync();
  });
  // Qty changes come from the page's own stepper script (mutates
  // the <output>'s textContent); observe it so the button stays
  // in step regardless of who writes the qty. Character-data
  // observation catches every path — direct assignment, innerHTML
  // rewrites, a future replacement of the text node, etc.
  if (qtyOut && typeof MutationObserver !== 'undefined') {
    new MutationObserver(sync).observe(qtyOut, {
      characterData: true, childList: true, subtree: true,
    });
  }
  sync(); // seed defaults into the button on first paint
})();
</script>`
