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
  const unit = p.unit ? ` <span>· ${escapeHtml(p.unit)}</span>` : ''
  const price = formatPrice(p.price)
  const use = p.long_description ? `<p class="pdp-use">${escapeHtml(p.long_description)}</p>` : ''
  const category = CATEGORY_LABELS[p.category ?? ''] ?? p.category ?? ''

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

  return `<div class="pdp-grid">
  <div class="pdp-tile">
    ${tag}
    <img src="${escapeAttr(p.image_url ?? '')}" alt="${escapeAttr(p.name)}">
  </div>
  <div class="pdp-body">
    <div class="pdp-cat">${escapeHtml(category)}</div>
    <h1>${escapeHtml(p.name)}</h1>
    ${en}
    <div class="pdp-price">${escapeHtml(price)}${unit}</div>
    ${use}
    ${facts}
    <div class="qty-row">
      <div class="stepper">
        <button type="button" data-step="down" aria-label="Decrease quantity">–</button>
        <output>1</output>
        <button type="button" data-step="up" aria-label="Increase quantity">+</button>
      </div>
      <button class="btn-add-lg" type="button" data-slug="${escapeAttr(p.slug)}">Add to cart</button>
    </div>
  </div>
</div>`
}

function formatPrice(raw: number | string): string {
  const n = typeof raw === 'number' ? raw : parseFloat(raw)
  if (!Number.isFinite(n)) return ''
  return `$${n.toFixed(2)}`
}
