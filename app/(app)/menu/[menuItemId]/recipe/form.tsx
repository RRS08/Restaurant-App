'use client'

// ----------------------------------------------------------------
// RecipeForm — Client Component
//
// Three sections:
//   1. Current recipe — shows existing ingredients with a "Remove" button
//   2. Add ingredient — dropdown of inventory items + quantity input
//   3. Quick-create — inline form to create a missing inventory item
//      without leaving the page
//
// After adding or removing an ingredient, the page re-fetches via
// revalidatePath (called in the server action), so the list updates.
// ----------------------------------------------------------------

import { useState, useActionState } from 'react'
import {
  addRecipeComponent,
  removeRecipeComponent,
  createInlineInventoryItem,
} from '@/app/actions/recipe'

interface InventoryItem {
  id: string
  name: string
  unit_of_measure: string
}

interface Component {
  id: string
  quantity_required: number
  inventory_items: InventoryItem | null
}

interface RecipeFormProps {
  menuItemId: string
  components: Component[]
  inventoryItems: InventoryItem[]
}

export default function RecipeForm({
  menuItemId,
  components,
  inventoryItems,
}: RecipeFormProps) {
  // State for the "add ingredient" form
  const [addState, addAction, addPending] = useActionState(addRecipeComponent, null)

  // State for the "quick-create inventory item" form
  const [createState, createAction, createPending] = useActionState(createInlineInventoryItem, null)

  // Toggle: show/hide the quick-create form
  const [showCreate, setShowCreate] = useState(false)

  // IDs of inventory items already in the recipe (to filter the dropdown)
  const usedIds = new Set(components.map((c) => (c.inventory_items as InventoryItem | null)?.id).filter(Boolean))
  const availableItems = inventoryItems.filter((item) => !usedIds.has(item.id))

  return (
    <div className="space-y-8">

      {/* ---- Section 1: Current recipe ---- */}
      <section>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
          Ingredients
          {components.length > 0 && (
            <span className="ml-2 text-gray-300">({components.length})</span>
          )}
        </h2>

        {components.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 bg-white p-8 text-center">
            <p className="text-sm text-gray-400">
              No ingredients yet. Add inventory items below to build this recipe.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {components.map((comp) => {
              const inv = comp.inventory_items as InventoryItem | null
              return (
                <div key={comp.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <span className="text-sm font-medium text-gray-900">
                      {inv?.name ?? 'Unknown item'}
                    </span>
                    <span className="ml-2 text-xs text-gray-400">
                      {Number(comp.quantity_required)} {inv?.unit_of_measure ?? ''}
                    </span>
                  </div>

                  {/* Remove button — a tiny form calling removeRecipeComponent */}
                  <form action={removeRecipeComponent}>
                    <input type="hidden" name="component_id" value={comp.id} />
                    <input type="hidden" name="menu_item_id" value={menuItemId} />
                    <button
                      type="submit"
                      className="text-xs text-red-500 hover:text-red-700 transition-colors"
                    >
                      Remove
                    </button>
                  </form>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ---- Section 2: Add ingredient ---- */}
      <section>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
          Add ingredient
        </h2>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <form action={addAction} className="space-y-4">
            <input type="hidden" name="menu_item_id" value={menuItemId} />

            {/* Inventory item dropdown */}
            <div>
              <label htmlFor="inventory_item_id" className="block text-sm font-medium text-gray-700 mb-1.5">
                Inventory item
              </label>
              {availableItems.length > 0 ? (
                <select
                  id="inventory_item_id"
                  name="inventory_item_id"
                  required
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                             focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select an ingredient…</option>
                  {availableItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.unit_of_measure})
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-gray-400 py-2">
                  No more inventory items available.{' '}
                  <button
                    type="button"
                    onClick={() => setShowCreate(true)}
                    className="text-blue-600 hover:underline"
                  >
                    Create one below
                  </button>
                </p>
              )}
            </div>

            {/* Quantity */}
            <div>
              <label htmlFor="quantity_required" className="block text-sm font-medium text-gray-700 mb-1.5">
                Quantity per 1 unit sold
              </label>
              <input
                id="quantity_required"
                name="quantity_required"
                type="number"
                required
                min="0.0001"
                step="0.0001"
                placeholder="e.g. 2"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                           placeholder:text-gray-400
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <p className="mt-1 text-xs text-gray-400">
                How much of this ingredient is used to make one of this menu item.
              </p>
            </div>

            {/* Error */}
            {addState?.error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
                <p className="text-sm text-red-700">{addState.error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={addPending || availableItems.length === 0}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold
                         text-white hover:bg-blue-700 transition-colors
                         disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {addPending ? 'Adding…' : 'Add to recipe'}
            </button>
          </form>
        </div>
      </section>

      {/* ---- Section 3: Quick-create inventory item ---- */}
      <section>
        {!showCreate ? (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="text-sm text-blue-600 hover:text-blue-500 transition-colors"
          >
            + Create a new inventory item
          </button>
        ) : (
          <div className="bg-gray-50 rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
                Quick-create inventory item
              </h2>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Cancel
              </button>
            </div>

            <form action={createAction} className="space-y-4">
              <input type="hidden" name="menu_item_id" value={menuItemId} />

              <div>
                <label htmlFor="create_name" className="block text-sm font-medium text-gray-700 mb-1.5">
                  Item name
                </label>
                <input
                  id="create_name"
                  name="name"
                  type="text"
                  required
                  placeholder="e.g. Tequila, Grapefruit Soda"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                             placeholder:text-gray-400
                             focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label htmlFor="create_uom" className="block text-sm font-medium text-gray-700 mb-1.5">
                  Unit of measure
                </label>
                <select
                  id="create_uom"
                  name="unit_of_measure"
                  defaultValue="units"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                             focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="units">Units (each)</option>
                  <option value="kg">Kilograms (kg)</option>
                  <option value="lbs">Pounds (lbs)</option>
                  <option value="liters">Liters</option>
                  <option value="gallons">Gallons</option>
                  <option value="oz">Ounces (oz)</option>
                  <option value="cases">Cases</option>
                  <option value="bags">Bags</option>
                </select>
              </div>

              {createState?.error && (
                <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
                  <p className="text-sm text-red-700">{createState.error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={createPending}
                className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold
                           text-white hover:bg-gray-800 transition-colors
                           disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {createPending ? 'Creating…' : 'Create item'}
              </button>
              <p className="text-xs text-gray-400">
                This creates a new inventory item. After creation, select it
                from the dropdown above to add it to this recipe.
              </p>
            </form>
          </div>
        )}
      </section>

    </div>
  )
}
