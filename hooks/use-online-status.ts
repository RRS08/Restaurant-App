'use client'

// ----------------------------------------------------------------
// useOnlineStatus — connectivity hook for the kiosk.
//
// Returns a boolean that flips when the browser fires online /
// offline events. Honest about its limitations: `navigator.onLine`
// reports whether a network adapter is up, not whether your server
// is reachable. A real "is Supabase reachable?" check would
// heartbeat against an endpoint every few seconds. We'll layer
// that on once we wire the actual queue replay — for now this is
// the cheap signal the banner needs.
// ----------------------------------------------------------------

import { useEffect, useState } from 'react'

export function useOnlineStatus(): boolean {
  // SSR-safe initial value. navigator is undefined during the
  // server render, so default to "online" — the worst case is a
  // brief flash of "online" before the client hydration corrects
  // it, which is far less alarming than a flash of "offline".
  const [online, setOnline] = useState(true)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  return online
}
