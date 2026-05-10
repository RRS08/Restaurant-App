'use client'

// ----------------------------------------------------------------
// Menu Client
//
// Family-aligned with Finance / Staffing / Sales / Inventory:
//
//   • Page header uses the family's `text-[28px] font-semibold tracking-tight`
//     title + mode-aware subtitle + small data-source pill on the
//     right (parallel to Sales' SourceChip).
//   • A 3-cell operational stats strip (Sections / Items / With recipe)
//     gives the page a stable top rhythm without adding analytics.
//   • A "Menu structure" eyebrow + flex-1 divider + count meta sets up
//     the section list below — same band anatomy as Sales' Recent
//     activity strip.
//   • Sections render as eyebrow-led bands with right-aligned scope
//     metadata + an "Add item" pill + a 2-step "Remove section"
//     confirmation. No more tiny X with instant delete.
//   • Item cards use the family card chrome (rounded-xl border-gray-200/80
//     shadow-[0_1px_2px_rgba(0,0,0,0.03)]) with calm hover, a strong
//     selected state when the drawer is open, and dimmed treatment for
//     inactive items.
//   • The drawer is rebuilt to match the Sales / Finance drawer family:
//     `flex flex-col` aside, sticky labeled header, full-bleed inactive
//     ribbon, scrollable body opening with a stats strip, and a pinned
//     footer "Manage" zone that hosts the destructive remove action with
//     audit-minded copy + a 2-step confirmation.
//
// What this pass intentionally does NOT do:
//   • Reinvent the section/item structural concept.
//   • Add reporting, finance, or analytics widgets.
//   • Add new server actions or change DB shape.
// ----------------------------------------------------------------

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
import MenuImportPanel from './import-panel'

// ================================================================
// Domain types
// ================================================================

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
interface ExternalConnection {
  id: string
  locationId: string
  provider: string
  active: boolean
  externalStoreId: string | null
  lastMenuSyncAt: string | null
  lastError: string | null
}
interface Props {
  categories: Category[]
  items: MenuItem[]
  inventoryItems: InventoryItem[]
  operatingMode?: 'native_pos' | 'external_pos' | null
  locations?: { id: string; name: string }[]
  externalConnections?: ExternalConnection[]
  isDev?: boolean
}

type OperatingMode = 'native_pos' | 'external_pos' | null

function isImportedSource(source: string): boolean {
  return source !== 'manual' && source.length > 0
}

// Single source of truth for "is this menu item mapped to inventory?"
//
// One or more linked recipe components → mapped. Several places used
// to inline `item.recipe.length > 0` directly; routing every check
// through this helper guarantees an item with even a SINGLE ingredient
// is consistently treated as mapped at the card, the page-level
// "With recipe" stat, and the drawer status. If you ever need to
// extend the rule (e.g. require active inventory_items only), this
// is the one place to change it.
function hasRecipe(item: MenuItem): boolean {
  return item.recipe.length > 0
}

const fmtMoney = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ================================================================
// Page
// ================================================================

