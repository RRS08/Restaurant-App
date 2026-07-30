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

import { useState, useRef, useEffect, useActionState, useTransition } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  createMenuItemInSection,
  createCategory,
  deleteMenuItem,
  setMenuItemActive,
  deleteCategory,
  setMenuItemAvailabilityOverride,
  updateMenuItemPrice,
  updateMenuItemName,
  assignMenuItemCategory,
  bulkAssignMenuItemCategory,
  bulkDeleteMenuItems,
  reorderCategories,
} from '@/app/actions/menu'
import {
  addRecipeComponent,
  removeRecipeComponent,
  createInlineInventoryItem,
  updateRecipeComponentQuantity,
} from '@/app/actions/recipe'
import {
  shortAvailabilityChip,
  type AvailabilityOverride,
  type EffectiveSellability,
  type ProjectionState,
} from '@/lib/menu/availability'
import {
  UNIT_GROUPS,
  normalizeUnit,
  convertQty,
  labelFor,
} from '@/lib/units'
import { makeT, type Lang } from '@/lib/i18n'

type T = (en: string, es?: string) => string

// ================================================================
// Domain types
// ================================================================

interface Category {
  id: string
  name: string
  sortOrder: number
  /** Non-null when this category is a sub-category of another
   *  top-level category. Enforced two-level-max at the action
   *  layer — a sub-category cannot itself have children. */
  parentId: string | null
}
interface RecipeEntry {
  id: string; inventoryItemId: string; inventoryItemName: string
  /** The inventory item's own unit. */
  unitOfMeasure: string
  quantityRequired: number
  /** The recipe's own unit. Null = "same as unitOfMeasure" (the
   *  backward-compat identity path for rows written before the
   *  unit-conversion feature). */
  unit: string | null
}
interface MenuItem {
  id: string; name: string; currentPrice: number; active: boolean
  categoryId: string | null; source: string
  /** When set, the item was imported from this external POS provider
   *  (e.g., 'clover', 'square'). The drawer uses this to clarify
   *  that our local `active` toggle controls our records only —
   *  actual availability for sale is managed in the external POS. */
  externalProvider: string | null
  /** Owner-side "hide from menu" flag. True means the owner hit
   *  Delete on this item — it's excluded from the Awaiting band
   *  and from category sections so it stops cluttering the UI.
   *  Sales history + reports still reference it. */
  hiddenFromMenu: boolean
  recipe: RecipeEntry[]
  // Availability foundation (computed in the page component).
  override: AvailabilityOverride
  overrideSetAt: string | null
  projectedCount: number | null
  projectionState: ProjectionState
  effectiveSellability: EffectiveSellability
  bottleneckInventoryItemName: string | null
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
  /** Whether the inventory bridge is live. Drives whether the
   *  drawer can surface honest projection counts vs. an "inventory
   *  not active yet" note. */
  inventoryActive?: boolean
  lang: Lang
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
// Bands (tablet md+) design tokens.
// Only used by the bands layout so they can't collide with anything
// the phone Tailwind path renders. Prefixed with B_ for grep-ability.
// ================================================================
const B_INK = '#18181B'
const B_PAPER = '#FAF9F6'
const B_LINE = '#E7E6E2'
const B_TREE_BG = '#FCFCFB'
const B_FILL = '#F4F4F5'
const B_MUTED = '#6B6B70'
const B_FAINT = '#A1A1A6'
const B_GHOST = '#C4C4C7'
const B_AMBER_BG = '#FFFBEB'
const B_AMBER = '#B45309'
const B_MONO = "'Geist Mono', ui-monospace, monospace"

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
  inventoryActive = false,
  lang,
}: Props) {
  const t = makeT(lang)
  const isExternal = operatingMode === 'external_pos'

  const subtitle = isExternal
    ? t('Review imported items and shape the menu your guests see.', 'Revisa los artículos importados y da forma al menú que ven tus clientes.')
    : operatingMode === 'native_pos'
      ? t('Build the menu your in-app POS reads from.', 'Construye el menú que lee tu POS integrado.')
      : t('Manage sections, items, and recipe links.', 'Administra secciones, artículos y vínculos de receta.')

  // addItemTo used to lift "which section has its Add Item popover
  // open" up to the page level for a single-form-at-a-time rule.
  // That made nested rendering awkward (parent + child both need
  // their own popover state independently), so each SectionBlock
  // now owns its own local addItemOpen state.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)

  // Filter — 'all' shows every section stacked; a category id
  // shows just that section; 'awaiting' shows only the unassigned
  // items filling the page for quick bulk categorization.
  const [filter, setFilter] = useState<'all' | 'awaiting' | string>('all')

  // Drag state: which item is being dragged (so we can dim it) and
  // which drop target is being hovered (so we can highlight it).
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null)
  const [hoverTargetId, setHoverTargetId] = useState<string | null>(null)

  // Chip-reorder state — parallel to draggingItemId but scoped to
  // filter-chip drag. Keeping the two channels separate lets the
  // chip drop handler tell "did the user drag a menu ITEM here"
  // (assign to this category) apart from "did the user drag a
  // CHIP here" (reorder the chip row) without mime-type gymnastics.
  const [draggingChipId, setDraggingChipId] = useState<string | null>(null)
  const [chipHoverTargetId, setChipHoverTargetId] = useState<string | null>(null)
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null)
  const [, startReorderTransition] = useTransition()

  // Pending optimistic move — used to hide the item from its source
  // bucket immediately on drop without waiting for revalidation.
  const [pendingMoves, setPendingMoves] = useState<Record<string, string | null>>({})
  const [, startAssignTransition] = useTransition()

  // Bands (tablet md+) layout state. Below md the existing chip
  // layout renders unchanged. At md+ the return branches into a
  // full-height 2-pane shell (tree + item grid) using this state.
  const [isBands, setIsBands] = useState(false)
  const [isWide, setIsWide] = useState(false)
  const [bandsSel, setBandsSel] = useState<
    | { kind: 'orphan' }
    | { kind: 'category'; id: string }
    | null
  >(null)
  const [bandsExpanded, setBandsExpanded] = useState<string | null>(null)
  const [bandsQuery, setBandsQuery] = useState('')
  const [bandsAddCatOpen, setBandsAddCatOpen] = useState(false)
  const [bandsAddSubOpen, setBandsAddSubOpen] = useState(false)
  const [bandsAddItemOpen, setBandsAddItemOpen] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mqBands = window.matchMedia('(min-width: 768px)')
    const mqWide = window.matchMedia('(min-width: 1280px)')
    const update = () => { setIsBands(mqBands.matches); setIsWide(mqWide.matches) }
    update()
    mqBands.addEventListener('change', update)
    mqWide.addEventListener('change', update)
    return () => {
      mqBands.removeEventListener('change', update)
      mqWide.removeEventListener('change', update)
    }
  }, [])

  const assignTo = (itemId: string, categoryId: string | null) => {
    setPendingMoves((prev) => ({ ...prev, [itemId]: categoryId }))
    startAssignTransition(async () => {
      const res = await assignMenuItemCategory(itemId, categoryId)
      if (res?.error) {
        // Rollback — remove the pending record so the item reappears
        // in its original bucket.
        setPendingMoves((prev) => {
          const next = { ...prev }
          delete next[itemId]
          return next
        })
      }
      // On success, revalidation will bring in fresh data. Clear the
      // pending record on the next tick so we don't fight the server.
      setTimeout(() => {
        setPendingMoves((prev) => {
          if (prev[itemId] === undefined) return prev
          const next = { ...prev }
          delete next[itemId]
          return next
        })
      }, 400)
    })
  }

  // Multi-select state for the "Awaiting a section" band. Tapping an
  // awaiting card toggles its id in this set; when the set is
  // non-empty a floating action bar exposes "Move all to [section]"
  // so a manager fresh off a CSV import can sort dozens of items in
  // a few taps instead of one-by-one drags. Only awaiting items go
  // in here — once an item leaves the band (assigned or otherwise)
  // it drops out of the selection automatically via `sanitize` on
  // the next render.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const toggleSelected = (itemId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }
  const clearSelection = () => setSelectedIds(new Set())

  const bulkAssignTo = (categoryId: string | null) => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    // Optimistic: stamp every selected id as pending → the whole
    // batch disappears from the awaiting band instantly.
    setPendingMoves((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = categoryId
      return next
    })
    clearSelection()
    startAssignTransition(async () => {
      const res = await bulkAssignMenuItemCategory(ids, categoryId)
      if (res?.error) {
        // Rollback the whole batch — same shape as single-item.
        setPendingMoves((prev) => {
          const next = { ...prev }
          for (const id of ids) delete next[id]
          return next
        })
      }
      setTimeout(() => {
        setPendingMoves((prev) => {
          const next = { ...prev }
          let dirty = false
          for (const id of ids) {
            if (next[id] !== undefined) {
              delete next[id]
              dirty = true
            }
          }
          return dirty ? next : prev
        })
      }, 400)
    })
  }

  // Bulk delete for the "Awaiting a section" band. Rides the same
  // optimistic pending-moves record used for bulk assign — sending
  // items to a fake sentinel category ('__deleted__') hides them
  // from the awaiting band immediately, and the server deletion
  // (or FK-restrict fallback to deactivate) resolves via a
  // revalidate afterwards. Rollback restores them on error.
  const bulkDeleteSelected = () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    if (typeof window !== 'undefined' && !window.confirm(
      `Delete ${ids.length} item${ids.length === 1 ? '' : 's'}?\n\n` +
      `Imported items (from Poynt / GoDaddy sync) get hidden rather than hard-deleted — otherwise they'd come back on the next sync since Poynt still has the SKU. Manual items with sales history also get hidden to preserve reports. Everything else deletes outright.`,
    )) return
    setPendingMoves((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = '__deleted__'
      return next
    })
    clearSelection()
    startAssignTransition(async () => {
      const res = await bulkDeleteMenuItems(ids)
      if (res.error) {
        setPendingMoves((prev) => {
          const next = { ...prev }
          for (const id of ids) delete next[id]
          return next
        })
        alert(`Bulk delete failed: ${res.error}`)
        return
      }
      // Successful revalidate will drop the deleted rows from the
      // items list, so the pending sentinel entries become stale
      // and can be cleared safely.
      setTimeout(() => {
        setPendingMoves((prev) => {
          const next = { ...prev }
          let dirty = false
          for (const id of ids) {
            if (next[id] !== undefined) {
              delete next[id]
              dirty = true
            }
          }
          return dirty ? next : prev
        })
      }, 400)
    })
  }

  // Apply pending optimistic moves to each item's effective category
  // before bucketing. If the server has already returned the updated
  // row, prev[itemId] === item.categoryId and the effective category
  // is unchanged; otherwise the pending record wins.
  const effectiveCategoryId = (item: MenuItem): string | null =>
    Object.prototype.hasOwnProperty.call(pendingMoves, item.id)
      ? pendingMoves[item.id]
      : item.categoryId

  // Items the owner explicitly hid via bulk-delete on the Awaiting
  // band never render — filter them out at bucketing time so
  // every downstream surface (chips, sections, awaiting, counts)
  // sees a consistent view. hidden_from_menu is separate from
  // `active`: `active` mirrors Poynt's own status and can flip
  // via catalog sync; `hidden_from_menu` is the owner's decision
  // and stays sticky across every sync.
  const visibleItems = items.filter((i) => !i.hiddenFromMenu)

  const itemsByCategory = new Map<string, MenuItem[]>()
  for (const item of visibleItems) {
    const key = effectiveCategoryId(item) ?? '__none__'
    if (!itemsByCategory.has(key)) itemsByCategory.set(key, [])
    itemsByCategory.get(key)!.push(item)
  }
  const awaitingItems = itemsByCategory.get('__none__') ?? []

  // Apply the pending drag-reorder to the displayed chip row so the
  // moved chip lands under the cursor instantly. When the server
  // catches up (revalidation), optimisticOrder clears and we fall
  // back to the freshly-fetched `categories` ordering.
  const displayedCategories: Category[] = (() => {
    if (!optimisticOrder) return categories
    const byId = new Map(categories.map((c) => [c.id, c]))
    const ordered: Category[] = []
    const consumed = new Set<string>()
    for (const id of optimisticOrder) {
      const c = byId.get(id)
      if (c && !consumed.has(id)) {
        ordered.push(c)
        consumed.add(id)
      }
    }
    // Append any categories not in the optimistic sequence — belt
    // and suspenders for a stale-tab payload.
    for (const c of categories) if (!consumed.has(c.id)) ordered.push(c)
    return ordered
  })()

  const reorderChipTo = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return
    const currentIds = displayedCategories.map((c) => c.id)
    const srcIdx = currentIds.indexOf(sourceId)
    const tgtIdx = currentIds.indexOf(targetId)
    if (srcIdx === -1 || tgtIdx === -1) return
    const next = [...currentIds]
    next.splice(srcIdx, 1)
    next.splice(tgtIdx, 0, sourceId)
    setOptimisticOrder(next)
    startReorderTransition(async () => {
      const res = await reorderCategories(next)
      if (res?.error) {
        setOptimisticOrder(null)
      } else {
        // On success, clear on the next tick after revalidation so
        // we don't fight the incoming fresh data.
        setTimeout(() => setOptimisticOrder(null), 400)
      }
    })
  }

  // Sanitize the selection: drop ids that have left the awaiting
  // bucket (assigned elsewhere, deleted, etc.) so the action bar's
  // count matches what's actually still selectable.
  useEffect(() => {
    if (selectedIds.size === 0) return
    const awaitingIdSet = new Set(awaitingItems.map((i) => i.id))
    let stale = false
    for (const id of selectedIds) {
      if (!awaitingIdSet.has(id)) {
        stale = true
        break
      }
    }
    if (!stale) return
    setSelectedIds((prev) => {
      const next = new Set<string>()
      for (const id of prev) if (awaitingIdSet.has(id)) next.add(id)
      return next
    })
  }, [awaitingItems, selectedIds])

  const liveItem = selectedItemId ? items.find((i) => i.id === selectedItemId) ?? null : null

  // Close drawer if the open item disappears (deleted, archived, etc.).
  useEffect(() => {
    if (selectedItemId && !items.find((i) => i.id === selectedItemId)) setSelectedItemId(null)
  }, [items, selectedItemId])

  // URL-driven selection. Other pages (notably the Inventory item
  // drawer's "Used in menu items" section) link here with
  // `?item=<menuItemId>` and expect that item's drawer to open
  // automatically. We hydrate selectedItemId once on mount when a
  // valid item id is present, then scroll the matching ItemCard
  // into view so the manager lands on the right object.
  //
  // A ref guards against re-firing the effect on subsequent renders
  // (e.g., when the user closes the drawer manually but the URL
  // param still hangs around). After hydration the URL param is
  // ignored; closing the drawer is closing the drawer.
  const searchParams = useSearchParams()
  const hydratedFromUrl = useRef(false)
  useEffect(() => {
    if (hydratedFromUrl.current) return
    const itemFromUrl = searchParams.get('item')
    if (!itemFromUrl) return
    if (!items.find((i) => i.id === itemFromUrl)) return
    hydratedFromUrl.current = true
    setSelectedItemId(itemFromUrl)
    // Scroll the matching card into view after the next paint so the
    // selected ring is visible. ID is stable: `menu-item-<id>` is
    // applied to each ItemCard button.
    const t = window.setTimeout(() => {
      const el = document.getElementById(`menu-item-${itemFromUrl}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    return () => window.clearTimeout(t)
  }, [searchParams, items])

  // -------- bands (md+) derivations ---------------------------------
  // Everything below is only read by the bands branch of the return.
  // Nothing here mutates state used by the phone/chip path.
  const bandsTopLevel = displayedCategories.filter((c) => !c.parentId)
  const bandsKidsOf = (cat: Category) =>
    displayedCategories.filter((c) => c.parentId === cat.id)
  const bandsCountFor = (
    sel: { kind: 'orphan' } | { kind: 'category'; id: string },
  ): number => {
    if (sel.kind === 'orphan') return awaitingItems.length
    const cat = categories.find((c) => c.id === sel.id)
    if (!cat) return 0
    const own = (itemsByCategory.get(cat.id) ?? []).length
    if (cat.parentId) return own
    const kids = bandsKidsOf(cat)
    return own + kids.reduce((n, k) => n + (itemsByCategory.get(k.id) ?? []).length, 0)
  }
  const bandsReviewCountFor = (
    sel: { kind: 'orphan' } | { kind: 'category'; id: string },
  ): number => {
    if (sel.kind === 'orphan') return awaitingItems.filter((i) => !hasRecipe(i)).length
    const cat = categories.find((c) => c.id === sel.id)
    if (!cat) return 0
    const own = (itemsByCategory.get(cat.id) ?? []).filter((i) => !hasRecipe(i)).length
    if (cat.parentId) return own
    const kids = bandsKidsOf(cat)
    return own + kids.reduce(
      (n, k) => n + (itemsByCategory.get(k.id) ?? []).filter((i) => !hasRecipe(i)).length,
      0,
    )
  }
  // Pane groups — one flat feed of { label, items }. Label null =
  // no section header rendered (would repeat the pane title).
  const bandsPaneGroups = (
    sel: { kind: 'orphan' } | { kind: 'category'; id: string },
  ): Array<{ label: string | null; items: MenuItem[] }> => {
    if (sel.kind === 'orphan') return [{ label: null, items: awaitingItems }]
    const cat = categories.find((c) => c.id === sel.id)
    if (!cat) return []
    if (cat.parentId) return [{ label: null, items: itemsByCategory.get(cat.id) ?? [] }]
    const kids = bandsKidsOf(cat)
    if (kids.length === 0) return [{ label: null, items: itemsByCategory.get(cat.id) ?? [] }]
    const groups: Array<{ label: string | null; items: MenuItem[] }> = []
    const own = itemsByCategory.get(cat.id) ?? []
    if (own.length > 0) groups.push({ label: cat.name, items: own })
    for (const k of kids) {
      const items = itemsByCategory.get(k.id) ?? []
      if (items.length > 0) groups.push({ label: k.name, items })
    }
    return groups
  }
  // Default selection: first top-level with items, else first
  // top-level, else the orphan pen if it has items.
  const activeBandsSel: { kind: 'orphan' } | { kind: 'category'; id: string } | null =
    bandsSel ??
    (bandsTopLevel.find((c) => (itemsByCategory.get(c.id) ?? []).length > 0 || bandsKidsOf(c).length > 0)
      ? { kind: 'category', id: bandsTopLevel[0].id }
      : bandsTopLevel[0]
        ? { kind: 'category', id: bandsTopLevel[0].id }
        : awaitingItems.length > 0
          ? { kind: 'orphan' }
          : null)
  const selKey =
    activeBandsSel?.kind === 'orphan'
      ? '__orphan__'
      : activeBandsSel?.kind === 'category'
        ? activeBandsSel.id
        : ''
  // Derive expanded-parent from selection: sub-category → parent, top-level with kids → itself.
  const expandedParent = (() => {
    if (activeBandsSel?.kind !== 'category') return bandsExpanded
    const cat = categories.find((c) => c.id === activeBandsSel.id)
    if (!cat) return bandsExpanded
    if (cat.parentId) return cat.parentId
    return bandsKidsOf(cat).length > 0 ? cat.id : bandsExpanded
  })()
  const selectBands = (sel: { kind: 'orphan' } | { kind: 'category'; id: string }) => {
    setBandsSel(sel)
    if (sel.kind === 'orphan') { setBandsExpanded(null); return }
    const cat = categories.find((c) => c.id === sel.id)
    if (!cat) { setBandsExpanded(null); return }
    if (cat.parentId) { setBandsExpanded(cat.parentId); return }
    setBandsExpanded(bandsKidsOf(cat).length > 0 ? cat.id : null)
  }
  const paneEyebrow = (() => {
    if (!activeBandsSel) return ''
    if (activeBandsSel.kind === 'orphan') return t('UNCATEGORISED', 'SIN CATEGORÍA')
    const cat = categories.find((c) => c.id === activeBandsSel.id)
    if (!cat) return ''
    if (cat.parentId) {
      const parent = categories.find((c) => c.id === cat.parentId)
      return parent ? `${parent.name.toUpperCase()} · ${cat.name.toUpperCase()}` : cat.name.toUpperCase()
    }
    return cat.name.toUpperCase()
  })()
  const activeName = (() => {
    if (!activeBandsSel) return ''
    if (activeBandsSel.kind === 'orphan') return t('Uncategorised', 'Sin categoría')
    return categories.find((c) => c.id === activeBandsSel.id)?.name ?? ''
  })()
  const activeCount = activeBandsSel ? bandsCountFor(activeBandsSel) : 0
  const activeReview = activeBandsSel ? bandsReviewCountFor(activeBandsSel) : 0
  const bandsQ = bandsQuery.trim().toLowerCase()
  const paneGroupsFiltered = activeBandsSel
    ? bandsPaneGroups(activeBandsSel)
        .map((g) => ({ label: g.label, items: bandsQ ? g.items.filter((i) => i.name.toLowerCase().includes(bandsQ)) : g.items }))
        .filter((g) => g.items.length > 0)
    : []
  const bandsTotalItems = visibleItems.length
  const bandsTotalReview = visibleItems.filter((i) => !hasRecipe(i)).length
  const bandsTotalCats = displayedCategories.filter((c) => !c.parentId).length
  const activeIsTopLevel =
    activeBandsSel?.kind === 'category' &&
    !categories.find((c) => c.id === activeBandsSel.id)?.parentId

  return (
    <>
    {isBands ? (
      // ============================================================
      // BANDS (md+) LAYOUT — full-height 2-pane shell: header band on
      // top, then tree (264px) + item grid. Below md this branch is
      // skipped and the existing chip layout renders unchanged.
      // ============================================================
      <div style={{
        height: '100vh', minWidth: 0, display: 'flex', flexDirection: 'column',
        background: '#fff', fontFamily: "'Geist', system-ui, sans-serif", color: B_INK,
      }}>
        {/* HEADER BAND */}
        <div style={{ background: '#fff', borderBottom: `1px solid ${B_LINE}`, flex: '0 0 auto' }}>
          <div style={{ padding: '16px 24px 15px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: '-0.035em' }}>
                  {t('Menu', 'Menú')}
                </h1>
                {isExternal && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#EEF2FF', color: '#4F46E5', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#6366F1' }} />
                    {t('Imported menu', 'Menú importado')}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: B_MONO, fontSize: 30, fontWeight: 600, letterSpacing: '-0.045em', lineHeight: 1 }}>
                  {bandsTotalItems}
                </span>
                <span style={{ fontFamily: B_MONO, fontSize: 11, color: B_FAINT }}>
                  {bandsTotalItems === 1 ? t('ITEM', 'ARTÍCULO') : t('ITEMS', 'ARTÍCULOS')}
                </span>
                {bandsTotalReview > 0 && (
                  <BandsTrail value={String(bandsTotalReview)} label={t('need review', 'requieren revisión')} tone={B_AMBER} />
                )}
                <BandsTrail
                  value={String(bandsTotalCats)}
                  label={bandsTotalCats === 1 ? t('category', 'categoría') : t('categories', 'categorías')}
                />
              </div>
            </div>
            <div style={{ display: 'flex', alignSelf: 'center', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
              <BandsSearchPill total={bandsTotalItems} value={bandsQuery} onChange={setBandsQuery} placeholder={t('Search', 'Buscar')} />
            </div>
          </div>
        </div>

        {/* TREE + ITEMS */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {/* TREE PANE */}
          <div style={{ width: 264, flex: '0 0 264px', borderRight: `1px solid ${B_LINE}`, background: B_TREE_BG, overflowY: 'auto', padding: '10px 8px 16px' }}>
            <div style={{ fontFamily: B_MONO, fontSize: 10, letterSpacing: '0.16em', color: B_FAINT, padding: '6px 10px 8px' }}>
              {t('CATEGORIES', 'CATEGORÍAS')}
            </div>
            {bandsTopLevel.length === 0 && awaitingItems.length === 0 ? (
              <div style={{ padding: '6px 10px', fontSize: 12, color: B_MUTED }}>
                {t('No categories yet.', 'Aún no hay categorías.')}
              </div>
            ) : (
              <>
                {bandsTopLevel.map((c) => {
                  const kids = bandsKidsOf(c)
                  const rows: React.ReactNode[] = [
                    <BandsTreeRow
                      key={c.id}
                      name={c.name}
                      on={selKey === c.id}
                      depth={0}
                      hasKids={kids.length > 0}
                      expanded={expandedParent === c.id}
                      needsReview={bandsReviewCountFor({ kind: 'category', id: c.id }) > 0}
                      onClick={() => selectBands({ kind: 'category', id: c.id })}
                    />,
                  ]
                  if (kids.length > 0 && expandedParent === c.id) {
                    for (const k of kids) {
                      rows.push(
                        <BandsTreeRow
                          key={k.id}
                          name={k.name}
                          on={selKey === k.id}
                          depth={1}
                          hasKids={false}
                          expanded={false}
                          needsReview={bandsReviewCountFor({ kind: 'category', id: k.id }) > 0}
                          onClick={() => selectBands({ kind: 'category', id: k.id })}
                        />,
                      )
                    }
                  }
                  return rows
                })}
                {awaitingItems.length > 0 && (
                  <BandsTreeRow
                    key="__orphan__"
                    name={t('Uncategorised', 'Sin categoría')}
                    on={selKey === '__orphan__'}
                    depth={0}
                    hasKids={false}
                    expanded={false}
                    needsReview={awaitingItems.some((i) => !hasRecipe(i))}
                    onClick={() => selectBands({ kind: 'orphan' })}
                    orphan
                  />
                )}
              </>
            )}
            {bandsAddCatOpen ? (
              <div style={{ marginTop: 6, padding: '8px 10px' }}>
                <BandsAddCategoryForm onClose={() => setBandsAddCatOpen(false)} t={t} />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setBandsAddCatOpen(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 0, background: 'transparent', borderRadius: 9, padding: '8px 10px', marginTop: 6, fontFamily: 'inherit', fontSize: 13, color: B_FAINT, cursor: 'pointer', textAlign: 'left' }}
              >
                + {t('Add category', 'Añadir categoría')}
              </button>
            )}
          </div>

          {/* ITEM REGION */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* CATEGORY HEADER BAND */}
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, padding: '12px 20px 11px', borderBottom: `1px solid ${B_LINE}`, background: '#fff', flex: '0 0 auto', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' }}>
                <div style={{ fontFamily: B_MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', color: B_INK }}>
                  {paneEyebrow}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginTop: 5, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: B_MONO, fontSize: 19, fontWeight: 600, letterSpacing: '-0.035em', lineHeight: 1 }}>
                    {activeCount}
                  </span>
                  <span style={{ fontFamily: B_MONO, fontSize: 11, color: B_FAINT }}>
                    {activeCount === 1 ? t('ITEM', 'ARTÍCULO') : t('ITEMS', 'ARTÍCULOS')}
                  </span>
                  {activeReview > 0 && (
                    <BandsTrail value={String(activeReview)} label={t('need review', 'requieren revisión')} tone={B_AMBER} size={13} />
                  )}
                </div>
              </div>
              {activeIsTopLevel && activeBandsSel?.kind === 'category' && (
                <div style={{ position: 'relative', flex: '0 0 auto' }}>
                  <button
                    type="button"
                    onClick={() => setBandsAddSubOpen((v) => !v)}
                    style={{ display: 'inline-flex', alignItems: 'center', border: 0, background: B_INK, color: B_PAPER, borderRadius: 10, height: 34, padding: '0 15px', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer' }}
                  >
                    + {t('Sub-section', 'Subsección')}
                  </button>
                  {bandsAddSubOpen && (
                    <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 260, zIndex: 30, background: '#fff', borderRadius: 12, border: `1px solid ${B_LINE}`, boxShadow: '0 10px 30px rgba(0,0,0,0.08)', padding: 14 }}>
                      <BandsAddCategoryForm
                        parentId={activeBandsSel.id}
                        parentName={activeName}
                        onClose={() => setBandsAddSubOpen(false)}
                        t={t}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ITEM GRID — one flat feed, no nested lists. Section
                headers only render when the pane has more than one
                group (i.e., a parent with sub-categories). */}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 0 4px' }}>
              {paneGroupsFiltered.length === 0 ? (
                <div style={{ padding: '40px 20px', color: B_MUTED, fontSize: 13 }}>
                  {bandsQ
                    ? t('No items match that search.', 'Ningún artículo coincide con esa búsqueda.')
                    : t('No items yet.', 'Aún no hay artículos.')}
                </div>
              ) : (
                paneGroupsFiltered.map((g, gi) => {
                  // At browser widths (xl+) the item region has enough
                  // room for 4 cards per row without stretching. Tablet
                  // stays at 3-up so the cards still read comfortably.
                  const perRow = isWide ? 4 : 3
                  const rowsOfCards: (MenuItem | undefined)[][] = []
                  for (let i = 0; i < g.items.length; i += perRow) {
                    const row: (MenuItem | undefined)[] = []
                    for (let k = 0; k < perRow; k++) row.push(g.items[i + k])
                    rowsOfCards.push(row)
                  }
                  const bare = !g.label || paneGroupsFiltered.length === 1
                  return (
                    <div key={g.label ?? `g${gi}`}>
                      {!bare && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px 10px', background: '#fff', position: 'sticky', top: 0, zIndex: 2 }}>
                          <span style={{ fontFamily: B_MONO, fontSize: 11, fontWeight: 600, letterSpacing: '0.14em', color: B_INK, flex: '0 0 auto' }}>
                            {g.label!.toUpperCase()}
                          </span>
                          <span style={{ flexGrow: 1, flexShrink: 1, flexBasis: '0%', height: 0, borderTop: `1px dotted ${B_INK}` }} />
                        </div>
                      )}
                      {rowsOfCards.map((row, i) => (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: `repeat(${perRow},1fr)`, gap: 10, padding: `${i === 0 ? 12 : 0}px 20px 10px` }}>
                          {row.map((r, j) =>
                            r ? (
                              <BandsItemCard
                                key={r.id}
                                item={r}
                                onOpen={() => setSelectedItemId(r.id)}
                                selected={selectedItemId === r.id}
                                t={t}
                              />
                            ) : (
                              <span key={j} />
                            ),
                          )}
                        </div>
                      ))}
                    </div>
                  )
                })
              )}
              <div style={{ padding: '12px 20px 20px' }}>
                {activeBandsSel?.kind === 'category' ? (
                  bandsAddItemOpen ? (
                    <div style={{ maxWidth: 320 }}>
                      <BandsAddItemForm
                        categoryId={activeBandsSel.id}
                        categoryName={activeName}
                        onClose={() => setBandsAddItemOpen(false)}
                        t={t}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setBandsAddItemOpen(true)}
                      style={{ display: 'inline-block', border: `1px dashed #D6D5D1`, background: 'transparent', borderRadius: 10, padding: '9px 14px', fontFamily: 'inherit', fontSize: 12, color: B_MUTED, cursor: 'pointer' }}
                    >
                      + {t('Add item', 'Añadir artículo')} {t('to', 'a')} {activeName}
                    </button>
                  )
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    ) : (
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
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-gray-900">{t('Menu', 'Menú')}</h1>
          <p className="mt-1.5 text-sm text-gray-500">{subtitle}</p>
        </div>
        <SourceChip operatingMode={operatingMode} t={t} />
      </div>

      {/* External-branch import panel — moved to Dev Toolbox for
          now. This surface will come back once we're ready to sell
          the external-POS integration as a first-class feature. */}

      {/* ================================================================ */}
      {/* 2. SECTIONS                                                      */}
      {/* The old "Menu structure" eyebrow band is gone — having a label   */}
      {/* layer right under the page title was reading as a second title.  */}
      {/* The page title + the section eyebrows below carry the structure  */}
      {/* on their own. A single right-aligned action row lives just above */}
      {/* the section list to anchor "+ Add section" to the actual         */}
      {/* menu-building surface.                                            */}
      {/* ================================================================ */}
      {categories.length === 0 && awaitingItems.length === 0 ? (
        <EmptyMenuState t={t} />
      ) : (
        <>
          {/* Filter chip row. Every chip is both a filter (click →
              show that bucket) and a drop target (drag an item onto
              it → assign it to that category). "Awaiting" chip only
              shows when there are unassigned items so it doesn't
              nag on a clean menu. */}
          <FilterChipsBar
            categories={displayedCategories}
            itemsByCategory={itemsByCategory}
            awaitingCount={awaitingItems.length}
            totalCount={visibleItems.length}
            filter={filter}
            onFilter={setFilter}
            onDropItem={assignTo}
            draggingItemId={draggingItemId}
            hoverTargetId={hoverTargetId}
            setHoverTargetId={setHoverTargetId}
            draggingChipId={draggingChipId}
            setDraggingChipId={setDraggingChipId}
            chipHoverTargetId={chipHoverTargetId}
            setChipHoverTargetId={setChipHoverTargetId}
            onReorderChip={reorderChipTo}
            t={t}
          />

          {/* Main content — the current filter's items.
              Nested rendering: top-level parents render as
              outer blocks, and each parent's sub-categories render
              INSIDE that block via the subSections prop. So the
              flat displayedCategories list is filtered to just
              top-level here; children come along for the ride via
              their parent. */}
          {filter === 'all' ? (
            <div className="space-y-10">
              {displayedCategories.filter((c) => !c.parentId).map((cat) => {
                const sectionItems = itemsByCategory.get(cat.id) ?? []
                const subSections = displayedCategories
                  .filter((c) => c.parentId === cat.id)
                  .map((sub) => ({
                    category: sub,
                    items: itemsByCategory.get(sub.id) ?? [],
                  }))
                return (
                  <SectionBlock
                    key={cat.id}
                    category={cat}
                    items={sectionItems}
                    selectedItemId={selectedItemId}
                    onOpenItem={setSelectedItemId}
                    onDragStartItem={setDraggingItemId}
                    onDragEndItem={() => setDraggingItemId(null)}
                    draggingItemId={draggingItemId}
                    onAssign={assignTo}
                    subSections={subSections}
                    t={t}
                  />
                )
              })}
            </div>
          ) : filter === 'awaiting' ? (
            // Awaiting-only view — the "sit at the bottom" bucket
            // rendered as the main surface so the manager can focus
            // on assigning without other sections in the way.
            <div className="space-y-6" />
          ) : (
            (() => {
              const cat = categories.find((c) => c.id === filter)
              if (!cat) return null
              const sectionItems = itemsByCategory.get(cat.id) ?? []
              // When filtering to a top-level parent, still show its
              // sub-categories nested inside. When filtering to a
              // sub-category, render it standalone (no children —
              // 2-level max).
              const subSections = !cat.parentId
                ? categories
                    .filter((c) => c.parentId === cat.id)
                    .map((sub) => ({
                      category: sub,
                      items: itemsByCategory.get(sub.id) ?? [],
                    }))
                : []
              return (
                <SectionBlock
                  category={cat}
                  items={sectionItems}
                  selectedItemId={selectedItemId}
                  onOpenItem={setSelectedItemId}
                  onDragStartItem={setDraggingItemId}
                  onDragEndItem={() => setDraggingItemId(null)}
                  draggingItemId={draggingItemId}
                  onAssign={assignTo}
                  subSections={subSections}
                  t={t}
                />
              )
            })()
          )}

          {/* Awaiting a section — always pinned to the bottom
              (regardless of the current filter) so the manager can
              drag from here up to any category chip at the top. On
              the 'awaiting' filter it fills the page. */}
          {awaitingItems.length > 0 && (
            <div className="mt-10">
              <AwaitingSectionBand
                items={awaitingItems}
                categories={categories}
                selectedIds={selectedIds}
                onToggleSelected={toggleSelected}
                onClearSelection={clearSelection}
                onBulkAssign={bulkAssignTo}
                onBulkDelete={bulkDeleteSelected}
                onDragStartItem={setDraggingItemId}
                onDragEndItem={() => setDraggingItemId(null)}
                t={t}
              />
            </div>
          )}
        </>
      )}

    </div>
    )}

    {/* DRAWER — shared between the bands and phone layouts. Rendered
        as a fixed overlay, so its position in the tree doesn't matter. */}
    {liveItem && (
      <ItemDrawer
        item={liveItem}
        sectionName={categories.find((c) => c.id === effectiveCategoryId(liveItem))?.name ?? null}
        categories={categories}
        inventoryItems={inventoryItems}
        inventoryActive={inventoryActive}
        onAssign={assignTo}
        onClose={() => setSelectedItemId(null)}
        t={t}
      />
    )}
    </>
  )
}

