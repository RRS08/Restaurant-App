'use client'

// ----------------------------------------------------------------
// POS Client — Native checkout surface.
//
// Left:   category strip + item grid (availability-aware tiles)
// Right:  current order → totals → payment method → payment workflow
//
// Payment method drives the lower workflow:
//   • Cash  → received-amount entry, quick tender, change-due, commit
//   • Card  → "Charge card" → ready/prompt → confirm to commit
//             (state shell prepared for a future processor)
//   • Other → minimal manual commit
//
// All paths submit through the same `createOrder` server action:
//   source         = 'native_pos'
//   payment_type   = cash | card | other
//   payment_status = 'paid'
//   status         = 'completed'
//   redirect_to    = '/pos'
// ----------------------------------------------------------------

import { useState, useMemo, useActionState, useEffect, useRef, useTransition } from 'react'
import { createOrder } from '@/app/actions/sales'
import { useSearchParams, useRouter } from 'next/navigation'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { enqueueAction } from '@/lib/offline-queue'
import { createTerminalPaymentIntent } from '@/app/actions/payments'
import { makeT, type Lang } from '@/lib/i18n'
import {
  type EffectiveSellability,
  type ProjectionState,
} from '@/lib/menu/availability'

// ================================================================
// Domain
// ================================================================

interface Category {
  id: string
  name: string
  /** Non-null when this is a sub-category. Bands layout groups
   *  sub-categories under their parent tab; phone keeps flat. */
  parentId: string | null
}
interface Item {
  id: string
  name: string
  price: number
  categoryId: string | null
  effectiveSellability: EffectiveSellability
  projectedCount: number | null
  projectionState: ProjectionState
}
interface CartLine {
  /** Per-line unique identifier (UUID). Every click on a menu tile
   *  creates a new cart line — two Cheeseburgers can sit side by
   *  side with different notes/modifiers/quantities — so we can't
   *  identify lines by `itemId` anymore. Generated on add via
   *  crypto.randomUUID(); never reaches the server (the server still
   *  only sees aggregated { menu_item_id, total_quantity } below). */
  lineId: string
  itemId: string
  name: string
  price: number
  quantity: number
  /** UI-only — captured by the Order item drawer. Not yet sent to
   *  createOrder; the action contract still only takes
   *  menu_item_id + quantity. Stored on the cart line so the drawer
   *  can round-trip the value while the order is being built. */
  notes?: string
  /** UI-only — placeholder for the future add-on / customization
   *  flow. The drawer surfaces a "coming soon" panel today but the
   *  field is in place so wiring is ready when the data model lands. */
  modifiers?: string[]
}

type PaymentType = 'cash' | 'card' | 'other'

/**
 * Stripe Terminal card-present workflow stages.
 *
 * The UI follows the real Terminal SDK lifecycle:
 *   idle        — default, "Charge card" button visible
 *   connecting  — SDK loading + reader discovery + connect in flight
 *   ready       — reader connected, server intent created, waiting for card
 *   collecting  — terminal.collectPaymentMethod(clientSecret) running
 *   processing  — terminal.processPayment(...) running
 *   approved    — Stripe returned succeeded; finalizing sale on our server
 *   failed      — any error from the SDK, Stripe, or our finalize step
 *   canceled    — cashier hit Cancel during collection
 *
 * Lives inside CardWorkflow now — the parent no longer needs to track it.
 */
type TerminalStage =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'collecting'
  | 'processing'
  | 'approved'
  | 'failed'
  | 'canceled'

const CURRENCY = (n: number) => `$${n.toFixed(2)}`

// ================================================================
// Bands (tablet md+) design tokens. Prefixed B_ so they never
// collide with future imports or the existing Tailwind layout.
// ================================================================
const B_INK = '#18181B'
const B_PAPER = '#FAF9F6'
const B_LINE = '#E7E6E2'
const B_LINE_SOFT = '#F0EFEB'
const B_SURFACE = '#FAFAF9'
const B_FILL = '#F4F4F2'
const B_MUTED = '#6B6B70'
const B_FAINT = '#A1A1A6'
const B_GHOST = '#C4C4C7'
const B_MONO = "'Geist Mono', ui-monospace, monospace"

