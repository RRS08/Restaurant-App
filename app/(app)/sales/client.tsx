'use client'

// ----------------------------------------------------------------
// Sales Client
//
// Lightweight review layer with small operational cues:
//   • badges for source, payment type, payment status, status
//   • source filter (manual / native POS / external POS / all)
//   • row click opens a minimal drill-down sheet with line items
//   • Void action from the drill-down for completed orders
// ----------------------------------------------------------------

import { useState, useMemo, useActionState, useEffect } from 'react'
import { voidOrder } from '@/app/actions/sales'

type Source = 'manual' | 'native_pos' | 'external_pos'
type PaymentType = 'cash' | 'card' | 'other'
type PaymentStatus = 'paid' | 'unpaid'
type OrderStatus = 'completed' | 'voided'

interface LineItem { id: string; name: string; quantity: number; unitPrice: number; totalPrice: number }
interface Order {
  id: string; total: number; createdAt: string
  source: Source; paymentType: PaymentType; paymentStatus: PaymentStatus; status: OrderStatus
  note: string | null; locationName: string | null; lineItems: LineItem[]
}

const SOURCE_META: Record<Source, { label: string; className: string }> = {
  manual:       { label: 'Manual',      className: 'bg-gray-100 text-gray-700' },
  native_pos:   { label: 'POS',         className: 'bg-blue-50 text-blue-700' },
  external_pos: { label: 'External',    className: 'bg-indigo-50 text-indigo-700' },
}

const STATUS_META: Record<OrderStatus, { label: string; className: string }> = {
  completed: { label: 'Completed', className: 'bg-green-50 text-green-700' },
  voided:    { label: 'Voided',    className: 'bg-red-50 text-red-700 line-through decoration-red-500' },
}

const CURRENCY = (n: number) => `$${n.toFixed(2)}`

type Filter = 'all' | Source

export default function SalesClient({ orders }: { orders: Order[] }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [openId, setOpenId] = useState<string | null>(null)

  const visible = useMemo(() => {
    if (filter === 'all') return orders
    return orders.filter((o) => o.source === filter)
  }, [orders, filter])

  const selected = openId ? orders.find((o) => o.id === openId) ?? null : null

  // Close the sheet if the selected order disappears after revalidation
  useEffect(() => {
    if (openId && !orders.find((o) => o.id === openId)) setOpenId(null)
  }, [orders, openId])

  return (
    <div className="max-w-5xl">

      {/* Controls */}
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="flex flex-wrap items-center gap-1">
          {(['all', 'manual', 'native_pos', 'external_pos'] as Filter[]).map((f) => {
            const active = filter === f
            const label =
              f === 'all' ? 'All' :
              f === 'manual' ? 'Manual' :
              f === 'native_pos' ? 'POS' : 'External'
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                  active ? 'bg-gray-900 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
          <p className="text-lg font-medium text-gray-400">No sales found</p>
          <p className="mt-1 text-sm text-gray-300">
            {orders.length === 0 ? 'Create your first sale to get started.' : 'Try a different filter.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left bg-gray-50/60">
                <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Date</th>
                <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Source</th>
                <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Payment</th>
                <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Location</th>
                <th className="px-5 py-2.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {visible.map((o) => {
                const srcMeta = SOURCE_META[o.source]
                const statusMeta = STATUS_META[o.status]
                const isVoided = o.status === 'voided'
                return (
                  <tr
                    key={o.id}
                    onClick={() => setOpenId(o.id)}
                    className={`group cursor-pointer transition-colors ${openId === o.id ? 'bg-blue-50/60' : 'hover:bg-gray-50'}`}
                  >
                    <td className={`px-5 py-3 ${isVoided ? 'text-gray-400' : 'text-gray-900'}`}>
                      {new Date(o.createdAt).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                        hour: 'numeric', minute: '2-digit',
                      })}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full ${srcMeta.className}`}>
                        {srcMeta.label}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[11px] font-medium text-gray-700 capitalize">{o.paymentType}</span>
                        <span className={`inline-flex text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                          o.paymentStatus === 'paid' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
                        }`}>
                          {o.paymentStatus}
                        </span>
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusMeta.className}`}>
                        {statusMeta.label}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-600">{o.locationName ?? '—'}</td>
                    <td className={`px-5 py-3 font-mono text-right ${isVoided ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                      {CURRENCY(o.total)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && <OrderDrawer order={selected} onClose={() => setOpenId(null)} />}
    </div>
  )
}

// ----------------------------------------------------------------
// OrderDrawer — minimal drill-down: line items + void action.
// ----------------------------------------------------------------
function OrderDrawer({ order, onClose }: { order: Order; onClose: () => void }) {
  const [state, action, pending] = useActionState(voidOrder, null)
  const canVoid = order.status === 'completed'
  const srcMeta = SOURCE_META[order.source]
  const statusMeta = STATUS_META[order.status]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <aside className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white border-l border-gray-200 shadow-2xl z-50 overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-start justify-between z-10">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Order</p>
            <h2 className="text-lg font-bold text-gray-900 truncate">
              {new Date(order.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </h2>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 -mt-1 -mr-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Meta */}
          <div className="flex flex-wrap gap-2">
            <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full ${srcMeta.className}`}>{srcMeta.label}</span>
            <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusMeta.className}`}>{statusMeta.label}</span>
            <span className="inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 capitalize">
              {order.paymentType}
            </span>
            <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full ${
              order.paymentStatus === 'paid' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
            }`}>{order.paymentStatus}</span>
          </div>

          {order.locationName && (
            <p className="text-xs text-gray-500">{order.locationName}</p>
          )}

          {/* Line items */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Items</p>
            <ul className="rounded-lg border border-gray-200 divide-y divide-gray-50">
              {order.lineItems.map((li) => (
                <li key={li.id} className="flex items-start justify-between px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{li.name}</p>
                    <p className="text-[10px] text-gray-400 tabular-nums mt-0.5">
                      {CURRENCY(li.unitPrice)} × {li.quantity}
                    </p>
                  </div>
                  <p className="font-mono text-gray-900 tabular-nums whitespace-nowrap">
                    {CURRENCY(li.totalPrice)}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          {/* Totals */}
          <div className="flex items-center justify-between text-sm font-bold text-gray-900 pt-2 border-t border-gray-100">
            <span>Total</span>
            <span className={`font-mono tabular-nums ${order.status === 'voided' ? 'line-through text-gray-400' : ''}`}>
              {CURRENCY(order.total)}
            </span>
          </div>

          {/* Void action */}
          <div className="pt-3 border-t border-gray-100">
            {canVoid ? (
              <form action={action}>
                <input type="hidden" name="order_id" value={order.id} />
                <button
                  type="submit"
                  disabled={pending}
                  className="w-full rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 px-4 py-2 text-xs font-semibold disabled:opacity-60 transition-colors"
                >
                  {pending ? 'Voiding…' : 'Void this order'}
                </button>
                <p className="mt-2 text-[10px] text-gray-400 leading-relaxed">
                  Voiding marks the order as corrected and reverses any inventory it depleted. The original record stays in the ledger for auditability.
                </p>
                {state?.error && <p className="text-[11px] text-red-600 mt-2">{state.error}</p>}
              </form>
            ) : (
              <p className="text-[11px] text-gray-400">This order is already voided.</p>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}