export default function MenuClient({
  categories,
  items,
  inventoryItems,
  operatingMode = null,
  locations = [],
  externalConnections = [],
  isDev = false,
}: Props) {
  const isExternal = operatingMode === 'external_pos'

  const subtitle = isExternal
    ? 'Review imported items and adjust the menu surface your guests see.'
    : operatingMode === 'native_pos'
      ? 'Build the menu your in-app POS reads from. Sections group items, ingredients map them to inventory.'
      : 'Organize your sections and items here. Ingredients map each item back to inventory.'

  const [addSectionOpen, setAddSectionOpen] = useState(false)
  const [addItemTo, setAddItemTo] = useState<string | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)

  const itemsByCategory = new Map<string, MenuItem[]>()
  for (const item of items) {
    const key = item.categoryId ?? '__none__'
    if (!itemsByCategory.has(key)) itemsByCategory.set(key, [])
    itemsByCategory.get(key)!.push(item)
  }

  const liveItem = selectedItemId ? items.find((i) => i.id === selectedItemId) ?? null : null

  // Close drawer if the open item disappears (deleted, archived, etc.).
  useEffect(() => {
    if (selectedItemId && !items.find((i) => i.id === selectedItemId)) setSelectedItemId(null)
  }, [items, selectedItemId])

  return (
    <div className="max-w-[1200px]">

      {/* ================================================================ */}
      {/* 1. HEADER                                                        */}
      {/* The page header is intentionally just identity now —             */}
      {/* title + subtitle + source-of-truth chip. The "+ Add section"     */}
      {/* control was pulled out of here and placed directly above the     */}
      {/* section list so it reads as part of the menu-building surface,   */}
      {/* not as page chrome floating in the corner.                       */}
      {/* ================================================================ */}
      <div className="mb-7 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">Menu</h1>
          <p className="mt-1.5 text-sm text-gray-500">{subtitle}</p>
        </div>
        <SourceChip operatingMode={operatingMode} />
      </div>

      {/* External-branch import panel (unchanged behavior). */}
      {isExternal && (
        <MenuImportPanel
          locations={locations}
          connections={externalConnections}
          isDev={isDev}
        />
      )}

      {/* ================================================================ */}
      {/* 2. SECTIONS                                                      */}
      {/* The old "Menu structure" eyebrow band is gone — having a label   */}
      {/* layer right under the page title was reading as a second title.  */}
      {/* The page title + the section eyebrows below carry the structure  */}
      {/* on their own. A single right-aligned action row lives just above */}
      {/* the section list to anchor "+ Add section" to the actual         */}
      {/* menu-building surface.                                            */}
      {/* ================================================================ */}
      {categories.length === 0 ? (
        <EmptyMenuState onAddSection={() => setAddSectionOpen(true)} />
      ) : (
        <>
          <div className="mb-4 flex items-center justify-end">
            <div className="relative">
              <button
                type="button"
                onClick={() => setAddSectionOpen((o) => !o)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
              >
                + Add section
              </button>
              {addSectionOpen && (
                <Popover onClose={() => setAddSectionOpen(false)} className="right-0 top-full mt-1.5 w-72">
                  <AddSectionForm onClose={() => setAddSectionOpen(false)} />
                </Popover>
              )}
            </div>
          </div>

          <div className="space-y-8">
            {categories.map((cat) => {
              const sectionItems = itemsByCategory.get(cat.id) ?? []
              return (
                <SectionBlock
                  key={cat.id}
                  category={cat}
                  items={sectionItems}
                  selectedItemId={selectedItemId}
                  onOpenItem={setSelectedItemId}
                  addItemOpen={addItemTo === cat.id}
                  onToggleAddItem={() => setAddItemTo((t) => (t === cat.id ? null : cat.id))}
                  onCloseAddItem={() => setAddItemTo(null)}
                />
              )
            })}
          </div>
        </>
      )}

      {/* DRAWER */}
      {liveItem && (
        <ItemDrawer
          item={liveItem}
          sectionName={categories.find((c) => c.id === liveItem.categoryId)?.name ?? null}
          inventoryItems={inventoryItems}
          onClose={() => setSelectedItemId(null)}
        />
      )}
    </div>
  )
}

// ================================================================
// SourceChip — page-level data-origin pill, parallel to Sales'.
// ================================================================
function SourceChip({ operatingMode }: { operatingMode: OperatingMode }) {
  const variants: Record<NonNullable<OperatingMode> | 'unset', { label: string; tone: string; dot: string }> = {
    native_pos: { label: 'Native menu', tone: 'text-blue-700', dot: 'bg-blue-500' },
    external_pos: { label: 'Imported menu', tone: 'text-indigo-700', dot: 'bg-indigo-500' },
    unset: { label: 'Operating mode not set', tone: 'text-gray-600', dot: 'bg-gray-400' },
  }
  const v = variants[operatingMode ?? 'unset']
  return (
    <div className="hidden sm:inline-flex items-center gap-2 self-start text-[11px] font-medium px-3 py-1.5 rounded-full border border-gray-200/80 bg-white/80 backdrop-blur-sm shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <span className={`w-1.5 h-1.5 rounded-full ${v.dot}`} />
      <span className={v.tone}>{v.label}</span>
    </div>
  )
}

