// ----------------------------------------------------------------
// {{site-footer}} widget.
//
// Renders the footer strip. Content structure:
//   - Brand: `site.name` + `site.config.footer.tagline`
//   - Columns: `site.config.footer.cols` — array of
//     `{ title, links: [{ label, href }, …] }`
//     Falls back to Hatziri's Shop + Hatziri columns so a new site
//     works without any config wiring.
//   - "Designed and hosted by Checked" mark — always rendered,
//     never configurable. That's the platform's tenant tag.
// ----------------------------------------------------------------

import type { ShortcodeContext } from '../index'
import { escapeAttr, escapeHtml } from '../utils'

interface FooterLink { label?: string; href?: string }
interface FooterCol { title?: string; links?: FooterLink[] }

const FALLBACK_COLS: FooterCol[] = [
  {
    title: 'Shop',
    links: [
      { label: 'Tea blends', href: '/shop?category=tea-blends' },
      { label: 'Ointments', href: '/shop?category=ointments' },
      { label: 'Accessories', href: '/shop?category=accessories' },
    ],
  },
  {
    title: 'Hatziri',
    links: [
      { label: 'Our story', href: '/about' },
      { label: 'Locations', href: '/locations' },
      { label: 'Contact', href: '/contact' },
    ],
  },
]

const FALLBACK_TAGLINE = 'Making wellness flavorful, affordable, cultural, and intentional.'

export function renderSiteFooter(_args: unknown, ctx: ShortcodeContext): string {
  const config = (ctx.site.config ?? {}) as Record<string, unknown>
  const footer = (config.footer ?? {}) as { tagline?: string; cols?: unknown }

  const tagline = typeof footer.tagline === 'string' ? footer.tagline : FALLBACK_TAGLINE
  const rawCols = Array.isArray(footer.cols) ? (footer.cols as FooterCol[]) : FALLBACK_COLS
  const cols = rawCols.length > 0 ? rawCols : FALLBACK_COLS

  const siteName = ctx.site.name ?? ctx.site.slug
  const logoUrl = readLogoUrl(config)
  const brand = splitBrand(config, siteName)
  const copyright = readCopyrightLine(config, siteName)

  const colsHtml = cols.map(col => {
    const links = Array.isArray(col.links) ? col.links : []
    const linkHtml = links
      .filter(l => typeof l?.label === 'string' && typeof l?.href === 'string')
      .map(l => `      <a href="${escapeAttr(l.href as string)}">${escapeHtml(l.label as string)}</a>`)
      .join('\n')
    return `    <div>
      <h4>${escapeHtml(col.title ?? '')}</h4>
${linkHtml}
    </div>`
  }).join('\n')

  // Leading </div> closes the .page-enter wrapper opened by
  // {{site-header}}. Header and footer themselves stay outside the
  // animation — only the content in between fades up on load.
  return `</div>
<footer class="site-foot">
  <style>${FOOTER_STYLE}</style>
  <div class="foot-top">
    <div class="foot-brand-block">
      <div class="foot-brand">
        <img src="${escapeAttr(logoUrl)}" alt="${escapeAttr(siteName)}">
        <div class="foot-brand-name">
          <strong>${escapeHtml(brand.mark)}</strong>${brand.kicker ? `<em>${escapeHtml(brand.kicker)}</em>` : ''}
        </div>
      </div>
      <p class="foot-tag">${escapeHtml(tagline)}</p>
    </div>
  </div>
  <div class="foot-cols">
${colsHtml}
  </div>
  <div class="foot-bar">
    <span class="foot-copyright">${escapeHtml(copyright)}</span>
    <span class="by-checked">
      <span>Designed and hosted by</span>
      <a href="https://onchecked.app" target="_blank" rel="noopener noreferrer">
        <svg width="8.75" height="15" viewBox="18 8 28 48" role="img" aria-label="Checked" style="display:block;flex:none">
          <path d="M24 10h16a4 4 0 0 1 4 4v36a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4z" fill="#18181B"></path>
          <rect x="26" y="16" width="14" height="3" rx="1.5" fill="#FAF9F6"></rect>
          <rect x="26" y="23" width="11" height="3" rx="1.5" fill="#FAF9F6"></rect>
          <rect x="26" y="30" width="8" height="3" rx="1.5" fill="#FAF9F6"></rect>
          <path d="M27 41l4 4 8-9" fill="none" stroke="#FAF9F6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
        <span class="cw">checked</span>
      </a>
    </span>
  </div>
</footer>`
}

