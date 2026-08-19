// ----------------------------------------------------------------
// {{site-header}} widget.
//
// Renders the sticky header — brand mark on the left, primary nav
// on the right (a drawer on mobile), cart pill/mini on both. The
// DOM shape must match what the global CSS + the burger toggle JS
// (shipped in the / page's js_body) expect; the class names are
// load-bearing.
//
// Content:
//   - Brand line 1: `site.name`
//   - Brand line 2 (kicker): `site.config.brand_kicker` (fallback:
//     the part of `site.name` after "Tea &" if the name matches
//     that shape, else empty — good enough that a new site can drop
//     in without any config)
//   - Nav items: `site.config.nav.items` — array of {label, href}.
//     Falls back to Hatziri's four-item nav so the site works out
//     of the box on a first insert with no config wiring.
//   - Logo image: `site.config.logo_url`, fallback to
//     `/assets/logo-tree.png`.
//
// Cart badge count comes from {{cart-count}} inside — the outer
// expander doesn't nest, so we call the cart-count renderer inline.
// ----------------------------------------------------------------

import type { ShortcodeContext } from '../index'
import { escapeAttr, escapeHtml } from '../utils'
import { renderCartCount } from './cart-count'

interface NavItemRaw { label?: string; href?: string }
interface NavItem { label: string; href: string }

const FALLBACK_NAV: NavItem[] = [
  { label: 'Shop', href: '/shop' },
  { label: 'Our story', href: '/about' },
  { label: 'Visit', href: '/locations' },
  { label: 'Contact', href: '/contact' },
]

export function renderSiteHeader(_args: unknown, ctx: ShortcodeContext): string {
  const config = (ctx.site.config ?? {}) as Record<string, unknown>
  const nav = (config.nav ?? {}) as { items?: unknown }
  const rawItems: NavItemRaw[] = Array.isArray(nav.items) ? (nav.items as NavItemRaw[]) : []
  const items: NavItem[] = rawItems
    .filter((i): i is NavItem => typeof i?.label === 'string' && typeof i?.href === 'string')
  const finalItems: NavItem[] = items.length > 0 ? items : FALLBACK_NAV

  const siteName = ctx.site.name ?? ctx.site.slug
  const brandKicker = readBrandKicker(config, siteName)
  const logoUrl = typeof config.logo_url === 'string' ? config.logo_url : '/assets/logo-tree.png'
  const cart = renderCartCount({}, ctx)

  const desktopLinks = finalItems.map(i => `    <a href="${escapeAttr(i.href)}">${escapeHtml(i.label)}</a>`).join('\n')
  const drawerLinks = finalItems.map(i => `    <a href="${escapeAttr(i.href)}">${escapeHtml(i.label)}</a>`).join('\n')

  // The trailing <div class="page-enter"> opens the fade-up wrapper
  // Design specced for real navigation. {{site-footer}} closes it.
  // Header stays outside the wrapper so it doesn't animate on every
  // click — only content between header + footer fades up.
  return `<header class="site-head">
  <a class="brand" href="/">
    <img src="${escapeAttr(logoUrl)}" alt="${escapeAttr(siteName)}">
    <span class="brand-name">${escapeHtml(brandName(siteName))}${brandKicker ? `<em>${escapeHtml(brandKicker)}</em>` : ''}</span>
  </a>
  <nav class="nav-desktop">
${desktopLinks}
    <a class="cart-pill" href="/cart">Cart${cart}</a>
  </nav>
  <div class="nav-mobile">
    <a class="cart-mini" href="/cart">Cart${cart}</a>
    <button class="burger" type="button" aria-label="Menu" aria-expanded="false" data-menu-toggle><span></span><span></span></button>
  </div>
  <nav class="drawer" id="drawer" hidden>
${drawerLinks}
  </nav>
</header>
${HEADER_SCRIPT}
<style>${PAGE_ENTER_STYLE}</style>
<div class="page-enter">`
}

// Design's page-entry animation. @keyframes floatIn is already in
// sites.config.global_css from the drawer animation; only .page-enter
// and the reduced-motion guard are added here. The guard is not
// optional — anyone with prefers-reduced-motion set gets no animation.
const PAGE_ENTER_STYLE = `
.page-enter{animation:floatIn .45s ease both}
@media (prefers-reduced-motion: reduce){*{animation:none !important}}
`

