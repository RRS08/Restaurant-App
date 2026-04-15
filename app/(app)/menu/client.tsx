'use client'

import { useState, useRef, useEffect, useActionState } from 'react'
import {
  createMenuItemInSection,
  createCategory,
  deleteMenuItem,
  deleteCategory,
} from '@/app/actions/menu'
import {
  addRecipeComponent,
  removeRecipeComponent,
  createInlineInventoryItem,
} from '@/app/actions/recipe'

interface Category { id: string; name: string; sortOrder: number }
interface RecipeEntry {
  id: string; inventoryItemId: string; inventoryItemName: string
  unitOfMeasure: string; quantityRequired: number
}
interface MenuItem {
  id: string; name: string; currentPrice: number; active: boolean
  categoryId: string | null; source: string; recipe: RecipeEntry[]
}
interface InventoryItem { id: string; name: string; unitOfMeasure: string }
interface Props {
  categories: Category[]
  items: MenuItem[]
  inventoryItems: InventoryItem[]
}

export default function MenuClient({ categories, items, inventoryItems }: Props) {
  const [addSectionOpen, setAddSectionOpen] = useState(false)
  const [addItemTo, setAddItemTo] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null)

  const itemsByCategory = new Map<string, MenuItem[]>()
  for (const item of items) {
    const key = item.categoryId ?? '__none__'
    if (!itemsByCategory.has(key)) itemsByCategory.set(key, [])
    itemsByCategory.get(key)!.push(item)
  }

  const liveItem = selectedItem ? items.find((i) => i.id === selectedItem.id) ?? selectedItem : null

  return (
    <div className="max-w-6xl">

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Menu</h1>
          <p className="mt-1 text-sm text-gray-500">Add items to each section below.</p>
        </div>
        {/* Add section — button + anchored popover */}
        <div className="relative">
          <button type="button" onClick={() => setAddSectionOpen(!addSectionOpen)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-600
                       hover:bg-gray-50 transition-colors">
            + Add section
          </button>
          {addSectionOpen && (
            <Popover onClose={() => setAddSectionOpen(false)} className="right-0 top-full mt-1.5 w-72">
              <AddSectionForm onClose={() => setAddSectionOpen(false)} />
            </Popover>
          )}
        </div>
      </div>

      {/* Sections */}
      {categories.map((cat) => {
        const sectionItems = itemsByCategory.get(cat.id) ?? []
        return (
          <section key={cat.id} className="mb-10">
            <div className="flex items-center gap-4 mb-4">
              <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-widest whitespace-nowrap">{cat.name}</h2>
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-xs text-gray-400 whitespace-nowrap mr-2">
                {sectionItems.length} item{sectionItems.length !== 1 ? 's' : ''}
              </span>
              <form action={deleteCategory} className="flex-shrink-0">
                <input type="hidden" name="category_id" value={cat.id} />
                <button type="submit" title="Remove section" className="text-gray-300 hover:text-red-400 transition-colors p-0.5">
                  <XIcon size={14} />
                </button>
              </form>
            </div>

            {sectionItems.length > 0 && (
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 mb-4">
                {sectionItems.map((item) => (
                  <button key={item.id} type="button" onClick={() => setSelectedItem(item)}
                    className="bg-white rounded-xl border border-gray-200 p-4 text-left transition-all duration-150
                               hover:shadow-md hover:border-gray-300 hover:-translate-y-0.5 cursor-pointer group">
                    <div className="flex items-start justify-between">
                      <p className="text-sm font-semibold text-gray-900 group-hover:text-blue-700 transition-colors">{item.name}</p>
                      <span className="text-sm font-mono text-gray-600 ml-2 flex-shrink-0">${item.currentPrice.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      {item.recipe.length > 0 ? (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-50 text-green-600">
                          {item.recipe.length} ingredient{item.recipe.length !== 1 ? 's' : ''}
                        </span>
                      ) : (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-400">No recipe</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {sectionItems.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-200 bg-white p-6 text-center mb-4">
                <p className="text-sm text-gray-400">No items in this section yet.</p>
              </div>
            )}

            {/* Add item — anchored popover */}
            <div className="relative inline-block">
              <button type="button" onClick={() => setAddItemTo(addItemTo === cat.id ? null : cat.id)}
                className="text-xs font-medium text-blue-600 hover:text-blue-500 transition-colors">
                + Add item
              </button>
              {addItemTo === cat.id && (
                <Popover onClose={() => setAddItemTo(null)} className="left-0 top-full mt-1.5 w-72">
                  <AddItemForm categoryId={cat.id} onClose={() => setAddItemTo(null)} />
                </Popover>
              )}
            </div>
          </section>
        )
      })}

      {liveItem && (
        <ItemPanel item={liveItem} inventoryItems={inventoryItems} onClose={() => setSelectedItem(null)} />
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// Popover — anchored to parent (relative), closes on outside click
// ----------------------------------------------------------------
function Popover({ children, onClose, className = '' }: {
  children: React.ReactNode; onClose: () => void; className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [onClose])

  return (
    <div ref={ref} className={`absolute z-30 ${className}`}>
      <div className="bg-white rounded-xl border border-gray-200 shadow-lg p-4">{children}</div>
    </div>
  )
}

// ----------------------------------------------------------------
// AddSectionForm
// ----------------------------------------------------------------
function AddSectionForm({ onClose }: { onClose: () => void }) {
  const [state, action, pending] = useActionState(createCategory, null)
  return (
    <form action={(fd) => { action(fd); if (!state?.error) onClose() }} className="space-y-3">
      <p className="text-sm font-semibold text-gray-900">New section</p>
      <input name="name" type="text" required autoFocus placeholder="Section name"
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400
                   focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
      {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={pending}
          className="flex-1 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
          {pending ? 'Adding…' : 'Add'}
        </button>
        <button type="button" onClick={onClose}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
      </div>
    </form>
  )
}

// ----------------------------------------------------------------
// AddItemForm
// ----------------------------------------------------------------
function AddItemForm({ categoryId, onClose }: { categoryId: string; onClose: () => void }) {
  const [state, action, pending] = useActionState(createMenuItemInSection, null)
  return (
    <form action={(fd) => { action(fd); if (!state?.error) onClose() }} className="space-y-3">
      <p className="text-sm font-semibold text-gray-900">New item</p>
      <input type="hidden" name="category_id" value={categoryId} />
      <input name="name" type="text" required autoFocus placeholder="Item name"
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400
                   focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
        <input name="price" type="number" required min="0" step="0.01" placeholder="0.00"
          className="w-full rounded-lg border border-gray-300 pl-7 pr-3 py-2 text-sm placeholder:text-gray-400
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
      </div>
      {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
      <p className="text-[10px] text-gray-400">Add ingredients later from the item card.</p>
      <div className="flex gap-2">
        <button type="submit" disabled={pending}
          className="flex-1 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
          {pending ? 'Adding…' : 'Add'}
        </button>
        <button type="button" onClick={onClose}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
      </div>
    </form>
  )
}

// ----------------------------------------------------------------
// ItemPanel — slide-over with unified ingredient combobox
// ----------------------------------------------------------------
function ItemPanel({ item, inventoryItems, onClose }: {
  item: MenuItem; inventoryItems: InventoryItem[]; onClose: () => void
}) {
  const [addState, addAction, addPending] = useActionState(addRecipeComponent, null)
  const [createState, createAction, createPending] = useActionState(createInlineInventoryItem, null)
  const [deleteState, deleteAction, deletePending] = useActionState(deleteMenuItem, null)

  const usedIds = new Set(item.recipe.map((r) => r.inventoryItemId))
  const available = inventoryItems.filter((ii) => !usedIds.has(ii.id))

  // Combobox state
  const [query, setQuery] = useState('')
  const [comboOpen, setComboOpen] = useState(false)
  const [selectedIngredient, setSelectedIngredient] = useState<InventoryItem | null>(null)
  const [creatingNew, setCreatingNew] = useState(false)
  const comboRef = useRef<HTMLDivElement>(null)

  // Auto-select ingredient after creation succeeds
  useEffect(() => {
    if (createState && 'item' in createState && createState.item) {
      const created = createState.item
      setSelectedIngredient({ id: created.id, name: created.name, unitOfMeasure: created.unitOfMeasure })
      setQuery(created.name)
      setCreatingNew(false)
      setComboOpen(false)
    }
  }, [createState])

  const filtered = query.trim()
    ? available.filter((ii) => ii.name.toLowerCase().includes(query.toLowerCase()))
    : available

  const exactMatch = available.some((ii) => ii.name.toLowerCase() === query.trim().toLowerCase())

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) setComboOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  const selectIngredient = (ii: InventoryItem) => {
    setSelectedIngredient(ii)
    setQuery(ii.name)
    setComboOpen(false)
    setCreatingNew(false)
  }

  const startCreate = () => {
    setCreatingNew(true)
    setComboOpen(true) // keep dropdown open — don't force a second click
    setSelectedIngredient(null)
  }

  const resetCombo = () => {
    setQuery('')
    setSelectedIngredient(null)
    setCreatingNew(false)
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white border-l border-gray-200 shadow-xl z-50 overflow-y-auto">
        <div className="p-6">

          {/* Header */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <h2 className="text-lg font-bold text-gray-900">{item.name}</h2>
              <p className="text-sm text-gray-500 mt-0.5">${item.currentPrice.toFixed(2)}</p>
            </div>
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
              <XIcon size={20} />
            </button>
          </div>

          {/* Ingredients */}
          <div className="mb-6">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
              Ingredients ({item.recipe.length})
            </h3>

            {/* Existing list */}
            {item.recipe.length > 0 && (
              <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-50 mb-4">
                {item.recipe.map((rc) => (
                  <div key={rc.id} className="flex items-center justify-between px-3 py-2.5">
                    <div>
                      <p className="text-sm text-gray-900">{rc.inventoryItemName}</p>
                      <p className="text-xs text-gray-400">{rc.quantityRequired} {rc.unitOfMeasure}</p>
                    </div>
                    <form action={removeRecipeComponent}>
                      <input type="hidden" name="component_id" value={rc.id} />
                      <input type="hidden" name="menu_item_id" value={item.id} />
                      <button type="submit" className="text-gray-300 hover:text-red-400 p-1"><XIcon size={14} /></button>
                    </form>
                  </div>
                ))}
              </div>
            )}

            {item.recipe.length === 0 && (
              <p className="text-xs text-gray-400 mb-4">No ingredients yet. Search or create below.</p>
            )}

            {/* ---- Ingredient: one surface, two modes ---- */}
            <div className={`rounded-lg border p-3 ${creatingNew ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200'}`}>

              {/* === NORMAL MODE: search/select === */}
              {!creatingNew && (
                <>
                  <form action={(fd) => { addAction(fd); resetCombo() }}>
                    <input type="hidden" name="menu_item_id" value={item.id} />
                    <input type="hidden" name="inventory_item_id" value={selectedIngredient?.id ?? ''} />

                    <div ref={comboRef} className="relative">
                      <input
                        type="text"
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setComboOpen(true); setSelectedIngredient(null) }}
                        onFocus={() => setComboOpen(true)}
                        placeholder="Search or create ingredient…"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400
                                   focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />

                      {comboOpen && (
                        <div className="absolute left-0 right-0 top-full mt-1 bg-white rounded-lg border border-gray-200 shadow-lg z-10 overflow-hidden">
                          <div className="max-h-40 overflow-y-auto">
                            {filtered.map((ii) => (
                              <button key={ii.id} type="button" onClick={() => selectIngredient(ii)}
                                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors">
                                {ii.name} <span className="text-gray-400 text-xs">({ii.unitOfMeasure})</span>
                              </button>
                            ))}
                            {filtered.length === 0 && available.length > 0 && (
                              <p className="px-3 py-2 text-xs text-gray-400">No matches</p>
                            )}
                            {filtered.length === 0 && available.length === 0 && (
                              <p className="px-3 py-2 text-xs text-gray-400">All items already in recipe</p>
                            )}
                          </div>
                          <button type="button" onClick={startCreate}
                            className="w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors border-t border-gray-100">
                            {query.trim() && !exactMatch
                              ? <span>+ Create <strong>&quot;{query.trim()}&quot;</strong></span>
                              : '+ New ingredient'}
                          </button>
                        </div>
                      )}
                    </div>

                    {selectedIngredient && (
                      <div className="flex gap-2 mt-2">
                        <input name="quantity_required" type="number" required min="0.0001" step="0.0001"
                          autoFocus placeholder="Qty"
                          className="w-24 rounded-lg border border-gray-300 px-2.5 py-2 text-sm placeholder:text-gray-400
                                     focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        <button type="submit" disabled={addPending}
                          className="flex-1 px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium
                                     hover:bg-blue-700 disabled:opacity-60 transition-colors">
                          {addPending ? 'Adding…' : `Add ${selectedIngredient.name}`}
                        </button>
                      </div>
                    )}
                  </form>
                  {addState?.error && <p className="text-xs text-red-600 mt-2">{addState.error}</p>}
                </>
              )}

              {/* === CREATE MODE: same surface transforms === */}
              {creatingNew && (
                <form action={(fd) => { createAction(fd) }}>
                  <input type="hidden" name="menu_item_id" value={item.id} />
                  <input type="hidden" name="name" value={query.trim()} />

                  <p className="text-[10px] font-semibold text-blue-600 uppercase tracking-wider mb-2">New ingredient</p>

                  {/* Name — same position as the search input in normal mode */}
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                    placeholder="Ingredient name"
                    className="w-full rounded-lg border border-blue-300 px-3 py-2 text-sm placeholder:text-gray-400
                               focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent mb-2"
                  />

                  {/* Unit + actions */}
                  <div className="flex gap-2">
                    <select name="unit_of_measure" defaultValue="units"
                      className="flex-1 rounded-lg border border-blue-300 px-2.5 py-2 text-sm
                                 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent">
                      <option value="units">Units (each)</option>
                      <option value="kg">Kilograms</option>
                      <option value="lbs">Pounds</option>
                      <option value="liters">Liters</option>
                      <option value="oz">Ounces</option>
                      <option value="gallons">Gallons</option>
                      <option value="cases">Cases</option>
                      <option value="bags">Bags</option>
                    </select>
                    <button type="submit" disabled={createPending || !query.trim()}
                      className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium
                                 hover:bg-blue-700 disabled:opacity-60 transition-colors">
                      {createPending ? '…' : 'Create'}
                    </button>
                    <button type="button" onClick={() => setCreatingNew(false)}
                      className="px-3 py-2 rounded-lg border border-blue-300 text-xs text-blue-600 hover:bg-blue-100 transition-colors">
                      Back
                    </button>
                  </div>
                  {createState?.error && <p className="text-xs text-red-600 mt-2">{createState.error}</p>}
                </form>
              )}

            </div>
          </div>

          {/* Details */}
          <div className="mb-6">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Details</h3>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Price</span>
                <span className="font-mono text-gray-900">${item.currentPrice.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Status</span>
                <span className={item.active ? 'text-green-600' : 'text-gray-500'}>{item.active ? 'Active' : 'Inactive'}</span>
              </div>
            </div>
          </div>

          {/* Remove */}
          <div className="pt-4 border-t border-gray-100">
            <form action={deleteAction}>
              <input type="hidden" name="item_id" value={item.id} />
              <button type="submit" disabled={deletePending}
                className="text-xs text-red-500 hover:text-red-600 disabled:opacity-60 transition-colors">
                {deletePending ? 'Removing…' : 'Remove this item'}
              </button>
            </form>
            {deleteState?.error && (
              <p className="text-xs text-amber-600 mt-2">{deleteState.error}</p>
            )}
          </div>

        </div>
      </div>
    </>
  )
}

// Tiny X icon helper
function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}
