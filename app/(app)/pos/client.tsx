'use client'

// ----------------------------------------------------------------
// POS Client
//
// Live transaction-entry surface. Left: categories + item grid.
// Right: cart, totals, payment type, Complete sale.
//
// Submits to the existing `createOrder` server action with:
//   source         = 'native_pos'
//   payment_type   = cash | card | other
//   payment_status = 'paid'
//   status         = 'completed'
//   redirect_to    = '/pos'
//
// The existing Sales → Inventory bridge depletes stock on save.
// ----------------------------------------------------------------

import { useState, useMemo, useActionState, useEffect, useRef } from 'react'
import { createOrder } from '@/app/actions/sales'

interface Category { id: string; name: string }
interface Item { id: string; name: string; price: number; categoryId: string | null }
interface CartLine { itemId: string; name: string; price: number; quantity: number }

type PaymentType = 'cash' | 'card' | 'other'

const CURRENCY = (n: number) => `$${n.toFixed(2)}`

export default function PosClient({ categories, items }: { categories: Category[]; items: Item[] }) {
  const [activeCategoryId, setActiveCategoryId] = useState<string | 'all'>(
    categories[0]?.id ?? 'all'
  )
  const [cart, setCart] = useState<CartLine[]>([])
  const [paymentType, setPaymentType] = useState<PaymentType>('cash')
  const [state, action, pending] = useActionState(createOrder, null)
  const [confirmation, setConfirmation] = useState<string | null>(null)

  // Clear cart and flash a small "Sale complete" confirmation after a
  // successful submission. createOrder redirects back to /pos when
  // `redirect_to=/pos` is supplied. We detect success by watching
  // `pending` fall from true to false without an error.
  const wasPendingRef = useRef(false)
  const lastSubtotalRef = useRef(0)
  useEffect(() => {
    if (pending) lastSubtotalRef.current = cart.reduce((s, l) => s + l.price * l.quantity, 0)
    if (wasPendingRef.current && !pending && !state?.error) {
      setCart([])
      setPaymentType('cash')
      setConfirmation(`Sale complete · $${lastSubtotalRef.current.toFixed(2)}`)
      const t = setTimeout(() => setConfirmation(null), 2000)
      return () => clearTimeout(t)
    }
    wasPendingRef.current = pending
  }, [pending, state, cart])

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

  const canCheckout = cart.length > 0 && !pending

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
          <h1 className="text-2xl font-bold text-gray-900">POS</h1>
          <p className="mt-1 text-sm text-gray-500">Ring up a sale. Orders post to the Sales ledger and deplete stock automatically.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6">

        {/* ================= LEFT: Menu ================= */}
        <div className="min-w-0">

          {/* Category tabs */}
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-2 mb-4">
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

          {/* Item grid */}
          {visibleItems.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
              <p className="text-lg font-medium text-gray-400">No items in this category</p>
              <p className="mt-1 text-sm text-gray-300">Add menu items to start selling.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
              {visibleItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => addItem(item)}
                  className="group text-left rounded-xl border border-gray-200 bg-white shadow-sm p-4 hover:border-blue-300 hover:shadow-md active:scale-[.98] transition-all"
                >
                  <p className="text-sm font-semibold text-gray-900 line-clamp-2 min-h-[2.5rem]">{item.name}</p>
                  <p className="mt-2 text-base font-bold text-blue-600 tabular-nums">{CURRENCY(item.price)}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ================= RIGHT: Cart / Checkout ================= */}
        <aside className="mt-4 lg:mt-0">
          <div className="sticky top-4 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]">

            {/* Header */}
            <div className="border-b border-gray-100 px-5 py-3 flex items-center justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Current order</p>
                <h2 className="text-base font-bold text-gray-900 mt-0.5">
                  {cart.length === 0 ? 'Empty cart' : `${cart.reduce((s, l) => s + l.quantity, 0)} item${cart.reduce((s, l) => s + l.quantity, 0) !== 1 ? 's' : ''}`}
                </h2>
              </div>
              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={clearCart}
                  className="text-[11px] font-semibold text-gray-400 hover:text-gray-700 uppercase tracking-wide"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Cart lines */}
            <div className="flex-1 overflow-y-auto">
              {cart.length === 0 ? (
                <div className="p-6 text-center">
                  <p className="text-xs text-gray-400 leading-relaxed">
                    Tap a menu item on the left to add it to the order.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-gray-50">
                  {cart.map((line) => (
                    <li key={line.itemId} className="px-5 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-900 truncate">{line.name}</p>
                          <p className="text-[11px] text-gray-400 tabular-nums mt-0.5">
                            {CURRENCY(line.price)} × {line.quantity}
                          </p>
                        </div>
                        <p className="text-sm font-bold text-gray-900 tabular-nums whitespace-nowrap">
                          {CURRENCY(line.price * line.quantity)}
                        </p>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="inline-flex items-center rounded-lg border border-gray-200 overflow-hidden">
                          <button
                            type="button"
                            onClick={() => changeQty(line.itemId, -1)}
                            className="px-2.5 py-1 text-gray-600 hover:bg-gray-50 text-sm"
                            aria-label="Decrease"
                          >−</button>
                          <span className="px-3 py-1 text-sm font-semibold tabular-nums border-x border-gray-200">
                            {line.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => changeQty(line.itemId, 1)}
                            className="px-2.5 py-1 text-gray-600 hover:bg-gray-50 text-sm"
                            aria-label="Increase"
                          >+</button>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeLine(line.itemId)}
                          className="text-[11px] text-gray-400 hover:text-red-600"
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Totals + payment + action */}
            <div className="border-t border-gray-100 p-5 space-y-4">
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>Subtotal</span>
                  <span className="tabular-nums">{CURRENCY(subtotal)}</span>
                </div>
                <div className="flex items-center justify-between text-base font-bold text-gray-900">
                  <span>Total</span>
                  <span className="tabular-nums">{CURRENCY(subtotal)}</span>
                </div>
              </div>

              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1.5">Payment</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['cash', 'card', 'other'] as PaymentType[]).map((pt) => {
                    const active = paymentType === pt
                    return (
                      <button
                        key={pt}
                        type="button"
                        onClick={() => setPaymentType(pt)}
                        className={`rounded-lg border px-2 py-2 text-xs font-semibold capitalize transition-colors ${
                          active
                            ? 'bg-gray-900 text-white border-gray-900 shadow-sm'
                            : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        {pt}
                      </button>
                    )
                  })}
                </div>
              </div>

              <form action={action}>
                <input type="hidden" name="line_items" value={lineItemsJson} />
                <input type="hidden" name="source" value="native_pos" />
                <input type="hidden" name="payment_type" value={paymentType} />
                <input type="hidden" name="payment_status" value="paid" />
                <input type="hidden" name="status" value="completed" />
                <input type="hidden" name="redirect_to" value="/pos" />
                <button
                  type="submit"
                  disabled={!canCheckout}
                  className="w-full rounded-lg bg-gray-900 px-4 py-3 text-sm font-bold text-white hover:bg-gray-800 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {pending ? 'Saving…' : `Complete sale · ${CURRENCY(subtotal)}`}
                </button>
                {state?.error && (
                  <p className="mt-2 text-[11px] text-red-600 text-center">{state.error}</p>
                )}
              </form>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
function CategoryChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
        active
          ? 'bg-gray-900 text-white shadow-sm'
          : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {label}
    </button>
  )
}
