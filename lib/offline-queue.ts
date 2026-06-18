// ----------------------------------------------------------------
// Offline action queue
//
// When the kiosk is offline (or the server action fails for
// network reasons), the caller serializes the action into
// localStorage so it survives a reload + can be replayed when
// connectivity returns. The current implementation is intentionally
// minimal — IndexedDB + service workers are overkill until pilots
// hit it in real life:
//
//   • Single FIFO queue per device, stored under one localStorage key
//   • Each entry: { id, kind, payload, queuedAt, attempts, lastError? }
//   • Replay layer (sync-runner) iterates oldest-first and calls
//     a replay function by `kind` — `create_order`, `update_inv`, …
//
// Failure modes the queue does NOT cover yet:
//   • Long device outage > 5MB of queued data (localStorage quota)
//   • Conflict resolution when the same item ran out while offline
//   • Cross-tab coordination (each tab has its own queue)
//
// These are acceptable for now — pilots will run on one iPad, with
// the queue empty 99% of the time. Document the gaps and move on.
//
// SSR safety: every export guards `typeof window` so importing
// this from a Server Component doesn't explode the build.
// ----------------------------------------------------------------

const STORAGE_KEY = 'checked.offline_queue.v1'
const MAX_ATTEMPTS = 8

export type QueuedActionKind =
  | 'create_order'
  // Add new replayable action kinds here. The sync runner needs a
  // matching entry in REPLAYERS (sync-runner.tsx) for each.

export interface QueuedAction<P = unknown> {
  id: string
  kind: QueuedActionKind
  payload: P
  queuedAt: number      // Date.now() when enqueued
  attempts: number
  lastError?: string
}

function safeRead(): QueuedAction[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as QueuedAction[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Corrupted payload — start clean. We'd rather drop a queue
    // than crash on every page load.
    return []
  }
}

function safeWrite(actions: QueuedAction[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(actions))
  } catch {
    // Quota exceeded or storage unavailable — silently drop. A real
    // implementation would surface this via the banner.
  }
}

// Generates a sortable id. We use `${Date.now()}-${random}` rather
// than crypto.randomUUID() so the id sorts by enqueue time even
// when the system clock is the only thing available offline.
function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function enqueueAction<P>(kind: QueuedActionKind, payload: P): QueuedAction<P> {
  const action: QueuedAction<P> = {
    id: makeId(),
    kind,
    payload,
    queuedAt: Date.now(),
    attempts: 0,
  }
  const current = safeRead()
  safeWrite([...current, action as QueuedAction])
  return action
}

export function getQueue(): QueuedAction[] {
  return safeRead()
}

export function getQueueLength(): number {
  return safeRead().length
}

export function removeFromQueue(id: string): void {
  const current = safeRead()
  safeWrite(current.filter((a) => a.id !== id))
}

export function markFailedAttempt(id: string, error: string): void {
  const current = safeRead()
  safeWrite(
    current
      .map((a) =>
        a.id === id
          ? { ...a, attempts: a.attempts + 1, lastError: error }
          : a,
      )
      // Drop entries that have exhausted their attempts. Without
      // this a permanently-bad payload (e.g. a sale referencing a
      // menu item the owner deleted) would block the entire queue
      // forever.
      .filter((a) => a.attempts < MAX_ATTEMPTS),
  )
}

export function clearQueue(): void {
  safeWrite([])
}
