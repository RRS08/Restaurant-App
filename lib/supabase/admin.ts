// ----------------------------------------------------------------
// Service-role Supabase client — trusted server-side bootstrap.
//
// Uses SUPABASE_SERVICE_ROLE_KEY (NOT the anon key) and bypasses
// RLS. Exists for one narrow reason: the onboarding bootstrap
// writes to multiple tables where RLS creates a circular
// dependency (user_roles needs a restaurant, dependent tables
// need user_roles via my_restaurant_id()).
//
// Security posture:
//   - service role key lives in server-side env vars only
//   - never imported from 'use client' files
//   - only onboarding bootstrap actions use this client
//   - every other server action uses the normal anon-key client
// ----------------------------------------------------------------

import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cached: SupabaseClient<any> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAdminClient(): SupabaseClient<any> {
  if (cached) return cached

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured. ' +
      'Add it to .env.local — find it in Supabase → Settings → API → service_role.'
    )
  }

  cached = createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return cached
}
