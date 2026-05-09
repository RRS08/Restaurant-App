'use client'

// ----------------------------------------------------------------
// NewTransactionForm — Client Component
//
// Logs a stock movement:
//   purchase   → stock arrived (user enters a positive number)
//   waste      → stock discarded (server auto-negates)
//   adjustment → correction after a count (user enters + or −)
//
// The server action handles sign logic:
//   - purchase: always stored as positive
//   - waste: always stored as negative
//   - adjustment: stored as entered
// So the user always enters a positive number for purchases and waste,
// and a signed number for adjustments.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import Link from 'next/link'
import { createInventoryTransaction } from '@/app/actions/inventory'

interface InventoryItem {
  id: string
  name: string
  unit_of_measure: string
}

export default function NewTransactionForm({ items }: { items: InventoryItem[] }) {
  const [state, action, pending] = useActionState(createInventoryTransaction, null)

  if (items.length === 0) {
    return (
      <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
        <p className="text-lg font-medium text-gray-400">No inventory items yet</p>
        <p className="mt-1 text-sm text-gray-300">
          <Link href="/inventory/new-item" className="text-blue-600 hover:underline">
            Create an inventory item
          </Link>{' '}
          before logging a transaction.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
      <form action={action} className="space-y-5">

        {/* Inventory item */}
        <div>
          <label htmlFor="inventory_item_id" className="block text-sm font-medium text-gray-700 mb-1.5">
            Inventory item
          </label>
          <select
            id="inventory_item_id"
            name="inventory_item_id"
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">Select an item…</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.unit_of_measure})
              </option>
            ))}
          </select>
        </div>

        {/* Transaction type */}
        <div>
          <label htmlFor="transaction_type" className="block text-sm font-medium text-gray-700 mb-1.5">
            Type
          </label>
          <select
            id="transaction_type"
            name="transaction_type"
            required
            defaultValue="purchase"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="purchase">Purchase (received stock)</option>
            <option value="waste">Waste (discarded)</option>
            <option value="adjustment">Adjustment (correction)</option>
          </select>
        </div>

        {/* Quantity */}
        <div>
          <label htmlFor="quantity_change" className="block text-sm font-medium text-gray-700 mb-1.5">
            Quantity
          </label>
          <input
            id="quantity_change"
            name="quantity_change"
            type="number"
            required
            min="0.01"
            step="0.01"
            placeholder="0.00"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                       placeholder:text-gray-400
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="mt-1 text-xs text-gray-400">
            Enter a positive number. The sign is set automatically based on the type.
          </p>
        </div>

        {/* Unit cost (optional) */}
        <div>
          <label htmlFor="unit_cost" className="block text-sm font-medium text-gray-700 mb-1.5">
            Unit cost{' '}
            <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
            <input
              id="unit_cost"
              name="unit_cost"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              className="w-full rounded-lg border border-gray-300 pl-7 pr-3 py-2.5 text-sm
                         placeholder:text-gray-400
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Reference note (optional) */}
        <div>
          <label htmlFor="reference_note" className="block text-sm font-medium text-gray-700 mb-1.5">
            Note{' '}
            <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            id="reference_note"
            name="reference_note"
            type="text"
            placeholder="e.g. Supplier invoice #1234, expired batch"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                       placeholder:text-gray-400
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Error */}
        {state?.error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
            <p className="text-sm text-red-700">{state.error}</p>
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-3 pt-1">
          <Link
            href="/inventory"
            className="flex-1 text-center rounded-lg border border-gray-300 px-4 py-2.5
                       text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={pending}
            className="flex-1 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold
                       text-white hover:bg-gray-800 transition-colors
                       disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {pending ? 'Saving…' : 'Log transaction'}
          </button>
        </div>

      </form>
    </div>
  )
}
