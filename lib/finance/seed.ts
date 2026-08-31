// ----------------------------------------------------------------
// Finance pillar — first-visit seeding.
//
// Idempotent seed for a restaurant that opens Finance for the
// first time. Runs on every page load; the ON CONFLICT DO NOTHING
// clauses mean it's a no-op after the initial insert. Cheap enough
// to keep re-running so a merchant who deletes a seed row and
// wants it back can trigger it via a "reset seeds" action later.
//
// Two-part seed:
//   1. Category starter set (SEED_CATEGORIES from types.ts) — one
//      insert per restaurant, unique on (restaurant_id, kind,
//      lower(name)) so a manually-added "Sales" collapses with
//      the seed one.
//   2. Auto-seeded accounts — one POS account tied to Poynt (only
//      if the site has a payment_provider), plus one "Register
//      drawer" per retail location. Owner adds every other
//      account manually.
// ----------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import { SEED_CATEGORIES, type FinanceAccountKind } from './types'

export async function ensureFinanceSeeds(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<void> {
  await Promise.all([
    seedCategories(supabase, restaurantId),
    seedAccounts(supabase, restaurantId),
  ])
}

async function seedCategories(supabase: SupabaseClient, restaurantId: string): Promise<void> {
  // Skip the network round trip when the table already has any
  // category for this restaurant — the first insert seeded it,
  // so a re-run is a pure no-op we can short-circuit.
  const { data: existing } = await supabase
    .from('finance_categories')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .limit(1)
  if (existing && existing.length > 0) return

  const rows = SEED_CATEGORIES.map(c => ({
    restaurant_id: restaurantId,
    name: c.name,
    kind: c.kind,
    color: c.color,
    sort_order: c.sort_order,
    tax_category: c.tax_category,
    active: true,
  }))
  await supabase
    .from('finance_categories')
    .insert(rows)
    // Unique index on (restaurant_id, kind, lower(name)) protects
    // against a race where two page loads seed at once — the
    // second one just fails silently on the collision.
}

async function seedAccounts(supabase: SupabaseClient, restaurantId: string): Promise<void> {
  // Same short-circuit as categories.
  const { data: existing } = await supabase
    .from('finance_accounts')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .limit(1)
  if (existing && existing.length > 0) return

  // Retail locations get an auto-seeded "Register drawer".
  const { data: locations } = await supabase
    .from('locations')
    .select('id, name, kind')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: true })

  const rows: Array<{
    restaurant_id: string
    location_id: string | null
    name: string
    kind: FinanceAccountKind
    color: string
    sort_order: number
  }> = []

  let order = 10

  // POS account — one per restaurant, shop-wide (location_id null).
  // Balance stays 0 until the first POS batch settlement lands as
  // an auto movement. Owner can rename or add more (e.g. Square
  // alongside Poynt) after the fact.
  rows.push({
    restaurant_id: restaurantId,
    location_id: null,
    name: 'POS',
    kind: 'pos',
    color: '#EEF2FF',
    sort_order: order,
  })
  order += 10

  // Register drawer per retail location. Online locations don't
  // get one — no cash lives there. Name stays plain "Register"
  // (not "Register — <location>") since the active-place filter
  // already scopes what the operator sees; a manager in Mcallen
  // sees Mcallen's Register, a manager in Weslaco sees Weslaco's,
  // and each register is unambiguously tied to its location_id
  // in the DB.
  for (const loc of locations ?? []) {
    if ((loc as { kind?: string }).kind === 'online') continue
    rows.push({
      restaurant_id: restaurantId,
      location_id: loc.id as string,
      name: 'Register',
      kind: 'cash',
      color: '#ECFDF5',
      sort_order: order,
    })
    order += 10
  }

  if (rows.length === 0) return
  await supabase.from('finance_accounts').insert(rows)
}
