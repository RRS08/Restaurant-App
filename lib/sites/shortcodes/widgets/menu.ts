// ----------------------------------------------------------------
// {{menu}} widget.
//
// Renders a grid of product cards. Attributes:
//
//   columns    "2" | "4"  — max cols at ≥1024px (grid CSS handles it).
//              For now the value is descriptive only; the CSS grid
//              always caps at four. Kept in the shortcode so a
//              two-up variant can be added without a page change.
//   category   "tea-blends" | "ointments" | "accessories" |
//              "featured" | ""    — filter. "featured" reads the
//              boolean flag, not a category value. Empty means "no
//              filter" (used by the /shop page when ?category= is
//              absent).
//   limit      integer     — cap the number of cards rendered.
//   related-to product slug — same category as that product,
//              excluding it. Powers the PDP "Also on the shelf" rail.
//
// Rows come from `site_products` scoped to the current site, live
// status only, ordered by (sort_order asc, name asc).
//
// Variant products (site_products.options non-empty) also render an
// inline dot picker on the card so a buyer sees the "Loose leaf vs
// Tea bags" choice + its different price WITHOUT clicking through
// to the PDP. Add-to-cart on the card respects the selected dot.
// Single-variant products render the picker markup omitted entirely
// so nothing extra shows.
// ----------------------------------------------------------------

import { createAdminClient } from '@/lib/supabase/admin'
import type { ShortcodeArgs, ShortcodeContext } from '../index'
import type { SiteProductRow, SiteProductOptionGroup } from '../../types'
import { normalizeGroups, resolveUnitPrice } from '../../cart-options'
import { escapeAttr, escapeHtml } from '../utils'

type Card = Pick<
  SiteProductRow,
  'slug' | 'name' | 'category' | 'price' | 'benefit' | 'purpose' | 'image_url' | 'options'
>

export async function renderMenu(args: ShortcodeArgs, ctx: ShortcodeContext): Promise<string> {
  const admin = createAdminClient()
  const category = typeof args.category === 'string' ? args.category.trim() : ''
  const relatedTo = typeof args['related-to'] === 'string' ? args['related-to'].trim() : ''
  const limit = parseInt(typeof args.limit === 'string' ? args.limit : '', 10) || 0

  let query = admin
    .from('site_products')
    .select('slug, name, category, price, benefit, purpose, image_url, options')
    .eq('site_id', ctx.site.id)
    .eq('status', 'live')

  if (relatedTo) {
    // Look up the base product's category so we can pull siblings
    // in the same section, excluding the product itself. Silent
    // no-op if the base slug doesn't resolve — keeps the PDP from
    // rendering a broken rail if a bad slug lands in the URL.
    const { data: base } = await admin
      .from('site_products')
      .select('category')
      .eq('site_id', ctx.site.id)
      .eq('slug', relatedTo)
      .maybeSingle()
    if (!base?.category) return '<div class="card-grid"></div>'
    query = query.eq('category', base.category).neq('slug', relatedTo)
  } else if (category === 'featured') {
    query = query.eq('featured', true)
  } else if (category) {
    query = query.eq('category', category)
  }

  query = query.order('sort_order', { ascending: true }).order('name', { ascending: true })
  if (limit > 0) query = query.limit(limit)

  const { data, error } = await query
  if (error) {
    console.error('[shortcode:menu] query failed', error)
    return '<div class="card-grid"></div>'
  }
  const products = (data ?? []) as Card[]
  if (products.length === 0) return '<div class="card-grid"></div>'

  // Only inject the picker CSS + client script if at least one card
  // actually has options — no reason to ship the extra bytes to a
  // grid of single-variant products (accessories, ointments, etc.).
  const anyPicker = products.some(p => normalizeGroups(p.options).length > 0)
  const pickerExtras = anyPicker ? CARD_PICKER_STYLE + CARD_PICKER_SCRIPT : ''

  return `<div class="card-grid">
${products.map(renderCard).join('\n')}
</div>${pickerExtras}`
}