// Ships with every page via the header widget so behaviour is
// consistent regardless of what a specific page's js_body does:
//   - Burger toggle for the mobile nav drawer
//   - Universal add-to-cart click delegation. Any button carrying
//     .btn-add or .btn-add-lg + data-slug POSTs to
//     /api/site-cart/add. Qty is 1 for .btn-add cards; PDP reads
//     from the sibling .stepper's <output>. UI feedback matches
//     Design's contract: swap label to "Added ✓", add .added class,
//     pop every .cart-count for 1400ms, then restore.
//   - Cart-page stepper (data-cart-step) + remove (data-cart-remove).
//     POST /api/site-cart/set with the new qty (0 = remove) and
//     reload — server row is the source of truth for v1, no client
//     reconciliation to get wrong.
//
// Uses a delegated document listener so it works for cards rendered
// server-side and any that might be injected client-side later.
const HEADER_SCRIPT = `<script>
(function(){
  var toggle = document.querySelector('[data-menu-toggle]');
  var drawer = document.getElementById('drawer');
  if (toggle && drawer && !toggle.__wired) {
    toggle.__wired = true;
    toggle.addEventListener('click', function(){
      var open = drawer.hasAttribute('hidden');
      if (open) drawer.removeAttribute('hidden'); else drawer.setAttribute('hidden','');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  function popCartCounts(count){
    var els = document.querySelectorAll('.cart-count');
    els.forEach(function(el){
      if (typeof count === 'number') el.textContent = String(count);
      el.classList.add('pop');
    });
    setTimeout(function(){
      els.forEach(function(el){ el.classList.remove('pop'); });
    }, 1400);
  }

  document.addEventListener('click', function(e){
    var addBtn = e.target.closest && e.target.closest('.btn-add, .btn-add-lg');
    if (addBtn && addBtn.dataset && addBtn.dataset.slug) {
      e.preventDefault();
      var qty = 1;
      var pdp = addBtn.closest('.pdp-grid');
      if (pdp) {
        var out = pdp.querySelector('.stepper output');
        if (out) { qty = parseInt(out.textContent, 10) || 1; }
      }
      var slug = addBtn.dataset.slug;
      // Options come from the PDP picker via the button's
      // data-options attribute (JSON-serialized). Absent for
      // .btn-add on card grids — the server fills in defaults
      // when the product has a picker but the payload omits it.
      var opts = null;
      var raw = addBtn.getAttribute('data-options');
      if (raw) { try { opts = JSON.parse(raw); } catch (_) { opts = null; } }
      var body = { slug: slug, qty: qty };
      if (opts && typeof opts === 'object') body.options = opts;
      var original = addBtn.innerHTML;
      addBtn.classList.add('added');
      addBtn.textContent = 'Added \\u2713';
      fetch('/api/site-cart/add', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify(body)
      }).then(function(r){ return r.json(); })
        .then(function(d){ if (d && typeof d.count === 'number') popCartCounts(d.count); })
        .catch(function(){})
        .finally(function(){
          setTimeout(function(){
            addBtn.classList.remove('added');
            addBtn.innerHTML = original;
          }, 1400);
        });
      return;
    }

    var stepBtn = e.target.closest && e.target.closest('[data-cart-step]');
    if (stepBtn) {
      e.preventDefault();
      var line = stepBtn.closest('.cart-line');
      if (!line) return;
      var out2 = line.querySelector('.stepper output');
      var current = out2 ? (parseInt(out2.textContent, 10) || 0) : 0;
      var newQty = Math.max(0, current + (stepBtn.dataset.cartStep === 'up' ? 1 : -1));
      var slug2 = stepBtn.dataset.slug || line.dataset.slug;
      if (!slug2) return;
      // The line's data-options identifies WHICH cart line to
      // update when the same slug appears with multiple variants.
      // Missing / unparseable = no options → still identifies the
      // no-picker line correctly.
      var opts2 = null;
      var rawOpts = line.getAttribute('data-options');
      if (rawOpts) { try { opts2 = JSON.parse(rawOpts); } catch (_) { opts2 = null; } }
      var body2 = { slug: slug2, qty: newQty };
      if (opts2 && typeof opts2 === 'object') body2.options = opts2;
      fetch('/api/site-cart/set', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify(body2)
      }).then(function(){ window.location.reload(); });
      return;
    }

    var removeBtn = e.target.closest && e.target.closest('[data-cart-remove]');
    if (removeBtn) {
      e.preventDefault();
      var line2 = removeBtn.closest('.cart-line');
      var slug3 = removeBtn.dataset.slug || (line2 && line2.dataset.slug);
      if (!slug3) return;
      var opts3 = null;
      var rawOpts2 = line2 && line2.getAttribute('data-options');
      if (rawOpts2) { try { opts3 = JSON.parse(rawOpts2); } catch (_) { opts3 = null; } }
      var body3 = { slug: slug3, qty: 0 };
      if (opts3 && typeof opts3 === 'object') body3.options = opts3;
      fetch('/api/site-cart/set', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify(body3)
      }).then(function(){ window.location.reload(); });
      return;
    }
  });
})();
</script>`

/** Split a name like "Hatziri Tea & Botanicals" into the first word
 *  (the wordmark) and the rest (the kicker). Rest goes into the
 *  small caps line under the mark. */
function brandName(fullName: string): string {
  const idx = fullName.indexOf(' ')
  return idx === -1 ? fullName : fullName.slice(0, idx)
}

function readBrandKicker(config: Record<string, unknown>, siteName: string): string {
  if (typeof config.brand_kicker === 'string') return config.brand_kicker
  const idx = siteName.indexOf(' ')
  return idx === -1 ? '' : siteName.slice(idx + 1)
}
