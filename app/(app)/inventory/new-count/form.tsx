'use client'

// ----------------------------------------------------------------
// NewCountForm — Client Component
//
// Records a point-in-time count: "we have X on hand right now."
// The user picks an inventory item and enters the quantity.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import Link from 'next/link'
import { createInventoryCount } from '@/app/actions/inventory'

interface InventoryItem {
  id: string
  name: string
  unit_of_measure: string
}

export default function NewCountForm({ items }: { items: InventoryItem[] }) {
  const [state, action, pending] = useActionState(createInventoryCount, null)

  if (items.length === 0) {
    return (
      <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-16 text-center">
        <p className="text-lg font-medium text-gray-400">No inventory items yet</p>
        <p className="mt-1 text-sm text-gray-300">
          <Link href="/inventory/new-item" className="text-blue-600 hover:underline">
            Create an inventory item
          </Link>{' '}
          before recording a count.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
      <form action={action} className="space-y-5">

        {/* Inventory item dropdown */}
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

        {/* Quantity on hand */}
        <div>
          <label htmlFor="quantity_on_hand" className="block text-sm font-medium text-gray-700 mb-1.5">
            Quantity on hand
          </label>
          <input
            id="quantity_on_hand"
            name="quantity_on_hand"
            type="number"
            required
            min="0"
            step="0.01"
            placeholder="0.00"
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
            {pending ? 'Saving…' : 'Save count'}
          </button>
        </div>

      </form>
    </div>
  )
}
