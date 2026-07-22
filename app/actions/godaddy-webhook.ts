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
import { registerMerchantWebhook } from '@/lib/godaddy/webhooks'
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