// Per-line unique id for cart rows. Each click on a menu tile
// generates a fresh one so two identical base items can live as
// separate lines with their own notes/modifiers/quantities.
// crypto.randomUUID exists in every modern browser and in Node ≥
// 14.17; the Math.random fallback is enough for ephemeral
// client-only cart ids if the API ever isn't available.
function makeLineId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `line-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// ================================================================
// Quick tender helper.
//
// Generates a short list of likely cash hand-offs for a given total:
// exact, next dollar, next $5, next $10, next $20 — deduped, capped
// at 4 buttons. Real-world cash flows almost always land in this set.
// ================================================================
function quickTenderAmounts(total: number): number[] {
  if (total <= 0) return []
  const result: number[] = []
  // Always offer "exact change" so the cashier can one-tap close it.
  result.push(Math.round(total * 100) / 100)
  const candidates = [
    Math.ceil(total),
    Math.ceil(total / 5) * 5,
    Math.ceil(total / 10) * 10,
    Math.ceil(total / 20) * 20,
  ]
  for (const c of candidates) {
    if (c > result[result.length - 1] && result.length < 4) {
      result.push(c)
    }
  }
  return result
}

// ================================================================
// Root component
// ================================================================

export default function PosClient({
  categories,
  items,
  operatingMode = null,
  kioskMode = false,
  lang,
}: {
  categories: Category[]
  items: Item[]
  operatingMode?: 'native_pos' | 'external_pos' | null
  /** True when the device is in staff kiosk mode (locked to /pos).
   *  The (app) layout's kiosk frame already shows brand + restaurant
   *  identity at the top, so we hide PosClient's internal "POS /
   *  Ring up a sale." header to avoid the redundancy and free up
   *  vertical space for the menu grid. */
  kioskMode?: boolean
  lang: Lang
}) {
  const t = makeT(lang)
  const [activeCategoryId, setActiveCategoryId] = useState<string | 'all'>(
    categories[0]?.id ?? 'all'
  )
  const [cart, setCart] = useState<CartLine[]>([])
  const [paymentType, setPaymentType] = useState<PaymentType>('cash')
  const [state, action, pending] = useActionState(createOrder, null)
  const [confirmation, setConfirmation] = useState<string | null>(null)

  // Sale-success celebration. createOrder ends with a server-side
  // redirect to /pos on success — the redirect destroys the
  // confirmation state we'd otherwise set client-side. To keep the
  // reward animation visible across that hop, we encode the sold
  // amount in the redirect URL (`?sold=12.50`) and read it here on
  // the next render. The router.replace then strips the param so
  // refreshing the page doesn't replay the celebration.
  const searchParams = useSearchParams()
  const router = useRouter()
  useEffect(() => {
    const sold = searchParams.get('sold')
    if (!sold) return
    const amount = parseFloat(sold)
    if (Number.isFinite(amount) && amount > 0) {
      setConfirmation(`${t('Sale complete', 'Venta completada')} · ${CURRENCY(amount)}`)
      const timer = setTimeout(() => setConfirmation(null), 3000)
      router.replace('/pos')
      return () => clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Offline-aware cash submit. When the kiosk has no connection we
  // refuse to even try the server action and instead serialize the
  // payload into the offline queue. SyncRunner replays it when the
  // connection returns. Card / Stripe Terminal still require a live
  // connection (you can't authorize a card without the network), so
  // only cash benefits from this path. See lib/offline-queue.ts.
  const online = useOnlineStatus()

  // Workflow state per payment method. Reset on payment-type change
  // so switching between Cash and Card never carries leftover input.
  // (Card stage is now internal to CardWorkflow — when the user
  // switches payment type, the conditional render unmounts the
  // workflow component, which naturally clears its state.)
  const [cashReceivedRaw, setCashReceivedRaw] = useState('')

  // Checkout-drawer open state. Native POS is now a two-phase flow:
  //   1. Build the order in the right rail (no payment UI visible).
  //   2. Click "Continue to payment" → opens this drawer with the
  //      payment-method selector + per-method workflow (cash / card
  //      / other). Keeps the order-building surface clean and stops
  //      the cashier from staring at payment controls before the
  //      order is even ready.
  const [checkoutOpen, setCheckoutOpen] = useState(false)

  // Order item drawer — opens when the cashier clicks a cart row to
  // edit that specific line item (quantity, notes, modifiers, or
  // remove). Identified by the cart line's `itemId` so the drawer
  // can read live from the cart state and auto-close if the row
  // gets removed.
  const [editingLineId, setEditingLineId] = useState<string | null>(null)

  // Bands (md+) tablet layout. Below md the existing chip + grid
  // renders unchanged. At md+ the return branches into a full-height
  // shell (header band + drag-scroll rail + item grid + right-side
  // order column). All checkout wiring (createOrder, Stripe Terminal,
  // offline queue, kiosk mode, confetti) is preserved — bands just
  // re-skins the ordering surface.
  const [isBands, setIsBands] = useState(false)
  const [bandsTabId, setBandsTabId] = useState<string | null>(null)
  const [bandsQuery, setBandsQuery] = useState('')
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(min-width: 768px)')
    const update = () => setIsBands(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // ----------------------------------------------------------------
  // Success effect.
  //
  // The form submits via the createOrder server action; on success
  // we clear the cart, reset every per-payment workflow state, and
  // flash a confirmation pill. The transition is detected by
  // pending falling from true → false without an error in the
  // returned action state.
  // ----------------------------------------------------------------
  const wasPendingRef = useRef(false)
  const lastSubtotalRef = useRef(0)
  useEffect(() => {
    if (pending) lastSubtotalRef.current = cart.reduce((s, l) => s + l.price * l.quantity, 0)
    if (wasPendingRef.current && !pending && !state?.error) {
      setCart([])
      setPaymentType('cash')
      setCashReceivedRaw('')
      setCheckoutOpen(false)
      setConfirmation(`${t('Sale complete', 'Venta completada')} · ${CURRENCY(lastSubtotalRef.current)}`)
      const dismissTimer = setTimeout(() => setConfirmation(null), 2000)
      return () => clearTimeout(dismissTimer)
    }
    wasPendingRef.current = pending
  }, [pending, state, cart])

  // Offline cash commit — runs the same reset + flash sequence as
  // the success effect above, but driven by the offline branch
  // synchronously instead of waiting for the server-action pending
  // state to transition. The confirmation copy explicitly mentions
  // the device queue so the cashier knows it didn't actually post.
  const commitOfflineSale = (subtotal: number) => {
    setCart([])
    setPaymentType('cash')
    setCashReceivedRaw('')
    setCheckoutOpen(false)
    setConfirmation(`${t('Saved on device', 'Guardado en el dispositivo')} · ${CURRENCY(subtotal)} · ${t('will sync when online', 'se sincronizará cuando vuelva la conexión')}`)
    setTimeout(() => setConfirmation(null), 3500)
  }

  // Reset payment-specific workflow on type change so switching
  // doesn't leave a stale cash-received value visible under the
  // card workflow (or vice versa).
  useEffect(() => {
    setCashReceivedRaw('')
  }, [paymentType])

  const visibleItems = useMemo(() => {
    if (activeCategoryId === 'all') return items
    return items.filter((i) => i.categoryId === activeCategoryId)
  }, [items, activeCategoryId])

  const subtotal = useMemo(() => cart.reduce((s, l) => s + l.price * l.quantity, 0), [cart])

  // Every tap on a menu tile creates a NEW cart line (no merging).
  // Two guests can order the same base item with different
  // customizations; smart merging by (menu_item_id + modifiers +
  // notes) is a future enhancement. For pilot, the simple rule
  // wins: one click → one line.
  const addItem = (item: Item) => {
    setCart((p) => [
      ...p,
      {
        lineId: makeLineId(),
        itemId: item.id,
        name: item.name,
        price: item.price,
        quantity: 1,
      },
    ])
  }

  const changeQty = (lineId: string, delta: number) => {
    setCart((p) => p
      .map((l) => l.lineId === lineId ? { ...l, quantity: l.quantity + delta } : l)
      .filter((l) => l.quantity > 0))
  }

  const removeLine = (lineId: string) => {
    setCart((p) => p.filter((l) => l.lineId !== lineId))
  }

  // Generic patch for a cart line — used by the Order item drawer
  // to update notes / modifiers without conflating with the qty +/-
  // semantics already covered by changeQty.
  const updateLine = (lineId: string, patch: Partial<CartLine>) => {
    setCart((p) => p.map((l) => l.lineId === lineId ? { ...l, ...patch } : l))
  }

  const clearCart = () => setCart([])

  // Resolve the currently-edited cart line. Auto-clears when the
  // line is removed (so the drawer closes naturally instead of
  // pointing at a stale id).
  const editingLine = useMemo(
    () => cart.find((l) => l.lineId === editingLineId) ?? null,
    [cart, editingLineId],
  )
  useEffect(() => {
    if (editingLineId && !editingLine) {
      setEditingLineId(null)
    }
  }, [editingLineId, editingLine])

  // Serialized payload for the server action.
  //
  // Cart lines are kept separate in the UI (each click = a new
  // line) so two guests can attach different notes/modifiers to the
  // same base menu item. For the wire format we aggregate by
  // menu_item_id and sum quantities so:
  //   • the server contract stays unchanged ({menu_item_id, quantity})
  //   • inventory depletion sees the total quantity per item
  //   • order_items records one row per unique menu item with the
  //     correct total quantity
  // Notes/modifiers don't reach the server in this pass — they're
  // captured client-side only per the prior pass.
  const lineItemsJson = useMemo(() => {
    const byItem = new Map<string, number>()
    for (const line of cart) {
      byItem.set(line.itemId, (byItem.get(line.itemId) ?? 0) + line.quantity)
    }
    return JSON.stringify(
      Array.from(byItem.entries()).map(([menu_item_id, quantity]) => ({
        menu_item_id,
        quantity,
      })),
    )
  }, [cart])

  const cartItemCount = cart.reduce((s, l) => s + l.quantity, 0)

  // -------- bands (md+) derivations -----------------------------
  // Top-level categories = tabs. Each tab covers its own id + its
  // sub-categories' ids. A tab covering more than one key renders
  // dotted section headers between the groups so the hierarchy
  // reads without a second row of chips (spec §3).
  const topLevelCats = categories.filter((c) => !c.parentId)
  const kidsOf = (parentId: string) => categories.filter((c) => c.parentId === parentId)
  const bandsTabs: Array<{ id: string; name: string; keys: string[] }> = topLevelCats.map((c) => ({
    id: c.id,
    name: c.name,
    keys: [c.id, ...kidsOf(c.id).map((k) => k.id)],
  }))
  const activeBandsTab = bandsTabs.find((t) => t.id === bandsTabId) ?? bandsTabs[0] ?? null

  // Bands cart-line quantity by item id. Bands consolidates lines
  // per menu item (one line per item id, +/- stepper). Phone keeps
  // its per-tap-per-line behaviour so notes/modifier lines don't
  // collapse across taps.
  const bandsQtyOf = (itemId: string) => cart.reduce((n, l) => l.itemId === itemId ? n + l.quantity : n, 0)
  const bandsAdd = (item: Item) => {
    setCart((p) => {
      // Bump the first line that has the same itemId (no notes).
      // If any exists with notes/modifiers, we still stack onto a
      // clean one first — the drawer per-line editor is phone-only,
      // so at bands there should be at most one line per itemId.
      const i = p.findIndex((l) => l.itemId === item.id && !l.notes && !l.modifiers?.length)
      if (i > -1) return p.map((l, j) => j === i ? { ...l, quantity: l.quantity + 1 } : l)
      return [...p, {
        lineId: makeLineId(), itemId: item.id, name: item.name, price: item.price, quantity: 1,
      }]
    })
  }
  const bandsBump = (itemId: string, by: number) => {
    setCart((p) => {
      // Bump the first matching line; if that would zero it, drop
      // every line with that itemId (consolidated view had one).
      const i = p.findIndex((l) => l.itemId === itemId)
      if (i < 0) return p
      const next = p[i].quantity + by
      if (next <= 0) return p.filter((l) => l.itemId !== itemId)
      return p.map((l, j) => j === i ? { ...l, quantity: next } : l)
    })
  }

  // Search spans the whole (already price>0) catalogue. Otherwise
  // items are grouped by category key inside the active tab.
  const bandsQ = bandsQuery.trim().toLowerCase()
  const bandsSections: Array<{ label: string; items: Item[] }> = bandsQ
    ? [{
        label: t('Results', 'Resultados'),
        items: items.filter((i) => i.name.toLowerCase().includes(bandsQ)),
      }]
    : (activeBandsTab
        ? activeBandsTab.keys.map((k) => ({
            label: categories.find((c) => c.id === k)?.name ?? '',
            items: items.filter((i) => i.categoryId === k),
          })).filter((s) => s.items.length > 0)
        : [])
  const bandsMultiSections = bandsSections.length > 1

  return (
    <div className={isBands ? '' : 'max-w-[1400px] h-full relative'} style={isBands ? { height: '100vh', display: 'flex', flexDirection: 'column', minHeight: 0, background: '#fff', color: B_INK, fontFamily: "'Geist', system-ui, sans-serif" } : undefined}>
      {/* Payment-complete reward overlay.
          The "did it!" moment. We want the cashier — and the
          customer watching from the other side of the counter — to
          feel a real spike of completion. Three layered effects:
            1. A backdrop blur dims the world so the celebration is
               undeniably foreground.
            2. A 144px green check disc scales in with a spring
               overshoot, framed by THREE staggered pulse rings.
            3. ~32 confetti pieces fall + rotate from above the
               check in green / amber / pink / sky-blue, randomized
               via inline transforms so each render varies slightly.
          Below the check, the sale total renders at 56px tabular
          mono — large enough to read from across the floor. The
          whole sequence holds for 3 seconds before the wrapping
          effect clears `confirmation` and the page returns to
          neutral. Inline keyframes so we don't have to edit
          globals.css. */}
      {confirmation && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/55 backdrop-blur-sm pointer-events-none overflow-hidden"
          role="status"
          aria-live="polite"
        >
          <style>{`
            @keyframes posSuccessPop {
              0%   { transform: scale(0.2); opacity: 0; }
              55%  { transform: scale(1.18); opacity: 1; }
              80%  { transform: scale(0.95); }
              100% { transform: scale(1); opacity: 1; }
            }
            @keyframes posSuccessRing {
              0%   { transform: scale(0.55); opacity: 0.7; }
              100% { transform: scale(2.1); opacity: 0; }
            }
            @keyframes posSuccessFadeUp {
              0%   { opacity: 0; transform: translateY(14px) scale(0.96); }
              100% { opacity: 1; transform: translateY(0) scale(1); }
            }
            @keyframes posConfettiFall {
              0%   { transform: translate3d(0,-40vh,0) rotate(0deg); opacity: 1; }
              80%  { opacity: 1; }
              100% { transform: translate3d(var(--fx, 0), 60vh, 0) rotate(var(--fr, 540deg)); opacity: 0; }
            }
            @keyframes posCheckDraw {
              0%   { stroke-dashoffset: 30; }
              100% { stroke-dashoffset: 0; }
            }
          `}</style>

          {/* Confetti layer. 32 colored squares scattered across the
              viewport width with randomized fall trajectory + rotation. */}
          <div className="absolute inset-0 pointer-events-none">
            {Array.from({ length: 32 }).map((_, i) => {
              const palette = ['#22C55E', '#F59E0B', '#EC4899', '#38BDF8', '#A855F7', '#FACC15']
              const color = palette[i % palette.length]
              // Deterministic-by-index pseudo-random so SSR/CSR agree.
              const seed = (i * 9301 + 49297) % 233280
              const r = seed / 233280
              const left = (i * 3.13) % 100
              const delay = (r * 0.5).toFixed(2)
              const duration = (1.2 + r * 1.1).toFixed(2)
              const drift = ((r - 0.5) * 200).toFixed(0)
              const rotate = (380 + r * 720).toFixed(0)
              const size = 8 + Math.round(r * 8)
              return (
                <span
                  key={i}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: `${left}%`,
                    width: size,
                    height: size,
                    background: color,
                    borderRadius: i % 2 === 0 ? 2 : '50%',
                    ['--fx' as string]: `${drift}px`,
                    ['--fr' as string]: `${rotate}deg`,
                    animation: `posConfettiFall ${duration}s cubic-bezier(0.2, 0.6, 0.4, 1) ${delay}s forwards`,
                  } as React.CSSProperties}
                />
              )
            })}
          </div>

          <div className="relative flex flex-col items-center gap-7">
            <div className="relative flex items-center justify-center">
              {/* Pulse rings — three staggered concentric arcs so
                  the eye lands on the disc, then expands outward. */}
              <span
                className="absolute w-40 h-40 rounded-full bg-green-400/30"
                style={{ animation: 'posSuccessRing 1100ms ease-out forwards' }}
              />
              <span
                className="absolute w-40 h-40 rounded-full bg-green-400/25"
                style={{ animation: 'posSuccessRing 1100ms ease-out 200ms forwards' }}
              />
              <span
                className="absolute w-40 h-40 rounded-full bg-green-400/15"
                style={{ animation: 'posSuccessRing 1100ms ease-out 400ms forwards' }}
              />
              {/* Green check disc — 144px, drop shadow tinted green
                  so the glow reads as celebratory rather than neutral. */}
              <span
                className="relative w-36 h-36 rounded-full bg-green-500 shadow-[0_25px_70px_-12px_rgba(34,197,94,0.65)] flex items-center justify-center"
                style={{ animation: 'posSuccessPop 620ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards' }}
              >
                <svg className="w-20 h-20 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3.5}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                    strokeDasharray="30"
                    style={{ animation: 'posCheckDraw 420ms ease-out 200ms backwards' }}
                  />
                </svg>
              </span>
            </div>
            <div
              className="text-center"
              style={{ animation: 'posSuccessFadeUp 420ms cubic-bezier(0.22, 1, 0.36, 1) 320ms backwards' }}
            >
              <p className="text-xs font-mono uppercase tracking-[0.22em] text-white/80 font-semibold">
                {t('Sale complete', 'Venta completada')}
              </p>
              <p className="mt-3 text-[56px] leading-none font-mono tabular-nums font-bold text-white drop-shadow-[0_4px_12px_rgba(0,0,0,0.25)]">
                {confirmation.includes('·')
                  ? confirmation.split('·').slice(1).join('·').trim()
                  : confirmation}
              </p>
              <p className="mt-3 text-[13px] text-white/60 font-medium">
                {t('Nice work.', '¡Buen trabajo!')}
              </p>
            </div>
          </div>
        </div>
      )}

      {isBands ? (
        // ============================================================
        // BANDS (md+) LAYOUT — full-height 2-pane shell. Header band
        // on top, drag-scroll category rail below, item grid + 334px
        // order column filling the rest. Keeps the existing cart /
        // checkout / drawers wiring by delegating to setCart / setCheckoutOpen.
        // ============================================================
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* HEADER BAND — hidden in kiosk mode (external kiosk chrome
              already carries brand + identity). External-POS advisory
              collapses into a chip beside the title (spec §1). */}
          {!kioskMode && (
            <div style={{ padding: '14px 24px 13px', borderBottom: `1px solid ${B_LINE}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap', flex: '0 0 auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: '-0.035em' }}>
                  {t('POS', 'POS')}
                </h1>
                {operatingMode === 'external_pos' && (
                  <span
                    title={t('Your provider is the canonical sales source — use this surface only when needed.', 'Tu proveedor es la fuente principal de ventas — usa esta superficie solo cuando sea necesario.')}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#EEF2FF', color: '#4F46E5', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}
                  >
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#6366F1' }} />
                    {t('Backup register', 'Registro auxiliar')}
                  </span>
                )}
              </div>
              <BandsSearchPill
                total={items.length}
                value={bandsQuery}
                onChange={setBandsQuery}
                placeholder={t('Search', 'Buscar')}
                unit={items.length === 1 ? t('item', 'artículo') : t('items', 'artículos')}
              />
            </div>
          )}

          {/* CATEGORY RAIL — one drag-scrollable row at any count. */}
          <BandsCategoryRail
            tabs={bandsTabs}
            activeId={bandsQuery ? null : (activeBandsTab?.id ?? null)}
            onPick={(id) => { setBandsTabId(id); setBandsQuery('') }}
          />

          {/* ITEM GRID + ORDER COLUMN */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '0 0 20px' }}>
              {bandsSections.length === 0 ? (
                <div style={{ padding: '44px 16px', textAlign: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#52525B' }}>
                    {bandsQuery
                      ? `${t('Nothing matches', 'Nada coincide con')} "${bandsQuery}"`
                      : t('No sellable items here yet.', 'Aún no hay artículos vendibles aquí.')}
                  </div>
                  <div style={{ fontSize: 12, color: B_FAINT, marginTop: 3 }}>
                    {bandsQuery
                      ? t('Try a shorter search, or pick another category.', 'Prueba una búsqueda más corta o elige otra categoría.')
                      : t('Priced items in Menu appear on the register.', 'Los artículos con precio en el Menú aparecen en el registro.')}
                  </div>
                </div>
              ) : (
                bandsSections.map((s, si) => (
                  <div key={`${s.label}-${si}`}>
                    {bandsMultiSections && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 16px 8px', background: '#fff', position: 'sticky', top: 0, zIndex: 2 }}>
                        <span style={{ fontFamily: B_MONO, fontSize: 11, fontWeight: 600, letterSpacing: '0.14em', color: B_INK, flex: '0 0 auto' }}>
                          {s.label.toUpperCase()}
                        </span>
                        <span style={{ flexGrow: 1, flexShrink: 1, flexBasis: '0%', height: 0, borderTop: `1px dotted ${B_INK}` }} />
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, padding: `${bandsMultiSections || si > 0 ? 0 : 14}px 16px 10px` }}>
                      {s.items.map((it) => (
                        <BandsItemCard
                          key={it.id}
                          item={it}
                          inCart={bandsQtyOf(it.id)}
                          onAdd={() => bandsAdd(it)}
                          t={t}
                        />
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* ORDER COLUMN — 334px right rail. */}
            <div style={{ width: 334, flex: '0 0 334px', borderLeft: `1px solid ${B_LINE}`, background: '#fff', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 18px 11px', borderBottom: `1px solid ${B_LINE}`, flex: '0 0 auto' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: B_MONO, fontSize: 10, fontWeight: 600, letterSpacing: '0.16em', color: B_INK }}>
                    {t('CURRENT ORDER', 'PEDIDO ACTUAL')}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 5 }}>
                    <span style={{ fontFamily: B_MONO, fontSize: 19, fontWeight: 600, letterSpacing: '-0.035em', lineHeight: 1 }}>{cartItemCount}</span>
                    <span style={{ fontFamily: B_MONO, fontSize: 11, color: B_FAINT }}>
                      {cartItemCount === 1 ? t('ITEM', 'ARTÍCULO') : t('ITEMS', 'ARTÍCULOS')}
                    </span>
                  </div>
                </div>
                {cart.length > 0 && (
                  <button
                    type="button"
                    onClick={clearCart}
                    style={{ border: `1px solid ${B_LINE}`, background: '#fff', borderRadius: 9, height: 30, padding: '0 11px', fontFamily: 'inherit', fontSize: 12, fontWeight: 500, color: '#3F3F46', cursor: 'pointer', flex: '0 0 auto' }}
                  >
                    {t('Clear', 'Limpiar')}
                  </button>
                )}
              </div>

              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {cart.length === 0 ? (
                  <div style={{ padding: '48px 20px', textAlign: 'center' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 999, background: B_FILL, marginBottom: 12 }}>
                      <BandsCartIcon color={B_FAINT} size={20} />
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#52525B' }}>
                      {t('No items yet', 'Aún no hay artículos')}
                    </div>
                    <div style={{ fontSize: 12, color: B_FAINT, marginTop: 3, lineHeight: 1.5 }}>
                      {t('Tap anything on the left to add it.', 'Toca cualquier cosa a la izquierda para agregarla.')}
                    </div>
                  </div>
                ) : (
                  // Consolidated view — one row per itemId with a
                  // stepper. Lines from the same item id are summed.
                  (() => {
                    const byItem = new Map<string, { name: string; price: number; quantity: number }>()
                    for (const l of cart) {
                      const prev = byItem.get(l.itemId)
                      if (prev) prev.quantity += l.quantity
                      else byItem.set(l.itemId, { name: l.name, price: l.price, quantity: l.quantity })
                    }
                    return Array.from(byItem.entries()).map(([itemId, l]) => (
                      <div key={itemId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', borderBottom: `1px solid ${B_LINE_SOFT}` }}>
                        <span style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
                          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.3 }}>{l.name}</span>
                          <span style={{ display: 'block', fontFamily: B_MONO, fontSize: 11, color: B_FAINT, marginTop: 2 }}>{CURRENCY(l.price)} {t('each', 'c/u')}</span>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 2, background: B_FILL, borderRadius: 9, padding: 2, flex: '0 0 auto' }}>
                          <BandsStepBtn onClick={() => bandsBump(itemId, -1)}>−</BandsStepBtn>
                          <span style={{ minWidth: 24, textAlign: 'center', fontFamily: B_MONO, fontSize: 12, fontWeight: 600 }}>{l.quantity}</span>
                          <BandsStepBtn onClick={() => bandsBump(itemId, 1)}>+</BandsStepBtn>
                        </span>
                        <span style={{ fontFamily: B_MONO, fontSize: 13, fontWeight: 600, minWidth: 52, textAlign: 'right', flex: '0 0 auto' }}>{CURRENCY(l.price * l.quantity)}</span>
                      </div>
                    ))
                  })()
                )}
              </div>

              <div style={{ borderTop: `1px solid ${B_LINE}`, background: B_SURFACE, padding: '12px 18px 14px', flex: '0 0 auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ fontSize: 12, color: B_MUTED }}>{t('Subtotal', 'Subtotal')}</span>
                  <span style={{ fontFamily: B_MONO, fontSize: 12 }}>{CURRENCY(subtotal)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginTop: 8, paddingTop: 9, borderTop: `1px solid ${B_LINE}` }}>
                  <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('Total', 'Total')}</span>
                  <span style={{ fontFamily: B_MONO, fontSize: 26, fontWeight: 600, letterSpacing: '-0.045em', lineHeight: 1 }}>{CURRENCY(subtotal)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => { if (cart.length) setCheckoutOpen(true) }}
                  disabled={cart.length === 0 || pending}
                  style={{
                    width: '100%', marginTop: 12, border: 0, borderRadius: 11, height: 46,
                    fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                    ...(cart.length && !pending
                      ? { background: B_INK, color: B_PAPER, cursor: 'pointer' }
                      : { background: B_LINE_SOFT, color: B_GHOST, cursor: 'default' }),
                  }}
                >
                  {cart.length
                    ? `${t('Take payment', 'Cobrar')} · ${CURRENCY(subtotal)}`
                    : t('Add items to start', 'Agrega artículos para comenzar')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (<>
      {/* Page header — hidden in kiosk mode because the (app) layout's
          kiosk strip already carries the brand + "POS" eyebrow at the
          top of the device. Showing it twice wastes a vertical band
          right where the menu grid wants to live. */}
      {!kioskMode && (
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">{t('POS', 'POS')}</h1>
            <p className="mt-1.5 text-sm text-gray-500">{t('Ring up a sale.', 'Cobra una venta.')}</p>
          </div>
        </div>
      )}

      {operatingMode === 'external_pos' && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-indigo-200/80 bg-indigo-50/60 px-4 py-3">
          <span className="flex-shrink-0 mt-0.5 inline-flex items-center gap-1 text-[10px] font-semibold text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded-full">
            <span className="w-1 h-1 rounded-full bg-indigo-500" />
            {t('External POS', 'POS externo')}
          </span>
          <p className="text-xs text-indigo-800 leading-relaxed">
            {t(
              'Your provider is the canonical sales source — use this surface only when needed.',
              'Tu proveedor es la fuente principal de ventas — usa esta superficie solo cuando sea necesario.',
            )}
          </p>
        </div>
      )}

      {/* iPad landscape (≈1024–1180px main width with sidebar) still
          activates the side-by-side via `lg:`. The right panel
          narrows to 340px between lg and xl so the item grid has
          enough room to render 3 tiles per row on iPad landscape;
          on desktop (xl+) the panel returns to its 400px width. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_400px] lg:gap-6">

        {/* ================= LEFT: Menu ================= */}
        <div className="min-w-0">
          {/* Category strip — calmer eyebrow + segmented chips that
              match the family's segmented-control vocabulary. */}
          <div className="mb-4 rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] p-1.5">
            <div className="flex flex-wrap items-center gap-1">
              <CategoryChip
                label={t('All', 'Todos')}
                active={activeCategoryId === 'all'}
                onClick={() => setActiveCategoryId('all')}
              />
              {categories.map((c) => (
                <CategoryChip
                  key={c.id}
                  label={c.name}
                  active={activeCategoryId === c.id}
                  onClick={() => setActiveCategoryId(c.id)}
                />
              ))}
            </div>
          </div>

          {visibleItems.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
              <p className="text-sm font-semibold text-gray-700">{t('No items in this category', 'Sin artículos en esta categoría')}</p>
              <p className="mt-1 text-xs text-gray-500">{t('Add menu items to start selling.', 'Agrega artículos al menú para empezar a vender.')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {visibleItems.map((item) => (
                <ItemTile key={item.id} item={item} onAdd={() => addItem(item)} lang={lang} />
              ))}
            </div>
          )}
        </div>

        {/* ================= RIGHT: Checkout panel =================
            Reframed as a transaction surface: the Total is the
            visual anchor (40px tabular hero number), the order
            lines sit in a calmer scroll region, and the Continue
            button reads as the cashier's primary action. The
            outer shell carries a slightly stronger shadow than
            the menu tiles so the eye knows where the payment
            decision happens. */}
        <aside className="mt-4 lg:mt-0">
          <div className="sticky top-4 rounded-2xl border border-gray-200 bg-white shadow-[0_8px_24px_-12px_rgba(15,23,42,0.10)] overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]">

            {/* Header — eyebrow + tiny meta line. Compact so the
                Total band below gets the visual weight. */}
            <div className="border-b border-gray-100 px-5 pt-4 pb-3 flex items-baseline justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
                  {t('Current order', 'Pedido actual')}
                </p>
                <p className="mt-0.5 text-[11px] text-gray-500">
                  {cart.length === 0
                    ? t('Empty', 'Vacío')
                    : cartItemCount === 1
                      ? `${cartItemCount} ${t('item', 'artículo')}`
                      : `${cartItemCount} ${t('items', 'artículos')}`}
                </p>
              </div>
              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={clearCart}
                  className="text-[11px] font-medium text-gray-500 hover:text-red-600 transition-colors"
                >
                  {t('Clear', 'Limpiar')}
                </button>
              )}
            </div>

            {/* Cart lines — capped scroll region.
                The lines region is the only part of the right panel
                that expands with order size; capping it at 26rem
                (~5 distinct rows) keeps the totals/payment/workflow
                blocks below stable on real-sized orders. min-h-0 +
                flex-1 lets the region shrink on short viewports so
                the footer stays visible there too. */}
            <div className="flex-1 min-h-0 max-h-[26rem] overflow-y-auto">
              {cart.length === 0 ? (
                <div className="p-6 text-center">
                  <p className="text-xs text-gray-400 leading-relaxed">
                    {t('Tap a menu item to add it.', 'Toca un artículo del menú para agregarlo.')}
                  </p>
                </div>
              ) : (
                <ul className="px-3 py-3 space-y-2">
                  {cart.map((line) => (
                    <li key={line.lineId} className="relative">
                      {/* Row body — clickable surface that opens the
                          Order item drawer for this specific line.
                          Each line is independent: two clicks on the
                          same menu item produce two rows here so
                          guests with different mods stay separate. */}
                      <button
                        type="button"
                        onClick={() => setEditingLineId(line.lineId)}
                        className="w-full text-left rounded-lg border border-gray-200/80 bg-white px-3 py-2.5 pr-10 shadow-[0_1px_2px_rgba(0,0,0,0.02)] hover:border-blue-300 hover:bg-blue-50/30 transition-colors"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-gray-900 truncate">{line.name}</p>
                            {line.notes && (
                              <p className="text-[11px] text-gray-500 truncate mt-0.5">{line.notes}</p>
                            )}
                          </div>
                          <p className="text-sm font-semibold text-blue-600 font-mono tabular-nums whitespace-nowrap flex-shrink-0">
                            {CURRENCY(line.price * line.quantity)}
                          </p>
                        </div>
                      </button>
                      {/* Remove X — sibling of the clickable row, not
                          a nested button (HTML can't nest buttons). */}
                      <button
                        type="button"
                        onClick={() => removeLine(line.lineId)}
                        aria-label={`${t('Remove', 'Quitar')} ${line.name}`}
                        title={t('Remove from order', 'Quitar del pedido')}
                        className="absolute top-1/2 -translate-y-1/2 right-1.5 text-gray-400 hover:text-red-600 p-1 rounded-md hover:bg-red-50 transition-colors"
                      >
                        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Transaction footer.
                Hero Total band uses an ink-on-cream surface so the
                cashier's eye lands on the dollar amount before the
                button. Continue button is full-width, taller, and
                lifted with a soft shadow so it reads as the
                drawer-opening action — not just another button. */}
            <div className="border-t border-gray-100 bg-gradient-to-b from-gray-50/80 to-gray-100/40">
              <div className="px-6 pt-5 pb-4">
                <div className="flex items-baseline justify-between text-[11px] text-gray-500">
                  <span className="uppercase tracking-[0.14em] font-semibold">{t('Subtotal', 'Subtotal')}</span>
                  <span className="font-mono tabular-nums text-gray-600">{CURRENCY(subtotal)}</span>
                </div>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">{t('Total', 'Total')}</span>
                  <span className="text-[26px] leading-none font-mono tabular-nums font-bold text-gray-900">
                    {CURRENCY(subtotal)}
                  </span>
                </div>
              </div>
              <div className="px-6 pb-6">
                <button
                  type="button"
                  onClick={() => setCheckoutOpen(true)}
                  disabled={cart.length === 0 || pending}
                  className="w-full rounded-xl bg-gray-900 px-4 py-4 text-base font-bold text-white hover:bg-gray-800 active:scale-[0.99] shadow-[0_8px_20px_-12px_rgba(15,23,42,0.4)] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none transition-all"
                >
                  {cart.length === 0
                    ? 'Add items to start'
                    : `Continue to payment · ${CURRENCY(subtotal)}`}
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
      </>)}

      {/* Order item drawer — clicking a cart row in the right rail
          opens this drawer for that specific line item. Quantity,
          notes, modifier placeholders, and the per-line Remove
          action all live here so the cart row itself stays minimal
          (name + line total + remove X). Phone-only for now — bands
          uses a consolidated stepper directly on each cart row. */}
      {editingLine && !isBands && (
        <OrderItemDrawer
          line={editingLine}
          onClose={() => setEditingLineId(null)}
          onChangeQty={(delta) => changeQty(editingLine.lineId, delta)}
          onUpdateNotes={(notes) => updateLine(editingLine.lineId, { notes })}
          onRemove={() => {
            removeLine(editingLine.lineId)
            setEditingLineId(null)
          }}
        />
      )}

      {/* Phase 2 — checkout drawer.
          Opens only after the cashier confirms the order is ready
          via "Continue to payment." Carries the payment-method
          selector + per-method workflow (the same Cash/Card/Other
          components we already built); they were just moved out of
          the always-visible right rail and into this dedicated
          payment surface. */}
      {checkoutOpen && cart.length > 0 && (
        <CheckoutDrawer
          cart={cart}
          subtotal={subtotal}
          cartItemCount={cartItemCount}
          lineItemsJson={lineItemsJson}
          paymentType={paymentType}
          onSetPaymentType={setPaymentType}
          cashReceivedRaw={cashReceivedRaw}
          onChangeCashRaw={setCashReceivedRaw}
          action={action}
          pending={pending}
          actionError={state?.error ?? null}
          onClose={() => setCheckoutOpen(false)}
          online={online}
          onOfflineCommit={commitOfflineSale}
        />
      )}
    </div>
  )
}

// ================================================================
// CategoryChip
// ================================================================
function CategoryChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
        active
          ? 'bg-gray-900 text-white shadow-sm'
          : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {label}
    </button>
  )
}

// ================================================================
// ItemTile — left-side menu item button.
// ================================================================
function ItemTile({ item, onAdd, lang }: { item: Item; onAdd: () => void; lang: Lang }) {
  const t = makeT(lang)
  // Tile communicates status through subtle card styling — no
  // visible labels on the face. Four states, all calm:
  //
  //   healthy   → default white card with gray border, blue hover.
  //   low       → faint amber tint + soft amber border. Still
  //               clickable. Covers projection 'low' and the
  //               force-enabled-but-stock-out case (still sellable,
  //               still flagged).
  //   out       → faint red tint + soft red border, not clickable,
  //               name muted. Communicates "inventory is out."
  //   disabled  → default border, no tint, opacity-50, not
  //               clickable. Visually different from 'out' on
  //               purpose: it's a manager override, not a stock
  //               problem.
  //
  // The status info is folded into aria-label so screen-reader
  // users still hear the state we removed from the visible face.
  type TileState = 'healthy' | 'low' | 'out' | 'disabled'
  const state: TileState = (() => {
    if (item.effectiveSellability === 'manually_disabled') return 'disabled'
    if (item.effectiveSellability === 'auto_disabled') return 'out'
    if (
      item.projectionState === 'low' ||
      (item.effectiveSellability === 'manually_enabled' && item.projectionState === 'out')
    ) {
      return 'low'
    }
    return 'healthy'
  })()
  const sellable = state === 'healthy' || state === 'low'

  const ariaSuffix =
    state === 'out'
      ? ` (${t('out of stock', 'agotado')})`
      : state === 'disabled'
        ? ` (${t('unavailable', 'no disponible')})`
        : state === 'low'
          ? item.projectionState === 'low' && item.projectedCount !== null
            ? ` (${t('low stock', 'stock bajo')}, ${item.projectedCount} ${t('left', 'restantes')})`
            : ` (${t('low stock', 'stock bajo')})`
          : ''

  // Card + text styling per state. Every card is white with a
  // calm gray border on all four sides. The state cue is a small
  // colored arc overlay in the bottom-right corner — see the
  // accentClass span at the end of the button below. Healthy and
  // Disabled get no accent.
  const cardClass: Record<TileState, string> = {
    healthy:
      'border-gray-200/80 bg-white hover:border-blue-300 hover:shadow-md active:scale-[.98]',
    low:
      'border-gray-200/80 bg-white hover:border-gray-300 hover:shadow-md active:scale-[.98]',
    out:
      'border-gray-200/80 bg-white cursor-not-allowed',
    disabled:
      'border-gray-200/80 bg-white cursor-not-allowed opacity-50',
  }
  const textClass: Record<TileState, string> = {
    healthy: 'text-gray-900',
    low: 'text-gray-900',
    out: 'text-gray-500',
    disabled: 'text-gray-500',
  }
  // Bottom-right corner accent — small colored L that hugs the
  // card's rounded corner. Roughly ¼ of each adjacent edge so the
  // indicator stays a subtle corner cue, not a half-card border.
  const accentBorderClass: string | null =
    state === 'low' ? 'border-amber-300'
      : state === 'out' ? 'border-red-300'
        : null

  return (
    <button
      type="button"
      onClick={sellable ? onAdd : undefined}
      disabled={!sellable}
      aria-disabled={!sellable}
      aria-label={`${item.name}${ariaSuffix}`}
      className={`relative group rounded-xl border shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-4 py-5 transition-all flex items-center justify-center min-h-[5rem] ${cardClass[state]}`}
    >
      <p className={`text-sm font-semibold text-center line-clamp-2 ${textClass[state]}`}>
        {item.name}
      </p>
      {accentBorderClass && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute -bottom-px -right-px w-7 h-7 rounded-br-xl border-b border-r ${accentBorderClass}`}
        />
      )}
      {/* Remaining-stock count — tiny black number tucked into the
          bottom-right corner accent. Renders for both Low (showing
          the projected count) and Out (showing `0`). Healthy and
          Manually-disabled tiles show no number. The aria-label
          already carries the same info for screen readers, so this
          span is decorative. */}
      {state === 'low' && item.projectionState === 'low' && item.projectedCount !== null && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 right-2 text-[10px] font-semibold font-mono tabular-nums text-gray-400"
        >
          {item.projectedCount}
        </span>
      )}
      {state === 'out' && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 right-2 text-[10px] font-semibold font-mono tabular-nums text-gray-400"
        >
          0
        </span>
      )}
    </button>
  )
}

// ================================================================
// CashWorkflow — received-amount entry with quick tender + change.
//
// The cashier enters (or quick-picks) the cash received. We compute
// change due or remaining-owed live, and only enable the commit
// button when the received amount covers the total. The commit
// button is a real `type="submit"` inside the parent form — that's
// what actually fires createOrder.
// ================================================================
function CashWorkflow({
  total,
  cashReceivedRaw,
  onChangeCashRaw,
  pending,
  cartEmpty,
}: {
  total: number
  cashReceivedRaw: string
  onChangeCashRaw: (v: string) => void
  pending: boolean
  cartEmpty: boolean
}) {
  const cashReceived = parseFloat(cashReceivedRaw) || 0
  const sufficient = cashReceived >= total && total > 0
  const changeDue = sufficient ? cashReceived - total : 0
  const stillOwed = sufficient ? 0 : Math.max(0, total - cashReceived)

  const tenderAmounts = useMemo(() => quickTenderAmounts(total), [total])

  return (
    <div className="space-y-3">
      {/* "Amount due" block previously sat here; the drawer-level
          summary above already shows the same number, so this
          workflow opens straight on the cash-received controls. */}

      {/* Quick tender + custom input.
          Hidden so they only appear when there's a real amount to
          tender — empty cart shouldn't show four "$0.00" buttons. */}
      {total > 0 && (
        <>
          <div>
            <p className="mb-1.5 text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">Cash received</p>
            <div className="grid grid-cols-4 gap-1.5">
              {tenderAmounts.map((amt) => {
                const active = Math.abs(cashReceived - amt) < 0.005
                return (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => onChangeCashRaw(amt.toFixed(2))}
                    className={`rounded-lg border px-2 py-2 text-xs font-semibold font-mono tabular-nums transition-colors ${
                      active
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {CURRENCY(amt)}
                  </button>
                )
              })}
            </div>
            <div className="relative mt-2">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 font-mono tabular-nums">$</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={cashReceivedRaw}
                onChange={(e) => onChangeCashRaw(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg border border-gray-200 bg-white pl-7 pr-3 py-2 text-sm font-mono tabular-nums placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
              />
            </div>
          </div>

          {/* Live change / remaining signal. Only one of the two
              renders at a time — "Change due" when the cashier has
              enough cash to close the sale, "Remaining" while they
              still need more. Cashiers think in terms of change
              due, so the prominent green Change-due card stays the
              decisive end of the flow. */}
          {cashReceivedRaw !== '' && (
            sufficient ? (
              <div className="rounded-xl border border-green-200 bg-green-50/60 px-4 py-3 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-green-700">Change due</span>
                <span className="text-base font-mono tabular-nums font-bold text-green-700">{CURRENCY(changeDue)}</span>
              </div>
            ) : (
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-amber-700">Remaining</span>
                <span className="text-base font-mono tabular-nums font-bold text-amber-700">{CURRENCY(stillOwed)}</span>
              </div>
            )
          )}
        </>
      )}

      <button
        type="submit"
        disabled={cartEmpty || pending || !sufficient}
        className="w-full rounded-lg bg-gray-900 px-4 py-3 text-sm font-bold text-white hover:bg-gray-800 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {pending
          ? 'Saving…'
          : cartEmpty
            ? 'Add items to start'
            : !sufficient
              ? `Enter at least ${CURRENCY(total)}`
              : 'Complete cash payment'}
      </button>
    </div>
  )
}