function renderCard(p: Card): string {
  const href = `/shop/${p.slug}`
  const basePriceNum = parsePrice(p.price)
  const tag = p.benefit ? `<span class="card-tag">${escapeHtml(p.benefit)}</span>` : ''
  const purpose = p.purpose ? `<div class="card-purpose">${escapeHtml(p.purpose)}</div>` : ''

  // data-category lets client-side filters (chip strip on /shop)
  // show/hide cards without a page reload. Server still filters
  // when a category attr is passed on the shortcode — this attribute
  // is additional metadata, not a replacement for server filtering.
  const category = p.category ?? ''
  const groups = normalizeGroups(p.options)

  // Which group / choice is "current" for the initial render?
  // Card supports only the FIRST option group — most tea shops have
  // a single "form" dimension. A product with multiple groups still
  // renders one picker on the card; the PDP handles the full matrix
  // when the buyer opens the drawer. First choice is the default.
  const firstGroup = groups[0] ?? null
  const defaultOptions = firstGroup ? { [firstGroup.key]: firstGroup.choices[0].key } : {}
  const defaultUnit = resolveUnitPrice(basePriceNum, groups, defaultOptions)
  const price = formatPrice(defaultUnit)

  const picker = firstGroup ? renderCardPicker(p.slug, firstGroup, basePriceNum) : ''

  const optionsAttr = firstGroup
    ? ` data-options='${escapeAttr(JSON.stringify(defaultOptions))}'`
    : ''

  return `<div class="card" data-category="${escapeAttr(category)}"${firstGroup ? ' data-has-picker="1"' : ''}>
  <a class="card-tile" href="${escapeAttr(href)}">
    ${tag}
    <img src="${escapeAttr(p.image_url ?? '')}" alt="${escapeAttr(p.name)}">
  </a>
  <a class="card-name" href="${escapeAttr(href)}">${escapeHtml(p.name)}</a>
  ${purpose}
  ${picker}
  <div class="card-foot">
    <span class="card-price" data-card-price>${escapeHtml(price)}</span>
    <button class="btn-add" type="button" data-slug="${escapeAttr(p.slug)}"${optionsAttr}>
      <span class="add-short">Add</span><span class="add-long">Add to cart</span>
    </button>
  </div>
</div>`
}

/** Per-index palette so each choice's dot carries its own color.
 *  First choice = sage green (matches Hatziri palette + PDP tone),
 *  second = deep navy, third = amber, fourth = plum. Loops if the
 *  product happens to declare more than 4 choices (rare). Colors
 *  chosen to read well on the sage-cream card background AND to
 *  differentiate at a glance without needing a legend. */
const CHOICE_COLORS = ['#2f4a1f', '#1e3a5f', '#7a4a1f', '#4a1f4a'] as const

/** Inline dot picker for a card. One row: N colored dots (each
 *  choice gets its own hue) followed by the label of the currently-
 *  selected choice. Radio inputs are visually hidden but drive the
 *  state; a delegated client script re-paints `.is-active` and
 *  updates the price + Add-to-cart data-options on change. */
function renderCardPicker(
  slug: string,
  group: SiteProductOptionGroup,
  basePrice: number,
): string {
  const defaultLabel = group.choices[0]?.label ?? ''
  const dots = group.choices.map((c, i) => {
    const priceForChoice = typeof c.price === 'number' ? c.price : basePrice
    const isDefault = i === 0
    const color = CHOICE_COLORS[i % CHOICE_COLORS.length]
    return `    <label class="card-opt${isDefault ? ' is-active' : ''}" style="--dot-color:${color}">
      <input type="radio" name="card-opt-${escapeAttr(slug)}-${escapeAttr(group.key)}" value="${escapeAttr(c.key)}"${isDefault ? ' checked' : ''} data-price="${escapeAttr(String(priceForChoice))}" data-label="${escapeAttr(c.label)}">
      <span class="card-opt-dot" aria-hidden="true"></span>
      <span class="visually-hidden">${escapeHtml(c.label)}</span>
    </label>`
  }).join('\n')
  return `<div class="card-opts" data-optgroup="${escapeAttr(group.key)}">
${dots}
    <span class="card-opt-label" data-card-opt-label>${escapeHtml(defaultLabel)}</span>
  </div>`
}