// ================================================================
// EmptyMenuState — the no-sections nudge.
// ================================================================
function EmptyMenuState({ onAddSection }: { onAddSection: () => void }) {
  return (
    <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white px-6 py-16 text-center">
      <p className="text-sm font-semibold text-gray-700">No menu sections yet</p>
      <p className="mx-auto mt-2 max-w-sm text-xs text-gray-500 leading-relaxed">
        Sections group items the way you want them to appear at the POS. Add your first one to start building.
      </p>
      <button
        type="button"
        onClick={onAddSection}
        className="mt-4 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
      >
        + Add section
      </button>
    </div>
  )
}

// ================================================================
// SectionBlock — eyebrow band + items grid + 2-step remove.
// ================================================================
function SectionBlock({
  category,
  items,
  selectedItemId,
  onOpenItem,
  addItemOpen,
  onToggleAddItem,
  onCloseAddItem,
}: {
  category: Category
  items: MenuItem[]
  selectedItemId: string | null
  onOpenItem: (id: string) => void
  addItemOpen: boolean
  onToggleAddItem: () => void
  onCloseAddItem: () => void
}) {
  // deleteCategory is a direct (formData) -> void server action — not
  // a useActionState-shaped one — so we use a plain <form action={...}>
  // here and drive the 2-step confirmation purely via local state.
  const [removeMode, setRemoveMode] = useState(false)

  return (
    <section>
      {/* Section header — quieted.
          Mapped count was removed from this row: per-item mapping is
          surfaced on the card itself, and the page-level "With recipe"
          stat covers the aggregate. The header now carries only what
          identifies and quietly counts the section. "+ Add item" was
          pulled out of this row and placed below the cards as a softer
          local action — repeating it across every section header read
          too heavy. */}
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-700 whitespace-nowrap">
          {category.name}
        </h2>
        <span className="flex-1 h-px bg-gray-200/70" />
        <p className="text-[11px] text-gray-400 tabular-nums whitespace-nowrap">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </p>
        {!removeMode ? (
          <button
            type="button"
            onClick={() => setRemoveMode(true)}
            aria-label="Remove section"
            title="Remove section"
            className="text-gray-300 hover:text-red-500 transition-colors p-1 rounded-md hover:bg-red-50"
          >
            <XIcon size={14} />
          </button>
        ) : (
          <form action={deleteCategory} className="flex items-center gap-1">
            <input type="hidden" name="category_id" value={category.id} />
            <button
              type="submit"
              className="text-[10px] font-semibold px-2 py-1 rounded-md border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 transition-colors"
            >
              Remove section
            </button>
            <button
              type="button"
              onClick={() => setRemoveMode(false)}
              className="text-[10px] font-medium px-2 py-1 rounded-md border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </form>
        )}
      </div>

      {/* Section body */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white px-6 py-8 text-center">
          <p className="text-xs text-gray-500">No items in this section yet.</p>
          <div className="relative inline-block mt-2">
            <button
              type="button"
              onClick={onToggleAddItem}
              className="text-[11px] font-medium text-blue-600 hover:text-blue-500 transition-colors"
            >
              + Add first item
            </button>
            {addItemOpen && (
              <Popover onClose={onCloseAddItem} className="left-1/2 -translate-x-1/2 top-full mt-1.5 w-72">
                <AddItemForm categoryId={category.id} onClose={onCloseAddItem} />
              </Popover>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                selected={selectedItemId === item.id}
                onClick={() => onOpenItem(item.id)}
              />
            ))}
          </div>

          {/* Soft local "+ Add item" — sits under the cards as a quiet
              text link rather than a repeated header pill. Anchors a
              popover the same way the page-level Add section button does. */}
          <div className="relative mt-3 inline-block">
            <button
              type="button"
              onClick={onToggleAddItem}
              className="text-[11px] font-medium text-blue-600 hover:text-blue-500 transition-colors"
            >
              + Add item
            </button>
            {addItemOpen && (
              <Popover onClose={onCloseAddItem} className="left-0 top-full mt-1.5 w-72">
                <AddItemForm categoryId={category.id} onClose={onCloseAddItem} />
              </Popover>
            )}
          </div>
        </>
      )}
    </section>
  )
}

