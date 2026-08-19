// ----------------------------------------------------------------
// Cart / product option helpers.
//
// One source of truth for how buyer-selected product options
// (form/size/color/…) resolve into a price + display label + a
// stable cart-line key. Every surface that renders a line item
// (cart page, checkout summary, order confirmation, transactional
// email, Checked's sales drawer) reads through these helpers so
// the buyer sees the same variant string everywhere.
//
// Shape reminder:
//   site_products.options :: SiteProductOptionGroup[] | null
//     [{ key, label, choices: [{ key, label, price? }] }]
//
//   cart line .options    :: Record<string, string> | undefined
//     { [option_group_key]: choice_key }
//
// Extensibility: the same shape carries color+size later — every
// group is independent. Multi-group products just pick one choice
// per group; the concatenated label is joined with " · ".
// ----------------------------------------------------------------

import type { SiteProductOptionGroup, SiteProductOptionChoice } from './types'

/** Normalize a raw options object off the wire (from a JSON body
 *  or a stored cart row) into a plain map of `{group_key: choice_key}`.
 *  Drops any keys/values that aren't strings so downstream code can
 *  trust the shape. Returns undefined for empty/missing/bogus input
 *  so a "no options" line stays visually distinct in logs.
 *  Never trust the client's serialization — call this at every
 *  boundary. */
export function normalizeOptions(
  raw: unknown,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0) continue
    if (typeof v !== 'string' || v.length === 0) continue
    out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Coerce a product's `options` column into a typed group array,
 *  dropping any malformed entries. Handles both null (no picker)
 *  and legacy rows that predate the column. Returns [] for the
 *  no-picker case so callers can uniformly iterate. */
export function normalizeGroups(raw: unknown): SiteProductOptionGroup[] {
  if (!Array.isArray(raw)) return []
  const groups: SiteProductOptionGroup[] = []
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue
    const gg = g as Partial<SiteProductOptionGroup>
    if (typeof gg.key !== 'string' || typeof gg.label !== 'string') continue
    if (!Array.isArray(gg.choices)) continue
    const choices: SiteProductOptionChoice[] = []
    for (const c of gg.choices) {
      if (!c || typeof c !== 'object') continue
      const cc = c as Partial<SiteProductOptionChoice>
      if (typeof cc.key !== 'string' || typeof cc.label !== 'string') continue
      const choice: SiteProductOptionChoice = { key: cc.key, label: cc.label }
      if (typeof cc.price === 'number' && Number.isFinite(cc.price)) {
        choice.price = cc.price
      }
      choices.push(choice)
    }
    if (choices.length === 0) continue
    groups.push({ key: gg.key, label: gg.label, choices })
  }
  return groups
}

/** Fill in missing group selections with each group's default
 *  choice (first entry). Used when a buyer's Add-to-cart click
 *  arrives without a full options payload — most commonly from a
 *  grid card's "Add" button that doesn't open the PDP picker.
 *  Also drops any group keys the product doesn't declare so a
 *  stale client can't smuggle bogus option keys into the cart. */
export function fillDefaults(
  groups: SiteProductOptionGroup[],
  supplied: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const g of groups) {
    const wanted = supplied?.[g.key]
    const chosen = wanted && g.choices.some(c => c.key === wanted)
      ? wanted
      : g.choices[0].key
    out[g.key] = chosen
  }
  return out
}

/** Human label for a chosen options set: each selected choice's
 *  label joined by " · ". Empty string when no picker or when
 *  nothing was chosen. */
export function formatVariantLabel(
  groups: SiteProductOptionGroup[],
  options: Record<string, string> | undefined,
): string {
  if (!options || groups.length === 0) return ''
  const parts: string[] = []
  for (const g of groups) {
    const key = options[g.key]
    if (!key) continue
    const choice = g.choices.find(c => c.key === key)
    if (choice) parts.push(choice.label)
  }
  return parts.join(' · ')
}

/** Resolve the unit price for a line given the chosen options.
 *  First choice with an explicit price wins (in group order); if
 *  no choice carries a price, the product base price is used.
 *  Later, when we grow to multi-dimensional variant pricing
 *  (color × size × …), swap this for a variant-matrix lookup. */
export function resolveUnitPrice(
  basePrice: number,
  groups: SiteProductOptionGroup[],
  options: Record<string, string> | undefined,
): number {
  if (!options) return basePrice
  for (const g of groups) {
    const key = options[g.key]
    if (!key) continue
    const choice = g.choices.find(c => c.key === key)
    if (choice && typeof choice.price === 'number') return choice.price
  }
  return basePrice
}

/** Stable serialization of an options set used to distinguish
 *  cart lines. Two lines with the same slug + same optionsKey
 *  merge (qty adds); different optionsKey stays as separate lines.
 *  Keys are sorted so `{a:1,b:2}` and `{b:2,a:1}` collide. */
export function optionsKey(options: Record<string, string> | undefined): string {
  if (!options) return ''
  const keys = Object.keys(options).sort()
  return keys.map(k => `${k}=${options[k]}`).join('|')
}