/** Format the DB's `numeric` price (returned as string or number)
 *  as a plain USD string. Prices ship as whole-dollar values in
 *  the seed data (e.g. 18.00 → "$18.00"). */
function formatPrice(raw: number | string): string {
  const n = typeof raw === 'number' ? raw : parseFloat(raw)
  if (!Number.isFinite(n)) return ''
  return `$${n.toFixed(2)}`
}

function parsePrice(raw: number | string): number {
  return typeof raw === 'number' ? raw : parseFloat(String(raw))
}

// ----------------------------------------------------------------
// Card variant picker CSS + client script.
//
// CSS keeps in Hatziri's palette (sage greens + cream) so the dots
// read as part of the card, not an app control. Styling is scoped
// with `.card` so no risk of collision with other .card usages.
//
// Script runs once at the bottom of the grid, delegates change
// events to the whole document (any card, any grid). On dot change:
// re-paint .is-active per dot, swap the label text, swap the card
// price, and refresh the Add button's data-options JSON. That last
// bit is what the existing cart-add handler in the site header
// reads on click — same wiring the PDP picker already uses.
// ----------------------------------------------------------------

const CARD_PICKER_STYLE = `
<style>
.card .card-opts {
  display: flex; align-items: center; gap: 3px;
  padding: 10px 0 4px;
  min-height: 28px;
}
.card .card-opt {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px;
  cursor: pointer; position: relative;
  border-radius: 999px;
}
.card .card-opt input {
  position: absolute; opacity: 0; pointer-events: none;
  width: 0; height: 0; margin: 0;
}
.card .card-opt-dot {
  display: block;
  width: 14px; height: 14px;
  border-radius: 999px;
  background: var(--dot-color, #2f4a1f);
  opacity: 0.35;
  transition: opacity .14s ease, box-shadow .14s ease;
}
.card .card-opt:hover .card-opt-dot { opacity: 0.6; }
.card .card-opt.is-active .card-opt-dot {
  opacity: 1;
  box-shadow: 0 0 0 3px #f0f3ea, 0 0 0 4.5px var(--dot-color, #2f4a1f);
}
.card .card-opt input:focus-visible + .card-opt-dot {
  box-shadow: 0 0 0 3px #f0f3ea, 0 0 0 4.5px var(--dot-color, #2f4a1f);
}
.card .card-opt-label {
  margin-left: 4px;
  font-size: 13.5px; color: #2f4a1f; font-weight: 500;
  letter-spacing: -0.005em;
  line-height: 1.2;
}
.card .visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
</style>`

const CARD_PICKER_SCRIPT = `
<script>
(function(){
  function fmt(n){ return '$' + n.toFixed(2); }
  function sync(card){
    var picker = card.querySelector('.card-opts');
    if (!picker) return;
    var group = picker.getAttribute('data-optgroup');
    var opts = picker.querySelectorAll('.card-opt');
    var checked = picker.querySelector('input[type=radio]:checked');
    if (!checked || !group) return;
    // Re-paint active state
    opts.forEach(function(lbl){
      var inp = lbl.querySelector('input[type=radio]');
      lbl.classList.toggle('is-active', !!(inp && inp.checked));
    });
    // Swap the label text
    var labelEl = picker.querySelector('[data-card-opt-label]');
    if (labelEl) labelEl.textContent = checked.getAttribute('data-label') || '';
    // Update the price
    var priceEl = card.querySelector('[data-card-price]');
    var raw = checked.getAttribute('data-price');
    var n = raw ? parseFloat(raw) : NaN;
    if (priceEl && isFinite(n)) priceEl.textContent = fmt(n);
    // Update Add-to-cart data-options
    var btn = card.querySelector('.btn-add');
    if (btn) {
      var payload = {};
      payload[group] = checked.value;
      btn.setAttribute('data-options', JSON.stringify(payload));
    }
  }
  document.addEventListener('change', function(e){
    var t = e.target;
    if (!t || !t.matches || !t.matches('.card-opts input[type=radio]')) return;
    var card = t.closest('.card');
    if (card) sync(card);
  });
})();
</script>`