// ================================================================
// SourceChip — page-level data-origin pill, parallel to Sales'.
// ================================================================
function SourceChip({ operatingMode, t }: { operatingMode: OperatingMode; t: T }) {
  const variants: Record<NonNullable<OperatingMode> | 'unset', { label: string; tone: string; dot: string }> = {
    native_pos: { label: t('Native menu', 'Menú nativo'), tone: 'text-blue-700', dot: 'bg-blue-500' },
    external_pos: { label: t('Imported menu', 'Menú importado'), tone: 'text-indigo-700', dot: 'bg-indigo-500' },
    unset: { label: t('Operating mode not set', 'Modo de operación no configurado'), tone: 'text-gray-600', dot: 'bg-gray-400' },
  }
  const v = variants[operatingMode ?? 'unset']
  return (
    <div className="hidden sm:inline-flex items-center gap-2 self-start text-[11px] font-medium px-3 py-1.5 rounded-full border border-gray-200/80 bg-white/80 backdrop-blur-sm shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <span className={`w-1.5 h-1.5 rounded-full ${v.dot}`} />
      <span className={v.tone}>{v.label}</span>
    </div>
  )
}

/** Flatten the category list so each parent is immediately
 *  followed by its own children, preserving each cohort's own
 *  sort order. Sub-categories that reference an unknown parent
 *  (shouldn't happen, but defensive) fall to the end as
 *  top-level orphans so nothing disappears. */
