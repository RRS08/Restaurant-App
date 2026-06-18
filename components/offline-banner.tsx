'use client'

// ----------------------------------------------------------------
// OfflineBanner — sticky strip across the top of the app surface
// when the kiosk is offline OR when there are queued actions
// waiting to sync.
//
// Three states:
//   1. Online + empty queue → nothing renders
//   2. Online + queue > 0    → calm yellow "Syncing N sale(s)…" strip
//   3. Offline               → red "You're offline" strip with count
//
// The strip is intentionally narrow (h-9-ish) so it doesn't push
// the rest of the layout around — owners need to see their
// dashboard, not a giant warning.
//
// Pairs with <SyncRunner /> which actually drains the queue.
// ----------------------------------------------------------------

import { useEffect, useState } from 'react'
import { WifiOff, RefreshCw } from 'lucide-react'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { getQueueLength } from '@/lib/offline-queue'

export default function OfflineBanner() {
  const online = useOnlineStatus()
  const [queueLength, setQueueLength] = useState(0)

  // Re-read queue length on a short interval. We avoid a global
  // event bus by polling — the queue is tiny and the read is cheap
  // (a JSON.parse over a small string). Once the kiosk has real
  // traffic this can become an event emitter.
  useEffect(() => {
    const tick = () => setQueueLength(getQueueLength())
    tick()
    const handle = window.setInterval(tick, 1500)
    return () => window.clearInterval(handle)
  }, [])

  if (online && queueLength === 0) return null

  if (!online) {
    return (
      <div
        role="status"
        className="bg-red-50 border-b border-red-200 px-4 py-2 flex items-center justify-center gap-2 text-[12px] text-red-800"
      >
        <WifiOff className="w-3.5 h-3.5" />
        <span className="font-semibold">You’re offline.</span>
        <span className="text-red-700">
          Sales will save on this device and sync as soon as the connection is back.
        </span>
        {queueLength > 0 && (
          <span className="font-mono text-[11px] text-red-700 ml-1">
            {queueLength} waiting
          </span>
        )}
      </div>
    )
  }

  // Online + queue > 0 → syncing strip
  return (
    <div
      role="status"
      className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-center gap-2 text-[12px] text-amber-900"
    >
      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
      <span className="font-semibold">Syncing {queueLength} item{queueLength === 1 ? '' : 's'}…</span>
    </div>
  )
}
