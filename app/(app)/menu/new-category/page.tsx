'use client'

// ----------------------------------------------------------------
// New Category Page  →  /menu/new-category
//
// A simple form that creates a menu_categories row.
// Uses the same useActionState pattern as login/signup/onboarding.
//
// After successful creation, the server action redirects to /menu.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import Link from 'next/link'
import { createCategory } from '@/app/actions/menu'

export default function NewCategoryPage() {
  const [state, action, pending] = useActionState(createCategory, null)

  return (
    <div className="max-w-md">

      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">New category</h1>
        <p className="mt-1 text-sm text-gray-500">
          Categories group your menu items — e.g. Appetizers, Mains, Drinks.
        </p>
      </div>

      {/* Form card */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
        <form action={action} className="space-y-5">

          {/* Category name */}
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-gray-700 mb-1.5"
            >
              Category name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              autoFocus
              placeholder="e.g. Appetizers, Mains, Drinks"
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                         placeholder:text-gray-400
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
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
              {pending ? 'Creating…' : 'Create category'}
            </button>
          </div>

        </form>
      </div>

    </div>
  )
}
