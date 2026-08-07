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
// ----------------------------------------------------------------

import { createAdminClient } from '@/lib/supabase/admin'
import type { ShortcodeArgs, ShortcodeContext } from '../index'
import type { SiteProductRow } from '../../types'
import { escapeAttr, escapeHtml } from '../utils'

type Card = Pick<
  SiteProductRow,
  'slug' | 'name' | 'category' | 'price' | 'benefit' | 'purpose' | 'image_url'
>

export async function renderMenu(args: ShortcodeArgs, ctx: ShortcodeContext): Promise<string> {
  const admin = createAdminClient()
  const category = typeof args.category === 'string' ? args.category.trim() : ''
  const relatedTo = typeof args['related-to'] === 'string' ? args['related-to'].trim() : ''
  const limit = parseInt(typeof args.limit === 'string' ? args.limit : '', 10) || 0

  let query = admin
    .from('site_products')
    .select('slug, name, category, price, benefit, purpose, image_url')
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

  return `<div class="card-grid">
${products.map(renderCard).join('\n')}
</div>`
}

function renderCard(p: Card): string {
  const href = `/shop/${p.slug}`
  const price = formatPrice(p.price)
  const tag = p.benefit ? `<span class="card-tag">${escapeHtml(p.benefit)}</span>` : ''
  const purpose = p.purpose ? `<div class="card-purpose">${escapeHtml(p.purpose)}</div>` : ''

  // data-category lets client-side filters (chip strip on /shop)
  // show/hide cards without a page reload. Server still filters
  // when a category attr is passed on the shortcode — this attribute
  // is additional metadata, not a replacement for server filtering.
  const category = p.category ?? ''
  return `<div class="card" data-category="${escapeAttr(category)}">
  <a class="card-tile" href="${escapeAttr(href)}">
    ${tag}
    <img src="${escapeAttr(p.image_url ?? '')}" alt="${escapeAttr(p.name)}">
  </a>
  <a class="card-name" href="${escapeAttr(href)}">${escapeHtml(p.name)}</a>
  ${purpose}
  <div class="card-foot">
    <span class="card-price">${escapeHtml(price)}</span>
    <button class="btn-add" type="button" data-slug="${escapeAttr(p.slug)}">
      <span class="add-short">Add</span><span class="add-long">Add to cart</span>
    </button>
  </div>
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