// ================================================================
// CardWorkflow — Stripe Terminal card-present flow.
//
// Drives the real card-present lifecycle with the simulated reader:
//
//   1. Click "Charge card" → discover + connect simulated reader.
//   2. Server creates a PaymentIntent (card_present), returns
//      clientSecret + canonical intentId.
//   3. terminal.collectPaymentMethod(clientSecret) — collect card.
//   4. terminal.processPayment(...) — Stripe authorizes.
//   5. On succeeded: dispatch createOrder with
//      `verified_payment_intent_id` so the server re-checks the
//      Stripe status before finalizing. The order + inventory
//      depletion only happen once Stripe confirms succeeded —
//      that's the entire product principle.
//   6. On error / cancel: stay open, allow retry; the order is
//      never finalized and inventory is never touched.
//
// State is internal to this component; it's unmounted whenever the
// drawer closes or paymentType changes, which clears any in-flight
// reader connection cleanly.
// ================================================================
function CardWorkflow({
  total,
  lineItemsJson,
  action,
  pending,
  cartEmpty,
}: {
  total: number
  lineItemsJson: string
  action: (formData: FormData) => void
  pending: boolean
  cartEmpty: boolean
}) {
  const [stage, setStage] = useState<TerminalStage>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // Dev-only simulator mode. Only consumed when talking to the
  // Stripe Terminal simulated reader; has no effect on a real
  // reader. 'approved' → default simulator card (4242…), 'declined'
  // → the Stripe-published "generic_decline" test card (4000…0002),
  // which causes processPayment to return a card_declined error.
  const [simulatorMode, setSimulatorMode] = useState<'approved' | 'declined'>('approved')
  // useActionState's dispatch must run inside a transition when
  // called outside of an <form action> / formAction binding — which
  // is exactly our case (we fire it from inside startCardFlow after
  // Stripe says yes).
  const [, startTransition] = useTransition()
  // Terminal SDK + reader + intent state held in refs so re-renders
  // mid-flow don't drop them and so they're available to the cancel
  // path without leaking through React state.
  // The @stripe/terminal-js Terminal type is wide and changes across
  // SDK versions; `any` here keeps the file from being coupled to a
  // specific minor release.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const terminalRef = useRef<any>(null)
  const intentIdRef = useRef<string | null>(null)

  // Best-effort cleanup when the drawer / payment-type unmount us.
  useEffect(() => {
    return () => {
      const t = terminalRef.current
      if (!t) return
      try { t.cancelCollectPaymentMethod?.() } catch { /* ignore */ }
      try { t.disconnectReader?.() } catch { /* ignore */ }
    }
  }, [])

  // After we dispatch createOrder, watch for parent's `pending`
  // flipping back. The parent's wasPendingRef effect handles cart
  // reset on success; we just need to surface a clean failure state
  // here if createOrder rejects after Stripe already succeeded.
  // (A separate state from `pending` so this component doesn't
  // flicker between approved and failed before the parent's effect
  // closes the drawer.)
  useEffect(() => {
    if (stage !== 'approved') return
    if (pending) return
    // If the parent's actionError surfaces after we dispatched, the
    // parent will show it under the workflow. We move ourselves to
    // 'failed' so the cashier can retry / cancel cleanly without
    // a stuck "Approved · completing sale" stamp.
    // (We can't read state.error directly from here — the parent
    // renders it under the form. This component just bails out of
    // 'approved'.)
    setStage('idle')
  }, [pending, stage])

  const finalizeSale = (intentId: string) => {
    const fd = new FormData()
    fd.set('line_items', lineItemsJson)
    fd.set('source', 'native_pos')
    fd.set('payment_type', 'card')
    fd.set('payment_status', 'paid')
    fd.set('status', 'completed')
    fd.set('redirect_to', '/pos')
    fd.set('verified_payment_intent_id', intentId)
    startTransition(() => {
      action(fd)
    })
  }

  const startCardFlow = async () => {
    setErrorMessage(null)
    setStage('connecting')

    try {
      // 1. Lazy-load the SDK only when the cashier actually charges
      //    a card — keeps the JS off the bundle path for cash-only sessions.
      const { loadStripeTerminal } = await import('@stripe/terminal-js')
      const StripeTerminal = await loadStripeTerminal()
      if (!StripeTerminal) throw new Error('Stripe Terminal SDK failed to load.')

      // 2. Build a Terminal instance. fetchConnectionToken hits our
      //    existing /api/payments/terminal/connection-token endpoint;
      //    the SDK calls it once at startup and again whenever the
      //    token expires (~1 hour).
      const terminal = StripeTerminal.create({
        onFetchConnectionToken: async () => {
          const r = await fetch('/api/payments/terminal/connection-token', { method: 'POST' })
          if (!r.ok) {
            const body = (await r.json().catch(() => ({}))) as { error?: string }
            throw new Error(body.error ?? `Connection token failed (${r.status})`)
          }
          const body = (await r.json()) as { secret: string }
          return body.secret
        },
        onUnexpectedReaderDisconnect: () => {
          setErrorMessage('Reader disconnected unexpectedly.')
          setStage('failed')
        },
      })
      terminalRef.current = terminal

      // 3. Discover the simulated reader and connect. The SDK's
      //    discover/connect/collect/process methods all return a
      //    `{ error } | { <success-payload> }` union, but the
      //    installed types don't always discriminate cleanly. We
      //    treat the result as a loose record and cast through it.
      type Loose = {
        error?: { message?: string | null; code?: string | null } | null
        discoveredReaders?: unknown[]
        paymentIntent?: { status?: string } | null
      }

      const discover = (await terminal.discoverReaders({ simulated: true })) as Loose
      if (discover.error) {
        throw new Error(discover.error.message ?? 'Reader discovery failed.')
      }
      const reader = discover.discoveredReaders?.[0]
      if (!reader) throw new Error('No simulated readers available.')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connect = (await terminal.connectReader(reader as any)) as Loose
      if (connect.error) {
        throw new Error(connect.error.message ?? 'Could not connect to reader.')
      }

      // 3b. Dev-only: pick which simulator test card the reader
      //     auto-presents. Default is the success card 4242…; the
      //     decline path uses the Stripe-published generic_decline
      //     test card 4000 0000 0000 0002, which causes
      //     processPayment() to return a card_declined error. This
      //     is a simulator-only knob — it has no effect on a real
      //     reader and never touches live payment data.
      try {
        terminal.setSimulatorConfiguration?.({
          testCardNumber:
            simulatorMode === 'declined' ? '4000000000000002' : '4242424242424242',
        })
      } catch {
        // setSimulatorConfiguration is best-effort; older SDK
        // versions may not expose it. Falling through means the
        // reader uses its default success card, which is the safer
        // failure mode for this dev-only switch.
      }

      // 4. Create the canonical PaymentIntent on our server.
      const intentFd = new FormData()
      intentFd.set('amount', String(total))
      const intentResult = await createTerminalPaymentIntent(null, intentFd)
      if ('error' in intentResult) throw new Error(intentResult.error)
      intentIdRef.current = intentResult.intentId

      setStage('ready')

      // 5. Collect payment method from the simulated reader.
      setStage('collecting')
      const collect = (await terminal.collectPaymentMethod(intentResult.clientSecret)) as Loose
      if (collect.error) {
        if (collect.error.code === 'canceled') {
          setStage('canceled')
          return
        }
        throw new Error(collect.error.message ?? 'Card collection failed.')
      }
      const collectedIntent = collect.paymentIntent
      if (!collectedIntent) throw new Error('Card collected but no intent returned.')

      // 6. Process the payment.
      setStage('processing')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const process = (await terminal.processPayment(collectedIntent as any)) as Loose
      if (process.error) {
        throw new Error(process.error.message ?? 'Payment processing failed.')
      }
      const processedIntent = process.paymentIntent
      if (processedIntent?.status !== 'succeeded') {
        throw new Error(
          `Stripe returned status "${processedIntent?.status ?? 'unknown'}", not succeeded.`
        )
      }

      // 7. Stripe said yes. Now ask the server to verify + finalize
      //    the sale. createOrder will re-check the Stripe intent
      //    server-side before writing the order or depleting stock.
      setStage('approved')
      finalizeSale(intentResult.intentId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Card payment failed.'
      setErrorMessage(msg)
      setStage('failed')
    }
  }

  const cancelFlow = async () => {
    const t = terminalRef.current
    if (t) {
      try { await t.cancelCollectPaymentMethod?.() } catch { /* ignore */ }
    }
    setStage('canceled')
  }

  const resetToIdle = () => {
    setErrorMessage(null)
    intentIdRef.current = null
    setStage('idle')
  }

  // ----------------------------------------------------------------
  // Render — one block per stage. Same visual vocabulary as the
  // cash workflow: dark filled primary actions, calm status cards,
  // restrained color (blue=in-progress, green=approved, amber=warn,
  // red=failed).
  // ----------------------------------------------------------------
  return (
    <div className="space-y-3">
      {stage === 'idle' && (
        <>
          <button
            type="button"
            onClick={startCardFlow}
            disabled={cartEmpty || pending || total <= 0}
            className="w-full rounded-lg bg-gray-900 px-4 py-3 text-sm font-bold text-white hover:bg-gray-800 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {cartEmpty ? 'Add items to start' : 'Charge card'}
          </button>

          {/* Dev-only simulator switch. Only meaningful while the
              Stripe Terminal simulated reader is in use — has no
              effect on real readers. Selecting "Declined" makes the
              next charge return a card_declined error so the team
              can verify the failed-state path without writing a sale
              or depleting inventory. */}
          <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50/60 px-3 py-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-amber-700">
                Test mode · simulator
              </span>
              <span className="text-[10px] font-medium text-amber-700/70">dev only</span>
            </div>
            <div
              role="radiogroup"
              aria-label="Simulator card outcome"
              className="mt-2 grid grid-cols-2 gap-1.5"
            >
              <button
                type="button"
                role="radio"
                aria-checked={simulatorMode === 'approved'}
                onClick={() => setSimulatorMode('approved')}
                className={
                  simulatorMode === 'approved'
                    ? 'rounded-md bg-gray-900 px-2 py-2 text-[11px] font-semibold text-white shadow-sm'
                    : 'rounded-md border border-amber-200 bg-white px-2 py-2 text-[11px] font-semibold text-amber-800 hover:bg-amber-50'
                }
              >
                Simulate approved card
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={simulatorMode === 'declined'}
                onClick={() => setSimulatorMode('declined')}
                className={
                  simulatorMode === 'declined'
                    ? 'rounded-md bg-red-700 px-2 py-2 text-[11px] font-semibold text-white shadow-sm'
                    : 'rounded-md border border-amber-200 bg-white px-2 py-2 text-[11px] font-semibold text-amber-800 hover:bg-amber-50'
                }
              >
                Simulate declined card
              </button>
            </div>
          </div>
        </>
      )}

      {stage === 'connecting' && (
        <div className="rounded-xl border border-gray-200/80 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 rounded-full bg-gray-400 animate-pulse" aria-hidden="true" />
            <span className="text-xs font-semibold text-gray-800">Connecting to reader…</span>
          </div>
          <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
            Finding the reader and opening the payment session.
          </p>
        </div>
      )}

      {stage === 'ready' && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/50 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 rounded-full bg-blue-500 animate-pulse" aria-hidden="true" />
            <span className="text-xs font-semibold text-blue-800">Reader ready</span>
          </div>
          <p className="mt-1.5 text-xs text-blue-800/80 leading-relaxed">
            Hand the reader to the guest to tap, insert, or swipe.
          </p>
        </div>
      )}

      {stage === 'collecting' && (
        <>
          <div className="rounded-xl border border-blue-200 bg-blue-50/50 px-4 py-3.5">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2 w-2 rounded-full bg-blue-500 animate-pulse" aria-hidden="true" />
              <span className="text-xs font-semibold text-blue-800">Collecting card</span>
            </div>
            <p className="mt-1.5 text-xs text-blue-800/80 leading-relaxed">
              Waiting for the reader. The simulator auto-presents a test card.
            </p>
          </div>
          <button
            type="button"
            onClick={cancelFlow}
            className="w-full rounded-lg border border-gray-200/80 bg-white px-3 py-3 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </>
      )}

      {stage === 'processing' && (
        <div className="rounded-xl border border-gray-200/80 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 rounded-full bg-gray-400 animate-pulse" aria-hidden="true" />
            <span className="text-xs font-semibold text-gray-800">Processing payment…</span>
          </div>
          <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
            Authorizing the card. Keep the drawer open.
          </p>
        </div>
      )}

      {stage === 'approved' && (
        <div className="rounded-xl border border-green-200 bg-green-50/60 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 rounded-full bg-green-500" aria-hidden="true" />
            <span className="text-xs font-semibold text-green-800">Approved · finalizing sale</span>
          </div>
          <p className="mt-1.5 text-xs text-green-800/80 leading-relaxed">
            Writing the order and depleting inventory.
          </p>
        </div>
      )}

      {stage === 'failed' && (
        <>
          <div className="rounded-xl border border-red-200 bg-red-50/60 px-4 py-3.5">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
              <span className="text-xs font-semibold text-red-800">Card payment failed</span>
            </div>
            <p className="mt-1.5 text-xs text-red-700/90 leading-relaxed">
              {errorMessage ?? 'The card did not go through. Try a different card or switch to cash.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={resetToIdle}
              className="rounded-lg border border-gray-200/80 bg-white px-3 py-3 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={startCardFlow}
              className="flex-1 rounded-lg bg-gray-900 px-4 py-3 text-sm font-bold text-white hover:bg-gray-800 shadow-sm transition-colors"
            >
              Retry
            </button>
          </div>
        </>
      )}

      {stage === 'canceled' && (
        <>
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3.5">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
              <span className="text-xs font-semibold text-amber-800">Payment canceled</span>
            </div>
            <p className="mt-1.5 text-xs text-amber-700/90 leading-relaxed">
              No card was charged. The order is still here when you&apos;re ready.
            </p>
          </div>
          <button
            type="button"
            onClick={resetToIdle}
            className="w-full rounded-lg bg-gray-900 px-4 py-3 text-sm font-bold text-white hover:bg-gray-800 shadow-sm transition-colors"
          >
            Charge again
          </button>
        </>
      )}
    </div>
  )
}

// ================================================================
// OtherWorkflow — minimal manual commit path.
//
// Reserved for non-cash / non-processor payments (manual card entry
// later, comped sale, employee meal, etc.). Intentionally narrow
// in this pass; no inline detail capture.
// ================================================================
function OtherWorkflow({
  total,
  pending,
  cartEmpty,
}: {
  total: number
  pending: boolean
  cartEmpty: boolean
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-gray-200/80 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <p className="text-[11px] text-gray-500 leading-relaxed">
          Manual payment — comp, employee meal, or external method. The sale still posts to the Sales ledger.
        </p>
      </div>
      <button
        type="submit"
        disabled={cartEmpty || pending || total <= 0}
        className="w-full rounded-lg bg-gray-900 px-4 py-3 text-sm font-bold text-white hover:bg-gray-800 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {pending
          ? 'Saving…'
          : cartEmpty
            ? 'Add items to start'
            : 'Complete other payment'}
      </button>
    </div>
  )
}

