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

  return `<div class="pdp-grid" data-pdp>
  <div class="pdp-tile">
    ${tag}
    <img src="${escapeAttr(p.image_url ?? '')}" alt="${escapeAttr(p.name)}">
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
</div>${optionsScript}${PICKER_STYLE}`
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
      const priceAttr = typeof c.price === 'number' ? String(c.price) : ''
      const priceStr = formatPrice(priceForChoice)
      const isDefault = i === 0
      return `      <label class="pdp-choice${isDefault ? ' is-active' : ''}">
        <input type="radio" name="pdp-opt-${escapeAttr(g.key)}" value="${escapeAttr(c.key)}"${isDefault ? ' checked' : ''} data-price="${escapeAttr(priceAttr)}">
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

const PICKER_STYLE = `<style>
.pdp-options { display: flex; flex-direction: column; gap: 12px; margin: 20px 0 8px; }
.pdp-optgroup { border: 0; margin: 0; padding: 0; }
.pdp-optgroup-label {
  display: block; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
  color: #6b6b70; margin: 0 0 10px; padding: 0; font-weight: 500;
}
.pdp-choices { display: flex; flex-wrap: wrap; gap: 8px; }
.pdp-choice {
  display: inline-flex; align-items: center; gap: 12px; cursor: pointer;
  padding: 11px 18px; border-radius: 999px; border: 1px solid #d6d5d1;
  background: #fff; color: #253b0e; font-size: 13.5px; line-height: 1.2;
  transition: border-color .15s ease, background .15s ease, color .15s ease, box-shadow .15s ease;
  user-select: none; position: relative;
}
.pdp-choice input { position: absolute; opacity: 0; pointer-events: none; width: 0; height: 0; }
.pdp-choice-label { font-weight: 600; letter-spacing: -0.005em; }
.pdp-choice-price {
  font-family: 'Geist Mono', ui-monospace, monospace;
  font-size: 12px; color: #6b6b70; font-weight: 500;
}
.pdp-choice.is-active {
  border-color: #253b0e; background: #253b0e; color: #faf9f6;
  box-shadow: 0 1px 3px rgba(37,59,14,0.15);
}
.pdp-choice.is-active .pdp-choice-price { color: #faf9f6; opacity: .78; }
.pdp-choice:hover:not(.is-active) { border-color: #55723e; background: #f7f6f0; }
@media (max-width: 480px) {
  .pdp-choice { padding: 10px 14px; font-size: 12.5px; gap: 10px; }
}
</style>`

const PICKER_SCRIPT = `<script>
(function(){
  var root = document.querySelector('[data-pdp]');
  if (!root) return;
  var addBtn  = root.querySelector('[data-add-button]');
  if (!addBtn) return;
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
    // Actual line price for the currently selected variant —
    // first choice in group order with an explicit price override
    // wins, matching resolveUnitPrice() server-side. Null means
    // no override (use the base price).
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
  function fmt(n){ return '$' + n.toFixed(2); }
  function sync(){
    // Re-paint the pill is-active state per group so keyboard
    // nav + a click both feel snappy. Hero price stays put —
    // the base price is the product's canonical price, and any
    // variant surcharge is shown on the pill itself + folded
    // into the Add-to-cart label below so the buyer confirms
    // the actual amount they're paying.
    root.querySelectorAll('.pdp-optgroup').forEach(function(fs){
      var choices = fs.querySelectorAll('.pdp-choice');
      choices.forEach(function(lbl){
        var inp = lbl.querySelector('input[type=radio]');
        lbl.classList.toggle('is-active', !!(inp && inp.checked));
      });
    });
    var p = pickPrice();
    if (p !== null) {
      addBtn.textContent = baseLabel + ' · ' + fmt(p);
    } else {
      addBtn.textContent = baseLabel;
    }
    addBtn.setAttribute('data-options', JSON.stringify(selectedOptions()));
  }
  root.addEventListener('change', function(e){
    if (e.target && e.target.matches && e.target.matches('input[type=radio]')) sync();
  });
  sync(); // seed defaults into the button on first paint
})();
</script>`
