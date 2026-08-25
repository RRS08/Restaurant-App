'use server'

// ----------------------------------------------------------------
// Catalog server actions — create / update / delete site_products
// for the tenant's online storefront.
//
// Guardrails:
//   • Every action verifies the operator's restaurant owns the
//     target site (or, for updates, the target product's site
//     belongs to the operator's restaurant). No cross-tenant
//     writes possible.
//   • Slug uniqueness enforced per-site: create refuses to
//     overwrite an existing (site_id, slug); update leaves slug
//     alone unless it's explicitly changed.
//   • Optional numeric fields are normalized here so the client
//     doesn't have to worry about "" vs null vs undefined.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeGroups } from '@/lib/sites/cart-options'

type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { error: string }

export interface CatalogProductInput {
  name: string
  slug?: string
  secondary_name?: string | null
  category?: string | null
  price: number
  unit?: string | null
  benefit?: string | null
  purpose?: string | null
  short_description?: string | null
  long_description?: string | null
  ritual?: string | null
  ritual_label?: string | null
  ingredients?: string | null
  image_url?: string | null
  featured?: boolean
  status?: 'live' | 'draft'
  sort_order?: number | null
  /** Options JSON — passed through to storage as-is after
   *  normalizeGroups() strips any malformed entries. */
  options?: unknown
}

/** Resolve the operator's restaurant + their site in one call.
 *  Every catalog action needs both; centralizing the auth path
 *  keeps the actions themselves short and consistent. */
async function resolveOperatorSite(): Promise<
  { ok: true; siteId: string } | { error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }
  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role) return { error: 'No restaurant.' }
  const admin = createAdminClient()
  const { data: site } = await admin
    .from('sites')
    .select('id')
    .eq('restaurant_id', role.restaurant_id)
    .maybeSingle()
  if (!site) return { error: 'No site configured for this restaurant.' }
  return { ok: true, siteId: site.id as string }
}

/** Build a stable slug from a display name. Lowercase, ASCII-only,
 *  spaces + separators collapse to a single '-'. Never returns an
 *  empty string — falls back to 'product' when the input is all
 *  non-slug characters so create() has something to store. */
function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.length > 0 ? s : 'product'
}

/** Turn the input into a database patch. Only keys the caller
 *  supplied get written so update() can leave untouched fields
 *  alone. Empty strings become null so the DB doesn't hold
 *  meaningless whitespace. */
function toPatch(input: Partial<CatalogProductInput>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const strFields: Array<keyof CatalogProductInput> = [
    'name', 'secondary_name', 'category', 'unit', 'benefit', 'purpose',
    'short_description', 'long_description', 'ritual', 'ritual_label',
    'ingredients', 'image_url',
  ]
  for (const k of strFields) {
    if (input[k] === undefined) continue
    const raw = input[k]
    patch[k] = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
  }
  if (input.price !== undefined) {
    const n = typeof input.price === 'number' ? input.price : parseFloat(String(input.price))
    if (!Number.isFinite(n) || n < 0) throw new Error('Price must be a non-negative number.')
    patch.price = n
  }
  if (input.featured !== undefined) patch.featured = !!input.featured
  if (input.status !== undefined) patch.status = input.status === 'draft' ? 'draft' : 'live'
  if (input.sort_order !== undefined) {
    patch.sort_order = typeof input.sort_order === 'number' && Number.isFinite(input.sort_order)
      ? input.sort_order
      : null
  }
  if (input.options !== undefined) {
    // Filter through normalizeGroups() so any garbage the client
    // sent is silently dropped — never stored raw. Empty result
    // becomes null so no-picker products don't carry [] in the
    // JSON column.
    const groups = normalizeGroups(input.options)
    patch.options = groups.length > 0 ? groups : null
  }
  return patch
}

/** Create a new site_products row on the operator's site. */
export async function createProduct(input: CatalogProductInput): Promise<ActionResult<{ id: string }>> {
  const ctx = await resolveOperatorSite()
  if ('error' in ctx) return ctx

  if (!input.name || !input.name.trim()) return { error: 'Name is required.' }
  const slug = input.slug?.trim() || slugify(input.name)

  const admin = createAdminClient()
  // Slug uniqueness per site — refuse to overwrite silently.
  const { data: existing } = await admin
    .from('site_products')
    .select('id')
    .eq('site_id', ctx.siteId)
    .eq('slug', slug)
    .maybeSingle()
  if (existing) return { error: `A product with slug "${slug}" already exists on this site.` }

  let patch: Record<string, unknown>
  try {
    patch = toPatch(input)
  } catch (e) {
    return { error: (e as Error).message }
  }
  patch.site_id = ctx.siteId
  patch.slug = slug
  patch.status = patch.status ?? 'live'

  const { data, error } = await admin
    .from('site_products')
    .insert(patch)
    .select('id')
    .single()
  if (error || !data) {
    console.error('[catalog:createProduct] insert failed', error)
    return { error: 'Could not create product.' }
  }

  revalidatePath('/catalog')
  return { ok: true, data: { id: data.id as string } }
}

/** Update an existing site_products row. Guards on site ownership
 *  before touching anything so a stray id can't reach across
 *  tenants. */
export async function updateProduct(
  productId: string,
  input: Partial<CatalogProductInput>,
): Promise<ActionResult> {
  if (!productId) return { error: 'Missing product id.' }
  const ctx = await resolveOperatorSite()
  if ('error' in ctx) return ctx

  const admin = createAdminClient()
  const { data: product } = await admin
    .from('site_products')
    .select('id, site_id, slug')
    .eq('id', productId)
    .maybeSingle()
  if (!product) return { error: 'Product not found.' }
  if (product.site_id !== ctx.siteId) return { error: 'Product not found.' }

  // Slug change is optional but has to stay unique on the site.
  const nextSlug = input.slug?.trim()
  if (nextSlug && nextSlug !== product.slug) {
    const { data: collision } = await admin
      .from('site_products')
      .select('id')
      .eq('site_id', ctx.siteId)
      .eq('slug', nextSlug)
      .neq('id', productId)
      .maybeSingle()
    if (collision) return { error: `Slug "${nextSlug}" already used by another product.` }
  }

  let patch: Record<string, unknown>
  try {
    patch = toPatch(input)
  } catch (e) {
    return { error: (e as Error).message }
  }
  if (nextSlug) patch.slug = nextSlug
  if (Object.keys(patch).length === 0) return { ok: true }

  const { error } = await admin
    .from('site_products')
    .update(patch)
    .eq('id', productId)
    .eq('site_id', ctx.siteId)
  if (error) {
    console.error('[catalog:updateProduct] update failed', error)
    return { error: 'Could not save product.' }
  }
  revalidatePath('/catalog')
  return { ok: true }
}

/** Delete a product. Same site-ownership guard as update. */
export async function deleteProduct(productId: string): Promise<ActionResult> {
  if (!productId) return { error: 'Missing product id.' }
  const ctx = await resolveOperatorSite()
  if ('error' in ctx) return ctx

  const admin = createAdminClient()
  const { error } = await admin
    .from('site_products')
    .delete()
    .eq('id', productId)
    .eq('site_id', ctx.siteId)
  if (error) {
    console.error('[catalog:deleteProduct] delete failed', error)
    return { error: 'Could not delete product.' }
  }
  revalidatePath('/catalog')
  return { ok: true }
}
