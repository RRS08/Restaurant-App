// ----------------------------------------------------------------
// Places — the workspace pivot introduced 2026-08-25.
//
// A "place" is a location the operator works from — either a
// physical shop (kind='retail') or the online storefront
// (kind='online'). The whole app is scoped to one active place at a
// time: nav items, page content, per-place data (sales, inventory,
// staffing) all narrow to that place's location_id.
//
// Storage: place identity IS a location row. `locations.kind`
// (added by 2026-08-25-locations-kind-places.sql) tells retail
// storefronts apart from the virtual "Online" location that houses
// web-checkout orders. Reusing `locations` means every existing
// per-location query (order.location_id, staffing, etc.) already
// composes with the new concept — no shadow table, no join fanout.
//
// Selection: after sign-in the layout resolves the active place
// from a cookie. Missing / stale / not authorized → redirect to
// /places. This module owns the cookie name + the lookup helpers
// so the redirect gate and every server component read from one
// place. Never inspect the cookie directly outside this file.
// ----------------------------------------------------------------

import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'

export const ACTIVE_PLACE_COOKIE = 'active_place_id'
export const ACTIVE_PLACE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

export type PlaceKind = 'retail' | 'online'

export interface Place {
  id: string
  name: string
  kind: PlaceKind
  timezone: string
}

/** Fetch every place (location row) the restaurant owns. Kept in
 *  createdAt order so the picker is stable — earliest-created shop
 *  first, then the auto-seeded Online tile. */
export async function listPlacesForRestaurant(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<Place[]> {
  const { data, error } = await supabase
    .from('locations')
    .select('id, name, kind, timezone')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: true })
  if (error || !data) return []
  return data.map(rowToPlace).filter((p): p is Place => p !== null)
}

/** Resolve the active place from the cookie, cross-checked against
 *  the restaurant's real locations so a stale cookie from another
 *  tenant can't leak state. Returns null when the cookie is missing
 *  or points at something the caller isn't authorized to see — the
 *  layout gate reads null as "redirect to /places". */
export async function resolveActivePlace(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<Place | null> {
  const cookieStore = await cookies()
  const raw = cookieStore.get(ACTIVE_PLACE_COOKIE)?.value
  if (!raw) return null
  const { data } = await supabase
    .from('locations')
    .select('id, name, kind, timezone')
    .eq('id', raw)
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
  return data ? rowToPlace(data) : null
}

function rowToPlace(row: {
  id: string
  name: string
  kind: string | null
  timezone: string | null
}): Place | null {
  if (typeof row.id !== 'string' || typeof row.name !== 'string') return null
  const kind: PlaceKind = row.kind === 'online' ? 'online' : 'retail'
  return {
    id: row.id,
    name: row.name,
    kind,
    timezone: row.timezone ?? 'UTC',
  }
}
