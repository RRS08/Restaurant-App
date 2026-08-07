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

  return `<footer class="site-foot">
  <div class="foot-top">
    <strong>${escapeHtml(siteName)}</strong>
    <p>${escapeHtml(tagline)}</p>
  </div>
  <div class="foot-cols">
${colsHtml}
  </div>
  <div class="foot-bar">
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
