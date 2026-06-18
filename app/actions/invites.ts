'use server'

// ----------------------------------------------------------------
// Invite codes — server actions
//
// Two audiences hit this file:
//
//   1. Dev (via /dev-tools/InviteCodesCard) — create / list / revoke
//      codes. Every action checks isDevEmail() before touching the
//      table. The table itself is RLS-locked-down; access is only
//      ever through the admin client here.
//
//   2. Signup (via app/actions/auth.signup) — validate + consume a
//      code as part of account creation. validateAndConsumeInviteCode
//      is the one entry-point the auth flow calls; it returns ok
//      or a user-facing error string.
//
// Code format: 8 uppercase alphanumeric chars in two dash-separated
// groups (e.g., `XB7K-3MWQ`). We omit ambiguous characters (0, O,
// 1, I, L) so handing a code over by phone doesn't turn into "is
// that a zero or a letter O" theater.
// ----------------------------------------------------------------

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isDevEmail } from '@/lib/dev'

// Characters used in generated codes. No 0/O/1/I/L on purpose.
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

function generateCode(): string {
  let raw = ''
  for (let i = 0; i < 8; i++) {
    raw += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  // Format as XXXX-XXXX for readability
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`
}

// Normalize a user-entered code: uppercase, strip spaces, allow
// dashes either way. So "xb7k 3mwq" and "XB7K-3MWQ" both land on
// the same canonical value.
function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '').replace(/^([0-9A-Z]{4})-?([0-9A-Z]{4})$/, '$1-$2')
}

async function requireDev(): Promise<
  | { ok: true; userId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }
  if (!isDevEmail(user.email)) return { ok: false, error: 'Dev only.' }
  return { ok: true, userId: user.id }
}

// ----------------------------------------------------------------
// createInviteCode — mint a new code with optional notes/expiry.
// Loops on collision (extremely unlikely with 31^8 = ~852 billion
// possibilities, but cheap to guard against).
// ----------------------------------------------------------------
export async function createInviteCode(
  prevState: { error?: string; code?: string } | null,
  formData: FormData,
): Promise<{ error?: string; code?: string }> {
  const dev = await requireDev()
  if (!dev.ok) return { error: dev.error }

  const notes = (formData.get('notes') as string | null)?.trim() || null
  const maxUsesRaw = formData.get('max_uses') as string | null
  const expiresInDaysRaw = formData.get('expires_in_days') as string | null

  const maxUses = maxUsesRaw ? Math.max(1, parseInt(maxUsesRaw, 10) || 1) : 1
  const expiresInDays = expiresInDaysRaw ? parseInt(expiresInDaysRaw, 10) : 0
  const expiresAt = expiresInDays > 0
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null

  const admin = createAdminClient()

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode()
    const { error } = await admin.from('invite_codes').insert({
      code,
      notes,
      max_uses: maxUses,
      used_count: 0,
      expires_at: expiresAt,
      created_by_user_id: dev.userId,
    })
    if (!error) {
      revalidatePath('/dev-tools')
      return { code }
    }
    // 23505 = unique_violation. Retry with a fresh random code.
    if (error.code !== '23505') {
      return { error: `Could not create code: ${error.message}` }
    }
  }
  return { error: 'Could not generate a unique code after 5 tries.' }
}

// ----------------------------------------------------------------
// listInviteCodes — for the dev-tools card. Returns codes with
// their consumption + expiry state. Newest first.
// ----------------------------------------------------------------
export interface InviteCodeRow {
  id: string
  code: string
  notes: string | null
  maxUses: number
  usedCount: number
  expiresAt: string | null
  createdAt: string
  status: 'active' | 'consumed' | 'expired'
}

export async function listInviteCodes(): Promise<{ codes: InviteCodeRow[]; error?: string }> {
  const dev = await requireDev()
  if (!dev.ok) return { codes: [], error: dev.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('invite_codes')
    .select('id, code, notes, max_uses, used_count, expires_at, created_at')
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) return { codes: [], error: error.message }

  const now = Date.now()
  const codes: InviteCodeRow[] = (data ?? []).map((r) => {
    const maxUses = r.max_uses as number
    const usedCount = r.used_count as number
    const expiresAt = (r.expires_at as string | null) ?? null
    const expired = expiresAt !== null && new Date(expiresAt).getTime() < now
    const consumed = usedCount >= maxUses
    const status: InviteCodeRow['status'] = expired ? 'expired' : consumed ? 'consumed' : 'active'
    return {
      id: r.id as string,
      code: r.code as string,
      notes: (r.notes as string | null) ?? null,
      maxUses,
      usedCount,
      expiresAt,
      createdAt: r.created_at as string,
      status,
    }
  })
  return { codes }
}

// ----------------------------------------------------------------
// revokeInviteCode — delete a code so it can never be consumed.
// Keeps the rest of the audit trail intact (we don't soft-delete
// because there's no foreign key dependency).
// ----------------------------------------------------------------
export async function revokeInviteCode(id: string): Promise<{ error?: string; ok?: boolean }> {
  const dev = await requireDev()
  if (!dev.ok) return { error: dev.error }

  const admin = createAdminClient()
  const { error } = await admin.from('invite_codes').delete().eq('id', id)
  if (error) return { error: error.message }
  revalidatePath('/dev-tools')
  return { ok: true }
}

// ----------------------------------------------------------------
// validateAndConsumeInviteCode — called by the signup action right
// before creating the auth user. Returns ok if the code is valid
// and atomically increments used_count. Returns a user-facing
// error otherwise.
//
// Note: this uses the admin client because the table is RLS-locked.
// The signup action is also unauthenticated at the call moment
// (the user account doesn't exist yet), so there's no auth context
// to enforce RLS against anyway.
// ----------------------------------------------------------------
export async function validateAndConsumeInviteCode(
  rawCode: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!rawCode || rawCode.trim().length === 0) {
    return { ok: false, error: 'An invite code is required.' }
  }

  const code = normalizeCode(rawCode)
  if (!/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code)) {
    return { ok: false, error: 'That doesn’t look like a valid invite code.' }
  }

  const admin = createAdminClient()
  const { data: row, error: lookupErr } = await admin
    .from('invite_codes')
    .select('id, max_uses, used_count, expires_at')
    .eq('code', code)
    .maybeSingle()

  if (lookupErr) return { ok: false, error: 'Could not check that code right now.' }
  if (!row) return { ok: false, error: 'That code isn’t valid.' }

  const maxUses = row.max_uses as number
  const usedCount = row.used_count as number
  const expiresAt = row.expires_at as string | null

  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
    return { ok: false, error: 'That code has expired.' }
  }
  if (usedCount >= maxUses) {
    return { ok: false, error: 'That code has already been used.' }
  }

  // Atomic increment — guard against a TOCTOU race where two
  // signups hit the same single-use code simultaneously. We
  // re-check used_count in the WHERE clause; if a parallel signup
  // already incremented it past the cap, this update affects 0
  // rows and we treat it as already-consumed.
  const { error: updateErr, count } = await admin
    .from('invite_codes')
    .update({ used_count: usedCount + 1 }, { count: 'exact' })
    .eq('id', row.id)
    .eq('used_count', usedCount)
    .lt('used_count', maxUses)

  if (updateErr) return { ok: false, error: 'Could not redeem that code.' }
  if (!count || count === 0) {
    return { ok: false, error: 'That code has already been used.' }
  }

  return { ok: true }
}
