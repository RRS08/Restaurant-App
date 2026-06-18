'use client'

// ----------------------------------------------------------------
// NewCategoryForm — Client Component
//
// Receives `lang` from the parent Server Component and renders the
// interactive form. Splitting was necessary because we need
// useActionState (a hook) here, but the server-only `getLang`
// helper has to live in the page above.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import Link from 'next/link'
import { createCategory } from '@/app/actions/menu'
import { makeT, type Lang } from '@/lib/i18n'

export default function NewCategoryForm({ lang }: { lang: Lang }) {
  const t = makeT(lang)
  const [state, action, pending] = useActionState(createCategory, null)

  return (
    <div className="max-w-md">

      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{t('New category', 'Nueva categoría')}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t('Categories group your menu items — e.g. Appetizers, Mains, Drinks.', 'Las categorías agrupan los artículos del menú — p. ej. Entradas, Principales, Bebidas.')}
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
              {t('Category name', 'Nombre de la categoría')}
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              autoFocus
              placeholder={t('e.g. Appetizers, Mains, Drinks', 'p. ej. Entradas, Principales, Bebidas')}
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
              {t('Cancel', 'Cancelar')}
            </Link>
            <button
              type="submit"
              disabled={pending}
              className="flex-1 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold
                         text-white hover:bg-gray-800 transition-colors
                         disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {pending ? t('Creating…', 'Creando…') : t('Create category', 'Crear categoría')}
            </button>
          </div>

        </form>
      </div>

    </div>
  )
}
