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
import { createTerminalPaymentIntent } from '@/app/actions/payments'
import {
  isPosSellable,
  type EffectiveSellability,
  type ProjectionState,
} from '@/lib/menu/availability'

// ================================================================
// Domain
// ================================================================

interface Category { id: string; name: string }
interface Item {
  id: string
  name: string
  price: number
  categoryId: string | null
  effectiveSellability: EffectiveSellability
  projectedCount: number | null
  projectionState: ProjectionState
}
interface CartLine { itemId: string; name: string; price: number; quantity: number }

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
}: {
  categories: Category[]
  items: Item[]
  operatingMode?: 'native_pos' | 'external_pos' | null
}) {
  const [activeCategoryId, setActiveCategoryId] = useState<string | 'all'>(
    categories[0]?.id ?? 'all'
  )
  const [cart, setCart] = useState<CartLine[]>([])
  const [paymentType, setPaymentType] = useState<PaymentType>('cash')
  const [state, action, pending] = useActionState(createOrder, null)
  const [confirmation, setConfirmation] = useState<string | null>(null)

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
      setConfirmation(`Sale complete · ${CURRENCY(lastSubtotalRef.current)}`)
      const t = setTimeout(() => setConfirmation(null), 2000)
      return () => clearTimeout(t)
    }
    wasPendingRef.current = pending
  }, [pending, state, cart])

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

  const addItem = (item: Item) => {
    setCart((p) => {
      const existing = p.find((l) => l.itemId === item.id)
      if (existing) {
        return p.map((l) => l.itemId === item.id ? { ...l, quantity: l.quantity + 1 } : l)
      }
      return [...p, { itemId: item.id, name: item.name, price: item.price, quantity: 1 }]
    })
  }

  const changeQty = (itemId: string, delta: number) => {
    setCart((p) => p
      .map((l) => l.itemId === itemId ? { ...l, quantity: l.quantity + delta } : l)
      .filter((l) => l.quantity > 0))
  }

  const removeLine = (itemId: string) => {
    setCart((p) => p.filter((l) => l.itemId !== itemId))
  }

  const clearCart = () => setCart([])

  // Serialized payload for the server action.
  const lineItemsJson = JSON.stringify(cart.map((l) => ({
    menu_item_id: l.itemId,
    quantity: l.quantity,
  })))

  const cartItemCount = cart.reduce((s, l) => s + l.quantity, 0)

  return (
    <div className="max-w-[1400px] h-full relative">
      {confirmation && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          <div className="flex items-center gap-2 rounded-full bg-gray-900 text-white text-xs font-semibold px-4 py-2 shadow-lg">
            <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            {confirmation}
          </div>
        </div>
      )}

      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">POS</h1>
          <p className="mt-1.5 text-sm text-gray-500">Ring up a sale.</p>
        </div>
      </div>

      {operatingMode === 'external_pos' && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-indigo-200/80 bg-indigo-50/60 px-4 py-3">
          <span className="flex-shrink-0 mt-0.5 inline-flex items-center gap-1 text-[10px] font-semibold text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded-full">
            <span className="w-1 h-1 rounded-full bg-indigo-500" />
            External POS
          </span>
          <p className="text-xs text-indigo-800 leading-relaxed">
            Your provider is the canonical sales source — use this surface only when needed.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-6">

        {/* ================= LEFT: Menu ================= */}
        <div className="min-w-0">
          {/* Category strip — calmer eyebrow + segmented chips that
              match the family's segmented-control vocabulary. */}
          <div className="mb-4 rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] p-1.5">
            <div className="flex flex-wrap items-center gap-1">
              <CategoryChip
                label="All"
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
              <p className="text-sm font-semibold text-gray-700">No items in this category</p>
              <p className="mt-1 text-xs text-gray-500">Add menu items to start selling.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
              {visibleItems.map((item) => (
                <ItemTile key={item.id} item={item} onAdd={() => addItem(item)} />
              ))}
            </div>
          )}
        </div>

        {/* ================= RIGHT: Checkout panel ================= */}
        <aside className="mt-4 lg:mt-0">
          <div className="sticky top-4 rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]">

            {/* Header */}
            <div className="border-b border-gray-100 px-5 py-4 flex items-baseline justify-between">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-gray-900">Current order</h2>
                <p className="mt-0.5 text-[11px] text-gray-500">
                  {cart.length === 0 ? 'Empty' : `${cartItemCount} item${cartItemCount !== 1 ? 's' : ''}`}
                </p>
              </div>
              {/* Clear — quiet text link. Calmer than the previous
                  uppercase treatment but still red-on-hover so the
                  destructive intent is obvious on intent to use. */}
              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={clearCart}
                  className="text-[11px] font-medium text-gray-500 hover:text-red-600 transition-colors"
                >
                  Clear
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
                    Tap a menu item to add it.
                  </p>
                </div>
              ) : (
                <ul className="px-3 py-3 space-y-2">
                  {cart.map((line) => (
                    <li
                      key={line.itemId}
                      className="rounded-lg border border-gray-200/80 bg-white px-3 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
                    >
                      {/* Identity row — item name + line total
                          baseline-aligned so the eye reads them as
                          one operational pair. The old "$X × N"
                          subtext was removed: redundant with the
                          stepper's count + the line total. */}
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-sm font-semibold text-gray-900 truncate">{line.name}</p>
                        <p className="text-sm font-semibold text-gray-900 tabular-nums whitespace-nowrap">
                          {CURRENCY(line.price * line.quantity)}
                        </p>
                      </div>
                      {/* Action row — stepper + remove. Symmetric
                          layout: control on the left, destructive on
                          the right. Both vertically centered with the
                          stepper so the remove X feels like part of
                          the row, not floating. */}
                      <div className="mt-2.5 flex items-center justify-between">
                        <div className="inline-flex items-center rounded-lg border border-gray-200/80 bg-white overflow-hidden">
                          <button
                            type="button"
                            onClick={() => changeQty(line.itemId, -1)}
                            className="px-2.5 py-1 text-gray-600 hover:bg-gray-50 text-sm leading-none"
                            aria-label="Decrease"
                          >−</button>
                          <span className="min-w-[2.25rem] px-2 py-1 text-sm font-bold tabular-nums text-center text-gray-900 border-x border-gray-200/80">
                            {line.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => changeQty(line.itemId, 1)}
                            className="px-2.5 py-1 text-gray-600 hover:bg-gray-50 text-sm leading-none"
                            aria-label="Increase"
                          >+</button>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeLine(line.itemId)}
                          aria-label={`Remove ${line.name}`}
                          title="Remove from order"
                          className="text-gray-400 hover:text-red-600 p-1.5 rounded-md hover:bg-red-50 transition-colors"
                        >
                          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Order-building footer.
                Default right-rail state focuses only on Phase 1:
                review totals and advance to payment. Payment method
                selection + the per-method workflow (cash/card/other)
                no longer live here — they're in the CheckoutDrawer
                that opens via the primary action below. */}
            <div className="border-t border-gray-100 bg-gray-50/40">
              <div className="px-5 pt-4 pb-3">
                <div className="flex items-center justify-between text-[11px] text-gray-500">
                  <span>Subtotal</span>
                  <span className="font-mono tabular-nums">{CURRENCY(subtotal)}</span>
                </div>
                <div className="mt-1 flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-gray-900">Total</span>
                  <span className="text-lg font-mono tabular-nums font-bold text-gray-900">{CURRENCY(subtotal)}</span>
                </div>
              </div>
              <div className="px-5 pb-5">
                <button
                  type="button"
                  onClick={() => setCheckoutOpen(true)}
                  disabled={cart.length === 0 || pending}
                  className="w-full rounded-lg bg-gray-900 px-4 py-3 text-sm font-bold text-white hover:bg-gray-800 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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

      {/* Phase 2 — checkout drawer.
          Opens only after the cashier confirms the order is ready
          via "Continue to payment." Carries the payment-method
          selector + per-method workflow (the same Cash/Card/Other
          components we already built); they were just moved out of
          the always-visible right rail and into this dedicated
          payment surface. */}
      {checkoutOpen && cart.length > 0 && (
        <CheckoutDrawer
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
function ItemTile({ item, onAdd }: { item: Item; onAdd: () => void }) {
  const sellable = isPosSellable(item.effectiveSellability)
  // Status cue mirrors the menu card chip vocabulary so staff don't
  // have to remember two languages. Healthy items show no cue;
  // auto-disabled and manually-disabled items get an inline state pill.
  const statusCue: { label: string; tone: 'red' | 'amber' | 'gray' } | null = (() => {
    if (item.effectiveSellability === 'auto_disabled') return { label: 'Out', tone: 'red' }
    if (item.effectiveSellability === 'manually_disabled') return { label: 'Disabled', tone: 'gray' }
    if (item.effectiveSellability === 'manually_enabled' && item.projectionState === 'out') {
      return { label: 'Out · Override', tone: 'amber' }
    }
    if (item.projectionState === 'low' && item.projectedCount !== null) {
      return { label: `Low · ${item.projectedCount}`, tone: 'amber' }
    }
    return null
  })()

  return (
    <button
      type="button"
      onClick={sellable ? onAdd : undefined}
      disabled={!sellable}
      aria-disabled={!sellable}
      className={`group text-left rounded-xl border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-4 py-3.5 transition-all ${
        sellable
          ? 'border-gray-200/80 hover:border-blue-300 hover:shadow-md active:scale-[.98]'
          : 'border-gray-200/80 opacity-60 cursor-not-allowed'
      }`}
    >
      <p className={`text-sm font-semibold line-clamp-2 min-h-[2.5rem] ${sellable ? 'text-gray-900' : 'text-gray-500'}`}>
        {item.name}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className={`text-base font-bold tabular-nums ${sellable ? 'text-blue-600' : 'text-gray-400'}`}>
          {CURRENCY(item.price)}
        </p>
        {statusCue && (
          <span
            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
              statusCue.tone === 'red'
                ? 'bg-red-50 text-red-700'
                : statusCue.tone === 'amber'
                  ? 'bg-amber-50 text-amber-700'
                  : 'bg-gray-100 text-gray-600'
            }`}
          >
            {statusCue.label}
          </span>
        )}
      </div>
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
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-500">Cash received</p>
            <div className="grid grid-cols-4 gap-1.5">
              {tenderAmounts.map((amt) => {
                const active = Math.abs(cashReceived - amt) < 0.005
                return (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => onChangeCashRaw(amt.toFixed(2))}
                    className={`rounded-lg border px-2 py-2 text-xs font-semibold tabular-nums transition-colors ${
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
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 tabular-nums">$</span>
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

          {/* Live change/owed signal. Only one of the two ever shows. */}
          {cashReceivedRaw !== '' && (
            sufficient ? (
              <div className="rounded-xl border border-green-200 bg-green-50/60 px-4 py-3 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-green-700">Change due</span>
                <span className="text-base font-mono tabular-nums font-bold text-green-700">{CURRENCY(changeDue)}</span>
              </div>
            ) : (
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-amber-700">Still owed</span>
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
              : `Complete cash sale · ${CURRENCY(total)}`}
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
            {cartEmpty ? 'Add items to start' : `Charge card · ${CURRENCY(total)}`}
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
            : `Complete sale · ${CURRENCY(total)}`}
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
}: {
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
      <aside className="fixed top-0 right-0 z-50 h-full w-full sm:max-w-md bg-white shadow-2xl border-l border-gray-200 flex flex-col">

        {/* Header */}
        <div className="border-b border-gray-100 px-6 py-5 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">Checkout</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-gray-900 leading-tight">Collect payment</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {cartItemCount} item{cartItemCount !== 1 ? 's' : ''} · pick a payment method.
            </p>
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

        {/* Body — order summary + payment method + active workflow.
            The form wraps the whole body so the submit buttons
            inside each workflow component still drive createOrder
            with the same hidden-field payload as before. */}
        <form action={action} className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          <input type="hidden" name="line_items" value={lineItemsJson} />
          <input type="hidden" name="source" value="native_pos" />
          <input type="hidden" name="payment_type" value={paymentType} />
          <input type="hidden" name="payment_status" value="paid" />
          <input type="hidden" name="status" value="completed" />
          <input type="hidden" name="redirect_to" value="/pos" />

          {/* Single primary amount summary for the drawer.
              The Cash and Card workflows used to each render their
              own "Amount due" / "Amount to charge" block under this
              one — same number, repeated twice. We keep this single
              summary as the canonical "what's being paid" and the
              workflows below go straight into their controls. */}
          <div className="rounded-xl border border-gray-200/80 bg-gray-50/50 px-4 py-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Amount due</span>
              <span className="text-lg font-mono tabular-nums font-bold text-gray-900">{CURRENCY(subtotal)}</span>
            </div>
            <p className="mt-1 text-[11px] text-gray-500 tabular-nums">
              {cartItemCount} item{cartItemCount !== 1 ? 's' : ''} in this order
            </p>
          </div>

          {/* Payment method selector */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-500">Payment method</p>
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