function orderCategoriesForChips(categories: Category[]): Category[] {
  const parents = categories.filter((c) => !c.parentId)
  const childrenByParent = new Map<string, Category[]>()
  for (const c of categories) {
    if (!c.parentId) continue
    if (!childrenByParent.has(c.parentId)) childrenByParent.set(c.parentId, [])
    childrenByParent.get(c.parentId)!.push(c)
  }
  const seen = new Set<string>()
  const out: Category[] = []
  for (const p of parents) {
    out.push(p)
    seen.add(p.id)
    for (const child of (childrenByParent.get(p.id) ?? [])) {
      out.push(child)
      seen.add(child.id)
    }
  }
  // Orphans — sub-categories whose parent was deleted while we
  // held stale data. Rare, but avoid dropping them silently.
  for (const c of categories) if (!seen.has(c.id)) out.push(c)
  return out
}

// ================================================================
// EmptyMenuState — the no-sections nudge.
// ================================================================
function EmptyMenuState({ t }: { t: T }) {
  return (
    <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white px-6 py-16 text-center">
      <p className="text-sm font-semibold text-gray-700">{t('No menu sections yet', 'Aún no hay secciones de menú')}</p>
      <p className="mx-auto mt-2 max-w-sm text-xs text-gray-500 leading-relaxed">
        {t('Sections group items the way they appear at the POS. Add one to start.', 'Las secciones agrupan los artículos como aparecen en el POS. Agrega una para comenzar.')}
      </p>
      <div className="mt-4">
        <AddSectionButton popoverClassName="left-1/2 -translate-x-1/2 top-full mt-1.5 w-72" t={t} />
      </div>
    </div>
  )
}

// ================================================================
// FilterChipsBar — the row of category filter chips at the top.
//
// Two jobs from one bar:
//   1. FILTER — click a chip to narrow the main content area to
//      that category (or "All", or "Awaiting").
//   2. DROP TARGET — while an item is being dragged, each chip
//      accepts drops. Dropping on a category chip assigns the
//      item to that category. Dropping on "Awaiting" clears the
//      assignment.
//
// Chip counts are computed from the live itemsByCategory map so
// they reflect optimistic moves the instant a drop lands.
// ================================================================
function FilterChipsBar({
  categories,
  itemsByCategory,
  awaitingCount,
  totalCount,
  filter,
  onFilter,
  onDropItem,
  draggingItemId,
  hoverTargetId,
  setHoverTargetId,
  draggingChipId,
  setDraggingChipId,
  chipHoverTargetId,
  setChipHoverTargetId,
  onReorderChip,
  t,
}: {
  categories: Category[]
  itemsByCategory: Map<string, MenuItem[]>
  awaitingCount: number
  totalCount: number
  filter: 'all' | 'awaiting' | string
  onFilter: (f: 'all' | 'awaiting' | string) => void
  onDropItem: (itemId: string, categoryId: string | null) => void
  draggingItemId: string | null
  hoverTargetId: string | null
  setHoverTargetId: (id: string | null) => void
  draggingChipId: string | null
  setDraggingChipId: (id: string | null) => void
  chipHoverTargetId: string | null
  setChipHoverTargetId: (id: string | null) => void
  onReorderChip: (sourceId: string, targetId: string) => void
  t: T
}) {
  // Native drag-drop handlers for the ITEM-onto-chip channel. Skipped
  // when a chip is being dragged so the chip-reorder handlers own the
  // event without competing hover state.
  const chipDragProps = (targetId: string, categoryIdOnDrop: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (draggingChipId) return
      if (!draggingItemId) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (hoverTargetId !== targetId) setHoverTargetId(targetId)
    },
    onDragLeave: () => {
      if (hoverTargetId === targetId) setHoverTargetId(null)
    },
    onDrop: (e: React.DragEvent) => {
      if (draggingChipId) return
      e.preventDefault()
      const itemId = e.dataTransfer.getData('text/plain')
      setHoverTargetId(null)
      if (itemId) onDropItem(itemId, categoryIdOnDrop)
    },
  })

  const chipClass = (id: string, active: boolean, hover: boolean, tone: 'default' | 'amber' = 'default') => {
    if (hover) {
      return tone === 'amber'
        ? 'border-amber-500 bg-amber-100 text-amber-900 shadow-[0_0_0_3px_rgba(245,158,11,0.18)]'
        : 'border-blue-500 bg-blue-50 text-blue-800 shadow-[0_0_0_3px_rgba(59,130,246,0.18)]'
    }
    if (active) {
      return tone === 'amber'
        ? 'border-amber-400 bg-amber-50 text-amber-800'
        : 'border-gray-900 bg-gray-900 text-white'
    }
    return tone === 'amber'
      ? 'border-amber-200 bg-white text-amber-700 hover:bg-amber-50'
      : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
  }

  return (
    <div className="mb-6 flex items-center gap-2 flex-wrap">
      {/* "All" chip — special: not a drop target since dropping on
          "All" doesn't identify a target category. Filter-only. */}
      <button
        type="button"
        onClick={() => onFilter('all')}
        className={`text-[11px] font-mono uppercase tracking-[0.1em] px-3 py-1.5 rounded-full border transition-all ${chipClass('all', filter === 'all', false)}`}
      >
        {t('All', 'Todo')} · {totalCount}
      </button>

      {/* Hierarchical ordering: each top-level category is followed
          by its own sub-categories, then the next top-level, etc.
          Sub-category chips get a `↳` prefix so the parent-child
          relationship is legible without another visual layer. */}
      {orderCategoriesForChips(categories).map((cat) => {
        const count = (itemsByCategory.get(cat.id) ?? []).length
        const active = filter === cat.id
        const itemHover = hoverTargetId === cat.id
        const chipHover = chipHoverTargetId === cat.id && draggingChipId !== cat.id
        const isDraggingSelf = draggingChipId === cat.id
        const isSub = !!cat.parentId
        // Merged drop handler: chip-in-transit wins; falls back to
        // the item-onto-chip channel when no chip is being dragged.
        const itemHandlers = chipDragProps(cat.id, cat.id)
        return (
          <button
            key={cat.id}
            type="button"
            onClick={() => onFilter(cat.id)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('application/x-menu-chip-id', cat.id)
              // Also stamp a plain-text payload — Safari refuses to
              // start a drag without one, and this string is never
              // read (item drops key off getData('text/plain') set
              // by the item card path, which uses the menu item id).
              e.dataTransfer.setData('text/plain', `chip:${cat.id}`)
              setDraggingChipId(cat.id)
            }}
            onDragEnd={() => {
              setDraggingChipId(null)
              setChipHoverTargetId(null)
            }}
            onDragOver={(e) => {
              if (draggingChipId && draggingChipId !== cat.id) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (chipHoverTargetId !== cat.id) setChipHoverTargetId(cat.id)
                return
              }
              itemHandlers.onDragOver(e)
            }}
            onDragLeave={() => {
              if (chipHoverTargetId === cat.id) setChipHoverTargetId(null)
              itemHandlers.onDragLeave()
            }}
            onDrop={(e) => {
              const src = e.dataTransfer.getData('application/x-menu-chip-id')
              if (src && src !== cat.id) {
                e.preventDefault()
                setChipHoverTargetId(null)
                onReorderChip(src, cat.id)
                return
              }
              itemHandlers.onDrop(e)
            }}
            title={t('Drag to reorder', 'Arrastra para reordenar')}
            className={`text-[11px] font-mono uppercase tracking-[0.1em] px-3 py-1.5 rounded-full border cursor-grab active:cursor-grabbing transition-all ${chipClass(cat.id, active, itemHover)} ${chipHover ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-white' : ''} ${isDraggingSelf ? 'opacity-40' : ''}`}
          >
            {isSub && <span aria-hidden="true" className="opacity-60 mr-1">↳</span>}
            {cat.name} · {count}
          </button>
        )
      })}

      {awaitingCount > 0 && (
        <button
          type="button"
          onClick={() => onFilter('awaiting')}
          {...chipDragProps('awaiting', null)}
          className={`text-[11px] font-mono uppercase tracking-[0.1em] px-3 py-1.5 rounded-full border transition-all ${chipClass('awaiting', filter === 'awaiting', hoverTargetId === 'awaiting', 'amber')}`}
          title={t('Items without a section — drag onto any category to assign', 'Artículos sin sección — arrastra a cualquier categoría para asignar')}
        >
          {t('Awaiting', 'Sin sección')} · {awaitingCount}
        </button>
      )}

      <div className="flex-1" />

      <AddSectionButton
        popoverClassName="right-0 top-full mt-1.5 w-72"
        t={t}
      />
    </div>
  )
}

