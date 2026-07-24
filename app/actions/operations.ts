'use server'

// ----------------------------------------------------------------
// Operations toggles — owner-only settings that change how the app
// presents itself to the merchant (not to the underlying data).
//
// Today: just `setNativePosEnabled`, which unlocks the in-app POS
// surface for external_pos merchants who want to trial the native
// POS alongside their existing GoDaddy / Square / Clover terminal.
// The operating_mode itself stays put — this is a UI-visibility
// flag, not a sales-source flip.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import { requireRestaurantOwner, AuthzError } from '@/lib/authz'
import { revalidatePath } from 'next/cache'

export async function setNativePosEnabled(
  enabled: boolean,
): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated.' }

  const { data: roleRow } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!roleRow?.restaurant_id) return { error: 'No restaurant found.' }

  try {
    await requireRestaurantOwner(roleRow.restaurant_id)
  } catch (err) {
    if (err instanceof AuthzError) return { error: err.message }
    throw err
  }

  // Upsert so first-time toggles on a restaurant that never touched
  // setup state still land. onConflict on restaurant_id (unique
  // column per schema) handles the merge.
  const { error } = await supabase
    .from('restaurant_setup_state')
    .upsert(
      {
        restaurant_id: roleRow.restaurant_id,
        native_pos_enabled: enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'restaurant_id' },
    )
  if (error) return { error: `Could not save toggle: ${error.message}` }

  // Sidebar visibility of the POS link depends on this flag, so
  // revalidate the shell layout to pick it up on the next render.
  revalidatePath('/', 'layout')
  return { ok: true }
}
