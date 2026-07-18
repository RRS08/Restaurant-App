'use server'

// ----------------------------------------------------------------
// Developer-only actions.
//
// Every action calls `requireDev(supabase)` as the first gate. Users
// not on the DEV_EMAILS allowlist are rejected before any DB writes.
// These actions ONLY write to restaurant_setup_state — they never
// touch operational data (orders, inventory, menu, etc.).
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireDev } from '@/lib/dev'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'
import { PILLAR_KEYS, VALID_PILLAR_STATES, type PillarKey, type PillarState } from '@/lib/readiness'

type Result = { error: string } | null

/**
 * Small local helper used by every dev action. Runs the existing
 * dev-allowlist check AND the owner check in one place so each
 * action's permission story is a single line. Returns either the
 * resolved context or an action-style error.
 *
 * Layering rationale: `requireDev` proves the user is on the
 * DEV_EMAILS allowlist and resolves their restaurant. That's
 * orthogonal to role. `requireRestaurantOwner` then proves they're
 * actually the owner of THAT restaurant. Both layers are required
 * for writes to restaurant_setup_state from dev tooling.
 */
async function gateDevOwner(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<{ ok: true; restaurantId: string } | { ok: false; error: string }> {
  const dev = await requireDev(supabase)
  if (!dev.ok) return { ok: false, error: dev.error }
  try {
    await requireRestaurantOwner(dev.restaurantId)
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message }
    throw err
  }
  return { ok: true, restaurantId: dev.restaurantId }
}

function isPillarKey(s: string): s is PillarKey {
  return (PILLAR_KEYS as readonly string[]).includes(s)
}

function isPillarState(s: string): s is PillarState {
  return (VALID_PILLAR_STATES as string[]).includes(s)
}

async function upsertDevState(
  supabase: Awaited<ReturnType<typeof createClient>>,
  restaurantId: string,
  patch: { dev_bypass_all?: boolean; dev_pillar_overrides?: Record<string, string> | null }
): Promise<Result> {
  // Upsert by restaurant_id so dev state always exists.
  const { error } = await supabase
    .from('restaurant_setup_state')
    .upsert(
      { restaurant_id: restaurantId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'restaurant_id' }
    )
  if (error) return { error: error.message }
  revalidatePath('/settings')
  revalidatePath('/analytics')
  revalidatePath('/web/analytics')
  revalidatePath('/dashboard')
  return null
}

// ----------------------------------------------------------------
// Feature 1 — Global full-system bypass.
// ----------------------------------------------------------------
export async function setDevBypass(
  prevState: Result,
  formData: FormData
): Promise<Result> {
  const supabase = await createClient()
  const gate = await gateDevOwner(supabase)
  if (!gate.ok) return { error: gate.error }

  const raw = (formData.get('enabled') as string)?.trim()
  const enabled = raw === 'true' || raw === 'on' || raw === '1'

  return upsertDevState(supabase, gate.restaurantId, { dev_bypass_all: enabled })
}

// ----------------------------------------------------------------
// Feature 2 — Per-pillar readiness overrides.
//
// Set a single pillar to a specific state, or clear that pillar's
// override (passing `clear=true`) so the real computed state surfaces.
// ----------------------------------------------------------------
export async function setPillarOverride(
  prevState: Result,
  formData: FormData
): Promise<Result> {
  const supabase = await createClient()
  const gate = await gateDevOwner(supabase)
  if (!gate.ok) return { error: gate.error }

  const pillar = (formData.get('pillar') as string)?.trim()
  const clear = (formData.get('clear') as string)?.trim() === 'true'
  const state = (formData.get('state') as string)?.trim()

  if (!isPillarKey(pillar)) return { error: `Unknown pillar: ${pillar}` }
  if (!clear && !isPillarState(state)) {
    return { error: `Invalid pillar state: ${state}` }
  }

  // Read current overrides, patch the one key, write back.
  const { data: current } = await supabase
    .from('restaurant_setup_state')
    .select('dev_pillar_overrides')
    .eq('restaurant_id', gate.restaurantId)
    .maybeSingle()

  const existing = (current?.dev_pillar_overrides ?? {}) as Record<string, string>
  const next = { ...existing }
  if (clear) delete next[pillar]
  else next[pillar] = state

  return upsertDevState(supabase, gate.restaurantId, {
    dev_pillar_overrides: Object.keys(next).length === 0 ? null : next,
  })
}

// ----------------------------------------------------------------
// Feature 3 — Reset controls.
//
// resetReadiness
//   Clears ALL setup/activation/override state on restaurant_setup_state:
//     operating_mode, inventory_activated_at, dev_bypass_all,
//     dev_pillar_overrides
//   Does NOT delete operational data (menu, sales, inventory, etc.).
//   For a full data wipe, use the existing /settings cleanup flow.
//
// resetPillarOverride
//   Clears every dev_pillar_override at once but leaves bypass and
//   the real setup state (operating_mode, inventory_activated_at)
//   untouched.
// ----------------------------------------------------------------
export async function resetReadiness(
  prevState: Result,
  _formData: FormData
): Promise<Result> {
  const supabase = await createClient()
  const gate = await gateDevOwner(supabase)
  if (!gate.ok) return { error: gate.error }

  const { error } = await supabase
    .from('restaurant_setup_state')
    .upsert(
      {
        restaurant_id: gate.restaurantId,
        operating_mode: null,
        inventory_activated_at: null,
        dev_bypass_all: false,
        dev_pillar_overrides: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'restaurant_id' }
    )

  if (error) return { error: error.message }
  revalidatePath('/settings')
  revalidatePath('/analytics')
  revalidatePath('/web/analytics')
  revalidatePath('/dashboard')
  return null
}

export async function resetPillarOverrides(
  prevState: Result,
  _formData: FormData
): Promise<Result> {
  const supabase = await createClient()
  const gate = await gateDevOwner(supabase)
  if (!gate.ok) return { error: gate.error }

  return upsertDevState(supabase, gate.restaurantId, { dev_pillar_overrides: null })
}