// ================================================================
// AwaitingSectionBand — the pinned-to-the-bottom bucket for items
// that don't yet belong to a section (imported without a category,
// mostly).
//
// UX model: tap-to-multi-select. Tapping a card toggles it in the
// selection set (highlights amber). Once one or more are selected,
// a sticky action bar at the top of the band exposes "Move all
// to [section ▾]" so a manager fresh off a CSV import can sort
// dozens of items in a few taps instead of dragging one at a time.
// The old per-card "Move to" popover was pulled — bulk-select
// covers the single-item case too (select one, move one).
//
// Drag-and-drop still works for muscle-memory / power users:
// drag a single card onto a category chip up top and it moves
// without touching the selection. Selected/highlighted cards are
// also draggable, but drag is intentionally single-item; bulk
// movement goes through the action bar.
//
// Rendered as an amber-tinted band so it reads as "needs your
// attention" without alarming.
// ================================================================
function AwaitingSectionBand({
  items,
  categories,
  selectedIds,
  onToggleSelected,
  onClearSelection,
  onBulkAssign,
  onBulkDelete,
  onDragStartItem,
  onDragEndItem,
  t,
}: {
  items: MenuItem[]
  categories: Category[]
  selectedIds: Set<string>
  onToggleSelected: (itemId: string) => void
  onClearSelection: () => void
  onBulkAssign: (categoryId: string | null) => void
  /** Called with the current selection when the manager hits the
   *  Delete affordance in the sticky action bar. Parent handles
   *  the confirm prompt + optimistic hide + server call. */
  onBulkDelete: () => void
  onDragStartItem: (id: string) => void
  onDragEndItem: () => void
  t: T
}) {
  const [movePickerOpen, setMovePickerOpen] = useState(false)
  const selectionCount = selectedIds.size
  const hasSelection = selectionCount > 0

  // Close the picker whenever the selection empties out (either
  // via bulk-assign clearing it or the user tapping "Clear").
  useEffect(() => {
    if (!hasSelection) setMovePickerOpen(false)
  }, [hasSelection])

  const allSelected = selectionCount > 0 && selectionCount === items.length
  const toggleAll = () => {
    if (allSelected) {
      onClearSelection()
    } else {
      // Fresh full-select — toggle each unselected id in.
      for (const it of items) {
        if (!selectedIds.has(it.id)) onToggleSelected(it.id)
      }
    }
  }

  return (
    <section className="rounded-[14px] border border-dashed border-[#E7E6E2] p-5">
      <div className="mb-4 flex items-center gap-4">
        <h2 className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-[#6B6B70]">
          {t('Awaiting a section', 'Sin sección asignada')}
        </h2>
        <span className="flex-1 h-px bg-[#E2E0DA]" />
        <p className="font-mono text-[11px] tabular-nums text-[#A1A1A6]">
          {items.length} {items.length === 1 ? t('item', 'artículo') : t('items', 'artículos')}
        </p>
      </div>

      {/* Action bar — sticky so it stays visible while scrolling a
          long awaiting list. Two states:
            • idle       → helper text + "Select all" affordance
            • selection  → count + "Move all to [section]" + Clear
          Styled to match the marketing/finance aesthetic: warm
          neutrals, ink-black primary CTA, mono eyebrows. */}
      <div className="sticky top-2 z-10 mb-4 rounded-[10px] border border-[#E7E6E2] bg-white px-4 py-2.5 shadow-[0_1px_2px_rgba(24,24,27,0.04)]">
        {hasSelection ? (
          <div className="flex items-center gap-3.5 flex-wrap">
            <span className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-[#18181B] tabular-nums">
              {selectionCount} {t('selected', 'seleccionados')}
            </span>
            <span className="h-3.5 w-px bg-[#E7E6E2]" aria-hidden="true" />
            <div className="relative">
              <button
                type="button"
                onClick={() => setMovePickerOpen((v) => !v)}
                disabled={categories.length === 0}
                className="text-[12px] font-semibold text-[#FAF9F6] bg-[#18181B] hover:bg-black disabled:bg-[#A1A1A6] disabled:cursor-not-allowed transition-colors rounded-[9px] px-3.5 py-1.5 inline-flex items-center gap-1.5"
              >
                {t('Move all to', 'Mover todo a')} <span aria-hidden="true" className="opacity-70">▾</span>
              </button>
              {movePickerOpen && (
                <Popover
                  onClose={() => setMovePickerOpen(false)}
                  className="left-0 top-full mt-2 w-60"
                >
                  <div className="p-1">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#A1A1A6] px-2.5 pt-2 pb-1.5">
                      {t('Move to section', 'Mover a sección')}
                    </p>
                    <ul>
                      {categories.map((cat) => (
                        <li key={cat.id}>
                          <button
                            type="button"
                            onClick={() => {
                              onBulkAssign(cat.id)
                              setMovePickerOpen(false)
                            }}
                            className="w-full text-left px-2.5 py-2 text-[13px] text-[#52525B] hover:bg-[#F4F1EA] hover:text-[#18181B] rounded-md transition-colors"
                          >
                            {cat.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </Popover>
              )}
            </div>
            {categories.length === 0 && (
              <span className="text-[11.5px] text-[#6B6B70]">
                {t('Add a section first.', 'Agrega una sección primero.')}
              </span>
            )}
            <span className="flex-1" />
            <button
              type="button"
              onClick={onBulkDelete}
              className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#B45309] hover:text-[#7C2D12] transition-colors"
              title={t('Delete selected items', 'Eliminar artículos seleccionados')}
            >
              {t('Delete', 'Eliminar')}
            </button>
            <span className="h-3.5 w-px bg-[#E7E6E2]" aria-hidden="true" />
            <button
              type="button"
              onClick={onClearSelection}
              className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#A1A1A6] hover:text-[#18181B] transition-colors"
            >
              {t('Clear', 'Limpiar')}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-4 flex-wrap">
            <p className="text-[12.5px] text-[#6B6B70] leading-relaxed flex-1 min-w-0">
              {t(
                'Tap items to select them, then move them all together.',
                'Toca los artículos para seleccionarlos, luego muévelos todos juntos.'
              )}
            </p>
            {items.length > 1 && (
              <button
                type="button"
                onClick={toggleAll}
                className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#6B6B70] hover:text-[#18181B] transition-colors"
              >
                {t('Select all', 'Seleccionar todo')}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <AwaitingItemCard
            key={item.id}
            item={item}
            selected={selectedIds.has(item.id)}
            onToggle={() => onToggleSelected(item.id)}
            onDragStart={() => onDragStartItem(item.id)}
            onDragEnd={onDragEndItem}
            t={t}
          />
        ))}
      </div>
    </section>
  )
}

// AwaitingItemCard — tap-to-toggle selection. Selected state gets
// a solid amber ring + checkmark badge. A tiny "Open" affordance
// (icon-only, right-corner) still lets a manager pop the drawer
// when they want to inspect details on a single item without
// disturbing the selection — click on the card body toggles
// selection instead.
function AwaitingItemCard({
  item,
  selected,
  onToggle,
  onDragStart,
  onDragEnd,
  t,
}: {
  item: MenuItem
  selected: boolean
  onToggle: () => void
  onDragStart: () => void
  onDragEnd: () => void
  t: T
}) {
  // Selected: ink-black border + subtle inner tint. Unselected:
  // warm hairline border on white. Matches the marketing/finance
  // aesthetic — no primary colors, everything sits in the warm-
  // neutral + ink-black system.
  const ringClass = selected
    ? 'border-[#18181B] bg-white shadow-[0_0_0_1px_#18181B,0_1px_2px_rgba(24,24,27,0.05)]'
    : 'border-[#E7E6E2] bg-white hover:border-[#C9C7C0] shadow-[0_1px_2px_rgba(24,24,27,0.03)]'

  return (
    <div
      id={`menu-item-${item.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', item.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle()
        }
      }}
      className={`relative rounded-[12px] border px-4 pt-3.5 pb-3 transition-all duration-150 hover:shadow-md cursor-pointer select-none ${ringClass}`}
    >
      {/* Selection checkmark — top-left corner, only when selected.
          Ink-black disc with cream ✓, mirroring the "One screen" pill
          on the marketing page. */}
      {selected && (
        <span
          aria-hidden="true"
          className="absolute -top-1.5 -left-1.5 h-5 w-5 rounded-full bg-[#18181B] text-[#FAF9F6] flex items-center justify-center text-[11px] font-bold shadow-sm"
        >
          ✓
        </span>
      )}

      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[14px] font-semibold tracking-tight truncate text-[#18181B] flex-1 min-w-0">
          {item.name}
        </span>
        <span className="font-mono text-[13px] tabular-nums text-[#52525B] flex-shrink-0">
          ${item.currentPrice.toFixed(2)}
        </span>
      </div>

      <div className="mt-2.5">
        {/* Warm-terra accent on the idle CTA — noticeable against
            the cream/white card without breaking out of the warm
            neutral palette. Once selected, the label settles into
            a muted "Selected" so the eye is drawn to the sticky
            action bar (Move all to …), not the individual card. */}
        <span
          className={
            selected
              ? 'font-mono text-[10px] uppercase tracking-[0.14em] text-[#A1A1A6]'
              : 'font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#B45309]'
          }
        >
          {selected ? t('Selected', 'Seleccionado') : t('Tap to assign', 'Toca para asignar')}
        </span>
      </div>
    </div>
  )
}

// ================================================================
// AddSectionButton — the "+ Add section" trigger and its popover,
// kept together in one component.
//
// These used to be split: the page owned an `addSectionOpen` flag and
// only the populated branch rendered the popover, so the empty state's
// button flipped a flag nothing read — the one button a brand-new
// menu actually needs did nothing. Co-locating trigger and popover
// makes that drift impossible.
// ================================================================
function AddSectionButton({
  popoverClassName,
  t,
}: {
  popoverClassName: string
  t: T
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
      >
        {t('+ Add section', '+ Agregar sección')}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className={popoverClassName}>
          <AddSectionForm onClose={() => setOpen(false)} t={t} />
        </Popover>
      )}
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
  onDragStartItem,
  onDragEndItem,
  draggingItemId,
  onAssign,
  subSections,
  depth = 0,
  t,
}: {
  category: Category
  items: MenuItem[]
  selectedItemId: string | null
  onOpenItem: (id: string) => void
  /** Fires when the manager begins dragging an item card. Parent
   *  uses it to track which item is in flight so drop targets can
   *  highlight and the card can dim. */
  onDragStartItem?: (id: string) => void
  onDragEndItem?: () => void
  /** Currently-in-flight item id — used to enable this section as
   *  a drop target only when a drag is actually happening. */
  draggingItemId?: string | null
  /** Handler that moves a dragged item into this section. Same
   *  handler the FilterChipsBar uses on chip drops — chips remain
   *  the primary target; the section body is a secondary
   *  convenience so managers don't have to aim precisely. */
  onAssign?: (itemId: string, categoryId: string) => void
  /** Optional child sections rendered visually contained inside
   *  this parent's block, after the parent's own items. Populated
   *  only for top-level categories with sub-categories. Each
   *  child is a full SectionBlock at depth=1 (smaller header,
   *  indented, tinted background) so the hierarchy is legible
   *  without a second surface. */
  subSections?: Array<{ category: Category; items: MenuItem[] }>
  /** Visual scale. 0 = top-level parent (full-width, bold header,
   *  outer card). 1 = sub-section nested inside a parent (smaller
   *  header, indented, softer container). Any deeper is a bug —
   *  we enforce 2-level max server-side. */
  depth?: 0 | 1
  t: T
}) {
  // deleteCategory is a direct (formData) -> void server action — not
  // a useActionState-shaped one — so we use a plain <form action={...}>
  // here and drive the 2-step confirmation purely via local state.
  const [removeMode, setRemoveMode] = useState(false)
  // Local "add item" popover state per section — was previously
  // page-lifted for a single-form-at-a-time rule, but that made
  // nested-section rendering awkward. Two open forms is fine.
  const [addItemOpen, setAddItemOpen] = useState(false)
  // Local hover state for the "you're about to drop here" visual.
  // Kept local instead of hoisting to the page because only this
  // section cares about its own highlight.
  const [dragOver, setDragOver] = useState(false)
  // "+ Sub-section" popover open state — kept local so multiple
  // section blocks each own their own popover independently.
  const [addSubOpen, setAddSubOpen] = useState(false)
  // Only top-level categories can have sub-categories (2-level
  // max, enforced server-side). A sub-category itself doesn't
  // get the "+ Sub-section" affordance in its header.
  const isTopLevel = !category.parentId

  // Only activate the section as a drop target when a drag is in
  // flight AND the item isn't already in this section (dropping
  // onto its own current home is a no-op we skip to avoid
  // flickering the highlight).
  const canAccept =
    !!onAssign && !!draggingItemId && !items.some((it) => it.id === draggingItemId)

  // Two levels, quiet hierarchy:
  //
  // depth 0 (parent) — clean white card with a thin border, no
  //   shadow, no eyebrow. The card itself is enough — it's a
  //   container, everything inside belongs to it.
  //
  // depth 1 (sub-section) — indented under the parent, with a
  //   thin gray left-border stripe and no background tint. The
  //   stripe + the ↳ prefix carry the "nested" signal without
  //   introducing color; the visual weight stays on the actual
  //   product cards below.
  //
  // Drag-hover accent (blue) still tints on hover so drop
  // targets remain unmistakable — the color shows up only when
  // the manager is actively dragging.
  const outerClass = depth === 1
    ? `relative rounded-r-md border-l-2 border-l-gray-200 pl-5 pr-2 py-2.5 transition-all ${dragOver ? 'ring-2 ring-blue-300 ring-offset-1 ring-offset-white bg-blue-50/40 border-l-blue-300' : ''}`
    : `rounded-2xl border border-gray-200 bg-white p-5 sm:p-6 transition-all ${dragOver ? 'ring-2 ring-blue-300 ring-offset-2 ring-offset-white bg-blue-50/20' : ''}`
  const headerNameClass = depth === 1
    ? 'text-[13px] font-medium tracking-tight text-gray-700 whitespace-nowrap'
    : 'text-[15px] font-semibold tracking-tight text-gray-900 whitespace-nowrap'
  const headerMarginClass = depth === 1 ? 'mb-2' : 'mb-4'

  return (
    <section
      onDragOver={canAccept ? (e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!dragOver) setDragOver(true)
      } : undefined}
      onDragLeave={canAccept ? () => { if (dragOver) setDragOver(false) } : undefined}
      onDrop={canAccept ? (e) => {
        e.preventDefault()
        setDragOver(false)
        const itemId = e.dataTransfer.getData('text/plain')
        if (itemId && onAssign) onAssign(itemId, category.id)
      } : undefined}
      className={outerClass}
    >
      {/* Section header. No role eyebrow — the container tells
          the story (card = parent, stripe = sub). At depth 1 the
          leading ↳ in a muted gray gives one more subtle nesting
          cue without introducing an accent color. */}
      <div className={`${headerMarginClass} flex items-center gap-3`}>
        <h2 className={headerNameClass}>
          {depth === 1 && (
            <span aria-hidden="true" className="mr-1.5 text-gray-400">↳</span>
          )}
          {category.name}
        </h2>
        <span className="flex-1 h-px bg-gray-200/70" />
        <p className="text-[11px] text-gray-500 font-mono tabular-nums whitespace-nowrap">
          {items.length} {items.length === 1 ? t('item', 'artículo') : t('items', 'artículos')}
        </p>
        {/* "+ Sub-section" — only on top-level parents. Anchors a
            popover that pre-scopes the new category to this
            parent (hidden parent_id input). Text-link styling
            keeps the header calm; the affordance is discoverable
            without competing with the item cards below. */}
        {isTopLevel && !removeMode && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setAddSubOpen((o) => !o)}
              className="text-[11px] font-medium text-blue-600 hover:text-blue-500 transition-colors whitespace-nowrap"
            >
              {t('+ Sub-section', '+ Sub-sección')}
            </button>
            {addSubOpen && (
              <Popover onClose={() => setAddSubOpen(false)} className="right-0 top-full mt-1.5 w-72">
                <AddSubSectionForm
                  parentId={category.id}
                  parentName={category.name}
                  onClose={() => setAddSubOpen(false)}
                  t={t}
                />
              </Popover>
            )}
          </div>
        )}
        {!removeMode ? (
          <button
            type="button"
            onClick={() => setRemoveMode(true)}
            aria-label={t('Remove section', 'Eliminar sección')}
            title={t('Remove section', 'Eliminar sección')}
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
              {t('Remove section', 'Eliminar sección')}
            </button>
            <button
              type="button"
              onClick={() => setRemoveMode(false)}
              className="text-[10px] font-medium px-2 py-1 rounded-md border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
            >
              {t('Cancel', 'Cancelar')}
            </button>
          </form>
        )}
      </div>

      {/* Section body */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white px-6 py-8 text-center">
          <p className="text-xs text-gray-500">{t('No items in this section yet.', 'Aún no hay artículos en esta sección.')}</p>
          <div className="relative inline-block mt-2">
            <button
              type="button"
              onClick={() => setAddItemOpen((o) => !o)}
              className="text-[11px] font-medium text-blue-600 hover:text-blue-500 transition-colors"
            >
              {t('+ Add first item', '+ Agregar primer artículo')}
            </button>
            {addItemOpen && (
              <Popover onClose={() => setAddItemOpen(false)} className="left-1/2 -translate-x-1/2 top-full mt-1.5 w-72">
                <AddItemForm categoryId={category.id} onClose={() => setAddItemOpen(false)} t={t} />
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
                onDragStart={() => onDragStartItem?.(item.id)}
                onDragEnd={() => onDragEndItem?.()}
                t={t}
              />
            ))}
          </div>

          {/* Soft local "+ Add item" — sits under the cards as a quiet
              text link rather than a repeated header pill. Anchors a
              popover the same way the page-level Add section button does. */}
          <div className="relative mt-4 inline-block">
            <button
              type="button"
              onClick={() => setAddItemOpen((o) => !o)}
              className="text-[11px] font-medium text-blue-600 hover:text-blue-500 transition-colors"
            >
              {t('+ Add item', '+ Agregar artículo')}
            </button>
            {addItemOpen && (
              <Popover onClose={() => setAddItemOpen(false)} className="left-0 top-full mt-1.5 w-72">
                <AddItemForm categoryId={category.id} onClose={() => setAddItemOpen(false)} t={t} />
              </Popover>
            )}
          </div>
        </>
      )}

      {/* Nested sub-sections — rendered visually contained inside
          the parent block, after the parent's own items. Each is
          the same SectionBlock component at depth=1, so all drag/
          drop / add-item / delete affordances carry through
          consistently. */}
      {subSections && subSections.length > 0 && (
        <div className="mt-5 space-y-3">
          {subSections.map((sub) => (
            <SectionBlock
              key={sub.category.id}
              category={sub.category}
              items={sub.items}
              selectedItemId={selectedItemId}
              onOpenItem={onOpenItem}
              onDragStartItem={onDragStartItem}
              onDragEndItem={onDragEndItem}
              draggingItemId={draggingItemId}
              onAssign={onAssign}
              depth={1}
              t={t}
            />
          ))}
        </div>
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
  onDragStart,
  onDragEnd,
  t,
}: {
  item: MenuItem
  selected: boolean
  onClick: () => void
  /** Native HTML5 drag hooks — parent tracks the currently-dragging
   *  item id so drop targets highlight and the source card dims.
   *  When omitted (older call sites), the card isn't draggable. */
  onDragStart?: () => void
  onDragEnd?: () => void
  t: T
}) {
  const isInactive = !item.active
  const isImported = isImportedSource(item.source)
  const mapped = hasRecipe(item)
  const ringClass = selected
    ? 'border-blue-500 shadow-[0_0_0_2px_rgba(59,130,246,0.12)]'
    : 'border-gray-200/80 hover:border-gray-300'

  // Availability cue. Healthy items return null and the card stays
  // visually quiet — no extra signals, matching the "do not surface
  // projected count on healthy items" rule.
  const availabilityCue = shortAvailabilityChip({
    projectedCount: item.projectedCount,
    projectionState: item.projectionState,
    effectiveSellability: item.effectiveSellability,
    bottleneckInventoryItemId: null,
  })
  // Cards visually dim when the item is unsellable for any reason
  // (inactive, manually disabled, auto-disabled by a stock-out).
  // 70% retains card readability while reading as "not in play."
  const unsellable = item.effectiveSellability === 'auto_disabled'
    || item.effectiveSellability === 'manually_disabled'
    || isInactive

  // ---- ONE status badge, picked by strict priority ----
  //
  // The previous polish dropped the badge pile too aggressively and
  // the cards read as flat. The revision restores a single highest-
  // priority status badge per card — never a pile — chosen by:
  //
  //   1. Imported + unmapped (any state)  → "Needs review"  amber
  //      (catch-all — the manager hasn't yet mapped the imported
  //      item, and that's the action regardless of active state)
  //   2. Inactive                         → "Inactive"      gray
  //   3. Disabled (manual override off)   → "Disabled"      gray
  //   4. Out / Out · Override on          → from cue        red/amber
  //   5. Low · N left                     → from cue        amber
  //   6. Native + unmapped (active)       → no badge — the metadata
  //                                          line "No recipe" carries
  //                                          the signal itself.
  //
  // Healthy mapped items return null and the card carries only the
  // quiet recipe metadata.
  type BadgeTone = 'red' | 'amber' | 'gray'
  let status: { label: string; tone: BadgeTone } | null = null
  if (isImported && !mapped) {
    status = { label: t('Needs review', 'Pendiente de revisión'), tone: 'amber' }
  } else if (isInactive) {
    status = { label: t('Inactive', 'Inactivo'), tone: 'gray' }
  } else if (availabilityCue?.label === 'Disabled') {
    status = { label: t('Disabled', 'Desactivado'), tone: 'gray' }
  } else if (availabilityCue?.label.startsWith('Out')) {
    // availabilityCue.label may be "Out" or "Out · Override on" — translate the prefix.
    const translated = availabilityCue.label.replace(/^Out/, t('Out', 'Agotado')).replace('Override on', t('Override on', 'Sobrescribir activo'))
    status = { label: translated, tone: availabilityCue.tone === 'red' ? 'red' : 'amber' }
  } else if (availabilityCue?.label.startsWith('Low')) {
    // "Low · N left" → translate "Low" and "left".
    const translated = availabilityCue.label
      .replace(/^Low/, t('Low', 'Bajo'))
      .replace(/\bleft\b/, t('left', 'restantes'))
    status = { label: translated, tone: 'amber' }
  }

  // ---- Metadata line (always rendered) ----
  //
  // Calm text that describes the item's recipe and (when relevant)
  // its source. Three patterns, matching the spec examples:
  //
  //   mapped               → "Recipe · N ingredients"   (green pill)
  //   imported + unmapped  → "Imported item · No recipe" (amber text)
  //   native  + unmapped   → "No recipe"                 (amber text)
  //
  // Mapped items render as a small soft green pill so the "this is
  // healthy" signal pops back into the card after the prior polish
  // pass made it too quiet. Unmapped items stay plain colored text
  // (no pill) so the right-side status badge still reads as the
  // dominant call to action when something needs review.
  const metadata = mapped
    ? {
        text: t(
          `Recipe · ${item.recipe.length} ingredient${item.recipe.length !== 1 ? 's' : ''}`,
          `Receta · ${item.recipe.length} ingrediente${item.recipe.length !== 1 ? 's' : ''}`,
        ),
        kind: 'pill' as const,
      }
    : isImported
      ? { text: t('Imported item · No recipe', 'Artículo importado · Sin receta'), kind: 'text' as const, tone: 'amber' as const }
      : { text: t('No recipe', 'Sin receta'), kind: 'text' as const, tone: 'amber' as const }

  return (
    // Was a <button> — but HTML5 drag on <button> is broken in
    // Firefox and inconsistent in Chrome. AwaitingItemCard uses
    // <div role="button"> and drags reliably; matching that
    // pattern here so items in populated sections can also be
    // dragged onto other chips or section bodies.
    <div
      // Stable DOM id so external surfaces (e.g. the Inventory item
      // drawer's "Used in menu items" links via /menu?item=<id>) can
      // call scrollIntoView after the menu page hydrates the
      // selection from the URL.
      id={`menu-item-${item.id}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      aria-pressed={selected}
      // Native HTML5 drag: only enabled when the parent passed
      // onDragStart, so older mount points (drawer, POS side) stay
      // click-only. dataTransfer carries the item id so a drop
      // target can read it out cheaply.
      draggable={!!onDragStart}
      onDragStart={onDragStart ? (e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', item.id)
        onDragStart()
      } : undefined}
      onDragEnd={onDragEnd}
      className={`group relative text-left rounded-xl border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] px-4 pt-3.5 pb-3 transition-all duration-150 hover:shadow-md ${ringClass} ${unsellable ? 'opacity-70' : ''} ${onDragStart ? 'cursor-grab active:cursor-grabbing' : ''} cursor-pointer`}
    >
      {/* Identity row — name + price baseline-aligned so the eye reads
          them as one operational pair. */}
      <div className="flex items-baseline justify-between gap-3">
        <p
          className={`text-sm font-semibold tracking-tight truncate transition-colors ${
            selected ? 'text-blue-700' : 'text-gray-900 group-hover:text-blue-700'
          }`}
        >
          {item.name}
        </p>
        <span className="text-[13px] font-mono tabular-nums font-medium text-gray-900 flex-shrink-0">
          {fmtMoney(item.currentPrice)}
        </span>
      </div>

      {/* Footer band — metadata left, single status badge right.
          The hairline divider that used to sit between identity and
          metadata was removed for a calmer card. Vertical rhythm
          alone (mt-3) keeps the three-layer reading without an
          explicit rule. */}
      <div className="mt-3 flex items-center justify-between gap-3 min-h-[22px]">
        <div className="min-w-0 flex-1">
          {metadata.kind === 'pill' ? (
            <span className="inline-flex text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-50 text-green-700">
              {metadata.text}
            </span>
          ) : (
            <p
              className={`text-[11px] truncate ${
                metadata.tone === 'amber' ? 'text-amber-700' : 'text-gray-500'
              }`}
            >
              {metadata.text}
            </p>
          )}
        </div>
        {status && (
          <span
            className={`flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded ${
              status.tone === 'red'
                ? 'bg-red-50 text-red-700'
                : status.tone === 'amber'
                  ? 'bg-amber-50 text-amber-700'
                  : 'bg-gray-50 text-gray-600 border border-gray-200/70'
            }`}
          >
            {status.label}
          </span>
        )}
      </div>

      {/* Projected-count line — quiet secondary metadata that shows
          how many units the recipe can produce against current
          inventory ("6 in stock"). Rendered only when the projection
          is definite (mapped item, inventory activated, all
          ingredients have stock). Healthy items now show the number
          instead of hiding it — pilot merchant asked for visibility
          on every mapped item, not just low/out. Skips when the
          right-side status badge already carries a count
          ("Low · 3 left") to avoid duplication. */}
      {item.projectedCount !== null
        && item.projectionState !== 'unavailable_to_project'
        && !(status?.label.startsWith(t('Low', 'Bajo')) || status?.label.startsWith('Low'))
        && !(status?.label.startsWith(t('Out', 'Agotado')) || status?.label.startsWith('Out'))
        && (
          <p className="mt-1 text-[10.5px] font-mono tabular-nums text-gray-500">
            {item.projectedCount} {t('in stock', 'en stock')}
          </p>
        )}
    </div>
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
/** Top-level section form: name only, always creates a top-level
 *  category. Sub-categories get their own entry point on each
 *  parent's section header — see AddSubSectionForm below. Keeping
 *  the two flows separate means the top-level "+ Add section"
 *  button unambiguously means "make a new top-level," and the
 *  in-section "+ Sub-section" button unambiguously means
 *  "make a child of THIS parent." No more forgetting to pick a
 *  parent from a dropdown. */
function AddSectionForm({
  onClose,
  t,
}: {
  onClose: () => void
  t: T
}) {
  const [state, action, pending] = useActionState(createCategory, null)

  // Close only once a submit has actually settled clean. The old
  // `action={(fd) => { action(fd); if (!state?.error) onClose() }}`
  // read `state` from the pre-submit render — always null on the
  // first try — so it closed unconditionally and threw away the
  // server's error ("Only the owner can edit the menu.", duplicate
  // name, RLS failure). The button looked inert on every rejection.
  const wasPending = useRef(false)
  useEffect(() => {
    if (wasPending.current && !pending && !state?.error) onClose()
    wasPending.current = pending
  }, [pending, state, onClose])

  return (
    <form action={action} className="space-y-3">
      <p className="text-xs font-semibold text-gray-900">{t('New section', 'Nueva sección')}</p>
      <input
        name="name"
        type="text"
        required
        autoFocus
        placeholder={t('Section name', 'Nombre de la sección')}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
      />
      {state?.error && <p className="text-[11px] text-red-600">{state.error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="flex-1 px-3 py-2 rounded-lg bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 disabled:opacity-60 transition-colors"
        >
          {pending ? t('Adding…', 'Agregando…') : t('Add section', 'Agregar sección')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
        >
          {t('Cancel', 'Cancelar')}
        </button>
      </div>
    </form>
  )
}

/** In-context sub-section form. Pre-scoped to a specific parent
 *  via a hidden parent_id input, so the manager just types a
 *  name and submits — no dropdown, no risk of picking the wrong
 *  parent. Rendered inside a Popover anchored to the "+ Sub-section"
 *  button on each parent's SectionBlock header. */
function AddSubSectionForm({
  parentId,
  parentName,
  onClose,
  t,
}: {
  parentId: string
  parentName: string
  onClose: () => void
  t: T
}) {
  const [state, action, pending] = useActionState(createCategory, null)
  const wasPending = useRef(false)
  useEffect(() => {
    if (wasPending.current && !pending && !state?.error) onClose()
    wasPending.current = pending
  }, [pending, state, onClose])

  return (
    <form action={action} className="space-y-3">
      <p className="text-xs font-semibold text-gray-900">
        {t(`New sub-section under ${parentName}`, `Nueva sub-sección bajo ${parentName}`)}
      </p>
      <input type="hidden" name="parent_id" value={parentId} />
      <input
        name="name"
        type="text"
        required
        autoFocus
        placeholder={t('Sub-section name', 'Nombre de la sub-sección')}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
      />
      {state?.error && <p className="text-[11px] text-red-600">{state.error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="flex-1 px-3 py-2 rounded-lg bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 disabled:opacity-60 transition-colors"
        >
          {pending ? t('Adding…', 'Agregando…') : t('Add sub-section', 'Agregar sub-sección')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
        >
          {t('Cancel', 'Cancelar')}
        </button>
      </div>
    </form>
  )
}

// ================================================================
// AddItemForm — popover, dark-filled primary commit.
// ================================================================
function AddItemForm({ categoryId, onClose, t }: { categoryId: string; onClose: () => void; t: T }) {
  const [state, action, pending] = useActionState(createMenuItemInSection, null)
  return (
    <form action={(fd) => { action(fd); if (!state?.error) onClose() }} className="space-y-3">
      <p className="text-xs font-semibold text-gray-900">{t('New item', 'Nuevo artículo')}</p>
      <input type="hidden" name="category_id" value={categoryId} />
      <input
        name="name"
        type="text"
        required
        autoFocus
        placeholder={t('Item name', 'Nombre del artículo')}
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
        {t('Map ingredients to inventory once the item is open in the drawer.', 'Vincula los ingredientes al inventario una vez que el artículo esté abierto en el panel.')}
      </p>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="flex-1 px-3 py-2 rounded-lg bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 disabled:opacity-60 transition-colors"
        >
          {pending ? t('Adding…', 'Agregando…') : t('Add item', 'Agregar artículo')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
        >
          {t('Cancel', 'Cancelar')}
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
  categories,
  inventoryItems,
  inventoryActive,
  onAssign,
  onClose,
  t,
}: {
  item: MenuItem
  sectionName: string | null
  /** Every category the restaurant has, so the "pick a section"
   *  surface can list them when the current item is uncategorized. */
  categories: Category[]
  inventoryItems: InventoryItem[]
  inventoryActive: boolean
  /** Same optimistic-move handler the page uses for drag-drop and
   *  the awaiting-band popover. Wired here so the drawer can share
   *  the same assign path — no parallel logic. */
  onAssign: (itemId: string, categoryId: string | null) => void
  onClose: () => void
  t: T
}) {
  const [addState, addAction, addPending] = useActionState(addRecipeComponent, null)
  const [createState, createAction, createPending] = useActionState(createInlineInventoryItem, null)
  const [deleteState, deleteAction, deletePending] = useActionState(deleteMenuItem, null)
  const [activeState, activeAction, activePending] = useActionState(setMenuItemActive, null)
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
  const [selectedIngredient, setSelectedIngredient] = useState<InventoryItem | null>(null)
  const [creatingNew, setCreatingNew] = useState(false)

  // Auto-select ingredient after creation succeeds — lands the user
  // straight on the confirm step (quantity + commit) without making
  // them search again for the thing they just created.
  useEffect(() => {
    if (createState && 'item' in createState && createState.item) {
      const created = createState.item
      setSelectedIngredient({ id: created.id, name: created.name, unitOfMeasure: created.unitOfMeasure })
      setQuery(created.name)
      setCreatingNew(false)
    }
  }, [createState])

  const filtered = query.trim()
    ? available.filter((ii) => ii.name.toLowerCase().includes(query.toLowerCase()))
    : available

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

  // The add card is a small two-step inline workspace, not a floating
  // autocomplete. Selecting an ingredient transitions to a confirm
  // view (quantity + commit), so we don't echo the picked name back
  // into `query` — that would flicker the search field on a screen
  // the user has already left.
  const selectIngredient = (ii: InventoryItem) => {
    setSelectedIngredient(ii)
    setCreatingNew(false)
  }

  const startCreate = () => {
    setCreatingNew(true)
    setSelectedIngredient(null)
  }

  const resetCombo = () => {
    setQuery('')
    setSelectedIngredient(null)
    setCreatingNew(false)
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
    item.source === 'manual' ? t('Manual', 'Manual') :
    item.source === 'imported' || item.source === 'external' ? t('Imported', 'Importado')
      : item.source

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-gray-900/30 backdrop-blur-[1px] z-40"
      />
      <aside className="fixed top-0 right-0 z-50 h-full w-full sm:max-w-md md:max-w-lg lg:max-w-md bg-white shadow-2xl border-l border-gray-200 flex flex-col">

        {/* HEADER — three-tier identity, in order:
              1. Item name (drawer headline)
              2. Calm meta line: "{Section} · ${Price} · {Source}"
              3. Status pill row: "Active/Inactive" + an optional
                 secondary state pill (Sellable / Low · N left / Out
                 / Disabled / etc.) so the manager reads "can this
                 be sold?" without diving into the Sellability band.
            The previous layout split price into its own line; this
            revision collapses identity into one quiet meta row so
            the pills below pop as the actionable signal. */}
        <div className="border-b border-gray-100 px-6 py-5 flex-shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <HeaderNameEditor item={item} t={t} />
              {/* Meta row — section + source on either side of the
                  inline price editor. Wrapped in a flex container
                  (not a <p>) so the price editor can swap to an
                  input + Save/Cancel inline without breaking the
                  layout. */}
              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-gray-500 leading-relaxed">
                {sectionName && (
                  <>
                    <span>{sectionName}</span>
                    <span className="text-gray-300">·</span>
                  </>
                )}
                <HeaderPriceEditor item={item} t={t} />
                <span className="text-gray-300">·</span>
                <span>{sourceLabel}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex-shrink-0 rounded-lg border border-gray-200/80 px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors -mt-1 -mr-1"
            >
              {t('Close', 'Cerrar')}
            </button>
          </div>
          {/* Top status pills — up to three:
                1. Active / Inactive (always)
                2. Sellable / Sellable · override on / Hidden by override
                   (suppressed for Inactive items, and when the stock
                   pill already says "Out" we skip a redundant "Not
                   sellable" pill — the stock pill carries that fact.)
                3. Stock state — Healthy / Low · N left / Out / No
                   recipe / Stock unknown (suppressed for Inactive).
              The bottleneck inventory item, when present and the
              stock is low/out, renders as a calm sub-line beneath
              the pills (relocated from the removed Sellability
              card). This replaces the prior single-secondary chip
              and brings stock + sellability into the header. */}
          <div className="mt-3 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {(() => {
                type PillTone = 'green' | 'blue' | 'amber' | 'red' | 'gray'
                const pills: { label: string; tone: PillTone }[] = []

                // Pill 1 — Active state
                pills.push({
                  label: item.active ? t('Active', 'Activo') : t('Inactive', 'Inactivo'),
                  tone: item.active ? 'green' : 'gray',
                })

                if (item.active) {
                  // Pill 2 — Sellability (suppressed for the
                  // auto_disabled-because-Out case; the stock pill
                  // already says "Out".)
                  switch (item.effectiveSellability) {
                    case 'enabled':
                      pills.push({ label: t('Sellable', 'Vendible'), tone: 'blue' })
                      break
                    case 'manually_enabled':
                      pills.push({ label: t('Sellable · override on', 'Vendible · sobrescribir activo'), tone: 'amber' })
                      break
                    case 'manually_disabled':
                      pills.push({ label: t('Hidden by override', 'Oculto por sobrescribir'), tone: 'gray' })
                      break
                    case 'auto_disabled':
                      // Stock pill below carries the signal — no
                      // separate "Not sellable" pill.
                      break
                    case 'inactive':
                      break
                  }

                  // Pill 3 — Stock state
                  switch (item.projectionState) {
                    case 'healthy':
                      pills.push({ label: t('Healthy', 'Saludable'), tone: 'green' })
                      break
                    case 'low':
                      pills.push({
                        label: item.projectedCount !== null ? t(`Low · ${item.projectedCount} left`, `Bajo · ${item.projectedCount} restantes`) : t('Low', 'Bajo'),
                        tone: 'amber',
                      })
                      break
                    case 'out':
                      pills.push({ label: t('Out', 'Agotado'), tone: 'red' })
                      break
                    case 'unavailable_to_project':
                      pills.push({
                        label: hasRecipe(item) ? t('Stock unknown', 'Inventario desconocido') : t('No recipe', 'Sin receta'),
                        tone: 'gray',
                      })
                      break
                  }
                }

                const toneClass: Record<PillTone, string> = {
                  green: 'bg-green-50 text-green-700',
                  blue: 'bg-blue-50 text-blue-700',
                  amber: 'bg-amber-50 text-amber-700',
                  red: 'bg-red-50 text-red-700',
                  gray: 'bg-gray-100 text-gray-600',
                }

                return pills.map((p, i) => (
                  <span
                    key={`${p.label}-${i}`}
                    className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${toneClass[p.tone]}`}
                  >
                    {/* Show a leading dot only on the Active pill —
                        keeps the active/inactive distinction quick
                        to read while the other pills stay calmer. */}
                    {i === 0 && (
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        p.tone === 'green' ? 'bg-green-500' : 'bg-gray-400'
                      }`} />
                    )}
                    {p.label}
                  </span>
                ))
              })()}
            </div>
            {item.active &&
              item.bottleneckInventoryItemName &&
              (item.projectionState === 'low' || item.projectionState === 'out') && (
                <p className="text-[11px] text-gray-500 leading-relaxed">
                  {t('Limited by', 'Limitado por')}{' '}
                  <span className="font-medium text-gray-700">
                    {item.bottleneckInventoryItemName}
                  </span>
                </p>
              )}

            {/* Projected-count stat — concrete number based on recipe
                × current stock. Only renders when the projection is
                definite (mapped item, inventory activated, all
                ingredients tracked). Sits alongside the pills so a
                Healthy item shows "Can produce: 42" instead of just
                a green pill; a Low item echoes the number that's
                already in the pill; an Out item shows a clear 0.
                Complements the smaller line on the card. */}
            {item.active
              && item.projectedCount !== null
              && item.projectionState !== 'unavailable_to_project' && (
                <p className="text-[11px] text-gray-500 leading-relaxed">
                  {t('Can produce', 'Puede producir')}{' '}
                  <span className={`font-mono tabular-nums font-semibold ${
                    item.projectedCount === 0 ? 'text-red-700'
                      : item.projectionState === 'low' ? 'text-amber-700'
                        : 'text-gray-800'
                  }`}>
                    {item.projectedCount}
                  </span>{' '}
                  {item.projectedCount === 1 ? t('unit', 'unidad') : t('units', 'unidades')}{' '}
                  <span className="text-gray-400">{t('from current stock', 'con el stock actual')}</span>
                </p>
              )}
          </div>
        </div>

        {/* Inactive ribbon — same pattern as Sales' voided stamp.
            Includes the inline Activate button so promoting an item
            after building its recipe is a single-click operation
            from the ribbon (which is the natural eye-catch when an
            inactive item is opened). */}
        {!item.active && (
          <div className="border-b border-amber-200/60 bg-amber-50/40 px-6 py-2.5 flex items-center gap-3 flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
            <p className="text-[11px] text-amber-700 flex-1 leading-relaxed">
              {t(
                "Inactive · this item won't appear at the POS until it's activated.",
                'Inactivo · este artículo no aparecerá en el POS hasta que se active.',
              )}
            </p>
            <form action={activeAction}>
              <input type="hidden" name="item_id" value={item.id} />
              <input type="hidden" name="active" value="true" />
              <button
                type="submit"
                disabled={activePending}
                className="rounded-md bg-amber-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-amber-700 disabled:opacity-60 transition-colors whitespace-nowrap"
              >
                {activePending ? t('Activating…', 'Activando…') : t('Activate', 'Activar')}
              </button>
            </form>
          </div>
        )}
        {activeState?.error && !item.active && (
          <div className="border-b border-red-200/60 bg-red-50/60 px-6 py-2 flex-shrink-0">
            <p className="text-[11px] text-red-700">{activeState.error}</p>
          </div>
        )}

        {/* BODY
            Uncategorized items get an assignment-first gate — no
            recipe, no availability, no controls until the item lives
            in a section. Once assigned, the full stack renders. */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {item.categoryId === null && (
            <AssignSectionBody
              itemId={item.id}
              categories={categories}
              onAssign={onAssign}
              t={t}
            />
          )}

          {item.categoryId !== null && (<>

          {/* Recipe card — self-contained with the eyebrow inside
              the card chrome (not above it). Subtle cool/neutral
              tint sets it apart from the POS override and Item
              controls cards below without adding loud color. */}
          <section className="rounded-xl border border-gray-200/80 bg-gray-50/40 p-4">
            <p className="mb-3 text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              {t('Recipe', 'Receta')}
            </p>

            {item.recipe.length > 0 && (
              <ul className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] divide-y divide-gray-100 mb-3 overflow-hidden">
                {item.recipe.map((rc) => (
                  <RecipeRow key={rc.id} rc={rc} menuItemId={item.id} t={t} />
                ))}
              </ul>
            )}

            {item.recipe.length === 0 && !addOpen && (
              <p className="mb-3 text-xs text-gray-500 leading-relaxed">
                {t('No ingredients yet. Map inventory to deplete stock when this sells.', 'Aún no hay ingredientes. Vincula el inventario para descontar existencias cuando se venda este artículo.')}
              </p>
            )}

            {/* Add-ingredient interaction.
                Default state is a quiet outlined "+ Add ingredient"
                button. Clicking it reveals an inline 2-step add card
                directly below the recipe list:
                  • Step 1 — pick: search field + integrated results
                    list + "+ Create new ingredient" row at the bottom.
                  • Step 2 — confirm: selected ingredient summary +
                    quantity input + Add / Cancel action row.
                Create-new is a deliberate branch off step 1 that keeps
                the user inside the same contained card. The results
                list is part of the card (no detached floating dropdown). */}
            {!addOpen ? (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="w-full rounded-lg bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800 transition-colors"
              >
                {t('+ Add ingredient', '+ Agregar ingrediente')}
              </button>
            ) : (
              <div className="rounded-xl border border-gray-200 bg-gray-50/60 overflow-hidden">

                {/* Top row: eyebrow + Cancel (persistent escape).
                    Cancel here always closes the entire add surface.
                    The in-create "Back" button below is the step-back
                    affordance and is distinct from this Cancel. */}
                <div className="px-3.5 pt-3 pb-2 flex items-center justify-between gap-3">
                  <p className={`text-[10px] font-semibold uppercase tracking-widest ${
                    creatingNew ? 'text-blue-700' : 'text-gray-500'
                  }`}>
                    {creatingNew ? t('New ingredient', 'Nuevo ingrediente') : t('Add ingredient', 'Agregar ingrediente')}
                  </p>
                  <button
                    type="button"
                    onClick={closeAddSurface}
                    className="text-[10px] font-medium text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    {t('Cancel', 'Cancelar')}
                  </button>
                </div>

                {creatingNew ? (
                  // ===== Create branch =====
                  <form action={(fd) => createAction(fd)} className="px-3.5 pb-3.5">
                    <input type="hidden" name="menu_item_id" value={item.id} />
                    <input type="hidden" name="name" value={query.trim()} />

                    <label className="block mb-2.5">
                      <span className="block text-[11px] font-semibold text-gray-600 mb-1.5">
                        {t('Name', 'Nombre')}
                      </span>
                      <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        autoFocus
                        placeholder={t('Ingredient name', 'Nombre del ingrediente')}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
                      />
                    </label>

                    <label className="block mb-3">
                      <span className="block text-[11px] font-semibold text-gray-600 mb-1.5">
                        {t('Unit', 'Unidad')}
                      </span>
                      <select
                        name="unit_of_measure"
                        defaultValue="units"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
                      >
                        <option value="units">{t('Units (each)', 'Unidades (cada uno)')}</option>
                        <option value="kg">{t('Kilograms', 'Kilogramos')}</option>
                        <option value="lbs">{t('Pounds', 'Libras')}</option>
                        <option value="liters">{t('Liters', 'Litros')}</option>
                        <option value="oz">{t('Ounces', 'Onzas')}</option>
                        <option value="gallons">{t('Gallons', 'Galones')}</option>
                        <option value="cases">{t('Cases', 'Cajas')}</option>
                        <option value="bags">{t('Bags', 'Bolsas')}</option>
                      </select>
                    </label>

                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={createPending || !query.trim()}
                        className="flex-1 px-3 py-2 rounded-lg bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 disabled:opacity-60 transition-colors"
                      >
                        {createPending ? t('Creating…', 'Creando…') : t('Create ingredient', 'Crear ingrediente')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setCreatingNew(false)}
                        className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        {t('Back', 'Atrás')}
                      </button>
                    </div>
                    {createState?.error && (
                      <p className="text-[11px] text-red-600 mt-2">{createState.error}</p>
                    )}
                  </form>
                ) : selectedIngredient ? (
                  // ===== Step 2: confirm =====
                  <form action={(fd) => addAction(fd)} className="px-3.5 pb-3.5">
                    <input type="hidden" name="menu_item_id" value={item.id} />
                    <input type="hidden" name="inventory_item_id" value={selectedIngredient.id} />

                    {/* Selection summary — clear "this is what's being added" */}
                    <div className="rounded-lg border border-gray-200/80 bg-white px-3 py-2.5 mb-3">
                      <p className="text-sm font-medium text-gray-900 truncate">{selectedIngredient.name}</p>
                      <p className="text-[11px] text-gray-500 mt-0.5">{selectedIngredient.unitOfMeasure}</p>
                    </div>

                    {/* Quantity input — only after selection.
                        Unit picker sits next to the number so a
                        recipe can measure in oz / g / ml even
                        when inventory is tracked in lb / kg / gal. */}
                    <label className="block mb-3">
                      <span className="block text-[11px] font-semibold text-gray-600 mb-1.5">
                        {t('Quantity per dish', 'Cantidad por platillo')}
                      </span>
                      <QtyWithUnitPicker
                        inventoryUnit={selectedIngredient.unitOfMeasure}
                        inventoryName={selectedIngredient.name}
                        autoFocus
                        t={t}
                      />
                    </label>

                    {/* Action row */}
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={addPending}
                        className="flex-1 px-3 py-2 rounded-lg bg-gray-900 text-white text-xs font-semibold hover:bg-gray-800 disabled:opacity-60 transition-colors"
                      >
                        {addPending ? t('Adding…', 'Agregando…') : t('Add ingredient', 'Agregar ingrediente')}
                      </button>
                      <button
                        type="button"
                        onClick={closeAddSurface}
                        className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        {t('Cancel', 'Cancelar')}
                      </button>
                    </div>
                    {addState?.error && (
                      <p className="text-[11px] text-red-600 mt-2">{addState.error}</p>
                    )}
                  </form>
                ) : (
                  // ===== Step 1: pick =====
                  <div className="px-3.5 pb-3.5">
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      autoFocus
                      placeholder={t('Search ingredient...', 'Buscar ingrediente...')}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
                    />

                    {/* Integrated results list — part of the same card,
                        not a floating autocomplete. The "+ Create new
                        ingredient" row is visually separated by a
                        top border so the alternative path reads as a
                        deliberate branch, not the default action. */}
                    <div className="mt-2 rounded-lg border border-gray-200/80 bg-white overflow-hidden">
                      <div className="max-h-44 overflow-y-auto divide-y divide-gray-100">
                        {filtered.length > 0 ? (
                          filtered.map((ii) => (
                            <button
                              key={ii.id}
                              type="button"
                              onClick={() => selectIngredient(ii)}
                              className="w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-blue-50 transition-colors"
                            >
                              <span className="font-medium">{ii.name}</span>
                              <span className="text-gray-400 text-xs ml-2">— {ii.unitOfMeasure}</span>
                            </button>
                          ))
                        ) : (
                          <p className="px-3 py-2.5 text-xs text-gray-400">
                            {available.length === 0 ? t('All items already in recipe.', 'Todos los artículos ya están en la receta.') : t('No matches.', 'Sin coincidencias.')}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={startCreate}
                        className="w-full text-left px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 transition-colors border-t border-gray-200"
                      >
                        {t('+ Create new ingredient', '+ Crear nuevo ingrediente')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* POS Override card — subtle blue tint marks it as a
              system/availability control. Separation from Recipe
              now comes from the gap between cards (space-y-4) plus
              the distinct hue, not from a hairline divider. */}
          <section className="rounded-xl border border-blue-200/60 bg-blue-50/30 p-4">
            <AvailabilitySection item={item} t={t} />
          </section>

          {/* Item controls card — compact destructive zone. Renamed
              from the former pinned footer into a normal in-body
              card so the drawer reads as a stack rather than
              pinned-foot heavy. Internal divide-y keeps the two
              rows tight; small action buttons sit on the right. */}
          <section className="rounded-xl border border-gray-200/80 bg-gray-50/40 px-3.5 py-2.5">
            <p className="mb-2 text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              {t('Item controls', 'Controles del artículo')}
            </p>
            <div className="divide-y divide-gray-200/60">
              {item.active && (
                <div className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium text-gray-900">{t('Deactivate this item', 'Desactivar este artículo')}</p>
                    <p className="text-[10px] text-gray-500 leading-snug mt-0.5">
                      {t('Hides from POS and analytics. Recipe links stay saved.', 'Lo oculta del POS y de los análisis. Los vínculos de receta se conservan.')}
                    </p>
                  </div>
                  <form action={activeAction} className="flex-shrink-0">
                    <input type="hidden" name="item_id" value={item.id} />
                    <input type="hidden" name="active" value="false" />
                    <button
                      type="submit"
                      disabled={activePending}
                      className="rounded-md border border-amber-200 bg-white text-amber-700 hover:bg-amber-50 hover:border-amber-300 px-2.5 py-1 text-[10px] font-semibold disabled:opacity-60 transition-colors whitespace-nowrap"
                    >
                      {activePending ? t('Deactivating…', 'Desactivando…') : t('Deactivate', 'Desactivar')}
                    </button>
                  </form>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-[12px] font-medium text-gray-900">{t('Remove this item', 'Eliminar este artículo')}</p>
                  <p className="text-[10px] text-gray-500 leading-snug mt-0.5">
                    {t('Removes the item and clears its recipe links. Past orders stay in Sales.', 'Elimina el artículo y borra sus vínculos de receta. Las órdenes pasadas se conservan en Ventas.')}
                  </p>
                </div>
                {!removeMode ? (
                  <button
                    type="button"
                    onClick={() => setRemoveMode(true)}
                    className="flex-shrink-0 rounded-md border border-red-200 bg-white text-red-700 hover:bg-red-50 hover:border-red-300 px-2.5 py-1 text-[10px] font-semibold transition-colors whitespace-nowrap"
                  >
                    {t('Remove', 'Eliminar')}
                  </button>
                ) : (
                  <form action={deleteAction} className="flex-shrink-0 flex items-center gap-1">
                    <input type="hidden" name="item_id" value={item.id} />
                    <button
                      type="submit"
                      disabled={deletePending}
                      className="rounded-md border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 px-2 py-1 text-[10px] font-semibold disabled:opacity-60 transition-colors whitespace-nowrap"
                    >
                      {deletePending ? t('Removing…', 'Eliminando…') : t('Confirm', 'Confirmar')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemoveMode(false)}
                      disabled={deletePending}
                      className="rounded-md border border-gray-200 bg-white text-[10px] font-medium text-gray-600 px-2 py-1 hover:bg-gray-50 transition-colors"
                    >
                      {t('Cancel', 'Cancelar')}
                    </button>
                  </form>
                )}
              </div>

              {(activeState?.error || deleteState?.error) && (
                <p className="py-2 text-[11px] text-red-600">
                  {activeState?.error || deleteState?.error}
                </p>
              )}
            </div>
          </section>

          </>)}
        </div>

      </aside>
    </>
  )
}

// ================================================================
// AssignSectionBody — the "pick a section first" surface that
// replaces the recipe / availability / controls stack in the drawer
// when the current item has no category assigned yet.
//
// Rationale: an imported item with no section can't have a POS
// override (there's no POS button for it), can't have a stock
// projection (unclear where it lives operationally), and its recipe
// is technically editable but pointless before the item has a
// place in the menu structure. So the drawer collapses everything
// down to one question: which section does this belong to?
//
// After the manager taps a category, the assign action fires
// through the same optimistic path the awaiting band uses. On
// success the item's categoryId changes, this component's parent
// re-renders, and the full drawer stack (recipe / availability /
// controls) shows in its place — no navigation required.
//
// The card matches the amber tone of the awaiting band on the
// main page so the "this item needs your attention" language stays
// consistent across surfaces.
// ================================================================
function AssignSectionBody({
  itemId,
  categories,
  onAssign,
  t,
}: {
  itemId: string
  categories: Category[]
  onAssign: (itemId: string, categoryId: string | null) => void
  t: T
}) {
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
      <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-amber-800">
        {t('Assign a section', 'Asignar una sección')}
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-amber-900">
        {t(
          'This item has no section yet. Pick one to unlock the recipe, availability, and other controls.',
          'Este artículo aún no tiene sección. Elige una para desbloquear la receta, la disponibilidad y demás controles.'
        )}
      </p>

      {categories.length === 0 ? (
        <p className="mt-4 text-[12px] text-gray-600 leading-relaxed">
          {t(
            'No sections exist yet. Add one from the menu page first, then come back here.',
            'Aún no hay secciones. Agrega una desde la página del menú primero, y regresa aquí.'
          )}
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => onAssign(itemId, cat.id)}
              className="text-left px-3 py-2.5 rounded-lg border border-amber-200 bg-white hover:border-amber-400 hover:bg-amber-50 transition-colors group"
            >
              <span className="text-[13px] font-semibold text-gray-900 group-hover:text-amber-900 transition-colors">
                {cat.name}
              </span>
              <span className="ml-2 text-[11px] text-amber-700 opacity-0 group-hover:opacity-100 transition-opacity">
                {t('Move here', 'Mover aquí')} →
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

// ================================================================
// AvailabilitySection — POS override control band.
//
// Previously rendered a Stock status card + the override card under
// a "Sellability" eyebrow. The stock card was removed in this pass
// — its information (Active / Sellable / Healthy-Low-Out, plus the
// bottleneck "Limited by") now lives in the drawer header pills.
// What remains here is the compact override control: three options
// in a single horizontal segmented strip plus a quiet hint line.
//
// The override values ('none' / 'force_enabled' / 'force_disabled')
// and the `setMenuItemAvailabilityOverride` action are unchanged —
// POS availability logic is untouched. Only the rendering compacted.
// ================================================================
function AvailabilitySection({ item, t }: { item: MenuItem; t: T }) {
  const [state, action, pending] = useActionState(setMenuItemAvailabilityOverride, null)

  // Override option set. Internal AvailabilityOverride values
  // ('none' / 'force_enabled' / 'force_disabled') are unchanged so
  // setMenuItemAvailabilityOverride keeps working — only the user-
  // facing labels/copy were updated per the polish spec.
  const overrideOptions: { value: AvailabilityOverride; label: string; hint: string }[] = [
    { value: 'none',           label: t('System default', 'Predeterminado del sistema'),    hint: t('System default follows inventory availability.', 'El predeterminado del sistema sigue la disponibilidad del inventario.') },
    { value: 'force_enabled',  label: t('Force available', 'Forzar disponible'),   hint: t('Stay sellable at the POS even when stock projects out.', 'Mantenerlo vendible en el POS incluso cuando el inventario proyecte agotado.') },
    { value: 'force_disabled', label: t('Force unavailable', 'Forzar no disponible'), hint: t('Hide from the POS regardless of stock.', 'Ocultarlo del POS sin importar el inventario.') },
  ]

  // Active override hint — surfaces the consequence of the current
  // selection. Helps the manager understand what the override means
  // without having to read all three options.
  const activeOverrideHint = overrideOptions.find((o) => o.value === item.override)?.hint
  const isOverrideOn = item.override !== 'none'

  return (
    <div>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
          {t('POS override', 'Sobrescribir POS')}
        </p>
        {isOverrideOn && item.overrideSetAt && (
          <p className="text-[10px] text-gray-400 font-mono tabular-nums">
            {t('since', 'desde')} {new Date(item.overrideSetAt).toLocaleString('en-US', {
              month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })}
          </p>
        )}
      </div>

      {/* Compact segmented control — three options share one rounded
          container with hairline internal dividers. Sized smaller
          than the prior card-of-three-buttons so the override reads
          as a secondary control beneath the Recipe workspace, not
          as a major content block. All three sit on one horizontal
          row at typical drawer widths. */}
      <div className="flex w-full rounded-md border border-gray-200 bg-white overflow-hidden">
        {overrideOptions.map((opt, i) => {
          const active = item.override === opt.value
          return (
            <form action={action} key={opt.value} className="flex-1 min-w-0">
              <input type="hidden" name="item_id" value={item.id} />
              <input type="hidden" name="override" value={opt.value} />
              <button
                type="submit"
                disabled={pending || active}
                className={`w-full px-2 py-1.5 text-[10px] font-semibold transition-colors truncate ${
                  i > 0 ? 'border-l border-gray-200' : ''
                } ${
                  active
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-700 hover:bg-gray-50 disabled:opacity-60'
                }`}
              >
                {opt.label}
              </button>
            </form>
          )
        })}
      </div>

      {activeOverrideHint && (
        <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">
          {activeOverrideHint}
        </p>
      )}
      {state?.error && <p className="mt-2 text-[11px] text-red-600">{state.error}</p>}
    </div>
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

// ================================================================
// QtyWithUnitPicker — number input + unit select + live-conversion
// hint, in one self-contained component. Used everywhere a recipe
// row asks for "how much of this ingredient per dish."
//
// Two channels feed the parent form on submit:
//   • name="quantity_required" (number, required, > 0)
//   • name="unit"              (canonical unit code from lib/units,
//                                or "" to mean "same as inventory")
//
// Default selected unit = the inventory item's unit, normalized to
// a canonical code we know how to convert. If the inventory's unit
// is opaque or unknown (`case`, `bag`, `bunches`, etc.), the
// picker only offers that literal option — the recipe must match.
//
// Live hint under the input shows what will actually be depleted:
//   • same-unit picks: "" (nothing to say)
//   • cross-unit picks: "≈ 0.03 lb of Flour" so the manager sees
//     the real depletion at a glance and catches surprises early.
// ================================================================
function QtyWithUnitPicker({
  inventoryUnit,
  inventoryName,
  defaultQty,
  defaultUnit,
  autoFocus,
  t,
}: {
  inventoryUnit: string
  inventoryName: string
  defaultQty?: string
  defaultUnit?: string | null
  autoFocus?: boolean
  t: T
}) {
  const invCanonical = normalizeUnit(inventoryUnit)
  const initialUnit: string = (() => {
    if (defaultUnit) {
      const canon = normalizeUnit(defaultUnit)
      if (canon) return canon
    }
    if (invCanonical) return invCanonical
    // Opaque inventory unit we don't recognize — mirror it verbatim
    // so the option renders and the recipe row matches the inventory.
    return inventoryUnit
  })()

  const [qty, setQty] = useState(defaultQty ?? '')
  const [unit, setUnit] = useState(initialUnit)

  // Available options: if the inventory unit is a known canonical,
  // show every unit in its family (or every convertible unit family +
  // the fallback opaque). If the inventory unit is opaque/unknown,
  // the picker only offers that literal option — no cross-conversion
  // is safe.
  const options: { code: string; label: string; groupLabel?: string }[] = (() => {
    if (!invCanonical) {
      // Opaque or unknown: only offer the literal inventory unit.
      return [{ code: inventoryUnit, label: inventoryUnit || 'unit' }]
    }
    const opts: { code: string; label: string; groupLabel?: string }[] = []
    for (const grp of UNIT_GROUPS) {
      const inGroup = grp.units.some((u) => u === invCanonical)
      // Same family as inventory → offer everything in that family.
      // Opaque family is only offered when inventory is opaque, and
      // that branch was already handled above.
      if (inGroup) {
        for (const u of grp.units) opts.push({ code: u, label: labelFor(u), groupLabel: grp.label })
      }
    }
    return opts
  })()

  // Live conversion hint. Only shown when the picked unit differs
  // from the inventory's canonical unit AND the two are compatible.
  const preview = (() => {
    const n = parseFloat(qty)
    if (!Number.isFinite(n) || n <= 0) return null
    if (!invCanonical) return null // no conversion possible
    const canonPick = normalizeUnit(unit)
    if (!canonPick || canonPick === invCanonical) return null
    const converted = convertQty(n, canonPick, invCanonical)
    if (converted === null) return null
    const rounded = converted < 0.01 ? converted.toPrecision(2) : converted.toFixed(2).replace(/\.?0+$/, '')
    return t(
      `≈ ${rounded} ${labelFor(invCanonical)} of ${inventoryName}`,
      `≈ ${rounded} ${labelFor(invCanonical)} de ${inventoryName}`,
    )
  })()

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          name="quantity_required"
          type="number"
          required
          min="0.0001"
          step="0.0001"
          autoFocus={autoFocus}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="0.00"
          className="flex-1 min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
        />
        <select
          name="unit"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
        >
          {options.map((o) => (
            <option key={o.code} value={o.code}>{o.label}</option>
          ))}
        </select>
      </div>
      {preview && (
        <p className="mt-1.5 text-[11px] text-gray-500 font-mono tabular-nums">{preview}</p>
      )}
    </div>
  )
}

// ================================================================
// HeaderNameEditor — inline name-edit affordance in the drawer
// header. Same interaction shape as HeaderPriceEditor: display
// mode shows the item name with a small Edit link; clicking swaps
// to an input + Save/Cancel. Closes automatically on the
// pending → not-pending transition when the server returned no
// error. Keeps the truncation behavior of the original h2 in the
// display state so long names don't blow the drawer header out.
// ================================================================
function HeaderNameEditor({ item, t }: { item: MenuItem; t: T }) {
  const [state, action, pending] = useActionState(updateMenuItemName, null)
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(item.name)

  const wasPendingRef = useRef(false)
  useEffect(() => {
    if (wasPendingRef.current && !pending && !state?.error) {
      setEditing(false)
      setVal(item.name)
    }
    wasPendingRef.current = pending
  }, [pending, state, item.name])

  if (!editing) {
    return (
      <div className="flex items-start gap-2 min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-gray-900 leading-tight truncate min-w-0">
          {item.name}
        </h2>
        <button
          type="button"
          onClick={() => {
            setVal(item.name)
            setEditing(true)
          }}
          className="mt-1 flex-shrink-0 text-[10px] font-medium text-blue-700 hover:text-blue-900 px-1.5 py-0.5 rounded hover:bg-blue-50 transition-colors"
        >
          {t('Edit', 'Editar')}
        </button>
      </div>
    )
  }

  return (
    <form action={action} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="item_id" value={item.id} />
      <input
        name="name"
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        autoFocus
        required
        maxLength={80}
        className="min-w-0 flex-1 h-8 rounded border border-gray-300 px-2 text-[15px] font-semibold text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
      />
      <button
        type="submit"
        disabled={pending}
        className="text-[10px] font-semibold text-white bg-gray-900 hover:bg-gray-800 px-2 py-1 rounded disabled:opacity-60 transition-colors"
      >
        {pending ? t('Saving…', 'Guardando…') : t('Save name', 'Guardar nombre')}
      </button>
      <button
        type="button"
        onClick={() => {
          setEditing(false)
          setVal(item.name)
        }}
        disabled={pending}
        className="text-[10px] font-medium text-gray-600 hover:text-gray-800 px-1.5 py-1 rounded hover:bg-gray-100 disabled:opacity-60 transition-colors"
      >
        {t('Cancel', 'Cancelar')}
      </button>
      {state?.error && (
        <span className="basis-full text-[10px] text-red-600 mt-0.5">{state.error}</span>
      )}
    </form>
  )
}

// ================================================================
// HeaderPriceEditor — inline price edit affordance in the drawer
// header. Display mode shows `$X.XX` followed by a small Edit link;
// clicking swaps to an input + Save/Cancel. On successful save the
// page revalidates, `item.currentPrice` updates, and the editor
// closes automatically (no manual prop-sync race).
// ================================================================
function HeaderPriceEditor({ item, t }: { item: MenuItem; t: T }) {
  const [state, action, pending] = useActionState(updateMenuItemPrice, null)
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(item.currentPrice.toFixed(2))

  // Close the editor on the pending → not-pending transition when no
  // error was returned. `wasPendingRef` tracks the prior pending
  // value so the close fires once per successful save, not on the
  // initial mount.
  const wasPendingRef = useRef(false)
  useEffect(() => {
    if (wasPendingRef.current && !pending && !state?.error) {
      setEditing(false)
      setVal(item.currentPrice.toFixed(2))
    }
    wasPendingRef.current = pending
  }, [pending, state, item.currentPrice])

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono tabular-nums font-medium text-gray-700">{fmtMoney(item.currentPrice)}</span>
        <button
          type="button"
          onClick={() => {
            setVal(item.currentPrice.toFixed(2))
            setEditing(true)
          }}
          className="text-[10px] font-medium text-blue-700 hover:text-blue-900 px-1.5 py-0.5 rounded hover:bg-blue-50 transition-colors"
        >
          {t('Edit', 'Editar')}
        </button>
      </span>
    )
  }

  return (
    <form action={action} className="inline-flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="item_id" value={item.id} />
      <span className="inline-flex items-center text-gray-500">
        <span className="text-[11px] mr-0.5">$</span>
        <input
          name="price"
          type="number"
          min="0.01"
          step="0.01"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          autoFocus
          required
          className="w-20 h-7 rounded border border-gray-300 px-1.5 text-[12px] font-mono tabular-nums text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </span>
      <button
        type="submit"
        disabled={pending}
        className="text-[10px] font-semibold text-white bg-gray-900 hover:bg-gray-800 px-2 py-1 rounded disabled:opacity-60 transition-colors"
      >
        {pending ? t('Saving…', 'Guardando…') : t('Save price', 'Guardar precio')}
      </button>
      <button
        type="button"
        onClick={() => {
          setEditing(false)
          setVal(item.currentPrice.toFixed(2))
        }}
        disabled={pending}
        className="text-[10px] font-medium text-gray-600 hover:text-gray-800 px-1.5 py-1 rounded hover:bg-gray-100 disabled:opacity-60 transition-colors"
      >
        {t('Cancel', 'Cancelar')}
      </button>
      {state?.error && (
        <span className="basis-full text-[10px] text-red-600 mt-0.5">{state.error}</span>
      )}
    </form>
  )
}

// ================================================================
// RecipeRow — editable row for a single recipe component.
//
// Layout:
//   Tortilla Chips
//   [3]  units used per sale  [Save]                       Remove
//
// The Save button only appears when the typed quantity differs
// from the saved one — keeps the row calm in the steady state and
// makes the "dirty / can save" affordance unmistakable when the
// manager has actually changed something.
//
// Both update and remove use useTransition so the page revalidates
// in place; no useActionState forms here because we want the
// pending state to apply to whichever button was clicked.
// ================================================================
function RecipeRow({ rc, menuItemId, t }: { rc: RecipeEntry; menuItemId: string; t: T }) {
  const [pending, startTransition] = useTransition()
  const [qty, setQty] = useState(String(rc.quantityRequired))
  // The row's own recipe unit. Null in the DB → we display the
  // inventory item's unit and, on save, send an empty string so
  // the action persists NULL again (identity-with-inventory).
  const invCanonical = normalizeUnit(rc.unitOfMeasure)
  const initialUnit: string = (() => {
    if (rc.unit) {
      const c = normalizeUnit(rc.unit)
      if (c) return c
    }
    if (invCanonical) return invCanonical
    return rc.unitOfMeasure
  })()
  const [unit, setUnit] = useState(initialUnit)
  const [err, setErr] = useState<string | null>(null)

  // Unit options — same rule as QtyWithUnitPicker: full family when
  // the inventory unit is a known canonical, otherwise just the
  // literal opaque unit.
  const options: { code: string; label: string }[] = (() => {
    if (!invCanonical) return [{ code: rc.unitOfMeasure, label: rc.unitOfMeasure || 'unit' }]
    const opts: { code: string; label: string }[] = []
    for (const grp of UNIT_GROUPS) {
      if (grp.units.some((u) => u === invCanonical)) {
        for (const u of grp.units) opts.push({ code: u, label: labelFor(u) })
      }
    }
    return opts
  })()

  // Dirty check spans BOTH channels so a unit-only change is
  // savable too.
  const parsed = parseFloat(qty)
  const qtyChanged =
    qty.trim().length > 0 &&
    Number.isFinite(parsed) &&
    parsed !== rc.quantityRequired
  const unitChanged = unit !== initialUnit
  const dirty = qtyChanged || unitChanged

  // Live preview of what will actually deplete inventory, computed
  // in the picked unit → inventory unit. Same rules as the picker.
  const preview = (() => {
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    if (!invCanonical) return null
    const canonPick = normalizeUnit(unit)
    if (!canonPick || canonPick === invCanonical) return null
    const converted = convertQty(parsed, canonPick, invCanonical)
    if (converted === null) return null
    const rounded = converted < 0.01 ? converted.toPrecision(2) : converted.toFixed(2).replace(/\.?0+$/, '')
    return `≈ ${rounded} ${labelFor(invCanonical)}`
  })()

  function save() {
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setErr(t('Quantity must be greater than 0.', 'La cantidad debe ser mayor que 0.'))
      return
    }
    setErr(null)
    const fd = new FormData()
    fd.append('component_id', rc.id)
    fd.append('menu_item_id', menuItemId)
    fd.append('quantity_required', qty)
    // Only send `unit` when the manager picked something meaningful.
    // Same-as-inventory selections persist as NULL (identity).
    fd.append('unit', unit === invCanonical ? '' : unit)
    startTransition(async () => {
      const res = await updateRecipeComponentQuantity(null, fd)
      if (res?.error) setErr(res.error)
    })
  }

  function remove() {
    setErr(null)
    const fd = new FormData()
    fd.append('component_id', rc.id)
    fd.append('menu_item_id', menuItemId)
    startTransition(async () => {
      await removeRecipeComponent(fd)
    })
  }

  return (
    <li className="px-3.5 py-2.5 transition-colors hover:bg-gray-50/60">
      <p className="text-xs font-medium text-gray-900 truncate">{rc.inventoryItemName}</p>
      <div className="mt-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          <input
            type="number"
            min="0.0001"
            step="0.0001"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            disabled={pending}
            aria-label={t(`Quantity per sale for ${rc.inventoryItemName}`, `Cantidad por venta para ${rc.inventoryItemName}`)}
            className="w-16 h-7 rounded border border-gray-200 bg-white px-1.5 text-[11px] font-mono tabular-nums text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-60"
          />
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            disabled={pending || options.length === 1}
            aria-label={t('Recipe unit', 'Unidad de receta')}
            className="h-7 rounded border border-gray-200 bg-white px-1.5 text-[11px] text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-60"
          >
            {options.map((o) => (
              <option key={o.code} value={o.code}>{o.label}</option>
            ))}
          </select>
          <span className="text-[11px] text-gray-500 whitespace-nowrap">
            {t('per sale', 'por venta')}
          </span>
          {dirty && (
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="text-[10px] font-semibold text-blue-700 hover:text-blue-900 px-1.5 py-0.5 rounded hover:bg-blue-50 disabled:opacity-60 transition-colors whitespace-nowrap"
            >
              {pending ? t('Saving…', 'Guardando…') : t('Save', 'Guardar')}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={remove}
          disabled={pending}
          aria-label={t(`Remove ${rc.inventoryItemName} from recipe`, `Eliminar ${rc.inventoryItemName} de la receta`)}
          className="text-[10px] font-medium text-gray-500 hover:text-red-600 px-1.5 py-0.5 rounded hover:bg-red-50 disabled:opacity-60 transition-colors whitespace-nowrap flex-shrink-0"
        >
          {t('Remove', 'Eliminar')}
        </button>
      </div>
      {preview && (
        <p className="mt-1 text-[10px] text-gray-500 font-mono tabular-nums">{preview}</p>
      )}
      {err && <p className="mt-1 text-[10px] text-red-600">{err}</p>}
    </li>
  )
}

// ================================================================
// Bands (tablet md+) pieces — only rendered by the isBands branch.
// ================================================================

function BandsTrail({
  value, label, tone, size = 14,
}: { value: string; label: string; tone?: string; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span aria-hidden style={{ width: 3, height: 3, borderRadius: '50%', background: '#D6D5D1', alignSelf: 'center', marginRight: 5 }} />
      <span style={{ fontFamily: B_MONO, fontSize: size, fontWeight: 600, color: tone ?? B_INK }}>{value}</span>
      <span style={{ fontSize: 12, color: tone ?? B_MUTED }}>{label}</span>
    </span>
  )
}

function BandsTreeRow({
  name, on, depth, hasKids, expanded, needsReview, onClick, orphan = false,
}: {
  name: string
  on: boolean
  depth: number
  hasKids: boolean
  expanded: boolean
  needsReview: boolean
  onClick: () => void
  orphan?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
        padding: `8px 10px 8px ${10 + depth * 16}px`,
        borderRadius: 9,
        ...(orphan
          ? { marginTop: 8, border: `1px dashed ${on ? B_FAINT : B_LINE}`, background: on ? B_FILL : 'transparent', color: on ? B_INK : B_MUTED }
          : { border: 0, background: on ? B_FILL : 'transparent', color: on ? B_INK : '#3F3F46' }),
      }}
    >
      <span aria-hidden style={{ width: 10, flex: '0 0 10px', fontSize: 9, color: B_FAINT }}>
        {hasKids ? (expanded ? '▾' : '▸') : ''}
      </span>
      <span style={{
        flexGrow: 1, flexShrink: 1, flexBasis: '0%', minWidth: 0, fontSize: 13,
        // Top-level rows always bold so the hierarchy reads at a
        // glance; sub-rows step down to 500 until selected.
        fontWeight: depth === 0 ? 700 : (on ? 600 : 500),
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {name}
      </span>
      <span
        aria-hidden
        style={{
          width: 6, height: 6, flex: '0 0 auto',
          ...(needsReview ? { borderRadius: '50%', background: '#D97706' } : {}),
        }}
      />
    </button>
  )
}

function BandsItemCard({
  item, onOpen, selected, t,
}: { item: MenuItem; onOpen: () => void; selected: boolean; t: T }) {
  const priced = item.currentPrice > 0
  const linked = hasRecipe(item)
  return (
    <button
      type="button"
      id={`menu-item-${item.id}`}
      onClick={onOpen}
      style={{
        border: `1px solid ${selected ? B_INK : B_LINE}`,
        borderRadius: 10, padding: '11px 12px', background: '#fff', cursor: 'pointer',
        textAlign: 'left', fontFamily: 'inherit', color: B_INK,
        boxShadow: selected ? '0 0 0 3px rgba(24,24,27,0.06)' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ minWidth: 0, fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.35 }}>
          {item.name}
        </span>
        <span style={{ fontFamily: B_MONO, fontSize: 13, fontWeight: 600, flex: '0 0 auto', color: priced ? B_INK : B_GHOST }}>
          {fmtMoney(item.currentPrice)}
        </span>
      </div>
      <div style={{ marginTop: 9 }}>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', borderRadius: 999,
            padding: '2px 9px', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
            ...(linked
              ? { background: '#ECFDF5', color: '#047857' }
              : { background: B_AMBER_BG, color: B_AMBER }),
          }}
        >
          {linked ? t('Recipe linked', 'Receta vinculada') : t('Needs review', 'Requiere revisión')}
        </span>
      </div>
    </button>
  )
}

/** Inline "New category" / "New sub-section" form. Uses the same
 *  createCategory server action as the phone layout's AddSectionForm
 *  — pass parentId to nest under a top-level category. Closes on
 *  a clean submit (revalidation propagates the new row through the
 *  categories prop). */
function BandsAddCategoryForm({
  parentId,
  parentName,
  onClose,
  t,
}: {
  parentId?: string
  parentName?: string
  onClose: () => void
  t: T
}) {
  const [state, action, pending] = useActionState(createCategory, null)
  const wasPending = useRef(false)
  useEffect(() => {
    if (wasPending.current && !pending && !state?.error) onClose()
    wasPending.current = pending
  }, [pending, state, onClose])
  const isSub = !!parentId
  return (
    <form action={action} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: B_INK }}>
        {isSub
          ? t(`New sub-section under ${parentName}`, `Nueva sub-sección bajo ${parentName}`)
          : t('New category', 'Nueva categoría')}
      </div>
      {parentId && <input type="hidden" name="parent_id" value={parentId} />}
      <input
        name="name"
        type="text"
        required
        autoFocus
        placeholder={isSub ? t('Sub-section name', 'Nombre de la sub-sección') : t('Category name', 'Nombre de la categoría')}
        style={{
          width: '100%', borderRadius: 8, border: `1px solid ${B_LINE}`, background: '#fff',
          padding: '7px 10px', fontFamily: 'inherit', fontSize: 13, color: B_INK, outline: 'none',
        }}
      />
      {state?.error && (
        <div style={{ fontSize: 11, color: '#B91C1C' }}>{state.error}</div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="submit"
          disabled={pending}
          style={{
            flex: 1, border: 0, background: B_INK, color: B_PAPER, borderRadius: 8,
            padding: '7px 10px', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
            cursor: pending ? 'default' : 'pointer', opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? t('Adding…', 'Agregando…') : isSub ? t('Add sub-section', 'Agregar sub-sección') : t('Add category', 'Agregar categoría')}
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{
            border: `1px solid ${B_LINE}`, background: '#fff', color: B_MUTED, borderRadius: 8,
            padding: '7px 10px', fontFamily: 'inherit', fontSize: 12, fontWeight: 500, cursor: 'pointer',
          }}
        >
          {t('Cancel', 'Cancelar')}
        </button>
      </div>
    </form>
  )
}

/** Inline "New item" form scoped to a specific category. Same
 *  server action as the phone layout (createMenuItemInSection),
 *  same fields (name + price). Recipe mapping happens later, once
 *  the drawer is open. Closes on a clean submit. */
function BandsAddItemForm({
  categoryId,
  categoryName,
  onClose,
  t,
}: {
  categoryId: string
  categoryName: string
  onClose: () => void
  t: T
}) {
  const [state, action, pending] = useActionState(createMenuItemInSection, null)
  const wasPending = useRef(false)
  useEffect(() => {
    if (wasPending.current && !pending && !state?.error) onClose()
    wasPending.current = pending
  }, [pending, state, onClose])
  return (
    <form action={action} style={{ display: 'flex', flexDirection: 'column', gap: 8, background: '#fff', border: `1px solid ${B_LINE}`, borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: B_INK }}>
        {t(`New item in ${categoryName}`, `Nuevo artículo en ${categoryName}`)}
      </div>
      <input type="hidden" name="category_id" value={categoryId} />
      <input
        name="name"
        type="text"
        required
        autoFocus
        placeholder={t('Item name', 'Nombre del artículo')}
        style={{
          width: '100%', borderRadius: 8, border: `1px solid ${B_LINE}`, background: '#fff',
          padding: '7px 10px', fontFamily: 'inherit', fontSize: 13, color: B_INK, outline: 'none',
        }}
      />
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: B_FAINT }}>$</span>
        <input
          name="price"
          type="number"
          required
          min="0"
          step="0.01"
          placeholder="0.00"
          style={{
            width: '100%', borderRadius: 8, border: `1px solid ${B_LINE}`, background: '#fff',
            padding: '7px 10px 7px 22px', fontFamily: 'inherit', fontSize: 13, color: B_INK, outline: 'none',
          }}
        />
      </div>
      {state?.error && (
        <div style={{ fontSize: 11, color: '#B91C1C' }}>{state.error}</div>
      )}
      <div style={{ fontSize: 10, color: B_FAINT, lineHeight: 1.4 }}>
        {t('Map ingredients to inventory once the item is open in the drawer.', 'Vincula los ingredientes al inventario una vez que el artículo esté abierto en el panel.')}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="submit"
          disabled={pending}
          style={{
            flex: 1, border: 0, background: B_INK, color: B_PAPER, borderRadius: 8,
            padding: '7px 10px', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
            cursor: pending ? 'default' : 'pointer', opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? t('Adding…', 'Agregando…') : t('Add item', 'Agregar artículo')}
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{
            border: `1px solid ${B_LINE}`, background: '#fff', color: B_MUTED, borderRadius: 8,
            padding: '7px 10px', fontFamily: 'inherit', fontSize: 12, fontWeight: 500, cursor: 'pointer',
          }}
        >
          {t('Cancel', 'Cancelar')}
        </button>
      </div>
    </form>
  )
}

function BandsSearchPill({
  total, value, onChange, placeholder,
}: { total: number; value: string; onChange: (v: string) => void; placeholder: string }) {
  const [focused, setFocused] = useState(false)
  return (
    <span
      style={{
        display: 'flex', alignItems: 'center', gap: 8, borderRadius: 999,
        padding: '0 6px 0 12px', height: 34,
        transition: 'background 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
        background: focused ? '#fff' : '#F4F4F2',
        border: `1px solid ${focused ? B_INK : 'transparent'}`,
        boxShadow: focused ? '0 0 0 3px rgba(24,24,27,0.06)' : 'none',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" style={{ flex: '0 0 auto', color: focused ? '#52525B' : B_FAINT }}>
        <circle cx="8.8" cy="8.8" r="5.6" strokeWidth="1.7" />
        <path d="M13 13l4 4" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={`${placeholder} ${total}`}
        style={{ border: 0, background: 'transparent', fontFamily: 'inherit', fontSize: 13, color: B_INK, width: 150, padding: 0, flex: 1, outline: 'none' }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, border: 0, borderRadius: '50%', background: B_LINE, fontFamily: 'inherit', fontSize: 13, lineHeight: 1, color: '#52525B', cursor: 'pointer', flex: '0 0 auto' }}
        >
          ×
        </button>
      )}
    </span>
  )
}
