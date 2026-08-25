// ----------------------------------------------------------------
// {{shop-chips}} widget.
//
// Renders the /shop filter strip with `.is-active` set on whichever
// chip matches the current ?category=. Server-computed — the raw
// markup can't do this because HTML doesn't have conditional class
// syntax and page-level {{query.X}} substitution only fires inside
// shortcode attribute values, not in class names.
//
// The category list is DERIVED — no hardcoded catalog. Two sources
// are merged so the strip always mirrors what the operator sees in
// /catalog:
//
//   1. site.config.catalog_categories — the ordered list of empty
//      categories the operator added via the catalog editor.
//   2. Distinct site_products.category slugs — categories that
//      have at least one live product but aren't in the persisted
//      list yet.
//
// Persisted order wins on the strip; anything derived-only appends
// after (known slugs first — tea-blends, ointments, accessories —
// then alphabetical for anything new). Empty categories still
// render as chips so an operator adding a category from the
// catalog editor can see it on the storefront immediately, even
// before the first product lands there.
// ----------------------------------------------------------------

import { createAdminClient } from '@/lib/supabase/admin'
import type { ShortcodeContext } from '../index'
import { escapeAttr, escapeHtml } from '../utils'

interface Chip { label: string; category: string }

/** Known slugs get pretty labels; anything new gets a title-cased
 *  version of its slug so a new "wellness-teas" category still
 *  renders as "Wellness Teas" on the chip strip. */
const KNOWN_LABELS: Record<string, string> = {
  'tea-blends': 'Tea blends',
  'ointments': 'Ointments',
  'accessories': 'Accessories',
}

function labelFor(slug: string): string {
  return KNOWN_LABELS[slug]
    ?? slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export async function renderShopChips(_args: unknown, ctx: ShortcodeContext): Promise<string> {
  const active = typeof ctx.query.category === 'string' ? ctx.query.category : ''

  const chips = await resolveChips(ctx)
  const links = chips.map(c => {
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

/** Merge persisted + derived categories into an ordered chip list.
 *  Always starts with "Everything" so the strip has a clear
 *  reset target. */
async function resolveChips(ctx: ShortcodeContext): Promise<Chip[]> {
  const chips: Chip[] = [{ label: 'Everything', category: '' }]
  const admin = createAdminClient()

  const config = (ctx.site.config ?? {}) as { catalog_categories?: unknown }
  const persistedRaw = Array.isArray(config.catalog_categories) ? config.catalog_categories : []
  const persisted: Chip[] = []
  const persistedKeys = new Set<string>()
  for (const raw of persistedRaw) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as { key?: unknown; label?: unknown }
    if (typeof c.key !== 'string' || typeof c.label !== 'string') continue
    if (persistedKeys.has(c.key)) continue
    persisted.push({ category: c.key, label: c.label })
    persistedKeys.add(c.key)
  }

  // Distinct categories currently in use on live products.
  const { data: productRows } = await admin
    .from('site_products')
    .select('category')
    .eq('site_id', ctx.site.id)
    .eq('status', 'live')
    .not('category', 'is', null)
  const usedKeys = new Set<string>()
  for (const row of productRows ?? []) {
    const cat = (row as { category?: string | null }).category
    if (typeof cat === 'string' && cat.length > 0) usedKeys.add(cat)
  }

  const derivedOnly = Array.from(usedKeys)
    .filter(k => !persistedKeys.has(k))
    .sort((a, b) => {
      const ai = Object.keys(KNOWN_LABELS).indexOf(a)
      const bi = Object.keys(KNOWN_LABELS).indexOf(b)
      if (ai === -1 && bi === -1) return a.localeCompare(b)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
    .map(k => ({ category: k, label: labelFor(k) }))

  return [...chips, ...persisted, ...derivedOnly]
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
