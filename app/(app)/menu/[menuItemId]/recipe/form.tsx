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

import { useState, useActionState, useMemo } from 'react'
import {
  addRecipeComponent,
  removeRecipeComponent,
  createInlineInventoryItem,
} from '@/app/actions/recipe'
import { makeT, type Lang } from '@/lib/i18n'
import { UNIT_GROUPS, normalizeUnit, convertQty, labelFor } from '@/lib/units'

interface InventoryItem {
  id: string
  name: string
  unit_of_measure: string
}

interface Component {
  id: string
  quantity_required: number
  /** Recipe's own unit — nullable, null = same as the linked
   *  inventory item's unit. Rendered in the "current recipe" list. */
  unit: string | null
  inventory_items: InventoryItem | null
}

interface RecipeFormProps {
  menuItemId: string
  components: Component[]
  inventoryItems: InventoryItem[]
  lang: Lang
}

export default function RecipeForm({
  menuItemId,
  components,
  inventoryItems,
  lang,
}: RecipeFormProps) {
  const t = makeT(lang)
  // State for the "add ingredient" form
  const [addState, addAction, addPending] = useActionState(addRecipeComponent, null)

  // State for the "quick-create inventory item" form
  const [createState, createAction, createPending] = useActionState(createInlineInventoryItem, null)

  // Toggle: show/hide the quick-create form
  const [showCreate, setShowCreate] = useState(false)

  // IDs of inventory items already in the recipe (to filter the dropdown)
  const usedIds = new Set(components.map((c) => (c.inventory_items as InventoryItem | null)?.id).filter(Boolean))
  const availableItems = inventoryItems.filter((item) => !usedIds.has(item.id))

  // Selected ingredient + recipe unit + quantity — hoisted so the
  // unit picker can restrict options to the ingredient's family and
  // show a live "= X.XX <invUnit>" preview.
  const [selectedInvId, setSelectedInvId] = useState<string>('')
  const [qty, setQty] = useState<string>('')
  const [recipeUnit, setRecipeUnit] = useState<string>('')

  const selectedInv = useMemo(
    () => availableItems.find((i) => i.id === selectedInvId) ?? null,
    [availableItems, selectedInvId],
  )
  const invCanonical = selectedInv ? normalizeUnit(selectedInv.unit_of_measure) : null

  // Unit picker options track the selected ingredient. Reset the
  // picked unit whenever the ingredient changes so a stale mass
  // pick doesn't survive into a volume ingredient.
  const unitOptions: { code: string; label: string }[] = useMemo(() => {
    if (!selectedInv) return []
    if (!invCanonical) return [{ code: selectedInv.unit_of_measure, label: selectedInv.unit_of_measure || 'unit' }]
    const opts: { code: string; label: string }[] = []
    for (const grp of UNIT_GROUPS) {
      if (grp.units.some((u) => u === invCanonical)) {
        for (const u of grp.units) opts.push({ code: u, label: labelFor(u) })
      }
    }
    return opts
  }, [selectedInv, invCanonical])

  // Default the picked unit to the ingredient's own canonical unit
  // whenever the ingredient changes.
  const effectiveRecipeUnit = recipeUnit || (invCanonical ?? selectedInv?.unit_of_measure ?? '')

  const preview = (() => {
    const n = parseFloat(qty)
    if (!Number.isFinite(n) || n <= 0) return null
    if (!invCanonical) return null
    const canonPick = normalizeUnit(effectiveRecipeUnit)
    if (!canonPick || canonPick === invCanonical) return null
    const converted = convertQty(n, canonPick, invCanonical)
    if (converted === null) return null
    const rounded = converted < 0.01 ? converted.toPrecision(2) : converted.toFixed(2).replace(/\.?0+$/, '')
    return t(
      `≈ ${rounded} ${labelFor(invCanonical)} of ${selectedInv?.name ?? ''}`,
      `≈ ${rounded} ${labelFor(invCanonical)} de ${selectedInv?.name ?? ''}`,
    )
  })()

  return (
    <div className="space-y-8">

      {/* ---- Section 1: Current recipe ---- */}
      <section>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
          {t('Ingredients', 'Ingredientes')}
          {components.length > 0 && (
            <span className="ml-2 text-gray-300">({components.length})</span>
          )}
        </h2>

        {components.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 bg-white p-8 text-center">
            <p className="text-sm text-gray-400">
              {t('No ingredients yet. Add inventory items below to build this recipe.', 'Aún no hay ingredientes. Agrega artículos del inventario abajo para armar esta receta.')}
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
                      {inv?.name ?? t('Unknown item', 'Artículo desconocido')}
                    </span>
                    <span className="ml-2 text-xs text-gray-400">
                      {Number(comp.quantity_required)} {comp.unit ?? inv?.unit_of_measure ?? ''}
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
                      {t('Remove', 'Eliminar')}
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
          {t('Add ingredient', 'Agregar ingrediente')}
        </h2>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <form action={addAction} className="space-y-4">
            <input type="hidden" name="menu_item_id" value={menuItemId} />

            {/* Inventory item dropdown */}
            <div>
              <label htmlFor="inventory_item_id" className="block text-sm font-medium text-gray-700 mb-1.5">
                {t('Inventory item', 'Artículo de inventario')}
              </label>
              {availableItems.length > 0 ? (
                <select
                  id="inventory_item_id"
                  name="inventory_item_id"
                  required
                  value={selectedInvId}
                  onChange={(e) => {
                    setSelectedInvId(e.target.value)
                    setRecipeUnit('')
                  }}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                             focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">{t('Select an ingredient…', 'Selecciona un ingrediente…')}</option>
                  {availableItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.unit_of_measure})
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-gray-400 py-2">
                  {t('No more inventory items available.', 'No hay más artículos de inventario disponibles.')}{' '}
                  <button
                    type="button"
                    onClick={() => setShowCreate(true)}
                    className="text-blue-600 hover:underline"
                  >
                    {t('Create one below', 'Crea uno abajo')}
                  </button>
                </p>
              )}
            </div>

            {/* Quantity + unit picker. Unit options are gated on
                the picked ingredient — a Weight ingredient only
                offers Weight units, so a recipe can measure in oz
                even when inventory is tracked in lb. Live preview
                below shows what actually depletes. */}
            <div>
              <label htmlFor="quantity_required" className="block text-sm font-medium text-gray-700 mb-1.5">
                {t('Quantity per 1 unit sold', 'Cantidad por 1 unidad vendida')}
              </label>
              <div className="flex items-stretch gap-2">
                <input
                  id="quantity_required"
                  name="quantity_required"
                  type="number"
                  required
                  min="0.0001"
                  step="0.0001"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder={t('e.g. 2', 'p. ej. 2')}
                  className="flex-1 min-w-0 rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                             placeholder:text-gray-400
                             focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <select
                  name="unit"
                  value={effectiveRecipeUnit}
                  onChange={(e) => setRecipeUnit(e.target.value)}
                  disabled={!selectedInv || unitOptions.length <= 1}
                  className="rounded-lg border border-gray-300 px-2 py-2.5 text-sm text-gray-700
                             focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                             disabled:opacity-60"
                >
                  {selectedInv ? (
                    unitOptions.map((o) => (
                      <option key={o.code} value={o.code}>{o.label}</option>
                    ))
                  ) : (
                    <option value="">{t('Pick ingredient first', 'Elige ingrediente primero')}</option>
                  )}
                </select>
              </div>
              <p className="mt-1 text-xs text-gray-400">
                {t('How much of this ingredient is used to make one of this menu item.', 'Cuánto de este ingrediente se usa para preparar uno de este artículo del menú.')}
              </p>
              {preview && (
                <p className="mt-1 text-[11px] text-gray-500 font-mono tabular-nums">{preview}</p>
              )}
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
              className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold
                         text-white hover:bg-gray-800 transition-colors
                         disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {addPending ? t('Adding…', 'Agregando…') : t('Add to recipe', 'Agregar a la receta')}
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
            {t('+ Create a new inventory item', '+ Crear un nuevo artículo de inventario')}
          </button>
        ) : (
          <div className="bg-gray-50 rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
                {t('Quick-create inventory item', 'Crear artículo de inventario rápido')}
              </h2>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                {t('Cancel', 'Cancelar')}
              </button>
            </div>

            <form action={createAction} className="space-y-4">
              <input type="hidden" name="menu_item_id" value={menuItemId} />

              <div>
                <label htmlFor="create_name" className="block text-sm font-medium text-gray-700 mb-1.5">
                  {t('Item name', 'Nombre del artículo')}
                </label>
                <input
                  id="create_name"
                  name="name"
                  type="text"
                  required
                  placeholder={t('e.g. Tequila, Grapefruit Soda', 'p. ej. Tequila, Refresco de Toronja')}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm
                             placeholder:text-gray-400
                             focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label htmlFor="create_uom" className="block text-sm font-medium text-gray-700 mb-1.5">
                  {t('Unit of measure', 'Unidad de medida')}
                </label>
                <select
                  id="create_uom"
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
                {createPending ? t('Creating…', 'Creando…') : t('Create item', 'Crear artículo')}
              </button>
              <p className="text-xs text-gray-400">
                {t('This creates a new inventory item. After creation, select it from the dropdown above to add it to this recipe.', 'Esto crea un nuevo artículo de inventario. Después de crearlo, selecciónalo en el menú desplegable de arriba para agregarlo a esta receta.')}
              </p>
            </form>
          </div>
        )}
      </section>

    </div>
  )
}
