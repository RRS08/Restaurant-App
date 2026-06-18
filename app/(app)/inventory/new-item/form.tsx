'use client'

// ----------------------------------------------------------------
// NewInventoryItemForm — Client Component
//
// A simple form to create a new ingredient/product to track.
// This doesn't set a quantity — it just registers the item.
// Quantities are set via counts or transactions.
// ----------------------------------------------------------------

import { useActionState } from 'react'
import Link from 'next/link'
import { createInventoryItem } from '@/app/actions/inventory'
import { makeT, type Lang } from '@/lib/i18n'

export default function NewInventoryItemForm({ lang }: { lang: Lang }) {
  const t = makeT(lang)
  const [state, action, pending] = useActionState(createInventoryItem, null)

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
      <form action={action} className="space-y-5">

        {/* Item name */}
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1.5">
            {t('Item name', 'Nombre del artículo')}
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            autoFocus
            placeholder={t('e.g. Mozzarella Cheese, Olive Oil, Napkins', 'ej. Queso mozzarella, aceite de oliva, servilletas')}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                       placeholder:text-gray-400
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Unit of measure */}
        <div>
          <label htmlFor="unit_of_measure" className="block text-sm font-medium text-gray-700 mb-1.5">
            {t('Unit of measure', 'Unidad de medida')}
          </label>
          <select
            id="unit_of_measure"
            name="unit_of_measure"
            defaultValue="units"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="units">{t('Units (each)', 'Unidades (cada uno)')}</option>
            <option value="kg">{t('Kilograms (kg)', 'Kilogramos (kg)')}</option>
            <option value="lbs">{t('Pounds (lbs)', 'Libras (lbs)')}</option>
            <option value="liters">{t('Liters', 'Litros')}</option>
            <option value="gallons">{t('Gallons', 'Galones')}</option>
            <option value="oz">{t('Ounces (oz)', 'Onzas (oz)')}</option>
            <option value="cases">{t('Cases', 'Cajas')}</option>
            <option value="bags">{t('Bags', 'Bolsas')}</option>
          </select>
        </div>

        {/* Low stock threshold */}
        <div>
          <label htmlFor="low_stock_threshold" className="block text-sm font-medium text-gray-700 mb-1.5">
            {t('Low stock threshold', 'Umbral de bajo stock')}
          </label>
          <input
            id="low_stock_threshold"
            name="low_stock_threshold"
            type="number"
            min="0"
            step="0.01"
            defaultValue="5"
            placeholder="5"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                       placeholder:text-gray-400
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="mt-1 text-xs text-gray-400">
            {t('You’ll see a “Low” warning when stock drops to this level or below.', 'Verás una advertencia de “Bajo” cuando el stock baje a este nivel o menos.')}
          </p>
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
            {t('Cancel', 'Cancelar')}
          </Link>
          <button
            type="submit"
            disabled={pending}
            className="flex-1 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold
                       text-white hover:bg-gray-800 transition-colors
                       disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {pending ? t('Creating…', 'Creando…') : t('Create item', 'Crear artículo')}
          </button>
        </div>

      </form>
    </div>
  )
}
