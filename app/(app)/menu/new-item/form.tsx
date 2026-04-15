'use client'

// ----------------------------------------------------------------
// NewItemForm — Client Component
//
// Receives the list of categories from the parent Server Component
// and renders the interactive form.
//
// WHY is this a separate file?
//   The parent page.tsx is a Server Component (needs DB access to
//   fetch categories). This form needs useActionState (a hook),
//   which only works in Client Components. Splitting them is the
//   standard Next.js pattern: "Server fetches, Client interacts."
// ----------------------------------------------------------------

import { useActionState } from 'react'
import Link from 'next/link'
import { createMenuItem } from '@/app/actions/menu'

interface Category {
  id: string
  name: string
}

export default function NewItemForm({ categories }: { categories: Category[] }) {
  const [state, action, pending] = useActionState(createMenuItem, null)

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
      <form action={action} className="space-y-5">

        {/* Item name */}
        <div>
          <label
            htmlFor="name"
            className="block text-sm font-medium text-gray-700 mb-1.5"
          >
            Item name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            autoFocus
            placeholder="e.g. Margherita Pizza"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                       placeholder:text-gray-400
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Price */}
        <div>
          <label
            htmlFor="price"
            className="block text-sm font-medium text-gray-700 mb-1.5"
          >
            Price
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
            <input
              id="price"
              name="price"
              type="number"
              required
              min="0"
              step="0.01"
              placeholder="0.00"
              className="w-full rounded-lg border border-gray-300 pl-7 pr-3 py-2.5 text-sm
                         placeholder:text-gray-400
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Category dropdown */}
        <div>
          <label
            htmlFor="category_id"
            className="block text-sm font-medium text-gray-700 mb-1.5"
          >
            Category
          </label>
          {categories.length > 0 ? (
            <select
              id="category_id"
              name="category_id"
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">No category</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm text-gray-400 py-2">
              No categories yet.{' '}
              <Link href="/menu/new-category" className="text-blue-600 hover:underline">
                Create one first
              </Link>
            </p>
          )}
        </div>

        {/* Error from server action */}
        {state?.error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
            <p className="text-sm text-red-700">{state.error}</p>
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-3 pt-1">
          <Link
            href="/menu"
            className="flex-1 text-center rounded-lg border border-gray-300 px-4 py-2.5
                       text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={pending}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold
                       text-white hover:bg-blue-700 transition-colors
                       disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {pending ? 'Adding…' : 'Add to menu'}
          </button>
        </div>

      </form>
    </div>
  )
}