function readLogoUrl(config: Record<string, unknown>): string {
  return typeof config.logo_url === 'string' ? config.logo_url : '/assets/logo-tree.png'
}

/** Split "Hatziri Tea & Botanicals" into { mark: "Hatziri",
 *  kicker: "TEA & BOTANICALS" } so the footer can stack them the
 *  way the header does. Honors an explicit config.brand_kicker
 *  when set (same key the header widget reads), otherwise derives
 *  the kicker from the words after the first. */
function splitBrand(config: Record<string, unknown>, siteName: string): { mark: string; kicker: string } {
  const explicit = typeof config.brand_kicker === 'string' ? config.brand_kicker : null
  const idx = siteName.indexOf(' ')
  const mark = idx === -1 ? siteName : siteName.slice(0, idx)
  const derivedKicker = idx === -1 ? '' : siteName.slice(idx + 1)
  return { mark, kicker: (explicit ?? derivedKicker).toUpperCase() }
}

/** Build "© YEAR Site Name · location suffix" from config. Falls
 *  back to just year + site name when no locations_label is set. */
function readCopyrightLine(config: Record<string, unknown>, siteName: string): string {
  const year = new Date().getFullYear()
  const footer = (config.footer ?? {}) as { locations_label?: unknown; copyright?: unknown }
  if (typeof footer.copyright === 'string' && footer.copyright.length > 0) {
    return `© ${year} ${footer.copyright}`
  }
  const label = typeof footer.locations_label === 'string' ? footer.locations_label : ''
  return label ? `© ${year} ${siteName} · ${label}` : `© ${year} ${siteName}`
}

// Widget-local CSS. Overrides earlier footer rules from
// sites.config.global_css by being emitted later (inline in body,
// after the head <style>). Keeping the styling inside the widget
// means a new site gets the fixed layout for free without a config
// update.
const FOOTER_STYLE = `
.site-foot .foot-brand-block{display:flex;flex-direction:column;gap:14px;max-width:340px}
.site-foot .foot-brand{display:flex;align-items:center;gap:12px}
.site-foot .foot-brand img{height:44px;width:auto}
.site-foot .foot-brand-name{line-height:1.05}
.site-foot .foot-brand-name strong{display:block;font-size:22px;font-weight:600;letter-spacing:-.02em}
.site-foot .foot-brand-name em{display:block;font-style:normal;font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:#7d8a6e;margin-top:4px}
.site-foot .foot-tag{font-size:13.5px;color:#7d8a6e;line-height:1.65;margin:0}
.site-foot .foot-bar{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center}
.site-foot .foot-copyright{font-size:11px;color:#9aa590}
@media(min-width:1024px){
  /* Two-track grid: brand block claims the left 1fr, link columns
     sit right-aligned. Cols internally use auto-sized tracks so
     they cluster together rather than filling the space they were
     given — the layout Design ships (brand LEFT, both cols
     grouped on the RIGHT with a comfortable inter-col gap). */
  .site-foot{display:grid;grid-template-columns:1fr auto;column-gap:64px}
  .site-foot .foot-top{grid-column:1;grid-row:1;margin-bottom:0;padding-bottom:0;border-bottom:0}
  .site-foot .foot-cols{grid-column:2;grid-row:1;grid-template-columns:auto auto;justify-content:end;gap:64px}
  .site-foot .foot-bar{grid-column:1 / -1;grid-row:2;margin-top:32px;padding-top:18px;border-top:1px solid #dee2d5}
  .site-foot .foot-brand img{height:52px}
  .site-foot .foot-brand-name strong{font-size:26px}
  .site-foot .foot-brand-name em{font-size:10px}
}
`
