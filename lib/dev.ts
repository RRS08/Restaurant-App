// ----------------------------------------------------------------
// Developer / internal account allowlist
//
// The cleanest "is this a dev user" check without a schema migration
// is an email allowlist sourced from an environment variable. This
// keeps the allowlist out of source control and makes it trivial to
// rotate without deploys.
//
// Set DEV_EMAILS in .env.local to a comma-separated list, e.g.
//
//   DEV_EMAILS=renato@example.com,teammate@example.com
//
// Every dev control in the app — bypass toggle, per-pillar overrides,
// reset buttons, the Dev Tools section in /settings — is gated on
// `isDevEmail(user.email)`. Regular users never see or reach them.
// ----------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0)
}

export const DEV_EMAILS: string[] = parseAllowlist(process.env.DEV_EMAILS)

export function isDevEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return DEV_EMAILS.includes(email.toLowerCase())
}

/**
 * Server-side gate used by every dev action. Looks up the current
 * user, checks the allowlist, and returns either the user + role
 * context or an error suitable for a server-action response shape.
 *
 * Callers should treat a non-null `error` as a hard refusal.
 */
export async function requireDev(
  supabase: SupabaseClient
): Promise<
  | { ok: true; userId: string; email: string; restaurantId: string }
  | { ok: false; error: string }
> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return { ok: false, error: 'Not authenticated.' }
  if (!isDevEmail(user.email)) return { ok: false, error: 'Developer access only.' }

  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role?.restaurant_id) return { ok: false, error: 'No restaurant found.' }

  return { ok: true, userId: user.id, email: user.email, restaurantId: role.restaurant_id }
}
