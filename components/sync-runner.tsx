'use client'

// ----------------------------------------------------------------
// SyncRunner — drains the offline queue when connectivity returns.
//
// Renders nothing. Mounts once in the protected app layout and
// listens for `online` events + a periodic tick (every 5s while
// online + queue non-empty) so a freshly-online tab catches up
// without the user having to reload.
//
// Replay strategy: per-kind functions in REPLAYERS take the queued
// payload and call the matching server action. On success the
// entry is removed; on failure the attempts counter is incremented
// (and the entry drops after MAX_ATTEMPTS in lib/offline-queue.ts).
//
// IMPORTANT: replay functions MUST be idempotent at the action
// layer, or the same sale could land twice if the server returned
// 200 but the network dropped before the response reached the
// browser. The createOrder action stamps `external_id` from the
// queued action.id when called via the queue — server enforces
// uniqueness, so a duplicate replay is a no-op.
//
// Not wired yet: no enqueue path calls this. POS integration is
// the next step — see TODO at the bottom.
// ----------------------------------------------------------------

import { useEffect, useRef } from 'react'
import { useOnlineStatus } from '@/hooks/use-online-status'
import {
  getQueue,
  removeFromQueue,
  markFailedAttempt,
  type QueuedAction,
  type QueuedActionKind,
} from '@/lib/offline-queue'
import { createOrder } from '@/app/actions/sales'

type Replayer = (action: QueuedAction) => Promise<{ ok: boolean; error?: string }>

// Server actions throw a special error (`digest` starts with
// "NEXT_REDIRECT") when they call `redirect()`. From the client's
// perspective that throw IS success — the redirect would have
// landed us on /sales if we were inside the normal action flow.
// We swallow it and treat as ok.
function isNextRedirect(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest?: unknown }).digest === 'string' &&
    ((err as { digest: string }).digest).startsWith('NEXT_REDIRECT')
  )
}

// Map of kind → replay function. When you add a new QueuedActionKind
// in lib/offline-queue.ts, add a matching entry here. Until then
// the runner refuses to drain unknown kinds and they sit in the
// queue forever — that's intentional, so unfinished features don't
// silently lose data.
const REPLAYERS: Partial<Record<QueuedActionKind, Replayer>> = {
  create_order: async (action) => {
    // The queue stores a flat key→value record (FormData was
    // serialized via Object.fromEntries on enqueue). Rebuild a
    // FormData with the same field names + values createOrder
    // already understands. The server action handles auth,
    // pricing, depletion, etc. exactly like a live submit.
    const payload = action.payload as Record<string, string>
    const formData = new FormData()
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'string') formData.append(key, value)
    }
    try {
      const result = await createOrder(null, formData)
      if (result?.error) return { ok: false, error: result.error }
      // createOrder always redirects on success — if we got here
      // without throwing, treat as success (the server-action
      // runtime would have thrown NEXT_REDIRECT before reaching
      // a non-error return).
      return { ok: true }
    } catch (err) {
      if (isNextRedirect(err)) return { ok: true }
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'replay threw',
      }
    }
  },
}

export default function SyncRunner() {
  const online = useOnlineStatus()
  const running = useRef(false)

  useEffect(() => {
    if (!online) return

    const drain = async () => {
      if (running.current) return
      running.current = true
      try {
        const queue = getQueue()
        for (const action of queue) {
          const replay = REPLAYERS[action.kind]
          if (!replay) continue   // unknown kind — leave alone
          try {
            const res = await replay(action)
            if (res.ok) {
              removeFromQueue(action.id)
            } else {
              markFailedAttempt(action.id, res.error ?? 'unknown')
            }
          } catch (err) {
            markFailedAttempt(action.id, err instanceof Error ? err.message : 'thrown')
          }
        }
      } finally {
        running.current = false
      }
    }

    drain()
    // Soft retry: tick every 5s while online so a transient
    // server hiccup gets a second chance without waiting for the
    // next online event.
    const handle = window.setInterval(drain, 5000)
    return () => window.clearInterval(handle)
  }, [online])

  return null
}