// ================================================================
// ItemCard — productized list-card object.
// ================================================================
function ItemCard({
  item,
  selected,
  onClick,
}: {
  item: MenuItem
  selected: boolean
  onClick: () => void
}) {
  const isInactive = !item.active
  const ringClass = selected
    ? 'border-blue-500 shadow-[0_0_0_2px_rgba(59,130,246,0.15)]'
    : 'border-gray-200/80 hover:border-gray-300'

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`group relative text-left rounded-xl border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] p-4 transition-all duration-150 hover:shadow-md ${ringClass} ${isInactive ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p
          className={`text-sm font-semibold truncate transition-colors ${
            selected ? 'text-blue-700' : 'text-gray-900 group-hover:text-blue-700'
          }`}
        >
          {item.name}
        </p>
        <span
          className={`text-[13px] font-mono tabular-nums flex-shrink-0 ${
            selected ? 'text-gray-900 font-semibold' : 'text-gray-700'
          }`}
        >
          {fmtMoney(item.currentPrice)}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
        {hasRecipe(item) ? (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-50 text-green-700">
            {item.recipe.length} ingredient{item.recipe.length !== 1 ? 's' : ''}
          </span>
        ) : (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
            No recipe
          </span>
        )}
        {isImportedSource(item.source) && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">
            Imported
          </span>
        )}
        {isInactive && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
            Inactive
          </span>
        )}
      </div>
    </button>
  )
}

// ================================================================
// Popover — anchored to parent (relative), closes on outside click.
// Unchanged behavior from prior version.
// ================================================================
function Popover({
  children,
  onClose,
  className = '',
}: {
  children: React.ReactNode
  onClose: () => void
  className?: string
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

// ================================================================
// AddSectionForm — popover, dark-filled primary commit.
// ================================================================
function AddSectionForm({ onClose }: { onClose: () => void }) {
  const [state, action, pending] = useActionState(createCategory, null)
  return (
    <form action={(fd) => { action(fd); if (!state?.error) onClose() }} className="space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">New section</p>
      <input
        name="name"
        type="text"
        required
        autoFocus
        placeholder="Section name"
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
      />
      {state?.error && <p className="text-[11px] text-red-600">{state.error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="flex-1 px-3 py-2 rounded-lg bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 disabled:opacity-60 transition-colors"
        >
          {pending ? 'Adding…' : 'Add section'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// ================================================================
// AddItemForm — popover, dark-filled primary commit.
// ================================================================
function AddItemForm({ categoryId, onClose }: { categoryId: string; onClose: () => void }) {
  const [state, action, pending] = useActionState(createMenuItemInSection, null)
  return (
    <form action={(fd) => { action(fd); if (!state?.error) onClose() }} className="space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">New item</p>
      <input type="hidden" name="category_id" value={categoryId} />
      <input
        name="name"
        type="text"
        required
        autoFocus
        placeholder="Item name"
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
      />
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">$</span>
        <input
          name="price"
          type="number"
          required
          min="0"
          step="0.01"
          placeholder="0.00"
          className="w-full rounded-lg border border-gray-300 bg-white pl-7 pr-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
        />
      </div>
      {state?.error && <p className="text-[11px] text-red-600">{state.error}</p>}
      <p className="text-[10px] text-gray-400 leading-relaxed">
        Map ingredients to inventory once the item is open in the drawer.
      </p>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="flex-1 px-3 py-2 rounded-lg bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 disabled:opacity-60 transition-colors"
        >
          {pending ? 'Adding…' : 'Add item'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// ================================================================
// ItemDrawer — family-aligned inspection workspace.
//
// Mirrors the Sales / Finance drawer anatomy:
//   • flex flex-col aside, sticky labeled header, scrollable body,
//     pinned footer "Manage" zone.
//   • Body opens with a 3-cell stats strip (Price / Ingredients /
//     Status) using the family stat-cell shell.
//   • Ingredients section: existing list as a clean rounded card,
//     followed by the same combobox surface that handles search /
//     select / inline create. All existing form action behavior is
//     preserved.
//   • Details section: small two-up grid (Section + Source).
//   • Footer hosts a 2-step remove with audit-minded copy.
// ================================================================
function ItemDrawer({
  item,
  sectionName,
  inventoryItems,
  onClose,
}: {
  item: MenuItem
  sectionName: string | null
  inventoryItems: InventoryItem[]
  onClose: () => void
}) {
  const [addState, addAction, addPending] = useActionState(addRecipeComponent, null)
  const [createState, createAction, createPending] = useActionState(createInlineInventoryItem, null)
  const [deleteState, deleteAction, deletePending] = useActionState(deleteMenuItem, null)
  const [removeMode, setRemoveMode] = useState(false)

  const usedIds = new Set(item.recipe.map((r) => r.inventoryItemId))
  const available = inventoryItems.filter((ii) => !usedIds.has(ii.id))

  // Ingredient-add surface — gated.
  // The drawer used to render the search/create input always-visible
  // below the recipe list, which made the area feel utility-heavy at
  // rest. `addOpen` controls whether the search/create surface is
  // mounted; at rest the user only sees a calm "+ Add ingredient"
  // trigger. Combobox state (query / selected / creatingNew) is reset
  // every time the surface is closed so reopening always starts fresh.
  const [addOpen, setAddOpen] = useState(false)
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

  // Outside-click closes combobox
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) setComboOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  // Esc + body-scroll lock — same pattern as Sales drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const selectIngredient = (ii: InventoryItem) => {
    setSelectedIngredient(ii)
    setQuery(ii.name)
    setComboOpen(false)
    setCreatingNew(false)
  }

  const startCreate = () => {
    setCreatingNew(true)
    setComboOpen(true) // keep dropdown context
    setSelectedIngredient(null)
  }

  const resetCombo = () => {
    setQuery('')
    setSelectedIngredient(null)
    setCreatingNew(false)
    setComboOpen(false)
  }

  const closeAddSurface = () => {
    setAddOpen(false)
    resetCombo()
  }

  // After a successful `Add ingredient` submission, collapse the
  // surface back to rest. We watch the pending->idle transition; when
  // there's no error on the way out, the add succeeded and we close.
  // On error, the surface stays open so the user can read the message
  // and retry without losing their selection.
  const wasAddPendingRef = useRef(false)
  useEffect(() => {
    if (wasAddPendingRef.current && !addPending && !addState?.error) {
      closeAddSurface()
    }
    wasAddPendingRef.current = addPending
    // closeAddSurface is stable for the lifetime of this drawer; it
    // only closes a piece of local state and never reads stale props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addPending, addState])

  const sourceLabel =
    item.source === 'manual' ? 'Manual' :
    item.source === 'imported' || item.source === 'external' ? 'Imported'
      : item.source

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-gray-900/30 backdrop-blur-[1px] z-40"
      />
      <aside className="fixed top-0 right-0 z-50 h-full w-full sm:max-w-md bg-white shadow-2xl border-l border-gray-200 flex flex-col">

        {/* HEADER
            Top row carries the section eyebrow + Close. Title row
            leads with the item name and an inline status pill so
            "Active / Inactive" registers immediately, paralleling the
            order-id + status-pill pattern in the Sales drawer. The
            subtitle line collapses what used to live in a separate
            body stats strip — price + source — into a single calm
            line of identity, leaving the body free to focus on
            ingredients. */}
        <div className="border-b border-gray-100 px-6 py-5 flex-shrink-0">
          <div className="flex items-start justify-between gap-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Menu item{sectionName ? <> · {sectionName}</> : null}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="flex-shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors -mt-1 -mr-1"
            >
              Close
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-gray-900 truncate">{item.name}</h2>
            <span
              className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                item.active ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${item.active ? 'bg-green-500' : 'bg-gray-400'}`} />
              {item.active ? 'Active' : 'Inactive'}
            </span>
          </div>
          <p className="mt-1.5 text-xs">
            <span className="text-gray-900 font-mono tabular-nums font-semibold">{fmtMoney(item.currentPrice)}</span>
            <span className="text-gray-400"> · </span>
            <span className="text-gray-600">{sourceLabel}</span>
          </p>
        </div>

        {/* Inactive ribbon — same pattern as Sales' voided stamp. */}
        {!item.active && (
          <div className="border-b border-amber-200/60 bg-amber-50/40 px-6 py-2.5 flex items-center gap-2 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            <p className="text-[11px] text-amber-700">
              Inactive · this item won&apos;t appear at the POS until it&apos;s reactivated.
            </p>
          </div>
        )}

        {/* BODY
            Stats strip and a separate Details section both removed.
            All identity (price / section / source / status) now lives
            in the header, leaving the body single-purpose: the
            ingredients workspace. The drawer reads as "manage what
            this item is made of," not "inspect a stack of metadata
            cards." */}
        <div className="flex-1 overflow-y-auto px-6 py-6">

          {/* Ingredients section — body's only band */}
          <div>
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-gray-700">
              Ingredients
            </p>

            {item.recipe.length > 0 && (
              <ul className="rounded-xl border border-gray-200 bg-white divide-y divide-gray-100 mb-3">
                {item.recipe.map((rc) => (
                  <li key={rc.id} className="flex items-center justify-between px-3.5 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-gray-900 truncate">{rc.inventoryItemName}</p>
                      <p className="text-[11px] text-gray-500 tabular-nums mt-0.5">
                        {rc.quantityRequired} {rc.unitOfMeasure}
                      </p>
                    </div>
                    <form action={removeRecipeComponent}>
                      <input type="hidden" name="component_id" value={rc.id} />
                      <input type="hidden" name="menu_item_id" value={item.id} />
                      <button
                        type="submit"
                        aria-label="Remove ingredient"
                        className="text-gray-300 hover:text-red-500 p-1 rounded-md hover:bg-red-50 transition-colors"
                      >
                        <XIcon size={14} />
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}

            {item.recipe.length === 0 && !addOpen && (
              <p className="mb-3 text-xs text-gray-500 leading-relaxed">
                No ingredients yet. Mapping inventory items lets stock deplete automatically when this dish sells.
              </p>
            )}

            {/* Add-ingredient entry point.
                At rest: a calm dashed-bordered "+ Add ingredient"
                button that invites the action without surfacing the
                full search/create UI. */}
            {!addOpen ? (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="w-full rounded-lg border border-dashed border-gray-300 bg-white px-3 py-2.5 text-xs font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 transition-colors"
              >
                + Add ingredient
              </button>
            ) : (
            // Reveal surface — search OR inline create.
            // Lives on a single calm tinted shell across both modes;
            // the previous version flipped background colors which
            // made the area feel utility-y. Mode is now communicated
            // by the header eyebrow text alone.
            <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-3.5">
              {/* Surface header: small eyebrow + Cancel.
                  Cancel always closes the entire add surface — distinct
                  from the in-create "Back" button which only steps from
                  create mode back to search mode. */}
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <p className={`text-[10px] font-semibold uppercase tracking-widest ${
                  creatingNew ? 'text-blue-700' : 'text-gray-500'
                }`}>
                  {creatingNew ? 'New ingredient' : 'Add ingredient'}
                </p>
                <button
                  type="button"
                  onClick={closeAddSurface}
                  className="text-[10px] font-medium text-gray-500 hover:text-gray-700 transition-colors"
                >
                  Cancel
                </button>
              </div>
              {!creatingNew ? (
                <>
                  <form action={(fd) => addAction(fd)}>
                    <input type="hidden" name="menu_item_id" value={item.id} />
                    <input type="hidden" name="inventory_item_id" value={selectedIngredient?.id ?? ''} />

                    <div ref={comboRef} className="relative">
                      <input
                        type="text"
                        value={query}
                        onChange={(e) => {
                          setQuery(e.target.value)
                          setComboOpen(true)
                          setSelectedIngredient(null)
                        }}
                        onFocus={() => setComboOpen(true)}
                        placeholder="Search or create ingredient…"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
                      />

                      {comboOpen && (
                        <div className="absolute left-0 right-0 top-full mt-1 bg-white rounded-lg border border-gray-200 shadow-lg z-10 overflow-hidden">
                          <div className="max-h-40 overflow-y-auto">
                            {filtered.map((ii) => (
                              <button
                                key={ii.id}
                                type="button"
                                onClick={() => selectIngredient(ii)}
                                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                              >
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
                          <button
                            type="button"
                            onClick={startCreate}
                            className="w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors border-t border-gray-100"
                          >
                            {query.trim() && !exactMatch
                              ? <span>+ Create <strong>&quot;{query.trim()}&quot;</strong></span>
                              : '+ New ingredient'}
                          </button>
                        </div>
                      )}
                    </div>

                    {selectedIngredient && (
                      <div className="flex gap-2 mt-2">
                        <input
                          name="quantity_required"
                          type="number"
                          required
                          min="0.0001"
                          step="0.0001"
                          autoFocus
                          placeholder="Qty"
                          className="w-24 rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
                        />
                        <button
                          type="submit"
                          disabled={addPending}
                          className="flex-1 px-3 py-2 rounded-lg bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 disabled:opacity-60 transition-colors"
                        >
                          {addPending ? 'Adding…' : `Add ${selectedIngredient.name}`}
                        </button>
                      </div>
                    )}
                  </form>
                  {addState?.error && (
                    <p className="text-[11px] text-red-600 mt-2">{addState.error}</p>
                  )}
                </>
              ) : (
                <form action={(fd) => createAction(fd)}>
                  <input type="hidden" name="menu_item_id" value={item.id} />
                  <input type="hidden" name="name" value={query.trim()} />

                  {/* The surface header above already announces
                      "New ingredient", so the in-form eyebrow it used
                      to repeat is intentionally omitted here. */}

                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                    placeholder="Ingredient name"
                    className="w-full rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition mb-2"
                  />

                  <div className="flex gap-2">
                    <select
                      name="unit_of_measure"
                      defaultValue="units"
                      className="flex-1 rounded-lg border border-blue-300 bg-white px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
                    >
                      <option value="units">Units (each)</option>
                      <option value="kg">Kilograms</option>
                      <option value="lbs">Pounds</option>
                      <option value="liters">Liters</option>
                      <option value="oz">Ounces</option>
                      <option value="gallons">Gallons</option>
                      <option value="cases">Cases</option>
                      <option value="bags">Bags</option>
                    </select>
                    <button
                      type="submit"
                      disabled={createPending || !query.trim()}
                      className="px-4 py-2 rounded-lg bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 disabled:opacity-60 transition-colors"
                    >
                      {createPending ? '…' : 'Create'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setCreatingNew(false)}
                      className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      Back
                    </button>
                  </div>
                  {createState?.error && (
                    <p className="text-[11px] text-red-600 mt-2">{createState.error}</p>
                  )}
                </form>
              )}
            </div>
            )}
          </div>
        </div>

        {/* ACTION ZONE — pinned footer with 2-step remove */}
        <div className="border-t border-gray-200 bg-gray-50/40 px-6 py-5 flex-shrink-0">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-gray-500">Manage</p>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs font-semibold text-gray-900">Remove this item</p>
            <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
              Removes the item from the menu surface and clears its ingredient links. Historical orders that
              referenced it stay intact in the Sales ledger.
            </p>
            {!removeMode ? (
              <button
                type="button"
                onClick={() => setRemoveMode(true)}
                className="mt-4 w-full rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50 hover:border-red-300 px-4 py-2 text-xs font-semibold transition-colors"
              >
                Remove this item
              </button>
            ) : (
              <form action={deleteAction} className="mt-4 flex items-center gap-2">
                <input type="hidden" name="item_id" value={item.id} />
                <button
                  type="submit"
                  disabled={deletePending}
                  className="flex-1 rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 px-4 py-2 text-xs font-semibold disabled:opacity-60 transition-colors"
                >
                  {deletePending ? 'Removing…' : 'Confirm remove'}
                </button>
                <button
                  type="button"
                  onClick={() => setRemoveMode(false)}
                  disabled={deletePending}
                  className="rounded-lg border border-gray-200 bg-white text-xs font-medium text-gray-600 px-3 py-2 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
              </form>
            )}
            {deleteState?.error && (
              <p className="mt-2 text-[11px] text-amber-600">{deleteState.error}</p>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}

// ================================================================
// XIcon — tiny SVG used in remove affordances.
// ================================================================
function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}
