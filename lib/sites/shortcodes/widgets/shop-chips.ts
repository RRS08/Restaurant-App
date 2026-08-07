// ----------------------------------------------------------------
// {{shop-chips}} widget.
//
// Renders the /shop filter strip with `.is-active` set on whichever
// chip matches the current ?category=. Server-computed — the raw
// markup can't do this because HTML doesn't have conditional class
// syntax and page-level {{query.X}} substitution only fires inside
// shortcode attribute values, not in class names.
//
// Categories are hardcoded here rather than derived from the DB.
// Deriving would require a distinct-categories query per pageload
// and a decision about ordering that we don't have yet; a hardcoded
// list matches what the tea shop actually sells and can be pulled
// into config the moment a second site needs a different set.
// ----------------------------------------------------------------

import type { ShortcodeContext } from '../index'
import { escapeAttr, escapeHtml } from '../utils'

interface Chip { label: string; category: string }

const CHIPS: Chip[] = [
  { label: 'Everything', category: '' },
  { label: 'Tea blends', category: 'tea-blends' },
  { label: 'Ointments', category: 'ointments' },
  { label: 'Accessories', category: 'accessories' },
]

export function renderShopChips(_args: unknown, ctx: ShortcodeContext): string {
  const active = typeof ctx.query.category === 'string' ? ctx.query.category : ''
  const links = CHIPS.map(c => {
    const isActive = c.category === active
    const href = c.category === '' ? '/shop' : `/shop?category=${encodeURIComponent(c.category)}`
    return `    <a class="chip${isActive ? ' is-active' : ''}" href="${escapeAttr(href)}" data-chip-cat="${escapeAttr(c.category)}">${escapeHtml(c.label)}</a>`
  }).join('\n')

  return `<div class="filter-bar">
  <div class="filter-scroll" data-scroll-x>
${links}
  </div>
</div>
${CHIP_SCRIPT}`
}

// Client-side chip behavior — intercepts anchor clicks so filtering
// feels instant instead of full-page-reloading. Falls back cleanly
// when JS is off: the anchors have real href="/shop?category=…"
// values, so a no-JS click still lands on the right server-rendered
// page.
//
// On click: preventDefault, pushState the anchor's href, move
// .is-active onto the clicked chip, and hide every .card whose
// data-category doesn't match (empty = show all).
//
// On load: read the URL's ?category= and apply the same filter
// so a deep-link like /shop?category=ointments arrives already
// filtered even though the server sent every card.
//
// popstate re-runs the URL filter so back/forward navigate through
// the client-side history correctly.
const CHIP_SCRIPT = `<script>
(function(){
  function applyCategory(cat){
    var chips = document.querySelectorAll('.chip[data-chip-cat]');
    chips.forEach(function(c){
      c.classList.toggle('is-active', (c.dataset.chipCat || '') === cat);
    });
    var cards = document.querySelectorAll('.card-grid .card');
    cards.forEach(function(card){
      var cc = card.dataset.category || '';
      card.style.display = (!cat || cc === cat) ? '' : 'none';
    });
  }
  function catFromLocation(){
    try {
      var u = new URL(window.location.href);
      return u.searchParams.get('category') || '';
    } catch (_) { return ''; }
  }
  document.addEventListener('click', function(e){
    var chip = e.target.closest && e.target.closest('.chip[data-chip-cat]');
    if (!chip) return;
    var href = chip.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    try { history.pushState({}, '', href); } catch (_) {}
    applyCategory(chip.dataset.chipCat || '');
  });
  window.addEventListener('popstate', function(){ applyCategory(catFromLocation()); });
  // On initial load, sync from the URL — the server rendered every
  // card (no category filter passed to {{menu}}), so we hide what
  // doesn't match right away.
  applyCategory(catFromLocation());
})();
</script>`
