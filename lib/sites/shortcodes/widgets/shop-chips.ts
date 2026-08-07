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
    return `    <a class="chip${isActive ? ' is-active' : ''}" href="${escapeAttr(href)}">${escapeHtml(c.label)}</a>`
  }).join('\n')

  return `<div class="filter-bar">
  <div class="filter-scroll" data-scroll-x>
${links}
  </div>
</div>`
}
