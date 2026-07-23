'use server'

// ----------------------------------------------------------------
// GoDaddy Poynt — webhook re-registration
//
// The install-time webhook registration is fire-and-forget; if it
// silently failed (endpoint mismatch, permission gap, whatever),
// the merchant is connected but no real-time push arrives — sync
// still works via the manual "Sync now" button + external cron.
//
// This owner-only action calls the registration helper again
// against the currently-stored token and returns a plain
// success/error the Settings UI can render. Successful
// registration overwrites webhook_id + webhook_secret on the
// token row so incoming events verify against the fresh secret.
// ----------------------------------------------------------------

import { getAuthContext } from '@/lib/auth'
import { getStoredToken, getValidAccessToken } from '@/lib/godaddy/tokens'
import { registerMerchantWebhook, deleteMerchantWebhook } from '@/lib/godaddy/webhooks'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'

export async function reregisterGodaddyWebhook(): Promise<
  | { ok: true; businessId: string }
  | { error: string }
> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  if (ctx.role !== 'owner') return { error: 'Only the owner can re-register the webhook.' }

  const stored = await getStoredToken(ctx.restaurantId)
  if (!stored) return { error: 'No GoDaddy Commerce connection found. Connect first.' }

  // Use a fresh access token in case the stored one is about to
  // expire — Poynt rejects requests with expired bearers.
  const tok = await getValidAccessToken(ctx.restaurantId)
  if ('error' in tok) return { error: tok.error }

  // Same URL shape the OAuth callback route registers with. The
  // env var wins so preview / dev deployments target the right
  // origin instead of hard-coding onchecked.app.
  const origin = process.env.NEXT_PUBLIC_SITE_URL || 'https://onchecked.app'
  const deliveryUrl = `${origin}/api/godaddy/webhooks`

  const result = await registerMerchantWebhook({
    restaurantId: ctx.restaurantId,
    businessId: stored.businessId,
    accessToken: tok.accessToken,
    deliveryUrl,
  })
  if ('error' in result) return { error: result.error }

  revalidatePath('/settings')
  return { ok: true, businessId: stored.businessId }
}

// ----------------------------------------------------------------
// disconnectGodaddy — owner-only, destructive.
//
// Wipes the local godaddy_poynt_tokens row so the merchant appears
// as "not connected" in Settings and can go through the OAuth
// flow fresh. Also best-effort deletes the webhook registration
// on Poynt's side so we don't leave a dangling hook pointing at
// our URL — but a failure there doesn't block the local wipe;
// clearing the local row is the important half.
//
// Why merchants might need this:
//   • Poynt's stored subscription got out of sync with our
//     webhook_secret (registration went stale, wrong scope) and
//     the cleanest reset is a fresh install.
//   • Merchant is troubleshooting webhook delivery and needs to
//     confirm re-registration wires up correctly.
//   • Ownership of the Poynt account changed and the new operator
//     wants a fresh consent flow.
//
// This does NOT touch imported orders — those stay in the DB as
// historical sales. If a re-connect happens, dedupe by external_id
// prevents any re-fetch from double-inserting.
// ----------------------------------------------------------------

export async function disconnectGodaddy(): Promise<
  | { ok: true; hookDeleted: boolean; note?: string }
  | { error: string }
> {
  const { context: ctx, error: authError } = await getAuthContext()
  if (authError || !ctx) return { error: authError ?? 'Authentication error.' }
  if (ctx.role !== 'owner') return { error: 'Only the owner can disconnect an external provider.' }

  const stored = await getStoredToken(ctx.restaurantId)
  if (!stored) return { error: 'No GoDaddy Commerce connection found.' }

  // Best-effort webhook cleanup on Poynt's side. Skipped if we
  // don't have a hookId (registration never persisted one) or if
  // the token exchange fails (expired refresh, revoked, etc.).
  let hookDeleted = false
  let note: string | undefined
  if (stored.webhookId) {
    const tok = await getValidAccessToken(ctx.restaurantId)
    if ('error' in tok) {
      note = `Local disconnect complete; Poynt hook cleanup skipped: ${tok.error}`
    } else {
      const del = await deleteMerchantWebhook({
        hookId: stored.webhookId,
        accessToken: tok.accessToken,
      })
      if ('error' in del) {
        note = `Local disconnect complete; Poynt hook cleanup failed: ${del.error}`
      } else {
        hookDeleted = true
      }
    }
  }

  // Wipe the token row. Cascade rules on other tables (menu_items,
  // orders, order_items) do NOT drop imported sales history — the
  // restaurant keeps its ledger intact.
  const admin = createAdminClient()
  const { error: delErr } = await admin
    .from('godaddy_poynt_tokens')
    .delete()
    .eq('restaurant_id', ctx.restaurantId)
    .eq('business_id', stored.businessId)
  if (delErr) return { error: `Local disconnect failed: ${delErr.message}` }

  revalidatePath('/settings')
  return { ok: true, hookDeleted, note }
}
