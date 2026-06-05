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

// ----------------------------------------------------------------
// Development-only fallback allowlist.
//
// Why this exists: DEV_EMAILS is loaded at process start. If a dev
// edits .env.local while the Next.js server is running, the new
// value isn't picked up until the server restarts — and the silent
// failure mode is "Dev Toolbox link disappears, /dev-tools
// redirects, looks like the page is broken." This hardcoded list
// gives local testing accounts a survivable fallback that doesn't
// rely on env-var timing.
//
// SECURITY: production deploys never honor this list — the
// NODE_ENV check below restricts the augmentation to development.
// Production trusts DEV_EMAILS alone, exactly as before.
// ----------------------------------------------------------------
const DEV_FALLBACK_EMAILS = [
  'sandra.ruiz@yahoo.com.mx',
] as const

function buildAllowlist(): string[] {
  const fromEnv = parseAllowlist(process.env.DEV_EMAILS)
  if (process.env.NODE_ENV === 'production') return fromEnv
  // Development: union env list + hardcoded fallback so local
  // testing accounts always resolve as dev.
  return Array.from(new Set([
    ...fromEnv,
    ...DEV_FALLBACK_EMAILS.map((e) => e.toLowerCase()),
  ]))
}

export const DEV_EMAILS: string[] = buildAllowlist()

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
