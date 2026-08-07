// ----------------------------------------------------------------
// {{announcement-bar}} widget.
//
// Renders the dark strip at the very top of the page. Copy comes
// from `site.config.announcement`:
//
//   {
//     "active": true,
//     "text_short": "Weslaco location opening October",
//     "text_long":  "Weslaco location opening October — Mercado open now",
//     "href": null
//   }
//
// When `active` is false or the config key is missing, the widget
// renders nothing at all — no wrapper, no whitespace — so the page
// snaps up to the header. Setting `active: false` in the admin is
// the off switch when a promo expires.
// ----------------------------------------------------------------

import type { ShortcodeContext } from '../index'
import { escapeAttr, escapeHtml } from '../utils'

interface Announcement {
  active?: boolean
  text_short?: string
  text_long?: string
  href?: string | null
}

export function renderAnnouncementBar(_args: unknown, ctx: ShortcodeContext): string {
  const config = (ctx.site.config ?? {}) as Record<string, unknown>
  const a = (config.announcement ?? {}) as Announcement

  if (!a.active) return ''
  const short = typeof a.text_short === 'string' ? a.text_short : ''
  const long = typeof a.text_long === 'string' ? a.text_long : short
  if (!short && !long) return ''

  const inner = `<span class="announce-short">${escapeHtml(short || long)}</span><span class="announce-long">${escapeHtml(long || short)}</span>`
  const href = typeof a.href === 'string' && a.href.length > 0 ? a.href : null

  return href
    ? `<div class="announce"><a href="${escapeAttr(href)}" style="color:inherit;text-decoration:none">${inner}</a></div>`
    : `<div class="announce">${inner}</div>`
}