// ================================================================
// CheckoutDrawer — Phase 2 of the Native POS flow.
//
// Opens after the cashier clicks "Continue to payment" with a
// non-empty cart. Carries the same payment-method selector +
// per-method workflow that previously lived inline in the right
// rail. The form lives inside this drawer now; the rail outside
// has no submit affordance anymore.
//
// State (paymentType / cashReceivedRaw / cardStage) lives on the
// parent so it survives drawer open/close and so the parent's
// success effect can reset it after a sale completes.
//
// Closing the drawer manually leaves the cart intact; the cashier
// can keep editing the order and reopen checkout. A successful
// `createOrder` submit closes the drawer + clears the cart via the
// parent's existing wasPendingRef effect.
// ================================================================
function CheckoutDrawer({
  cart,
  subtotal,
  cartItemCount,
  lineItemsJson,
  paymentType,
  onSetPaymentType,
  cashReceivedRaw,
  onChangeCashRaw,
  action,
  pending,
  actionError,
  onClose,
  online,
  onOfflineCommit,
}: {
  cart: CartLine[]
  subtotal: number
  cartItemCount: number
  lineItemsJson: string
  paymentType: PaymentType
  onSetPaymentType: (pt: PaymentType) => void
  cashReceivedRaw: string
  onChangeCashRaw: (v: string) => void
  action: (formData: FormData) => void
  pending: boolean
  actionError: string | null
  onClose: () => void
  online: boolean
  onOfflineCommit: (subtotal: number) => void
}) {
  // Esc + body-scroll lock — same pattern as the Menu and Sales
  // drawers in this codebase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-gray-900/30 backdrop-blur-[1px] z-40"
      />
      <aside className="fixed top-0 right-0 z-50 h-full w-full sm:max-w-md md:max-w-lg lg:max-w-md bg-white shadow-2xl border-l border-gray-200 flex flex-col">

        {/* Header — trimmed. The "N items · pick a method" subtitle
            moved into the hero amount block below; the header now
            carries only the section identity + Close so the body
            can open straight on the dollar amount. */}
        <div className="border-b border-gray-100 px-6 py-4 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">Checkout</p>
            <h2 className="mt-0.5 text-base font-semibold tracking-tight text-gray-900 leading-tight">
              Collect payment
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="flex-shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 disabled:opacity-60 transition-colors -mt-1 -mr-1"
          >
            Close
          </button>
        </div>

        {/* Body — five bands top-to-bottom:
              1. Hero amount due (visual anchor)
              2. Read-only order summary
              3. Payment method
              4. Active per-method workflow
              5. Optional action error
            The form wraps the whole body so each workflow's submit
            button still drives createOrder with the same hidden-
            field payload as before. */}
        <form
          action={action}
          onSubmit={(e) => {
            // Card / Stripe Terminal require a live network to
            // authorize — there's no graceful offline path for
            // them. Cash is the only payment type we can safely
            // queue, because it's already-collected money.
            if (online) return
            const fd = new FormData(e.currentTarget)
            const submittedPaymentType = (fd.get('payment_type') as string) || 'cash'
            if (submittedPaymentType !== 'cash') return
            e.preventDefault()
            // Serialize the FormData as a plain key→value record so
            // it round-trips through localStorage. createOrder
            // re-hydrates a FormData from this on replay (see
            // components/sync-runner.tsx).
            const payload: Record<string, string> = {}
            fd.forEach((value, key) => {
              if (typeof value === 'string') payload[key] = value
            })
            enqueueAction('create_order', payload)
            onOfflineCommit(subtotal)
          }}
          className="flex-1 overflow-y-auto px-6 py-5 space-y-5"
        >
          <input type="hidden" name="line_items" value={lineItemsJson} />
          <input type="hidden" name="source" value="native_pos" />
          <input type="hidden" name="payment_type" value={paymentType} />
          <input type="hidden" name="payment_status" value="paid" />
          <input type="hidden" name="status" value="completed" />
          {/* Encode the sold amount in the redirect URL so PosClient
              can fire the celebration overlay on the post-redirect
              render. See the useSearchParams effect at the top of
              the component. */}
          <input type="hidden" name="redirect_to" value={`/pos?sold=${subtotal.toFixed(2)}`} />

          {/* Offline status hint inside the drawer — gives the
              cashier confidence the cash flow still works, and
              flags that card won't. Only renders when offline so
              it stays out of the way during normal operation. */}
          {!online && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
              <p className="font-semibold">You’re offline.</p>
              <p className="mt-0.5 leading-relaxed">
                Cash sales will save on this device and sync when the network returns. Card and other electronic payments can’t be authorized offline.
              </p>
            </div>
          )}

          {/* 1. Hero — Amount due is the visual anchor of the
              drawer. No card chrome around it; a large centered
              tabular number reads as the checkout moment, not as a
              metric in a generic form. */}
          <div className="text-center pt-1 pb-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
              Amount due
            </p>
            <p className="mt-1 text-[40px] leading-none font-mono tabular-nums font-bold text-gray-900">
              {CURRENCY(subtotal)}
            </p>
            <p className="mt-2 text-[11px] text-gray-500">
              {cartItemCount} item{cartItemCount !== 1 ? 's' : ''} in this order
            </p>
          </div>

          {/* 2. Order summary — read-only, bounded scroll so long
              orders don't push payment controls off-screen. Each
              row is a quiet "name · qty · line total" tuple; no
              edit affordances (the cart panel behind the drawer is
              the editor). */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              Order summary
            </p>
            <ul className="rounded-lg border border-gray-200/80 bg-white divide-y divide-gray-100 max-h-32 overflow-y-auto">
              {cart.map((line) => (
                <li
                  key={line.lineId}
                  className="flex items-baseline justify-between gap-3 px-3 py-2"
                >
                  <p className="text-xs font-medium text-gray-900 truncate">
                    {line.name}
                    {line.quantity > 1 && (
                      <span className="ml-1.5 text-[11px] text-gray-500 font-mono tabular-nums">
                        × {line.quantity}
                      </span>
                    )}
                  </p>
                  <p className="text-xs font-semibold text-gray-900 font-mono tabular-nums whitespace-nowrap">
                    {CURRENCY(line.price * line.quantity)}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          {/* 3. Payment method — same three options as before, still
              rendered as a 3-column segmented strip. */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              Payment method
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {(['cash', 'card', 'other'] as PaymentType[]).map((pt) => {
                const active = paymentType === pt
                return (
                  <button
                    key={pt}
                    type="button"
                    onClick={() => onSetPaymentType(pt)}
                    disabled={pending}
                    className={`rounded-lg border px-2 py-1.5 text-xs font-semibold capitalize transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                      active
                        ? 'bg-gray-900 text-white border-gray-900 shadow-sm'
                        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {pt}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Active workflow */}
          {paymentType === 'cash' && (
            <CashWorkflow
              total={subtotal}
              cashReceivedRaw={cashReceivedRaw}
              onChangeCashRaw={onChangeCashRaw}
              pending={pending}
              cartEmpty={false}
            />
          )}
          {paymentType === 'card' && (
            <CardWorkflow
              total={subtotal}
              lineItemsJson={lineItemsJson}
              action={action}
              pending={pending}
              cartEmpty={false}
            />
          )}
          {paymentType === 'other' && (
            <OtherWorkflow
              total={subtotal}
              pending={pending}
              cartEmpty={false}
            />
          )}

          {actionError && (
            <p className="text-[11px] text-red-600 text-center">{actionError}</p>
          )}
        </form>
      </aside>
    </>
  )
}

// ================================================================
// OrderItemDrawer — per-line editor for items already in the cart.
//
// Opens when the cashier taps a cart row in the right-side current
// order panel. Renders the same drawer chrome (right-side aside +
// backdrop) the CheckoutDrawer uses so the family stays consistent.
//
// What it manages:
//   • Quantity (stepper; minimum 1 — removal goes through the
//     dedicated Remove button so the cashier never "decrements
//     into a delete" by mistake)
//   • Special request / note — captured on the cart line via
//     onUpdateNotes. UI-only for this pass; the createOrder action
//     contract isn't extended yet (see the CartLine JSDoc).
//   • Add-ons / modifiers — placeholder section so the interaction
//     is established. Renders a "coming soon" surface today.
//   • Remove from order — destructive action footer-left.
// ================================================================
function OrderItemDrawer({
  line,
  onClose,
  onChangeQty,
  onUpdateNotes,
  onRemove,
}: {
  line: CartLine
  onClose: () => void
  onChangeQty: (delta: number) => void
  onUpdateNotes: (notes: string) => void
  onRemove: () => void
}) {
  // Esc + body-scroll lock — same pattern as the CheckoutDrawer and
  // the rest of the family.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-gray-900/30 backdrop-blur-[1px] z-40"
      />
      <aside className="fixed top-0 right-0 z-50 h-full w-full sm:max-w-md md:max-w-lg lg:max-w-md bg-white shadow-2xl border-l border-gray-200 flex flex-col">

        {/* Header — single price mention only. Per-unit price reads
            as quiet supporting context under the name. Line total
            used to appear here AND beside the quantity AND in the
            cart row outside; the drawer now lets the cart row carry
            the live total so the header stays simple. */}
        <div className="border-b border-gray-100 px-6 py-5 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">Order item</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-gray-900 leading-tight truncate">
              {line.name}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              <span className="font-mono tabular-nums">{CURRENCY(line.price)}</span> each
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors -mt-1 -mr-1"
          >
            Close
          </button>
        </div>

        {/* Body — section order per the polish spec:
              1. Quantity (smaller, less dominant)
              2. Add-ons / modifiers
              3. Special request
            Quantity is the first editable control after identity;
            add-ons sit ahead of notes because structural customization
            comes before free-text annotation. */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* 1. Quantity — compact stepper. Sized down from text-base
              to text-sm so it reads as a modifier of the item rather
              than the main focus of the drawer. */}
          <div>
            <p className="mb-2 text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              Quantity
            </p>
            <div className="inline-flex items-center rounded-lg border border-gray-200/80 bg-white overflow-hidden">
              <button
                type="button"
                onClick={() => onChangeQty(-1)}
                disabled={line.quantity <= 1}
                aria-label="Decrease quantity"
                className="px-2.5 py-1 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed text-sm leading-none"
              >
                −
              </button>
              <span className="min-w-[2.25rem] px-2 py-1 text-sm font-bold font-mono tabular-nums text-center text-gray-900 border-x border-gray-200/80">
                {line.quantity}
              </span>
              <button
                type="button"
                onClick={() => onChangeQty(1)}
                aria-label="Increase quantity"
                className="px-2.5 py-1 text-gray-600 hover:bg-gray-50 text-sm leading-none"
              >
                +
              </button>
            </div>
            <p className="mt-1.5 text-[10px] text-gray-400 leading-relaxed">
              Use Remove below to take this item off the order.
            </p>
          </div>

          {/* 2. Add-ons / modifiers — placeholder until the data
              model lands. Structural customization sits ahead of the
              free-text "Special request" below. */}
          <div>
            <p className="mb-2 text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              Add-ons / modifiers
            </p>
            <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/40 px-4 py-5 text-center">
              <p className="text-xs text-gray-500 leading-relaxed">
                Item customizations coming soon.
              </p>
              <p className="mt-1 text-[10px] text-gray-400 leading-relaxed">
                Modifiers and add-ons will appear here once available.
              </p>
            </div>
          </div>

          {/* 3. Special request — free-text after structural mods. */}
          <div>
            <p className="mb-2 text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              Special request
            </p>
            <textarea
              value={line.notes ?? ''}
              onChange={(e) => onUpdateNotes(e.target.value)}
              rows={3}
              placeholder="No onions, dressing on the side…"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition resize-none"
            />
            <p className="mt-1 text-[10px] text-gray-400 leading-relaxed">
              Captured with this line item during the current order.
            </p>
          </div>
        </div>

        {/* Footer — destructive on the left, primary "Done" on the
            right. Done just closes the drawer; quantity / notes
            updates already wrote through to the cart on each
            interaction, so there's no separate save step. */}
        <div className="border-t border-gray-100 px-6 py-4 flex-shrink-0 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md border border-red-200 bg-white text-red-700 hover:bg-red-50 hover:border-red-300 px-3 py-1.5 text-xs font-semibold transition-colors"
          >
            Remove from order
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-gray-900 text-white hover:bg-gray-800 px-4 py-1.5 text-xs font-semibold transition-colors"
          >
            Done
          </button>
        </div>
      </aside>
    </>
  )
}

// ================================================================
// Bands (md+) helpers — only used by the isBands branch.
// ================================================================

/** Drag-scrollable single-row category rail. Fills chevron + edge
 *  fade when there's more to the right; drag-to-scroll on tablet. */
function BandsCategoryRail({
  tabs, activeId, onPick,
}: {
  tabs: Array<{ id: string; name: string; keys: string[] }>
  activeId: string | null
  onPick: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ x: number; at: number } | null>(null)
  const [more, setMore] = useState(false)
  const sync = () => {
    const el = ref.current
    if (el) setMore(el.scrollLeft < el.scrollWidth - el.clientWidth - 4)
  }
  useEffect(() => { sync() }, [tabs.length])
  return (
    <div style={{ position: 'relative', borderBottom: `1px solid ${B_LINE}`, background: B_SURFACE, flex: '0 0 auto' }}>
      <div
        ref={ref}
        onPointerDown={(e) => { if (ref.current) setDrag({ x: e.clientX, at: ref.current.scrollLeft }) }}
        onPointerMove={(e) => { if (drag && ref.current) { ref.current.scrollLeft = drag.at - (e.clientX - drag.x); sync() } }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        onScroll={sync}
        style={{
          display: 'flex', alignItems: 'stretch',
          padding: '0 34px 0 24px',
          overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none',
          touchAction: 'pan-x', cursor: drag ? 'grabbing' : 'grab',
        }}
      >
        {tabs.map((tb) => {
          const on = activeId === tb.id
          return (
            <button
              key={tb.id}
              type="button"
              onClick={() => onPick(tb.id)}
              style={{
                display: 'inline-flex', alignItems: 'center', border: 0, background: 'transparent',
                padding: '11px 14px 10px', marginLeft: -14, marginBottom: -1,
                fontFamily: 'inherit', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap', flex: '0 0 auto',
                borderBottom: `2px solid ${on ? B_INK : 'transparent'}`,
                fontWeight: on ? 600 : 500, color: on ? B_INK : B_MUTED,
              }}
            >
              {tb.name}
            </button>
          )
        })}
      </div>
      {more && (
        <>
          <span aria-hidden style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 52, pointerEvents: 'none', background: 'linear-gradient(270deg,#FAFAF9 34%,rgba(250,250,249,0))' }} />
          <button
            type="button"
            onClick={() => { if (ref.current) { ref.current.scrollLeft += 240; sync() } }}
            title="More categories"
            style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, border: `1px solid ${B_LINE}`, borderRadius: 999, background: '#fff', boxShadow: '0 1px 3px rgba(24,24,27,0.10)', fontFamily: 'inherit', fontSize: 13, lineHeight: 1, color: '#52525B', cursor: 'pointer', padding: 0 }}
          >
            ›
          </button>
        </>
      )}
    </div>
  )
}

/** Sellable item tile — every item here already has price > 0
 *  (filtered server-side). Ink border + "N in order" badge when
 *  the item is in the cart. */
function BandsItemCard({
  item, inCart, onAdd, t,
}: { item: Item; inCart: number; onAdd: () => void; t: (en: string, es?: string) => string }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      title={`${t('Add', 'Añadir')} ${item.name}`}
      style={{
        display: 'block', width: '100%', textAlign: 'left', borderRadius: 10,
        padding: '11px 12px', fontFamily: 'inherit', color: B_INK,
        border: `1px solid ${inCart ? B_INK : B_LINE}`,
        background: inCart ? B_SURFACE : '#fff',
        cursor: 'pointer',
      }}
    >
      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.35 }}>{item.name}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: 9 }}>
        <span style={{ fontFamily: B_MONO, fontSize: 14, fontWeight: 600, color: B_INK }}>{CURRENCY(item.price)}</span>
        {inCart > 0 && (
          <span style={{ fontFamily: B_MONO, fontSize: 10, fontWeight: 600, color: B_PAPER, background: B_INK, borderRadius: 999, padding: '2px 7px' }}>
            {inCart} {t('in order', 'en pedido')}
          </span>
        )}
      </span>
    </button>
  )
}

/** Bands search pill — header-band right anchor. Same silhouette
 *  as the menu / sales / inventory tablet searches. */
function BandsSearchPill({
  total, value, onChange, placeholder, unit,
}: { total: number; value: string; onChange: (v: string) => void; placeholder: string; unit: string }) {
  const [focused, setFocused] = useState(false)
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, borderRadius: 999,
        padding: '0 6px 0 12px', height: 34, flex: '0 0 auto',
        transition: 'background 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
        background: focused ? '#fff' : B_FILL,
        border: `1px solid ${focused ? B_INK : 'transparent'}`,
        boxShadow: focused ? '0 0 0 3px rgba(24,24,27,0.06)' : 'none',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={focused ? '#52525B' : B_FAINT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.35-4.35" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={`${placeholder} ${total} ${unit}`}
        style={{ border: 0, background: 'transparent', fontFamily: 'inherit', fontSize: 13, color: B_INK, width: 200, padding: 0, outline: 'none' }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, border: 0, borderRadius: '50%', background: B_LINE, fontFamily: 'inherit', fontSize: 13, lineHeight: 1, color: '#52525B', cursor: 'pointer', flex: '0 0 auto' }}
        >
          ×
        </button>
      )}
    </span>
  )
}

function BandsStepBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', border: 0, background: '#fff', borderRadius: 7, width: 24, height: 24, fontFamily: 'inherit', fontSize: 14, lineHeight: 1, color: '#52525B', cursor: 'pointer', boxShadow: '0 1px 2px rgba(24,24,27,0.06)' }}
    >
      {children}
    </button>
  )
}

function BandsCartIcon({ color, size = 22 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="21" r="1" /><circle cx="19" cy="21" r="1" />
      <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
    </svg>
  )
}
