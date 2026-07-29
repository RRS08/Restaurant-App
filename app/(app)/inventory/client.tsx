'use client'

// ----------------------------------------------------------------
// Inventory Client
//
// Operational workspace:
//   header → modern toolbar → paginated stock table → activity feed
// Clicking a row opens an item detail slide-over with threshold +
// count actions.
// ----------------------------------------------------------------

import { useState, useRef, useEffect, useMemo, useActionState, useTransition } from 'react'
import Link from 'next/link'
import {
  updateThreshold,
  archiveInventoryItem,
  deleteInventoryItem,
  updateInventoryItem,
  createInventoryCount,
  createInventoryItem,
  quickAddToOrder,
  markRestockReceived,
  cancelRestockOrder,
  closeRestockBatch,
  updateRestockQuantity,
  placeRestockTicket,
} from '@/app/actions/inventory'
import { cleanupDuplicateInventoryItems, mergeInventoryItems, runInventoryIntegrityChecks } from '@/app/actions/inventory-cleanup'
import { makeT, type Lang } from '@/lib/i18n'

// Translator function shape — threaded as a prop to every child
// component that renders user-visible English copy. Centralizes the
// signature so each subcomponent's props can spell it as `t: T`.
type T = (en: string, es?: string) => string

interface MenuItemDep {
  menuItemId: string
  menuItemName: string
  /** Recipe-required amount per menu-item sale, in this inventory
   *  item's unit. Comes from recipe_components.quantity_required. */
  quantityRequired: number
}

interface Item {
  id: string; name: string; unitOfMeasure: string; threshold: number
  estimated: number | null; lastCount: number | null; status: 'no_count' | 'out' | 'low' | 'ok'
  recipeLinks: number; hasDependencies: boolean
  /** Active menu items whose recipes consume this inventory item.
   *  Sorted alphabetically by menu item name. Drives the "Used in
   *  menu items" card inside the item drawer. */
  menuItems: MenuItemDep[]
}

interface Transaction {
  id: string
  inventoryItemId: string
  itemName: string
  type: string
  qty: number
  note: string | null
  date: string
}

// Unified restock-order row. Status is the full 4-state lifecycle so
// the same shape can carry both active workspace lines (draft/
// ordered) and recently closed lines (received/canceled) into the
// Restock Orders drawer.
//
// `quantity` is the ORDERED amount — never overwritten. It's the
// "intent" truth: what the manager committed to the vendor.
// `receivedQuantity` is the actual received amount, read off the
// linked inventory_transaction at fetch time. Together they preserve
// "ordered 10 · received 7" without mutating the original row.
//
// receivedAt / canceledAt distinguish the two closed sub-states:
//   received  → goods arrived, stock moved
//   canceled  → didn't come; closed short (multi-line batch) or
//               canceled from draft (cart-side).
interface RestockOrder {
  id: string
  inventoryItemId: string
  quantity: number
  vendor: string | null
  expectedCost: number | null
  /** Optional expected delivery date (yyyy-mm-dd). Annotation only —
   *  never gates the receipt; stock still moves only when the
   *  manager explicitly confirms received quantities. */
  expectedDate: string | null
  notes: string | null
  status: 'draft' | 'ordered' | 'received' | 'canceled'
  orderedAt: string | null
  receivedAt: string | null
  canceledAt: string | null
  /** Actual received quantity (read from the linked inventory
   *  transaction). null for non-received lines. Distinct from
   *  `quantity`, which is the ordered intent. */
  receivedQuantity: number | null
  createdAt: string
}

const STATUS = {
  no_count: { label: 'No count', color: 'bg-gray-100 text-gray-600', dot: 'bg-gray-400' },
  out:      { label: 'Out',      color: 'bg-red-50 text-red-700',    dot: 'bg-red-500' },
  low:      { label: 'Low',      color: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  ok:       { label: 'OK',       color: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
} as const

// Translate the STATUS label to the active language. Centralizes the
// English → Spanish mapping for the four buckets so callers don't
// repeat the t() literals at every consumption site.
function translateStatusLabel(status: Item['status'], t: T): string {
  switch (status) {
    case 'no_count': return t('No count', 'Sin conteo')
    case 'out':      return t('Out', 'Agotado')
    case 'low':      return t('Low', 'Bajo')
    case 'ok':       return t('OK', 'OK')
  }
}

const STATUS_ORDER: Record<Item['status'], number> = { out: 0, low: 1, no_count: 2, ok: 3 }
type Filter = 'all' | 'out' | 'low' | 'no_count' | 'ok'

const PAGE_SIZE = 12
const ACTIVITY_LIMIT = 8

// Drawer state — exactly one drawer open at a time. Discriminated
// union so adding a new drawer is a single new branch in the
// render block at the bottom of InventoryClient.
type DrawerState =
  | { mode: 'item'; itemId: string }
  | { mode: 'create-item' }
  | { mode: 'cart' }
  | { mode: 'orders' }
  | { mode: 'merge-items' }
  | null

// ----------------------------------------------------------------
// Design tokens (2026-07 Claude Design pass).
//
// Palette + type ramp shared with the sales and staffing pillars so
// the three feel like one system. Inline styles win over Tailwind
// for the stateful widgets (search focus, filter chip on/off) —
// keeps behavior colocated with the element instead of ping-ponging
// between className and a :focus-within rule that Tailwind's
// utilities can't observe.
// ----------------------------------------------------------------
const INK = '#18181B'
const PAPER = '#FAF9F6'
const LINE = '#E7E6E2'
const SURFACE = '#FAFAF9'
const FILL = '#F4F4F2'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const GHOST = '#D6D5D1'
const MONO = "'Geist Mono', ui-monospace, monospace"

// One tone per status — tile background / stroke+text / dot.
const STATUS_TONE: Record<Item['status'], { bg: string; ink: string; dot: string }> = {
  out:      { bg: '#FEF2F2', ink: '#B91C1C', dot: '#DC2626' },
  low:      { bg: '#FFFBEB', ink: '#B45309', dot: '#D97706' },
  ok:       { bg: '#ECFDF5', ink: '#047857', dot: '#10B981' },
  no_count: { bg: '#F5F5F4', ink: '#78716C', dot: '#A8A29E' },
}

// ---------------- Icon set (inline SVG so it inherits currentColor
// and avoids an icon-library dependency for four glyphs). ----------
function SearchIcon({ color = '#A1A1A6' }: { color?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  )
}
function CartIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="20" r="1.6" />
      <circle cx="18" cy="20" r="1.6" />
      <path d="M3 4h2l2 12h12l2-8H6" />
    </svg>
  )
}
function OrdersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </svg>
  )
}
function CountIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <circle cx="4" cy="6" r="1" fill="currentColor" />
      <circle cx="4" cy="12" r="1" fill="currentColor" />
      <circle cx="4" cy="18" r="1" fill="currentColor" />
    </svg>
  )
}

// One glyph per status. Each one is deliberately distinct at 20px
// so the icon alone communicates state — no need to read the chip.
function StatusGlyph({ status }: { status: Item['status'] }) {
  const ink = STATUS_TONE[status].ink
  switch (status) {
    case 'out':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
          <path d="M10 3 L18 17 L2 17 Z" fill="none" stroke={ink} strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M10 8 L10 12" stroke={ink} strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="10" cy="14.5" r="0.9" fill={ink} />
        </svg>
      )
    case 'low':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
          <circle cx="10" cy="10" r="7" fill={ink} opacity="0.15" />
          <path d="M10 6 L10 11" stroke={ink} strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="10" cy="13.5" r="0.9" fill={ink} />
        </svg>
      )
    case 'ok':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
          <circle cx="10" cy="10" r="7" fill={ink} opacity="0.15" />
          <path d="M6.5 10 L9 12.5 L13.5 8" fill="none" stroke={ink} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'no_count':
      return (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
          <circle cx="10" cy="10" r="7" fill="none" stroke={ink} strokeWidth="1.4" strokeDasharray="2 2" />
          <text x="10" y="14" textAnchor="middle" fontFamily="'Geist Mono', ui-monospace, monospace" fontSize="10" fontWeight="600" fill={ink}>?</text>
        </svg>
      )
  }
}

export default function InventoryClient({ items, transactions, restockOrders, closedRestockOrders = [], duplicateGroups = [], mergeableItems = [], archivedInRecipes = [], lang }: {
  items: Item[]
  transactions: Transaction[]
  restockOrders: RestockOrder[]
  /** Closed restock orders (received + canceled with ordered_at).
   *  Powers the Closed Orders section of the Restock Orders drawer
   *  and partial-receipt detection for Pending Orders. */
  closedRestockOrders?: RestockOrder[]
  /** Active inventory items grouped by normalized name where >1 row
   *  exists. When non-empty, render an in-page banner with a one-
   *  click merge — the most common cause of "depletion writes exist
   *  but stock movement isn't visible" is duplicate items, and the
   *  user can resolve it without leaving the page. */
  duplicateGroups?: { displayName: string; count: number }[]
  /** Active + archived inventory items, used by the manual-merge
   *  drawer's pickers. Always available, even when the auto-banner
   *  doesn't fire (e.g., one duplicate was already archived). */
  mergeableItems?: { id: string; name: string; active: boolean }[]
  /** Names of archived inventory items still referenced by active
   *  recipe_components. Depletion writes to these archived ids land
   *  on rows the page filters out of the table; one-click banner
   *  triggers `runInventoryIntegrityChecks` which reactivates them. */
  archivedInRecipes?: string[]
  /** Language passed down from the server-component page. Used to
   *  build the `t` translator that's threaded to every child. */
  lang: Lang
}) {
  const t = makeT(lang)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<DrawerState>(null)
  const selectedId = drawer?.mode === 'item' ? drawer.itemId : null

  // Auto-close the create-item drawer once revalidation delivers
  // the new row.
  const itemCountRef = useRef(items.length)
  useEffect(() => {
    if (drawer?.mode === 'create-item' && items.length > itemCountRef.current) {
      setDrawer(null)
    }
    itemCountRef.current = items.length
  }, [items.length, drawer])

  const counts = useMemo(() => ({
    out: items.filter((i) => i.status === 'out').length,
    low: items.filter((i) => i.status === 'low').length,
    no_count: items.filter((i) => i.status === 'no_count').length,
    ok: items.filter((i) => i.status === 'ok').length,
    total: items.length,
  }), [items])

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items
      .filter((i) => {
        if (q && !i.name.toLowerCase().includes(q)) return false
        if (filter === 'all') return true
        return i.status === filter
      })
      .sort((a, b) => {
        const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
        return d !== 0 ? d : a.name.localeCompare(b.name)
      })
  }, [items, query, filter])

  // Reset to page 1 whenever the filter/search changes the dataset
  useEffect(() => { setPage(1) }, [query, filter])

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * PAGE_SIZE
  const pageItems = filteredItems.slice(pageStart, pageStart + PAGE_SIZE)

  const selectedItem = selectedId ? items.find((i) => i.id === selectedId) ?? null : null

  // If the selected item disappears (archived/deleted), close the drawer.
  useEffect(() => {
    if (selectedId && !items.find((i) => i.id === selectedId)) setDrawer(null)
  }, [items, selectedId])

  // ---- Restock-order indexing ----
  // The order-builder rail and the per-row "Add" affordance both
  // need fast lookups. Build them once per render so neither path
  // does linear filtering inside the hot list.
  const itemsById = useMemo(() => {
    const m = new Map<string, Item>()
    for (const it of items) m.set(it.id, it)
    return m
  }, [items])

  const ordersByItem = useMemo(() => {
    const m = new Map<string, RestockOrder[]>()
    for (const o of restockOrders) {
      const list = m.get(o.inventoryItemId) ?? []
      list.push(o)
      m.set(o.inventoryItemId, list)
    }
    return m
  }, [restockOrders])

  const draftOrders = useMemo(
    () => restockOrders.filter((o) => o.status === 'draft'),
    [restockOrders]
  )
  const orderedOrders = useMemo(
    () => restockOrders.filter((o) => o.status === 'ordered'),
    [restockOrders]
  )

  // Search focus is inline-driven so the pill ring + border animate
  // in one place — Tailwind's focus/focus-within can't reach the
  // wrapper the way this design wants (whole pill lights up, not
  // just the input).
  const [searchFocused, setSearchFocused] = useState(false)

  // Small helper for the header stat row ("12 items · 3 need
  // restocking"). Fabricated inline to keep call sites terse.
  const stat = (v: string, label: string, color: string = INK) => (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, letterSpacing: '-0.02em', color }}>{v}</span>
      <span style={{ fontSize: 12, color: MUTED }}>{label}</span>
    </span>
  )
  const dot = <span style={{ width: 3, height: 3, borderRadius: '50%', background: GHOST, alignSelf: 'center' }} />

  const ghostBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    border: `1px solid ${LINE}`, background: '#fff', borderRadius: 10,
    height: 34, padding: '0 13px', font: 'inherit', fontSize: 13,
    fontWeight: 500, color: '#3F3F46', cursor: 'pointer',
  }
  const inkBtn: React.CSSProperties = {
    border: 0, background: INK, color: PAPER, borderRadius: 10,
    height: 34, padding: '0 16px', font: 'inherit', fontSize: 13,
    fontWeight: 600, cursor: 'pointer',
  }

  const filterMeta: Array<{ key: Filter; label: string; count: number; tone: { bg: string; ink: string; dot: string } | null }> = [
    { key: 'all',      label: t('All', 'Todos'),                count: counts.total,    tone: null              },
    { key: 'out',      label: t('Out', 'Agotado'),              count: counts.out,      tone: STATUS_TONE.out   },
    { key: 'low',      label: t('Low', 'Bajo'),                 count: counts.low,      tone: STATUS_TONE.low   },
    { key: 'ok',       label: t('Healthy', 'Saludable'),        count: counts.ok,       tone: STATUS_TONE.ok    },
    { key: 'no_count', label: t('Never counted', 'Sin conteo'), count: counts.no_count, tone: STATUS_TONE.no_count },
  ]

  return (
    <div style={{ maxWidth: 1400, fontFamily: "'Geist', system-ui, sans-serif", color: INK }}>

      {/* Duplicate-name banner.
          Renders when any item-name group has multiple rows and at
          least one is active. Catches both 2+ active and the
          1 active + archived-with-deps case (where depletion writes
          land on one row while the count lives on another). Offers
          two paths: one-click bulk merge, or pick canonical manually
          via the merge drawer. */}
      {duplicateGroups.length > 0 && (
        <DuplicateMergeBanner
          groups={duplicateGroups}
          onPickManually={() => setDrawer({ mode: 'merge-items' })}
          t={t}
        />
      )}

      {/* Archived-in-recipes banner.
          Surfaces inventory_items that were archived while still
          referenced by active recipe_components. POS depletion still
          writes to the archived id; the page render filters those
          rows out of the table; movement disappears. One click runs
          `runInventoryIntegrityChecks`, which now auto-reactivates
          these items so depletion lands on a visible row again. */}
      {archivedInRecipes.length > 0 && (
        <ArchivedInRecipesBanner names={archivedInRecipes} t={t} />
      )}

      {items.length === 0 ? (
        <div style={{
          border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff',
          padding: 48, textAlign: 'center',
        }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#3F3F46' }}>
            {t('No inventory items yet', 'Sin artículos de inventario aún')}
          </p>
          <p style={{ margin: '6px auto 0', maxWidth: 380, fontSize: 12, color: FAINT, lineHeight: 1.5 }}>
            {t('Add ingredients and products to start tracking stock health and movements.', 'Agrega ingredientes y productos para comenzar a rastrear la salud del stock y los movimientos.')}
          </p>
          <button
            type="button"
            onClick={() => setDrawer({ mode: 'create-item' })}
            style={{ ...inkBtn, marginTop: 20 }}
          >
            {t('+ Track new item', '+ Rastrear nuevo artículo')}
          </button>
        </div>
      ) : (
        <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff' }}>

          {/* ---- HEADER BAND ----
              Title + inline stats on the left; four actions on the
              right (Merge / Orders / Cart / Add item). Stats read
              as headline facts, not badges — a mono count paired
              with a muted noun keeps the eye moving fast. */}
          <div style={{
            padding: '16px 16px 14px', display: 'flex',
            alignItems: 'center', justifyContent: 'space-between',
            gap: 24, flexWrap: 'wrap',
          }}>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: '-0.035em' }}>
                {t('Inventory', 'Inventario')}
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 7, flexWrap: 'wrap' }}>
                {stat(String(counts.total), counts.total === 1 ? t('item', 'artículo') : t('items', 'artículos'))}
                {(counts.out + counts.low) > 0 && (<>{dot}{stat(String(counts.out + counts.low), t('need restocking', 'requieren reabastecimiento'), STATUS_TONE.low.ink)}</>)}
                {counts.no_count > 0 && (<>{dot}{stat(String(counts.no_count), t('uncounted', 'sin conteo'), STATUS_TONE.no_count.ink)}</>)}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setDrawer({ mode: 'merge-items' })}
                style={ghostBtn}
                title={t('Merge duplicate items', 'Combinar artículos duplicados')}
              >
                {t('Merge', 'Combinar')}
              </button>
              <button
                type="button"
                onClick={() => setDrawer({ mode: 'orders' })}
                style={ghostBtn}
                title={t('Restock orders awaiting receipt', 'Órdenes de reabastecimiento esperando recepción')}
              >
                <OrdersIcon />
                {t('Orders', 'Órdenes')}
                {orderedOrders.length > 0 && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: 18, height: 18, borderRadius: 999,
                    background: STATUS_TONE.low.bg, color: STATUS_TONE.low.ink,
                    fontFamily: MONO, fontSize: 10, fontWeight: 600, padding: '0 4px',
                  }}>
                    {orderedOrders.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setDrawer({ mode: 'cart' })}
                style={ghostBtn}
                title={t('Items staged for your next restock order', 'Artículos preparados para tu próxima orden de reabastecimiento')}
              >
                <CartIcon />
                {t('Cart', 'Carrito')}
                {draftOrders.length > 0 && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: 18, height: 18, borderRadius: 999,
                    background: INK, color: PAPER,
                    fontFamily: MONO, fontSize: 10, fontWeight: 600, padding: '0 4px',
                  }}>
                    {draftOrders.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setDrawer({ mode: 'create-item' })}
                style={inkBtn}
              >
                {t('Add item', 'Añadir artículo')}
              </button>
            </div>
          </div>

          {/* ---- FILTER BAR + SEARCH PILL ----
              Five pills for the four health buckets + All, with a
              live count on each. Search pill sits on the right and
              lights up on focus (bg + border + soft ring). */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px',
            borderTop: `1px solid ${LINE}`, borderBottom: `1px solid ${LINE}`,
            background: SURFACE, flexWrap: 'wrap',
          }}>
            {filterMeta.map((f) => {
              const on = filter === f.key
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 7,
                    borderRadius: 999, padding: '5px 12px',
                    font: 'inherit', fontSize: 12, cursor: 'pointer',
                    border: `1px solid ${on ? INK : LINE}`,
                    background: on ? INK : '#fff',
                    color: on ? PAPER : '#3F3F46',
                    fontWeight: on ? 600 : 500,
                  }}
                >
                  {f.tone && <span style={{ width: 6, height: 6, borderRadius: '50%', background: f.tone.dot }} />}
                  {f.label}
                  <span style={{ fontFamily: MONO, fontSize: 10, color: on ? 'rgba(250,249,246,0.65)' : FAINT }}>
                    {f.count}
                  </span>
                </button>
              )
            })}

            <span style={{
              marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8,
              borderRadius: 999, padding: '0 6px 0 12px', height: 34,
              transition: 'background 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
              background: searchFocused ? '#fff' : FILL,
              border: `1px solid ${searchFocused ? INK : 'transparent'}`,
              boxShadow: searchFocused ? '0 0 0 3px rgba(24,24,27,0.06)' : 'none',
            }}>
              <SearchIcon color={searchFocused ? '#52525B' : FAINT} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder={`${t('Search', 'Buscar')} ${counts.total} ${counts.total === 1 ? t('item', 'artículo') : t('items', 'artículos')}`}
                style={{
                  border: 0, background: 'transparent', fontFamily: 'inherit',
                  fontSize: 13, color: INK, width: 180, padding: 0, outline: 'none',
                }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  title={t('Clear search', 'Borrar búsqueda')}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 22, height: 22, border: 0, borderRadius: '50%',
                    background: LINE, font: 'inherit', fontSize: 13, lineHeight: 1,
                    color: '#52525B', cursor: 'pointer', flex: '0 0 auto',
                  }}
                >
                  ×
                </button>
              )}
            </span>
          </div>

          {/* ---- ROWS ----
              Soft rows inside the board card. Each row: status
              glyph tile · name + status chip (+ recipe count if
              linked) · qty column with reorder line · action
              button · chevron. Row click opens the item drawer;
              the action button is the visible affordance for the
              same destination — count for uncounted, cart for
              everything else. */}
          <div style={{ padding: 8 }}>
            {pageItems.length === 0 ? (
              <div style={{ padding: '48px 16px', textAlign: 'center', color: FAINT, fontSize: 12 }}>
                {t('No items match this filter.', 'Ningún artículo coincide con este filtro.')}
                {(filter !== 'all' || query.length > 0) && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => { setFilter('all'); setQuery('') }}
                      style={{
                        border: 0, background: 'transparent', padding: 0,
                        font: 'inherit', fontSize: 12, fontWeight: 500,
                        color: '#2563EB', cursor: 'pointer',
                      }}
                    >
                      {t('Clear filters', 'Limpiar filtros')}
                    </button>
                  </>
                )}
              </div>
            ) : pageItems.map((item) => {
              const tone = STATUS_TONE[item.status]
              const uncounted = item.status === 'no_count'
              // Depletion can drag `estimated` below zero (write-ahead
              // consumption with no follow-up count). Clamp for
              // display so the qty reads as an actionable target.
              const displayQty = item.estimated === null
                ? null
                : Math.max(0, item.estimated)
              const qtyColor =
                uncounted ? GHOST
                  : item.status === 'ok' ? INK
                    : tone.ink
              const selected = item.id === selectedId
              return (
                <div
                  key={item.id}
                  onClick={() => setDrawer({ mode: 'item', itemId: item.id })}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 13,
                    padding: '11px 12px', borderRadius: 10, cursor: 'pointer',
                    border: `1px solid ${selected ? LINE : 'transparent'}`,
                    background: selected ? SURFACE : 'transparent',
                    transition: 'background 120ms',
                  }}
                >
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 34, height: 34, borderRadius: 10, flex: '0 0 auto',
                    background: tone.bg,
                  }}>
                    <StatusGlyph status={item.status} />
                  </span>

                  <span style={{ minWidth: 0, flex: 1, paddingRight: 24 }}>
                    <span style={{
                      display: 'block', fontSize: 14, fontWeight: 600,
                      letterSpacing: '-0.015em',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {item.name}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3, flexWrap: 'wrap' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center',
                        borderRadius: 999, padding: '1px 8px',
                        fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                        background: tone.bg, color: tone.ink,
                      }}>
                        {translateStatusLabel(item.status, t)}
                      </span>
                      {item.recipeLinks > 0 && (
                        <span style={{ fontSize: 11, color: FAINT }}>
                          {t('used in', 'usado en')} {item.recipeLinks} {item.recipeLinks === 1 ? t('recipe', 'receta') : t('recipes', 'recetas')}
                        </span>
                      )}
                    </span>
                  </span>

                  <span style={{ width: 150, flex: '0 0 150px', textAlign: 'right' }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 5 }}>
                      <span style={{
                        fontFamily: MONO, fontSize: 16, fontWeight: 600,
                        letterSpacing: '-0.03em', color: qtyColor,
                      }}>
                        {displayQty === null ? '—' : displayQty.toFixed(2)}
                      </span>
                      <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>{item.unitOfMeasure}</span>
                    </span>
                    <span style={{
                      display: 'block', fontFamily: MONO, fontSize: 11, color: FAINT,
                      marginTop: 2, whiteSpace: 'nowrap',
                    }}>
                      {t('restock at', 'reabastecer a')} {item.threshold.toFixed(2)} {item.unitOfMeasure}
                    </span>
                  </span>

                  <span style={{ width: 48, flex: '0 0 48px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      title={uncounted
                        ? t('Count this item', 'Contar este artículo')
                        : t('Add to restock cart', 'Añadir al carrito de reabastecimiento')}
                      onClick={(e) => {
                        // Same destination as the row click for now
                        // (opens the item drawer). Kept as its own
                        // control so a future quick-add-to-cart flow
                        // can hang here without touching row markup.
                        e.stopPropagation()
                        setDrawer({ mode: 'item', itemId: item.id })
                      }}
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 34, height: 34, border: `1px solid ${LINE}`,
                        background: '#fff', borderRadius: 9, padding: 0,
                        font: 'inherit', color: '#52525B', cursor: 'pointer',
                      }}
                    >
                      {uncounted ? <CountIcon /> : <CartIcon />}
                    </button>
                  </span>

                  <span style={{ fontSize: 12, color: GHOST, marginLeft: -4 }}>›</span>
                </div>
              )
            })}

            {filteredItems.length > PAGE_SIZE && (
              <div style={{
                borderTop: `1px solid ${LINE}`, marginTop: 8,
                padding: '10px 8px 4px', display: 'flex',
                alignItems: 'center', justifyContent: 'space-between',
                flexWrap: 'wrap', gap: 8,
              }}>
                <span style={{ fontFamily: MONO, fontSize: 10, color: MUTED }}>
                  {t('Showing', 'Mostrando')} <span style={{ color: '#3F3F46', fontWeight: 600 }}>{pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredItems.length)}</span> {t('of', 'de')} <span style={{ color: '#3F3F46', fontWeight: 600 }}>{filteredItems.length}</span>
                </span>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage === 1}
                    aria-label={t('Previous items', 'Artículos anteriores')}
                    style={{
                      border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8,
                      padding: '2px 10px', font: 'inherit', fontSize: 12,
                      color: safePage === 1 ? GHOST : '#52525B',
                      cursor: safePage === 1 ? 'not-allowed' : 'pointer',
                      opacity: safePage === 1 ? 0.5 : 1,
                    }}
                  >
                    ←
                  </button>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: MUTED, padding: '0 4px' }}>
                    {safePage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}
                    aria-label={t('Next items', 'Artículos siguientes')}
                    style={{
                      border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8,
                      padding: '2px 10px', font: 'inherit', fontSize: 12,
                      color: safePage === totalPages ? GHOST : '#52525B',
                      cursor: safePage === totalPages ? 'not-allowed' : 'pointer',
                      opacity: safePage === totalPages ? 0.5 : 1,
                    }}
                  >
                    →
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- DRAWERS ----
          One drawer kind active at a time. Drawer state union at
          the top of the component keeps this list exhaustive. */}
      {drawer?.mode === 'item' && selectedItem && (
        <ItemWorkspaceDrawer
          item={selectedItem}
          transactions={transactions}
          restockOrders={ordersByItem.get(selectedItem.id) ?? []}
          onClose={() => setDrawer(null)}
          t={t}
        />
      )}
      {drawer?.mode === 'create-item' && (
        <QuickAddItemDrawer onClose={() => setDrawer(null)} t={t} />
      )}
      {drawer?.mode === 'cart' && (
        <CartDrawer
          drafts={draftOrders}
          itemsById={itemsById}
          onClose={() => setDrawer(null)}
          onInspectItem={(itemId) => setDrawer({ mode: 'item', itemId })}
          t={t}
        />
      )}
      {drawer?.mode === 'orders' && (
        <OrdersDrawer
          ordered={orderedOrders}
          closed={closedRestockOrders}
          itemsById={itemsById}
          onClose={() => setDrawer(null)}
          onInspectItem={(itemId) => setDrawer({ mode: 'item', itemId })}
          t={t}
        />
      )}
      {drawer?.mode === 'merge-items' && (
        <MergeItemsDrawer
          mergeableItems={mergeableItems}
          onClose={() => setDrawer(null)}
          t={t}
        />
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// StockStatusStrip — compact filter row above the Stock Health
// list. Five pills: All / Out / Low / No count / OK. Selected pill
// uses the dark active-filter style shared with the rest of the
// app (Sales source filter, etc.); unselected pills carry a small
// status dot so the four health buckets stay recognizable at a
// glance. The Restock Cart card that used to live here was
// duplicative with the toolbar's Restock cart button — pulled out
// so the strip reads strictly as "filter the list", not as KPIs.
// ----------------------------------------------------------------
function StockStatusStrip({
  counts,
  filter,
  onFilter,
  t,
}: {
  counts: { out: number; low: number; no_count: number; ok: number; total: number }
  filter: Filter
  onFilter: (f: Filter) => void
  t: T
}) {
  // `dot` is the status palette shared with ItemRow's left stripe
  // (red Out, amber Low, gray No count, emerald OK). `All` is the
  // neutral reset filter and intentionally has no dot.
  const pills: Array<{
    key: Filter
    label: string
    value: number
    dot: string | null
  }> = [
    { key: 'all',      label: t('All', 'Todos'),         value: counts.total,    dot: null            },
    { key: 'out',      label: t('Out', 'Agotado'),       value: counts.out,      dot: 'bg-red-500'    },
    { key: 'low',      label: t('Low', 'Bajo'),          value: counts.low,      dot: 'bg-amber-500'  },
    { key: 'no_count', label: t('No count', 'Sin conteo'), value: counts.no_count, dot: 'bg-gray-400'   },
    { key: 'ok',       label: t('OK', 'OK'),             value: counts.ok,       dot: 'bg-emerald-500' },
  ]

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label={t('Filter stock by status', 'Filtrar stock por estado')}
    >
      {pills.map((p) => {
        const isActive = filter === p.key
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => onFilter(p.key)}
            aria-pressed={isActive}
            className={`inline-flex items-center gap-1.5 h-8 rounded-md px-3 text-xs font-semibold transition-colors ${
              isActive
                ? 'bg-gray-900 text-white border border-gray-900'
                : 'bg-white border border-gray-200/80 text-gray-700 hover:bg-gray-50 hover:border-gray-300'
            }`}
          >
            {/* Dot only renders on the unselected state — on the
                dark active background the small color disc reads
                muddy, and the selected label + count already carry
                enough signal on their own. */}
            {p.dot && !isActive && (
              <span className={`w-1.5 h-1.5 rounded-full ${p.dot}`} aria-hidden />
            )}
            <span>{p.label}</span>
            <span
              className={`font-mono tabular-nums ${isActive ? 'text-white/70' : 'text-gray-500'}`}
            >
              {p.value}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ----------------------------------------------------------------
// DrawerShell — shared chrome used by every page-level drawer here
// (Cart / Orders / Create-item). Same shape as Staffing's drawers
// so the inventory drawers feel like the same product family.
// ----------------------------------------------------------------
function DrawerShell({ eyebrow, title, subtitle, onClose, children, t }: {
  eyebrow?: string
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
  t: T
}) {
  // Close on Escape — same convention every other drawer in the
  // app uses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <aside
        className="fixed right-0 top-0 bottom-0 w-full max-w-md md:max-w-lg lg:max-w-md bg-white border-l border-gray-200 shadow-xl z-50 flex flex-col"
        aria-label={title}
      >
        <header className="flex-shrink-0 border-b border-gray-100 px-6 py-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {eyebrow && (
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">
                {eyebrow}
              </p>
            )}
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-gray-900 leading-tight">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-1 text-xs text-gray-500 leading-relaxed">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Close', 'Cerrar')}
            className="flex-shrink-0 text-gray-400 hover:text-gray-600 p-1 -mt-0.5"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>
        {children}
      </aside>
    </>
  )
}

// ----------------------------------------------------------------
// CartDrawer — vendor-ticket builder.
//
// The drawer is no longer "place every staged item as one order."
// It's an interactive surface where the manager builds one vendor
// ticket at a time: select items from the staging area, assemble
// them into the active ticket, capture ticket-level vendor / total
// / date / notes, then commit. Items not added to the ticket stay
// staged so the manager can build a separate ticket for a different
// vendor next.
//
// Hierarchy:
//   Staging Area         → all currently-staged drafts not yet
//                          assigned to the active ticket. Each item
//                          card is draggable + click-to-select for
//                          a11y/fallback.
//   Active Vendor Ticket → working ticket: vendor field, drop zone,
//                          ticket items list, total / date / notes,
//                          Create order ticket commit.
//
// State lives in the drawer; nothing about which drafts are in the
// ticket vs. staging is persisted server-side until the manager
// hits Create. On Create, placeRestockTicket flips the selected
// drafts to 'ordered' with shared vendor/date/notes and an equally-
// split expected_cost so the existing receipt-time Finance bridge
// reconciles to the entered ticket total.
// ----------------------------------------------------------------
function CartDrawer({ drafts, itemsById, onClose, onInspectItem, t }: {
  drafts: RestockOrder[]
  itemsById: Map<string, Item>
  onClose: () => void
  onInspectItem: (itemId: string) => void
  t: T
}) {
  // Active ticket membership — Set of draft ids currently in the
  // ticket. Drafts not in this set stay in the staging area.
  const [ticketItemIds, setTicketItemIds] = useState<Set<string>>(new Set())
  // Click-to-select fallback for the staging side — accessible
  // alternative to drag/drop, also handles touch devices where
  // native HTML5 drag is awkward.
  const [selectedStagingId, setSelectedStagingId] = useState<string | null>(null)
  // Drag-over visual feedback on the ticket drop zone.
  const [dragOverTicket, setDragOverTicket] = useState(false)
  // Vendor lives in state (drives the ticket title and the Create
  // button's enabled state); the rest of the ticket fields are
  // uncontrolled refs since their values don't affect any other
  // render.
  const [vendor, setVendor] = useState('')
  const totalRef = useRef<HTMLInputElement>(null)
  const dateRef = useRef<HTMLInputElement>(null)
  const notesRef = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Drafts that disappear server-side (cancelled, or placed in
  // another ticket window via revalidation) should fall out of the
  // active ticket membership Set automatically so the UI never
  // references stale ids.
  const stagingItems = drafts.filter((d) => !ticketItemIds.has(d.id))
  const ticketItems = drafts.filter((d) => ticketItemIds.has(d.id))

  const moveToTicket = (id: string) => {
    setTicketItemIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
    if (selectedStagingId === id) setSelectedStagingId(null)
  }
  const moveBackToStaging = (id: string) => {
    setTicketItemIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  // Native HTML5 drag/drop. The draft id rides in the dataTransfer
  // text/plain payload — simplest cross-browser contract. The drop
  // target preventDefaults dragover so drop fires; without that
  // most browsers reject the drop silently.
  const onDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('text/plain', id)
    e.dataTransfer.effectAllowed = 'move'
  }
  const onTicketDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragOverTicket) setDragOverTicket(true)
  }
  const onTicketDragLeave = (e: React.DragEvent) => {
    // Only clear when the cursor genuinely leaves the drop region —
    // child element hover/leave cycles would otherwise flash the
    // state off and on rapidly.
    if (e.currentTarget === e.target) setDragOverTicket(false)
  }
  const onTicketDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    setDragOverTicket(false)
    if (id && drafts.some((d) => d.id === id)) moveToTicket(id)
  }

  const onCreateTicket = () => {
    setError(null)
    if (ticketItems.length === 0) {
      setError(t('Add at least one item to the ticket.', 'Agrega al menos un artículo a la boleta.'))
      return
    }
    if (!vendor.trim()) {
      setError(t('Add a vendor before creating the order ticket.', 'Agrega un proveedor antes de crear la boleta de orden.'))
      return
    }
    startTransition(async () => {
      const fd = new FormData()
      fd.set('order_ids', Array.from(ticketItemIds).join(','))
      fd.set('vendor', vendor.trim())
      fd.set('expected_total', totalRef.current?.value.trim() ?? '')
      fd.set('expected_date', dateRef.current?.value.trim() ?? '')
      fd.set('notes', notesRef.current?.value.trim() ?? '')
      const result = await placeRestockTicket(null, fd)
      if (result?.error) {
        setError(result.error)
        return
      }
      // Success: clear ticket membership and reset form. The placed
      // drafts will fall out of `drafts` on the next revalidation;
      // remaining staged items appear in the staging area.
      setTicketItemIds(new Set())
      setVendor('')
      if (totalRef.current) totalRef.current.value = ''
      if (dateRef.current) dateRef.current.value = ''
      if (notesRef.current) notesRef.current.value = ''
    })
  }

  return (
    <DrawerShell
      eyebrow={t('Replenishment', 'Reabastecimiento')}
      title={t('Restock Cart', 'Carrito de reabastecimiento')}
      subtitle={t('Build vendor order tickets from staged items.', 'Crea boletas de orden de proveedor a partir de artículos preparados.')}
      onClose={onClose}
      t={t}
    >
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {drafts.length === 0 ? (
          <div className="text-center py-10">
            <div className="mx-auto w-10 h-10 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center mb-3">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-gray-900">{t('Restock cart is empty.', 'El carrito de reabastecimiento está vacío.')}</p>
            <p className="mx-auto mt-1.5 max-w-[300px] text-xs text-gray-500 leading-relaxed">
              {t('Add low or out items from Stock Health to start building a vendor ticket.', 'Agrega artículos bajos o agotados desde Salud del stock para empezar a crear una boleta de proveedor.')}
            </p>
          </div>
        ) : (
          <>
            {/* Hierarchy: Active Ticket on top (the surface the
                manager is composing), Staging Area below (the pool
                they're drawing from). The staged items page-break
                after 3 so a long bench never pushes the ticket up
                or scrolls the cart. */}
            <ActiveTicketCard
              items={ticketItems}
              itemsById={itemsById}
              vendor={vendor}
              setVendor={setVendor}
              totalRef={totalRef}
              dateRef={dateRef}
              notesRef={notesRef}
              onMoveBack={moveBackToStaging}
              onDragOver={onTicketDragOver}
              onDragLeave={onTicketDragLeave}
              onDrop={onTicketDrop}
              dragOverTicket={dragOverTicket}
              selectedStagingId={selectedStagingId}
              onAddSelected={() => {
                if (selectedStagingId) moveToTicket(selectedStagingId)
              }}
              onCreateTicket={onCreateTicket}
              pending={pending}
              error={error}
              t={t}
            />

            <StagingArea
              items={stagingItems}
              itemsById={itemsById}
              selectedId={selectedStagingId}
              onSelect={setSelectedStagingId}
              onMoveToTicket={moveToTicket}
              onDragStart={onDragStart}
              ticketHasItems={ticketItems.length > 0}
              t={t}
            />
          </>
        )}
      </div>
    </DrawerShell>
  )
}

// ----------------------------------------------------------------
// StagingArea — top section of the cart showing all drafts not yet
// assigned to the active vendor ticket. Each item is a draggable
// card that also supports click-to-select for accessibility and
// touch ergonomics.
// ----------------------------------------------------------------
function StagingArea({
  items,
  itemsById,
  selectedId,
  onSelect,
  onMoveToTicket,
  onDragStart,
  ticketHasItems,
  t,
}: {
  items: RestockOrder[]
  itemsById: Map<string, Item>
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMoveToTicket: (id: string) => void
  onDragStart: (e: React.DragEvent, id: string) => void
  ticketHasItems: boolean
  t: T
}) {
  return (
    // Soft blue top accent puts the Staging Area in the same color
    // family as the Active Ticket, but a step lighter (200 vs 300)
    // so the two cards read as "soft / waiting" vs "active / now."
    // Both belong to the same workflow; the saturation delta marks
    // the role.
    <div className="rounded-xl border border-gray-200/80 border-t-2 border-t-blue-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-gray-900">{t('Staging area', 'Área de preparación')}</p>
          <p className="mt-0.5 text-[10.5px] text-gray-500">
            {t('Items waiting to be assigned to a vendor ticket.', 'Artículos esperando ser asignados a una boleta de proveedor.')}
          </p>
        </div>
        {items.length > 0 && (
          // Soft blue pill — same family as the Active Ticket's
          // "N items" pill but a step lighter. The blue-300 dot
          // signals "in the workflow" without competing with the
          // ticket's stronger blue-500 dot.
          <span className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600">
            <span className="w-1 h-1 rounded-full bg-blue-300" />
            {items.length === 1 ? t('1 waiting', '1 en espera') : `${items.length} ${t('waiting', 'en espera')}`}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <p className="px-4 py-3 text-[10.5px] text-gray-400 leading-relaxed">
          {ticketHasItems
            ? t('All staged items are on the active ticket above.', 'Todos los artículos preparados están en la boleta activa de arriba.')
            : t('Nothing waiting. Add items from Stock Health.', 'Nada en espera. Agrega artículos desde Salud del stock.')}
        </p>
      ) : (
        // Bounded scrollable tray. Above 3 items the list scrolls
        // internally so the Active Ticket above stays anchored.
        // Minimal scrollbar styling — thin slate-300 thumb on both
        // Firefox and Chromium, no track, no chrome bar. Below the
        // threshold no max-height applies and the card sizes
        // naturally to its content.
        <div
          className={
            items.length > 3
              ? 'max-h-[300px] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#cbd5e1_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-slate-300 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:hover:bg-slate-400'
              : ''
          }
        >
          <ul className="p-2 space-y-1.5">
            {items.map((order) => (
              <StagingItemCard
                key={order.id}
                order={order}
                item={itemsById.get(order.inventoryItemId)}
                selected={selectedId === order.id}
                onSelect={() => onSelect(selectedId === order.id ? null : order.id)}
                onMoveToTicket={() => onMoveToTicket(order.id)}
                onDragStart={(e) => onDragStart(e, order.id)}
                t={t}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// StagingItemCard — single draggable staging row.
//
// Four affordances:
//   1. Drag handle (entire card is draggable into the ticket drop
//      zone).
//   2. Click to select/deselect — drives the "Add to ticket" button
//      that appears in the qty row and the "Add selected to ticket"
//      affordance on the ActiveTicketCard.
//   3. Inline qty stepper (+/-) — optimistic local state, fires
//      updateRestockQuantity on each click via useTransition.
//      Clamped at 0.01 to match the server's "quantity > 0" check.
//   4. Remove × — fires cancelRestockOrder, drops the draft.
//
// Selected state uses the soft blue accent ring; selection
// auto-clears when the row is moved into the ticket.
// ----------------------------------------------------------------
function StagingItemCard({
  order,
  item,
  selected,
  onSelect,
  onMoveToTicket,
  onDragStart,
  t,
}: {
  order: RestockOrder
  item: Item | undefined
  selected: boolean
  onSelect: () => void
  onMoveToTicket: () => void
  onDragStart: (e: React.DragEvent) => void
  t: T
}) {
  const unit = item?.unitOfMeasure ?? ''
  const recipeSubtitle = item?.recipeLinks
    ? `${t('Used in', 'Usado en')} ${item.recipeLinks} ${item.recipeLinks > 1 ? t('recipes', 'recetas') : t('recipe', 'receta')}`
    : t('Standalone item', 'Artículo independiente')

  // String-based input draft. Lets the manager type partial values
  // like "1." or transient empties without snapping back on each
  // keystroke; we parse + clamp + commit on blur or Enter. Re-syncs
  // from order.quantity when the server confirms an update.
  const [inputDraft, setInputDraft] = useState(order.quantity.toString())
  useEffect(() => {
    setInputDraft(order.quantity.toString())
  }, [order.quantity])

  const [qtyPending, startQtyTransition] = useTransition()
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelRestockOrder, null)

  // Current visible value — falls back to order.quantity when the
  // input is mid-edit / empty. Drives disabled-state for the
  // decrement button.
  const currentParsed = parseFloat(inputDraft)
  const displayQty =
    Number.isFinite(currentParsed) && currentParsed > 0 ? currentParsed : order.quantity

  const commitToServer = (next: number) => {
    const clamped = Math.max(0.01, Math.round(next * 100) / 100)
    setInputDraft(clamped.toString())
    if (clamped === order.quantity) return
    startQtyTransition(async () => {
      const fd = new FormData()
      fd.set('order_id', order.id)
      fd.set('quantity', clamped.toString())
      await updateRestockQuantity(null, fd)
    })
  }

  const onInputBlur = () => {
    const parsed = parseFloat(inputDraft)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      // Revert invalid / empty input back to the server-confirmed
      // quantity rather than silently committing 0.
      setInputDraft(order.quantity.toString())
      return
    }
    commitToServer(parsed)
  }

  return (
    <li
      draggable
      onDragStart={(e) => {
        // Guard: don't initiate a card drag when the manager is
        // interacting with form controls (the stepper region). The
        // stepper container is tagged `data-no-drag`; we check
        // whether the dragstart originated inside it and bail.
        if ((e.target as HTMLElement).closest('[data-no-drag]')) {
          e.preventDefault()
          return
        }
        onDragStart(e)
      }}
      onClick={onSelect}
      className={`group rounded-lg border bg-white p-3 transition-all cursor-grab active:cursor-grabbing ${
        selected
          ? 'border-blue-300 bg-blue-50/40 shadow-[0_0_0_2px_rgba(59,130,246,0.15)]'
          : 'border-gray-200 hover:border-gray-300 hover:shadow-[0_2px_4px_rgba(15,23,42,0.04)]'
      }`}
    >
      {/* Header — item identity (read-only) + Remove ×. The name
          is a plain div, NOT a button: the cart is for assembling
          the order, not for inspecting items. Manager inspects an
          item from Stock Health. */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900 truncate">
            {item?.name ?? '—'}
          </p>
          <p className="text-[11px] text-gray-500 truncate mt-0.5">{recipeSubtitle}</p>
        </div>

        <form action={cancelAction} className="flex-shrink-0 -mr-1 -mt-1" onClick={(e) => e.stopPropagation()}>
          <input type="hidden" name="order_id" value={order.id} />
          <button
            type="submit"
            disabled={cancelPending}
            aria-label={t('Remove from staging', 'Quitar de preparación')}
            title={t('Remove from staging', 'Quitar de preparación')}
            className="text-gray-300 hover:text-red-600 transition-colors p-1 disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </form>
      </div>

      {/* Bottom row — qty stepper with an editable number input,
          unit glued to its right edge, and (when selected) Add to
          ticket pinned to the far right. The whole region is
          `data-no-drag` so dragging or clicking inside the stepper
          doesn't trigger card drag or selection toggle. */}
      <div
        data-no-drag
        className="mt-2.5 flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="inline-flex items-stretch rounded-md border border-gray-300 bg-white overflow-hidden">
          <button
            type="button"
            onClick={() => commitToServer(displayQty - 1)}
            disabled={qtyPending || displayQty <= 0.01}
            aria-label={t('Decrease staged quantity', 'Disminuir cantidad preparada')}
            className="px-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
            </svg>
          </button>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={inputDraft}
            onChange={(e) => setInputDraft(e.target.value)}
            onBlur={onInputBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                (e.target as HTMLInputElement).blur()
              }
            }}
            disabled={qtyPending}
            aria-label={t('Staged quantity', 'Cantidad preparada')}
            className="h-7 w-14 text-center text-sm font-mono font-semibold tabular-nums text-gray-900 border-x border-gray-300 focus:outline-none focus:bg-blue-50/40 disabled:opacity-50 appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
          />
          <button
            type="button"
            onClick={() => commitToServer(displayQty + 1)}
            disabled={qtyPending}
            aria-label={t('Increase staged quantity', 'Aumentar cantidad preparada')}
            className="px-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
        <span className="text-[11px] font-medium text-gray-600 flex-shrink-0">{unit}</span>

        {selected && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onMoveToTicket()
            }}
            className="ml-auto flex-shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-[10.5px] font-semibold text-white hover:bg-blue-700 transition-colors"
          >
            {t('Add to ticket', 'Agregar a boleta')}
          </button>
        )}
      </div>

      {(cancelState?.error) && (
        <p className="mt-1.5 text-[10px] text-red-600">{cancelState.error}</p>
      )}
    </li>
  )
}

// ----------------------------------------------------------------
// ActiveTicketCard — working vendor ticket. The drop zone accepts
// staged items via drag, plus a click-driven fallback through the
// "Add selected to ticket" button when a staging row is selected.
// Vendor / total / date / notes are ticket-level — the manager
// captures the supplier order once, not per item. Create order
// ticket fires placeRestockTicket, which atomically flips the
// included drafts to 'ordered' with shared metadata and a per-line
// cost split that aggregates back to the entered ticket total.
// ----------------------------------------------------------------
function ActiveTicketCard({
  items,
  itemsById,
  vendor,
  setVendor,
  totalRef,
  dateRef,
  notesRef,
  onMoveBack,
  onDragOver,
  onDragLeave,
  onDrop,
  dragOverTicket,
  selectedStagingId,
  onAddSelected,
  onCreateTicket,
  pending,
  error,
  t,
}: {
  items: RestockOrder[]
  itemsById: Map<string, Item>
  vendor: string
  setVendor: (v: string) => void
  totalRef: React.RefObject<HTMLInputElement | null>
  dateRef: React.RefObject<HTMLInputElement | null>
  notesRef: React.RefObject<HTMLInputElement | null>
  onMoveBack: (id: string) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  dragOverTicket: boolean
  selectedStagingId: string | null
  onAddSelected: () => void
  onCreateTicket: () => void
  pending: boolean
  error: string | null
  t: T
}) {
  const hasItems = items.length > 0
  const canCreate = hasItems && vendor.trim().length > 0 && !pending
  const title = vendor.trim() ? `${vendor.trim()} ${t('ticket', 'boleta')}` : t('Active ticket', 'Boleta activa')
  const ctaLabel = pending
    ? t('Creating…', 'Creando…')
    : vendor.trim()
      ? `${t('Create', 'Crear')} ${vendor.trim()} ${t('order ticket', 'boleta de orden')}`
      : t('Create order ticket', 'Crear boleta de orden')

  return (
    <div className="rounded-xl border border-gray-200/80 border-t-2 border-t-blue-300 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-gray-900 truncate">{title}</p>
          <p className="mt-0.5 text-[10.5px] text-gray-500">
            {t('Build one vendor order from staged items.', 'Crea una orden de proveedor a partir de artículos preparados.')}
          </p>
        </div>
        <span className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">
          <span className="w-1 h-1 rounded-full bg-blue-500" />
          {items.length === 1 ? t('1 item', '1 artículo') : `${items.length} ${t('items', 'artículos')}`}
        </span>
      </div>

      {/* Vendor — required for Create. Controlled so the ticket
          title above and the CTA below stay in sync as the manager
          types. */}
      <div className="px-4 py-2.5 border-b border-gray-100">
        <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1">
          {t('Vendor / source', 'Proveedor / origen')}
        </label>
        <input
          type="text"
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          placeholder="HEB, US Foods, Walmart…"
          className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
        />
      </div>

      {/* Drop zone + ticket items. Dashed-blue treatment when
          dragging makes the target unmistakable; empty state nudges
          toward the click fallback when nothing is being dragged. */}
      <div className="px-4 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1.5">
          {t('Ticket items', 'Artículos de la boleta')}
        </p>
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`rounded-lg transition-colors ${
            dragOverTicket
              ? 'border-2 border-dashed border-blue-400 bg-blue-50/50'
              : hasItems
                ? 'border border-gray-200 bg-gray-50/40'
                : 'border border-dashed border-gray-300 bg-gray-50/30'
          }`}
        >
          {hasItems ? (
            <ul className="p-1.5 space-y-1">
              {items.map((order) => (
                <TicketItemRow
                  key={order.id}
                  order={order}
                  item={itemsById.get(order.inventoryItemId)}
                  onMoveBack={() => onMoveBack(order.id)}
                  t={t}
                />
              ))}
            </ul>
          ) : (
            <p className={`px-4 py-3.5 text-center text-[11px] leading-relaxed ${
              dragOverTicket ? 'text-blue-700 font-medium' : 'text-gray-500'
            }`}>
              {dragOverTicket
                ? t('Drop to add to the ticket.', 'Suelta para agregar a la boleta.')
                : selectedStagingId
                  ? t('Drop here, or click Add selected below.', 'Suelta aquí, o haz clic en Agregar seleccionado abajo.')
                  : t('Drag staged items here, or select one and add it.', 'Arrastra artículos preparados aquí, o selecciona uno y agrégalo.')}
            </p>
          )}
        </div>

        {selectedStagingId && (
          <button
            type="button"
            onClick={onAddSelected}
            className="mt-1.5 w-full rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 transition-colors"
          >
            {t('+ Add selected to ticket', '+ Agregar seleccionado a boleta')}
          </button>
        )}
      </div>

      {/* Ticket-level metadata. Total + date on one row, notes on
          its own. All optional; no per-item price. */}
      <div className="px-4 py-2.5 border-t border-gray-100 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1">
              {t('Expected total', 'Total esperado')}
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">$</span>
              <input
                ref={totalRef}
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                className="h-9 w-full rounded-md border border-gray-200 bg-white pl-6 pr-3 text-sm font-mono tabular-nums placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1">
              {t('Expected date', 'Fecha esperada')}
            </label>
            <input
              ref={dateRef}
              type="date"
              className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
            />
          </div>
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-1">
            {t('Notes', 'Notas')}
          </label>
          <input
            ref={notesRef}
            type="text"
            placeholder={t('Confirm with vendor', 'Confirmar con proveedor')}
            className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
          />
        </div>
      </div>

      {error && (
        <p className="px-4 pb-2 text-[11px] text-red-600">{error}</p>
      )}

      {/* Create commit. Disabled until both vendor and items are in
          place. Stock and Finance update on receipt. */}
      <div className="px-4 py-3 border-t border-gray-100 bg-white">
        <button
          type="button"
          onClick={onCreateTicket}
          disabled={!canCreate}
          className="w-full rounded-md bg-gray-900 px-4 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {ctaLabel}
        </button>
        <p className="mt-1.5 text-[10px] text-gray-400 leading-relaxed text-center">
          {t('Stock and Finance update on receipt.', 'Stock y Finanzas se actualizan al recibir.')}
        </p>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// TicketItemRow — compact assigned-to-ticket row inside the active
// ticket drop zone. Shows the item identity and its quantity; the
// ← affordance moves it back to staging without canceling the
// underlying draft.
// ----------------------------------------------------------------
function TicketItemRow({
  order,
  item,
  onMoveBack,
  t,
}: {
  order: RestockOrder
  item: Item | undefined
  onMoveBack: () => void
  t: T
}) {
  const unit = item?.unitOfMeasure ?? ''
  return (
    <li className="flex items-center justify-between gap-2 rounded-md bg-white border border-gray-200 px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-gray-900 truncate">{item?.name ?? '—'}</p>
        <p className="text-[10px] text-gray-500 font-mono tabular-nums">
          {order.quantity.toFixed(order.quantity % 1 === 0 ? 0 : 2)} {unit}
        </p>
      </div>
      <button
        type="button"
        onClick={onMoveBack}
        title={t('Move back to staging', 'Mover de regreso a preparación')}
        aria-label={t('Move back to staging', 'Mover de regreso a preparación')}
        className="flex-shrink-0 text-gray-400 hover:text-blue-700 p-1 transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
      </button>
    </li>
  )
}

// ----------------------------------------------------------------
// OrdersDrawer — order-lifecycle surface for placed restock orders.
// Two sections only:
//
//   1. Pending Orders — batches with at least one ordered line that
//      still needs receiving. Includes "Awaiting receipt" (nothing
//      received yet) and "Partially received" (some lines done, some
//      still pending).
//   2. Closed Orders — recently completed batches (all lines either
//      received or canceled-short). Read-only preview.
//
// The drawer is for tracking + receiving + closing. Order CREATION
// happens in the Restock Cart; this drawer never re-builds tickets.
// ----------------------------------------------------------------
type OrderLifecycle = 'pending' | 'partial' | 'closed'

function OrdersDrawer({ ordered, closed, itemsById, onClose, onInspectItem, t }: {
  ordered: RestockOrder[]
  closed: RestockOrder[]
  itemsById: Map<string, Item>
  onClose: () => void
  onInspectItem: (itemId: string) => void
  t: T
}) {
  // Group lines into batches by `orderedAt`, then split the pending
  // bucket by whether any sibling has already been received. That
  // mirrors the lifecycle the manager actually browses:
  //   • pending  → nothing received yet (Awaiting receipt)
  //   • partial  → some received, some still ordered
  //   • closed   → nothing ordered remaining
  //
  // splitRestockBatches still returns the binary pending/closed
  // split (its only job is "does this batch still have an ordered
  // line?"). We then bucket the pending side here in one cheap pass.
  const { pendingBatches, closedBatches } = useMemo(
    () => splitRestockBatches(ordered, closed),
    [ordered, closed],
  )
  const awaitingBatches = useMemo(
    () => pendingBatches.filter((b) => !b.lines.some((l) => l.status === 'received')),
    [pendingBatches],
  )
  const partialBatches = useMemo(
    () => pendingBatches.filter((b) => b.lines.some((l) => l.status === 'received')),
    [pendingBatches],
  )

  // Lifecycle filter — single selected tab at a time. Defaults to
  // Pending so the manager lands on the most-actionable bucket.
  // Empty buckets still render their empty state rather than being
  // disabled — easier for the manager to see the zero rather than
  // wonder why a tab is greyed out.
  const [tab, setTab] = useState<OrderLifecycle>('pending')

  // Per-tab pagination — 6 tickets per page across all three
  // lifecycles. Each tab carries its own page state so switching
  // back to a tab preserves position (the user's "where I left
  // off" is per lifecycle). The pagination footer pattern matches
  // the Recent Movement pagination idiom from the Inventory item
  // drawer.
  const TAB_PAGE_SIZE = 6
  const [pendingPage, setPendingPage] = useState(1)
  const [partialPage, setPartialPage] = useState(1)
  const [closedPage,  setClosedPage]  = useState(1)

  // Slice helpers — pure function over (list, page) → visible slice.
  // Returns the start index too so the footer can render
  // "Showing N–M of T" without re-derivation.
  function slicePage<T>(list: T[], page: number): {
    visible: T[]; safePage: number; totalPages: number; start: number
  } {
    const totalPages = Math.max(1, Math.ceil(list.length / TAB_PAGE_SIZE))
    const safePage = Math.min(page, totalPages)
    const start = (safePage - 1) * TAB_PAGE_SIZE
    return { visible: list.slice(start, start + TAB_PAGE_SIZE), safePage, totalPages, start }
  }
  const pendingSlice = slicePage(awaitingBatches, pendingPage)
  const partialSlice = slicePage(partialBatches,  partialPage)
  const closedSlice  = slicePage(closedBatches,   closedPage)

  // Only one OrderBatchCard expanded at a time. The lift keeps the
  // drawer focused on a single receive flow — opening Receive on
  // batch B auto-collapses batch A. Tab change clears the expanded
  // key so a stale id from another bucket can't haunt the new tab.
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  useEffect(() => { setExpandedKey(null) }, [tab])

  const filters: Array<{ key: OrderLifecycle; label: string; count: number }> = [
    { key: 'pending', label: t('Pending', 'Pendientes'), count: awaitingBatches.length },
    { key: 'partial', label: t('Partial', 'Parcial'),    count: partialBatches.length },
    { key: 'closed',  label: t('Closed', 'Cerradas'),    count: closedBatches.length  },
  ]

  return (
    <DrawerShell
      eyebrow={t('Replenishment', 'Reabastecimiento')}
      title={t('Restock Orders', 'Órdenes de reabastecimiento')}
      subtitle={t('Track restock tickets through receiving.', 'Rastrea las boletas de reabastecimiento durante la recepción.')}
      onClose={onClose}
      t={t}
    >
      {/* LIFECYCLE FILTER ROW — black-active pill style, same family
          as Stock Health filters. One selection at a time. The count
          inline keeps the bucket sizes legible without a separate
          eyebrow row. */}
      <div className="flex-shrink-0 px-6 pt-4 pb-3 border-b border-gray-100">
        <div className="flex items-center gap-1.5" role="group" aria-label={t('Filter by lifecycle', 'Filtrar por ciclo de vida')}>
          {filters.map((f) => {
            const isActive = tab === f.key
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setTab(f.key)}
                aria-pressed={isActive}
                className={`inline-flex items-center gap-1.5 h-8 rounded-md px-3 text-xs font-semibold transition-colors ${
                  isActive
                    ? 'bg-gray-900 text-white border border-gray-900'
                    : 'bg-white border border-gray-200/80 text-gray-700 hover:bg-gray-50 hover:border-gray-300'
                }`}
              >
                <span>{f.label}</span>
                <span className={`font-mono tabular-nums ${isActive ? 'text-white/70' : 'text-gray-500'}`}>
                  {f.count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'pending' && (
          <div className="px-6 py-5">
            {awaitingBatches.length === 0 ? (
              <EmptyLifecycle
                title={t('No pending orders.', 'Sin órdenes pendientes.')}
                body={t('New restock tickets will appear here until something is received.', 'Las nuevas boletas de reabastecimiento aparecerán aquí hasta que se reciba algo.')}
              />
            ) : (
              <>
                <ul className="space-y-3">
                  {pendingSlice.visible.map((batch) => (
                    <OrderBatchCard
                      key={batch.key}
                      batch={batch}
                      itemsById={itemsById}
                      onInspectItem={onInspectItem}
                      mode="awaiting"
                      isExpanded={expandedKey === batch.key}
                      onToggleExpand={(open) =>
                        setExpandedKey(open ? batch.key : null)
                      }
                      t={t}
                    />
                  ))}
                </ul>
                {awaitingBatches.length > TAB_PAGE_SIZE && (
                  <PaginationFooter
                    start={pendingSlice.start}
                    pageSize={TAB_PAGE_SIZE}
                    total={awaitingBatches.length}
                    safePage={pendingSlice.safePage}
                    totalPages={pendingSlice.totalPages}
                    onPrev={() => setPendingPage((p) => Math.max(1, p - 1))}
                    onNext={() => setPendingPage((p) => Math.min(pendingSlice.totalPages, p + 1))}
                    ariaContext={t('pending orders', 'órdenes pendientes')}
                    t={t}
                  />
                )}
              </>
            )}
          </div>
        )}

        {tab === 'partial' && (
          <div className="px-6 py-5">
            {partialBatches.length === 0 ? (
              <EmptyLifecycle
                title={t('No partially received orders.', 'Sin órdenes recibidas parcialmente.')}
                body={t('Orders appear here when only part of a delivery has arrived.', 'Las órdenes aparecen aquí cuando solo parte de una entrega ha llegado.')}
              />
            ) : (
              <>
                <ul className="space-y-3">
                  {partialSlice.visible.map((batch) => (
                    <OrderBatchCard
                      key={batch.key}
                      batch={batch}
                      itemsById={itemsById}
                      onInspectItem={onInspectItem}
                      mode="partial"
                      isExpanded={expandedKey === batch.key}
                      onToggleExpand={(open) =>
                        setExpandedKey(open ? batch.key : null)
                      }
                      t={t}
                    />
                  ))}
                </ul>
                {partialBatches.length > TAB_PAGE_SIZE && (
                  <PaginationFooter
                    start={partialSlice.start}
                    pageSize={TAB_PAGE_SIZE}
                    total={partialBatches.length}
                    safePage={partialSlice.safePage}
                    totalPages={partialSlice.totalPages}
                    onPrev={() => setPartialPage((p) => Math.max(1, p - 1))}
                    onNext={() => setPartialPage((p) => Math.min(partialSlice.totalPages, p + 1))}
                    ariaContext={t('partially received orders', 'órdenes recibidas parcialmente')}
                    t={t}
                  />
                )}
              </>
            )}
          </div>
        )}

        {tab === 'closed' && (
          <div className="px-6 py-5">
            {closedBatches.length === 0 ? (
              <EmptyLifecycle
                title={t('No closed orders yet.', 'Sin órdenes cerradas aún.')}
                body={t('Closed tickets will appear here after receiving is complete.', 'Las boletas cerradas aparecerán aquí después de completar la recepción.')}
              />
            ) : (
              <>
                <ul className="space-y-3">
                  {closedSlice.visible.map((batch) => (
                    <ClosedOrderCard
                      key={batch.key}
                      batch={batch}
                      itemsById={itemsById}
                      t={t}
                    />
                  ))}
                </ul>
                {closedBatches.length > TAB_PAGE_SIZE && (
                  <PaginationFooter
                    start={closedSlice.start}
                    pageSize={TAB_PAGE_SIZE}
                    total={closedBatches.length}
                    safePage={closedSlice.safePage}
                    totalPages={closedSlice.totalPages}
                    onPrev={() => setClosedPage((p) => Math.max(1, p - 1))}
                    onNext={() => setClosedPage((p) => Math.min(closedSlice.totalPages, p + 1))}
                    ariaContext={t('closed orders', 'órdenes cerradas')}
                    t={t}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </DrawerShell>
  )
}

// ----------------------------------------------------------------
// PaginationFooter — shared compact footer used by all three
// lifecycle tabs. Renders "Showing N–M of T" on the left and
// ← page X / Y → arrows on the right. Only shows up when there's
// more than one page; callers gate the render with `totalPages > 1`.
// ----------------------------------------------------------------
function PaginationFooter({
  start, pageSize, total, safePage, totalPages, onPrev, onNext, ariaContext, t,
}: {
  start: number
  pageSize: number
  total: number
  safePage: number
  totalPages: number
  onPrev: () => void
  onNext: () => void
  ariaContext: string
  t: T
}) {
  return (
    <div className="mt-3 flex items-center justify-between">
      <p className="text-[10px] text-gray-500 font-mono tabular-nums">
        {t('Showing', 'Mostrando')}{' '}
        <span className="font-semibold text-gray-700">
          {start + 1}–{Math.min(start + pageSize, total)}
        </span>{' '}
        {t('of', 'de')} <span className="font-semibold text-gray-700">{total}</span>
      </p>
      <div className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={onPrev}
          disabled={safePage === 1}
          aria-label={`${t('Previous', 'Anterior')} ${ariaContext}`}
          className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          ←
        </button>
        <span className="text-[10px] text-gray-500 px-1.5 font-mono tabular-nums">
          {safePage} / {totalPages}
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={safePage === totalPages}
          aria-label={`${t('Next', 'Siguiente')} ${ariaContext}`}
          className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          →
        </button>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// EmptyLifecycle — shared compact empty-state block for each tab.
// Single border-dashed card, two lines of copy, no center alignment
// chrome so it reads as "section has nothing yet" instead of
// "alert." Identical visual treatment per tab — the title + body
// vary by lifecycle.
// ----------------------------------------------------------------
function EmptyLifecycle({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/60 px-4 py-5 text-center">
      <p className="text-xs font-medium text-gray-700">{title}</p>
      <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">{body}</p>
    </div>
  )
}

// ----------------------------------------------------------------
// Restock batches — group lines into the order tickets that produced
// them. placeRestockTicket / placeAllDrafts flip every selected
// draft to `ordered` in one DB update, so every line of a batch
// carries an identical `ordered_at` timestamp. That's the natural
// batch identity. Lines without `orderedAt` (drafts received via the
// fast-receipt path) fall back to their own id so they render as
// distinct single-line batches.
//
// A batch's `lines` array can mix statuses: ordered + received +
// canceled all coexist while the manager works through a partial
// delivery. The batch-state derivation (awaiting / partial /
// closed) reads off this mix.
// ----------------------------------------------------------------
type RestockBatch = {
  key: string
  orderedAt: string | null
  lines: RestockOrder[]
  vendorList: string[]
  totalExpectedCost: number | null
  soonestExpectedDate: string | null
}

// Split all active + closed lines into:
//   • pendingBatches — at least one line is still `ordered`
//   • closedBatches  — every line is `received` or `canceled`
//
// Partial-receipt batches (some lines done, some still ordered)
// land in `pendingBatches` so the manager can keep working through
// them; their card derives "Partially received" from the mix.
function splitRestockBatches(
  active: RestockOrder[],
  closed: RestockOrder[],
): { pendingBatches: RestockBatch[]; closedBatches: RestockBatch[] } {
  const groups = new Map<string, RestockOrder[]>()
  for (const o of [...active, ...closed]) {
    const key = o.orderedAt ?? `solo:${o.id}`
    const list = groups.get(key) ?? []
    list.push(o)
    groups.set(key, list)
  }

  const pendingBatches: RestockBatch[] = []
  const closedBatches: RestockBatch[] = []

  for (const [key, lines] of groups) {
    // Vendor mix — unique, order-of-first-appearance, omit blanks.
    const seenVendors = new Set<string>()
    const vendorList: string[] = []
    for (const l of lines) {
      const v = (l.vendor ?? '').trim()
      if (v && !seenVendors.has(v)) {
        seenVendors.add(v)
        vendorList.push(v)
      }
    }

    // Sum expected cost only if every line that has one rolls up,
    // otherwise show null so the UI omits the figure gracefully —
    // a partial total would mislead. Summation runs in integer
    // cents to avoid float-drift: a 1000.00 ticket split into
    // 333.34/333.33/333.33 must read back as 1000.00, not 999.99
    // or 1000.0000000001.
    const everyLineHasCost = lines.every((l) => l.expectedCost !== null)
    const totalExpectedCost = everyLineHasCost
      ? lines.reduce(
          (cents, l) => cents + Math.round((l.expectedCost ?? 0) * 100),
          0,
        ) / 100
      : null

    // Soonest expected date across lines. Ignore nulls.
    const dates = lines.map((l) => l.expectedDate).filter((d): d is string => !!d)
    const soonestExpectedDate = dates.length > 0
      ? dates.sort()[0]
      : null

    const batch: RestockBatch = {
      key,
      orderedAt: lines[0].orderedAt,
      lines,
      vendorList,
      totalExpectedCost,
      soonestExpectedDate,
    }

    const hasPending = lines.some((l) => l.status === 'ordered')
    if (hasPending) pendingBatches.push(batch)
    else closedBatches.push(batch)
  }

  // Pending: newest first (the most recent placement is the most
  // top-of-mind). Closed: most recently finalized first (the latest
  // close decision is what the manager wants to verify).
  pendingBatches.sort((a, b) => {
    const ta = a.orderedAt ? new Date(a.orderedAt).getTime() : 0
    const tb = b.orderedAt ? new Date(b.orderedAt).getTime() : 0
    return tb - ta
  })
  closedBatches.sort((a, b) => {
    const ta = closeStamp(a)
    const tb = closeStamp(b)
    return tb - ta
  })

  return { pendingBatches, closedBatches }
}

// Latest close timestamp across a batch's lines. Prefers receivedAt
// (the "real" close moment for received lines), falls back to
// canceledAt, then orderedAt. Drives Closed Orders sort order.
function closeStamp(batch: RestockBatch): number {
  let max = 0
  for (const l of batch.lines) {
    const t = l.receivedAt
      ? new Date(l.receivedAt).getTime()
      : l.canceledAt
        ? new Date(l.canceledAt).getTime()
        : l.orderedAt
          ? new Date(l.orderedAt).getTime()
          : 0
    if (t > max) max = t
  }
  return max
}

// ----------------------------------------------------------------
// OrderBatchCard — one card per pending restock batch. Surfaces
// the batch lifecycle state at a glance (Awaiting receipt vs
// Partially received), shows the item mix, and houses the receive
// flow.
//
// Receive flow supports three outcomes:
//   1. Receive all remaining lines (the typical case) — every line
//      flips to `received`, batch moves to Closed Orders.
//   2. Receive some, keep batch open — selected lines flip to
//      `received`, unchecked lines stay `ordered`, batch stays in
//      Pending Orders and reads as "Partially received."
//   3. Receive some, close batch short — selected lines flip to
//      `received`, unchecked lines flip to `canceled` (closed
//      short), batch moves to Closed Orders.
//
// Per-line semantics:
//   - Checkbox: include this line in this receipt round.
//   - Quantity input: defaults to ordered qty; partial-line receipt
//     (received 7 of 10) is a single keystroke. The stock movement
//     uses the ENTERED value, not the ordered qty.
//   - The ordered quantity is never overwritten — it stays on the
//     row as the "intent" truth. The actual received amount lives
//     on the linked inventory_transaction.
//
// Lines already received in earlier rounds (partially-received
// batches) render read-only with their captured received quantity.
// ----------------------------------------------------------------
function OrderBatchCard({
  batch,
  itemsById,
  onInspectItem,
  mode,
  isExpanded,
  onToggleExpand,
  t,
}: {
  batch: RestockBatch
  itemsById: Map<string, Item>
  onInspectItem: (itemId: string) => void
  /** Drives the collapsed-view layout:
   *    'awaiting' → comma-joined item names, single Receive button
   *    'partial'  → split Still open / Received subsections,
   *                 Continue receiving button
   *  The expanded receive panel is identical for both — it reads
   *  off line statuses, not the mode prop. */
  mode: 'awaiting' | 'partial'
  /** Controlled expand. Lifted to the drawer so only one card is
   *  open at a time; opening this card collapses any other open
   *  card automatically. */
  isExpanded: boolean
  onToggleExpand: (open: boolean) => void
  t: T
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Confirmed-total input. Defaults to the expected ticket total
  // (sum of per-line expected_cost). Manager can adjust before
  // closing. Sent on every receive call; the server re-distributes
  // across siblings and updates the Finance row in place when it
  // differs from the current value.
  const initialConfirmedTotal = batch.totalExpectedCost !== null && batch.totalExpectedCost > 0
    ? batch.totalExpectedCost.toFixed(2)
    : ''
  const [confirmedTotalDraft, setConfirmedTotalDraft] = useState(initialConfirmedTotal)

  // Lines still needing a decision in this batch.
  const orderedLines = batch.lines.filter((l) => l.status === 'ordered')
  // Lines that were received in earlier rounds (siblings of the
  // still-pending lines via shared ordered_at). Drives the
  // "Partially received" status pill + the read-only stat in the
  // receive panel.
  const earlierReceivedLines = batch.lines.filter((l) => l.status === 'received')
  // Lines already canceled (closed short) in earlier rounds.
  const earlierCanceledLines = batch.lines.filter((l) => l.status === 'canceled')

  const isPartial = earlierReceivedLines.length > 0

  // Per-line UI state — checkbox + quantity input, only meaningful
  // for the still-`ordered` lines. Seeded to "include + ordered qty"
  // so the typical case (everything arrived as expected) is a single
  // button click.
  const [includedIds, setIncludedIds] = useState<Set<string>>(
    () => new Set(orderedLines.map((l) => l.id)),
  )
  const [receivedQtys, setReceivedQtys] = useState<Record<string, string>>(
    () => Object.fromEntries(orderedLines.map((l) => [l.id, l.quantity.toString()])),
  )
  // Session-local "just received in this expand" tracker. Lets the
  // panel show the green checkmark as each line completes without
  // waiting for the revalidation round-trip.
  const [receivedInSession, setReceivedInSession] = useState<Set<string>>(() => new Set())

  const includedLines = orderedLines.filter(
    (l) => includedIds.has(l.id) && !receivedInSession.has(l.id),
  )
  const skippedLines = orderedLines.filter(
    (l) => !includedIds.has(l.id) && !receivedInSession.has(l.id),
  )

  const placedLabel = batch.orderedAt
    ? formatBatchTimestamp(batch.orderedAt)
    : t('Order awaiting receipt', 'Orden esperando recepción')

  // The receive commit. `closeShort` controls what happens to the
  // unchecked lines:
  //   true  → cancel them so the batch closes
  //   false → leave them as `ordered` so the batch stays pending
  // Both paths receive the checked lines at their entered quantity.
  const onConfirm = (closeShort: boolean) => {
    setError(null)
    if (includedLines.length === 0 && !closeShort) {
      setError(t('Select at least one line to receive, or use "Receive & close" to short-close the order.', 'Selecciona al menos una línea para recibir, o usa "Recibir y cerrar" para cerrar la orden con faltante.'))
      return
    }
    startTransition(async () => {
      // Phase 1: receive each included line in turn. Stops on the
      // first error so the manager doesn't end up with a partially
      // applied multi-line receipt that's hard to reason about.
      for (const line of includedLines) {
        const raw = receivedQtys[line.id] ?? line.quantity.toString()
        const parsed = parseFloat(raw)
        if (!Number.isFinite(parsed) || parsed <= 0) {
          const name = itemsById.get(line.inventoryItemId)?.name ?? t('Item', 'Artículo')
          setError(`${name}: ${t('received quantity must be greater than zero.', 'la cantidad recibida debe ser mayor que cero.')}`)
          return
        }
        const fd = new FormData()
        fd.set('order_id', line.id)
        fd.set('received_quantity', raw)
        // Ticket-level confirmed total — the server uses this as
        // the Finance amount and re-distributes across siblings'
        // expected_cost. Empty → server falls back to the prior
        // sibling-sum behavior.
        if (confirmedTotalDraft.trim() !== '') {
          fd.set('confirmed_total', confirmedTotalDraft.trim())
        }
        const result = await markRestockReceived(null, fd)
        if (result?.error) {
          const name = itemsById.get(line.inventoryItemId)?.name ?? t('Item', 'Artículo')
          setError(`${name}: ${result.error}`)
          return
        }
        setReceivedInSession((s) => new Set(s).add(line.id))
      }

      // Phase 2: if close-short was requested, cancel any still-
      // ordered skipped lines in one server round-trip. Lines that
      // have already received this session are skipped; the batch
      // is now closing because nothing pending remains.
      if (closeShort && skippedLines.length > 0) {
        const fd = new FormData()
        fd.set('order_ids', skippedLines.map((l) => l.id).join(','))
        const result = await closeRestockBatch(null, fd)
        if (result?.error) {
          setError(result.error)
          return
        }
      }

      onToggleExpand(false)
    })
  }

  // Title reads the vendor when present so the card immediately
  // identifies who the order is from. Falls back to "Restock order"
  // when no vendor was captured (legacy data, or the cart's vendor
  // field was left blank before commit).
  const itemCount = batch.lines.length
  const primaryVendor = batch.vendorList[0] ?? null
  const titleText = primaryVendor ? `${primaryVendor} ${t('order', 'orden')}` : t('Restock order', 'Orden de reabastecimiento')
  const vendorOverflow = batch.vendorList.length > 1 ? ` +${batch.vendorList.length - 1}` : ''

  // Item preview — up to 3 lines shown directly in the collapsed
  // card so the manager can verify "what's in this order" without
  // expanding. Layout adapts when the batch is partially received:
  // already-received lines show "X / Y received", still-ordered
  // show "Y ordered".
  const PREVIEW_LIMIT = 3
  const previewLines = batch.lines.slice(0, PREVIEW_LIMIT)
  const previewOverflow = batch.lines.length - previewLines.length

  // Visual semantics: amber for awaiting, blue for partially
  // received. Closed-out lines coexist; the batch's top-edge accent
  // reflects the dominant state ("still waiting on something").
  const topAccent = isPartial ? 'border-t-blue-200' : 'border-t-amber-200'
  const pillBg = isPartial ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'
  const pillDot = isPartial ? 'bg-blue-500' : 'bg-amber-500'
  const pillLabel = isPartial ? t('Partially received', 'Recibida parcialmente') : t('Awaiting receipt', 'Esperando recepción')
  const buttonLabel = isPartial ? t('Continue receiving', 'Continuar recepción') : t('Receive order', 'Recibir orden')
  const expandedHeader = isPartial
    ? primaryVendor ? `${t('Continue receiving', 'Continuar recepción de')} ${primaryVendor} ${t('order', 'orden')}` : t('Continue receiving', 'Continuar recepción')
    : primaryVendor ? `${t('Receive', 'Recibir')} ${primaryVendor} ${t('order', 'orden')}` : t('Confirm received quantities', 'Confirmar cantidades recibidas')

  // Partial-progress meta line (collapsed view): "X of Y items
  // received" so the lifecycle is legible without expanding.
  const partialProgress = isPartial
    ? `${earlierReceivedLines.length} ${t('of', 'de')} ${itemCount} ${itemCount === 1 ? t('item received', 'artículo recibido') : t('items received', 'artículos recibidos')}`
    : null

  // Comma-joined item-name preview for the awaiting card. Quantities
  // are deferred to the receive panel where they're actionable.
  const previewNames = previewLines
    .map((l) => itemsById.get(l.inventoryItemId)?.name ?? '—')
    .join(', ')
  const previewSuffix = previewOverflow > 0 ? ` + ${previewOverflow} ${t('more', 'más')}` : ''

  // Partial-card subsections — "Still open" lists the lines still
  // awaiting receipt, "Received" lists what already came in. Both
  // capped at a small preview so the card stays compact; the full
  // detail lives in the expanded receive panel.
  const STILL_OPEN_PREVIEW = 3
  const RECEIVED_PREVIEW   = 3
  const stillOpenPreview     = orderedLines.slice(0, STILL_OPEN_PREVIEW)
  const stillOpenOverflow    = orderedLines.length - stillOpenPreview.length
  const receivedPreview      = earlierReceivedLines.slice(0, RECEIVED_PREVIEW)
  const receivedOverflow     = earlierReceivedLines.length - receivedPreview.length

  return (
    <li className={`rounded-xl border border-gray-200/80 border-t-2 ${topAccent} bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden`}>
      {/* COLLAPSED HEADER — branches by mode:
            • awaiting → single comma-joined item-name preview line
            • partial  → Still open (comma-joined names) + Received
                         (per-line with received/ordered) sections
          Both variants drop the "Placed at …" line in favor of a
          combined `{N items} · Expected {date} · ~${total}` line,
          per the polish spec. */}
      {!isExpanded && (
        <div className="px-4 py-3.5">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-gray-900 truncate">
              {titleText}
              {vendorOverflow && <span className="text-gray-400 font-normal text-[11px]">{vendorOverflow}</span>}
            </p>
            <span className={`flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${pillBg}`}>
              <span className={`w-1 h-1 rounded-full ${pillDot}`} />
              {pillLabel}
            </span>
          </div>
          {/* Single combined meta line: items + expected date +
              expected total. Drops the "Placed today, 12:10 AM"
              prefix; placement time is internal state, not what the
              manager is deciding on. */}
          <p className="mt-0.5 text-[11px] text-gray-500">
            {itemCount} {itemCount === 1 ? t('item', 'artículo') : t('items', 'artículos')}
            {batch.soonestExpectedDate && (
              <>
                <span className="text-gray-300 mx-1">·</span>
                <span>{t('Expected', 'Esperada')} {formatRestockDate(batch.soonestExpectedDate)}</span>
              </>
            )}
            {batch.totalExpectedCost !== null && batch.totalExpectedCost > 0 && (
              <>
                <span className="text-gray-300 mx-1">·</span>
                <span className="font-mono tabular-nums">~${batch.totalExpectedCost.toFixed(2)}</span>
              </>
            )}
          </p>
          {partialProgress && (
            <p className="mt-0.5 text-[11px] text-blue-700 font-medium">{partialProgress}</p>
          )}

          {/* Preview — awaiting variant: comma-joined names. */}
          {mode === 'awaiting' && previewNames.length > 0 && (
            <p className="mt-2 text-[11px] text-gray-700 truncate">
              {previewNames}
              {previewSuffix && <span className="text-gray-400">{previewSuffix}</span>}
            </p>
          )}

          {/* Preview — partial variant: Still open (comma-joined
              names, no quantities) + Received (per-line with
              received / ordered). The split is preserved as a
              quick mental model of "what's left vs what arrived";
              the open-items names alone keep the card light. */}
          {mode === 'partial' && (
            <div className="mt-2.5 space-y-2.5">
              {stillOpenPreview.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">{t('Still open', 'Aún abierto')}</p>
                  <p className="mt-1 text-[11px] text-gray-700 truncate">
                    {stillOpenPreview
                      .map((l) => itemsById.get(l.inventoryItemId)?.name ?? '—')
                      .join(', ')}
                    {stillOpenOverflow > 0 && (
                      <span className="text-gray-400"> + {stillOpenOverflow} {t('more', 'más')}</span>
                    )}
                  </p>
                </div>
              )}
              {receivedPreview.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">{t('Received', 'Recibido')}</p>
                  <div className="mt-1 space-y-0.5">
                    {receivedPreview.map((line) => {
                      const item = itemsById.get(line.inventoryItemId)
                      const unit = item?.unitOfMeasure ?? ''
                      const recv = line.receivedQuantity ?? line.quantity
                      const recvStr = recv.toFixed(recv % 1 === 0 ? 0 : 2)
                      const orderedStr = line.quantity.toFixed(line.quantity % 1 === 0 ? 0 : 2)
                      return (
                        <p key={line.id} className="text-[11px] text-gray-700 truncate font-mono tabular-nums">
                          <span className="font-medium text-gray-900">{item?.name ?? '—'}</span>
                          <span className="text-gray-500"> · {recvStr} / {orderedStr} {unit} {t('received', 'recibido')}</span>
                        </p>
                      )
                    })}
                    {receivedOverflow > 0 && (
                      <p className="text-[10.5px] text-gray-400">+ {receivedOverflow} {t('more', 'más')}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => onToggleExpand(true)}
            className="mt-3 w-full rounded-md bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800 transition-colors"
          >
            {buttonLabel}
          </button>
        </div>
      )}

      {/* RECEIVE PANEL — polished receiving workflow.
            • Subtle blue top accent signals "active mode."
            • Header restates identity (vendor + pill + meta).
            • No standing "Confirm received quantities / Stock
              updates only…" helper — the panel structure speaks.
            • Lines are flat divider rows. Item names are plain
              text (not links). Inputs are −/n/+ steppers, matching
              the staging-area control language.
            • Already-received lines under their own quiet eyebrow.
            • Order-level Confirmed total field above the actions.
            • Two-button close decision unchanged behaviorally. */}
      {isExpanded && (
        <ReceivePanelBody
          batch={batch}
          itemsById={itemsById}
          orderedLines={orderedLines}
          earlierReceivedLines={earlierReceivedLines}
          earlierCanceledLines={earlierCanceledLines}
          receivedInSession={receivedInSession}
          includedIds={includedIds}
          setIncludedIds={setIncludedIds}
          receivedQtys={receivedQtys}
          setReceivedQtys={setReceivedQtys}
          confirmedTotalDraft={confirmedTotalDraft}
          setConfirmedTotalDraft={setConfirmedTotalDraft}
          pending={pending}
          error={error}
          skippedLines={skippedLines}
          titleText={titleText}
          vendorOverflow={vendorOverflow}
          pillBg={pillBg}
          pillDot={pillDot}
          pillLabel={pillLabel}
          itemCount={itemCount}
          partialProgress={partialProgress}
          onConfirm={onConfirm}
          onCancel={() => {
            onToggleExpand(false)
            setError(null)
          }}
          t={t}
        />
      )}
    </li>
  )
}

// ----------------------------------------------------------------
// ReceivePanelBody — the expanded receive workflow rendered inside
// an OrderBatchCard. Extracted from OrderBatchCard so the JSX tree
// stays readable. Pure presentation + per-line state wiring; the
// receive/close actions are still owned by OrderBatchCard.
//
// Visual model:
//   1. Header        → vendor + pill + meta line
//   2. Open items    → eyebrow + per-line stepper rows
//   3. Already       → eyebrow + compact done rows (when partial)
//   4. Closed short  → quiet text rows (when previously short)
//   5. Confirmed     → order-level total input
//   6. Actions       → keep-open / close-order / cancel
// ----------------------------------------------------------------
function ReceivePanelBody({
  batch,
  itemsById,
  orderedLines,
  earlierReceivedLines,
  earlierCanceledLines,
  receivedInSession,
  includedIds,
  setIncludedIds,
  receivedQtys,
  setReceivedQtys,
  confirmedTotalDraft,
  setConfirmedTotalDraft,
  pending,
  error,
  skippedLines,
  titleText,
  vendorOverflow,
  pillBg,
  pillDot,
  pillLabel,
  itemCount,
  partialProgress,
  onConfirm,
  onCancel,
  t,
}: {
  batch: RestockBatch
  itemsById: Map<string, Item>
  orderedLines: RestockOrder[]
  earlierReceivedLines: RestockOrder[]
  earlierCanceledLines: RestockOrder[]
  receivedInSession: Set<string>
  includedIds: Set<string>
  setIncludedIds: React.Dispatch<React.SetStateAction<Set<string>>>
  receivedQtys: Record<string, string>
  setReceivedQtys: React.Dispatch<React.SetStateAction<Record<string, string>>>
  confirmedTotalDraft: string
  setConfirmedTotalDraft: React.Dispatch<React.SetStateAction<string>>
  pending: boolean
  error: string | null
  skippedLines: RestockOrder[]
  titleText: string
  vendorOverflow: string
  pillBg: string
  pillDot: string
  pillLabel: string
  itemCount: number
  partialProgress: string | null
  onConfirm: (closeShort: boolean) => void
  onCancel: () => void
  t: T
}) {
  return (
    <div className="border-t-2 border-t-blue-300 bg-white">
      {/* HEADER — identity always visible at top of the panel. */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-gray-900 truncate">
            {titleText}
            {vendorOverflow && <span className="text-gray-400 font-normal text-[11px]">{vendorOverflow}</span>}
          </p>
          <span className={`flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${pillBg}`}>
            <span className={`w-1 h-1 rounded-full ${pillDot}`} />
            {pillLabel}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-gray-500">
          {itemCount} {itemCount === 1 ? t('item', 'artículo') : t('items', 'artículos')}
          {batch.soonestExpectedDate && (
            <>
              <span className="text-gray-300 mx-1">·</span>
              <span>{t('Expected', 'Esperada')} {formatRestockDate(batch.soonestExpectedDate)}</span>
            </>
          )}
          {batch.totalExpectedCost !== null && batch.totalExpectedCost > 0 && (
            <>
              <span className="text-gray-300 mx-1">·</span>
              <span className="font-mono tabular-nums">~${batch.totalExpectedCost.toFixed(2)}</span>
            </>
          )}
        </p>
        {partialProgress && (
          <p className="mt-0.5 text-[11px] text-blue-700 font-medium">{partialProgress}</p>
        )}
      </div>

      {/* OPEN ITEMS — eyebrow + per-line stepper rows. */}
      {orderedLines.length > 0 && (
        <>
          <div className="px-4 pt-3 pb-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">
              {t('Open items', 'Artículos abiertos')}
            </p>
          </div>
          <ul className="px-4 pb-3 space-y-3">
            {orderedLines.map((line) => (
              <OpenLineRow
                key={line.id}
                line={line}
                item={itemsById.get(line.inventoryItemId)}
                isReceivedInSession={receivedInSession.has(line.id)}
                isIncluded={includedIds.has(line.id)}
                raw={receivedQtys[line.id] ?? line.quantity.toString()}
                pending={pending}
                t={t}
                onToggleSkip={() => {
                  setIncludedIds((s) => {
                    const next = new Set(s)
                    if (next.has(line.id)) next.delete(line.id)
                    else next.add(line.id)
                    return next
                  })
                }}
                onChangeQty={(value) =>
                  setReceivedQtys((m) => ({ ...m, [line.id]: value }))
                }
                onStepQty={(delta) => {
                  setReceivedQtys((m) => {
                    const curr = parseFloat(m[line.id] ?? line.quantity.toString())
                    const base = Number.isFinite(curr) && curr > 0 ? curr : line.quantity
                    const next = Math.max(0.01, Math.round((base + delta) * 100) / 100)
                    return { ...m, [line.id]: next.toString() }
                  })
                }}
              />
            ))}
          </ul>
        </>
      )}

      {/* ALREADY RECEIVED — partial-receipt siblings. */}
      {earlierReceivedLines.length > 0 && (
        <>
          <div className="px-4 pt-2 pb-1 border-t border-gray-100">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">
              {t('Already received', 'Ya recibido')}
            </p>
          </div>
          <ul className="px-4 pb-3 pt-1 space-y-1">
            {earlierReceivedLines.map((line) => {
              const item = itemsById.get(line.inventoryItemId)
              const unit = item?.unitOfMeasure ?? ''
              const recv = line.receivedQuantity ?? line.quantity
              const recvStr = recv.toFixed(recv % 1 === 0 ? 0 : 2)
              const orderedStr = line.quantity.toFixed(line.quantity % 1 === 0 ? 0 : 2)
              return (
                <li
                  key={line.id}
                  className="flex items-center gap-2 text-[11px] font-mono tabular-nums"
                >
                  <svg className="w-3 h-3 text-emerald-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <p className="text-gray-700 truncate flex-1 min-w-0">
                    <span className="font-medium text-gray-900">{item?.name ?? '—'}</span>
                    <span className="text-gray-500"> · {recvStr} / {orderedStr} {unit}</span>
                  </p>
                  <span className="text-[10px] font-semibold text-emerald-700 flex-shrink-0">{t('Done', 'Listo')}</span>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {/* CLOSED SHORT — quiet rows when prior rounds short-closed
          some lines. Rare; muted single-line text. */}
      {earlierCanceledLines.length > 0 && (
        <>
          <div className="px-4 pt-2 pb-1 border-t border-gray-100">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">
              {t('Closed short', 'Cerrado con faltante')}
            </p>
          </div>
          <ul className="px-4 pb-3 pt-1 space-y-1">
            {earlierCanceledLines.map((line) => {
              const item = itemsById.get(line.inventoryItemId)
              const unit = item?.unitOfMeasure ?? ''
              const orderedStr = line.quantity.toFixed(line.quantity % 1 === 0 ? 0 : 2)
              return (
                <li key={line.id} className="text-[11px] text-gray-500 truncate">
                  <span className="font-medium text-gray-700">{item?.name ?? '—'}</span>
                  <span> · {orderedStr} {unit} {t('ordered · not received', 'pedido · no recibido')}</span>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {/* CONFIRMED TOTAL — order-level cost confirmation. Default
          to the expected ticket total; edit before close. Server
          uses this as the Finance amount and re-distributes across
          sibling expected_cost shares. */}
      <div className="px-4 pt-3 pb-3 border-t border-gray-100">
        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">
            {t('Confirmed total', 'Total confirmado')}
          </span>
          <div className="relative mt-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={confirmedTotalDraft}
              onChange={(e) => setConfirmedTotalDraft(e.target.value)}
              disabled={pending}
              placeholder="0.00"
              aria-label={t('Confirmed order total', 'Total confirmado de la orden')}
              className="h-9 w-full rounded-md border border-gray-200 bg-white pl-6 pr-3 text-sm font-mono font-semibold tabular-nums placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition disabled:opacity-60"
            />
          </div>
          <p className="mt-1 text-[10px] text-gray-400 leading-relaxed">
            {t('Used for inventory spend when the order closes.', 'Se usa para gasto de inventario cuando se cierra la orden.')}
          </p>
        </label>
      </div>

      {error && (
        <p className="px-4 pb-2 text-[11px] text-red-600">{error}</p>
      )}

      {/* CLOSE DECISION — two buttons when skipped lines exist; one
          primary button otherwise. Cancel sits below as quiet text. */}
      <div className="border-t border-gray-100 px-4 py-3">
        {skippedLines.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onConfirm(false)}
              disabled={pending}
              className="h-9 rounded-md border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors"
            >
              {pending ? t('Working…', 'Procesando…') : t('Receive · keep open', 'Recibir · mantener abierta')}
            </button>
            <button
              type="button"
              onClick={() => onConfirm(true)}
              disabled={pending}
              className="h-9 rounded-md bg-gray-900 px-3 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
            >
              {pending ? t('Working…', 'Procesando…') : t('Receive · close order', 'Recibir · cerrar orden')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onConfirm(true)}
            disabled={pending}
            className="w-full h-9 rounded-md bg-gray-900 px-3 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
          >
            {pending ? t('Working…', 'Procesando…') : t('Receive · close order', 'Recibir · cerrar orden')}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="mt-1.5 w-full h-7 text-[11px] font-medium text-gray-500 hover:text-gray-700 disabled:opacity-60 transition-colors"
        >
          {t('Cancel', 'Cancelar')}
        </button>
        {skippedLines.length > 0 && (
          <p className="mt-1.5 text-[10px] text-gray-400 leading-relaxed text-center">
            {t('Keep open leaves skipped lines pending. Close order cancels them.', 'Mantener abierta deja las líneas omitidas pendientes. Cerrar orden las cancela.')}
          </p>
        )}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// OpenLineRow — one open item in the receive panel.
//   • Plain-text name (no link styling, no underline, no pointer
//     cursor). Spec: "should look like a label, not a navigation
//     action."
//   • Compact metadata line: "Ordered X · Received so far 0".
//   • −/n/+ stepper matching the staging-area quantity control.
//   • Inline Remaining on the right, colored by completeness.
//   • Skipped → muted single-line "Skipped for now" + Include link.
//   • Just-received in session → compact green Done row.
// ----------------------------------------------------------------
function OpenLineRow({
  line,
  item,
  isReceivedInSession,
  isIncluded,
  raw,
  pending,
  onToggleSkip,
  onChangeQty,
  onStepQty,
  t,
}: {
  line: RestockOrder
  item: Item | undefined
  isReceivedInSession: boolean
  isIncluded: boolean
  raw: string
  pending: boolean
  onToggleSkip: () => void
  onChangeQty: (value: string) => void
  onStepQty: (delta: number) => void
  t: T
}) {
  const unit = item?.unitOfMeasure ?? ''
  const name = item?.name ?? '—'
  const orderedStr = line.quantity.toFixed(line.quantity % 1 === 0 ? 0 : 2)

  // Just-received this session — quiet green confirmation row.
  if (isReceivedInSession) {
    const recvStr = raw
    return (
      <li className="flex items-center gap-2 text-[11px] font-mono tabular-nums">
        <svg className="w-3 h-3 text-emerald-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <p className="text-gray-700 truncate flex-1 min-w-0">
          <span className="font-medium text-gray-900">{name}</span>
          <span className="text-gray-500"> · {recvStr} / {orderedStr} {unit}</span>
        </p>
        <span className="text-[10px] font-semibold text-emerald-700 flex-shrink-0">{t('Done', 'Listo')}</span>
      </li>
    )
  }

  // Skipped — single muted line + Include text link.
  if (!isIncluded) {
    return (
      <li className="flex items-center gap-2">
        <p className="text-[11px] text-gray-500 truncate flex-1 min-w-0">
          <span className="font-medium text-gray-700">{name}</span>
          <span> · {t('Skipped for now', 'Omitido por ahora')}</span>
        </p>
        <button
          type="button"
          onClick={onToggleSkip}
          disabled={pending}
          className="flex-shrink-0 text-[10px] font-medium text-blue-700 hover:text-blue-800 underline-offset-2 hover:underline transition-colors disabled:opacity-50"
        >
          {t('Include', 'Incluir')}
        </button>
      </li>
    )
  }

  // Active receiving line.
  const parsed = parseFloat(raw)
  const receivingNow = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  const remainingRaw = line.quantity - receivingNow
  const remaining = Math.max(0, remainingRaw)
  const overReceiving = remainingRaw < 0
  const isComplete = remaining === 0 && !overReceiving
  const remainingStr = remaining.toFixed(remaining % 1 === 0 ? 0 : 2)

  return (
    <li>
      {/* Plain-text name + quiet Skip text link. */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900 truncate flex-1 min-w-0">
          {name}
        </p>
        <button
          type="button"
          onClick={onToggleSkip}
          disabled={pending}
          className="flex-shrink-0 text-[10px] font-medium text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline transition-colors disabled:opacity-50"
        >
          {t('Skip', 'Omitir')}
        </button>
      </div>

      {/* Metadata line — muted Ordered + Received so far. */}
      <p className="mt-0.5 text-[11px] text-gray-500 font-mono tabular-nums">
        {t('Ordered', 'Pedido')}{' '}
        <span className="font-mono font-semibold text-gray-700">{orderedStr} {unit}</span>
        <span className="text-gray-300 mx-1.5">·</span>
        {t('Received so far', 'Recibido hasta ahora')}{' '}
        <span className="font-mono font-semibold text-gray-700">0 {unit}</span>
      </p>

      {/* Stepper + Remaining inline. */}
      <div className="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500">{t('Receiving now', 'Recibiendo ahora')}</span>
          <div className="inline-flex items-stretch rounded-md border border-gray-300 bg-white overflow-hidden">
            <button
              type="button"
              onClick={() => onStepQty(-1)}
              disabled={pending}
              aria-label={`${t('Decrease receiving for', 'Disminuir recepción para')} ${name}`}
              className="px-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
              </svg>
            </button>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={raw}
              onChange={(e) => onChangeQty(e.target.value)}
              disabled={pending}
              aria-label={`${t('Receiving now for', 'Recibiendo ahora para')} ${name}`}
              className="h-7 w-14 text-center text-sm font-mono font-semibold tabular-nums text-gray-900 border-x border-gray-300 focus:outline-none focus:bg-blue-50/40 disabled:opacity-60 appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
            />
            <button
              type="button"
              onClick={() => onStepQty(1)}
              disabled={pending}
              aria-label={`${t('Increase receiving for', 'Aumentar recepción para')} ${name}`}
              className="px-2 text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
          <span className="text-[11px] text-gray-500">{unit}</span>
        </div>
        <p className="text-[11px] font-mono tabular-nums">
          <span className="text-gray-500">{t('Remaining', 'Restante')} </span>
          <span className={`font-mono font-semibold ${
            overReceiving
              ? 'text-amber-700'
              : isComplete
                ? 'text-emerald-700'
                : 'text-gray-700'
          }`}>
            {remainingStr} {unit}
          </span>
        </p>
      </div>

      {overReceiving && (
        <p className="mt-1 text-[10px] text-amber-700">
          {t('Receiving more than ordered.', 'Recibiendo más de lo pedido.')}
        </p>
      )}
    </li>
  )
}

// Render a batch's `ordered_at` timestamp as a short, scannable
// label. Uses today/yesterday for recent batches so the eye can
// pattern-match the freshness without parsing a full date.
function formatBatchTimestamp(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  if (sameDay) {
    return `today, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  }
  if (isYesterday) {
    return `yesterday, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ----------------------------------------------------------------
// ClosedOrderCard — one card per closed restock batch. Read-only at
// pilot scope: the batch has finalized, the manager is here to
// verify what shipped vs what was short.
//
// Click the card to expand. Collapsed view: vendor title, status
// pill, "Closed today · 2 items · $82.00", per-line preview (up to
// 4 lines), "+ N more" tail.
//
// Expanded view: full timestamp, final recorded spend, status
// summary (Closed complete vs Closed short), every line with
// Ordered / Received / Short stats, and a one-line Finance note.
// No reopen, no edit, no delete — closed orders are immutable.
//
// Three close sub-states share this card:
//   • All lines received           → "Closed complete", green
//   • Mixed received + canceled    → "Closed short", green pill
//                                     (some receipts hit stock)
//   • All lines canceled-short     → "Closed short", neutral pill
// ----------------------------------------------------------------
function ClosedOrderCard({
  batch,
  itemsById,
  t,
}: {
  batch: RestockBatch
  itemsById: Map<string, Item>
  t: T
}) {
  const [expanded, setExpanded] = useState(false)

  const receivedLines = batch.lines.filter((l) => l.status === 'received')
  const canceledLines = batch.lines.filter((l) => l.status === 'canceled')
  const allReceived = receivedLines.length > 0 && canceledLines.length === 0
  const allCanceled = receivedLines.length === 0 && canceledLines.length > 0

  // Vendor-first title — same convention as pending batches so the
  // family of cards reads consistently.
  const primaryVendor = batch.vendorList[0] ?? null
  const titleText = primaryVendor ? `${primaryVendor} ${t('order', 'orden')}` : t('Restock order', 'Orden de reabastecimiento')
  const vendorOverflow = batch.vendorList.length > 1 ? ` +${batch.vendorList.length - 1}` : ''

  // Status pill semantics:
  //   • Pure all-canceled batch → neutral "Closed" (no receipts hit
  //     stock or Finance — the green tone would mislead).
  //   • Mixed or all-received   → emerald "Closed" (the close
  //     decision finalized stock movement).
  const pillBg = allCanceled ? 'bg-gray-100 text-gray-600' : 'bg-emerald-50 text-emerald-700'
  const pillDot = allCanceled ? 'bg-gray-400' : 'bg-emerald-500'

  // Close-completeness label for the expanded summary line.
  //   complete → every ordered line landed in stock at the ordered
  //              quantity (no shortages)
  //   short    → at least one line either short-received or
  //              canceled-short
  const isOrderComplete =
    !allCanceled &&
    canceledLines.length === 0 &&
    receivedLines.every((l) => {
      const recv = l.receivedQuantity ?? l.quantity
      return recv >= l.quantity
    })
  const closeStatusLabel = isOrderComplete ? t('Closed complete', 'Cerrada completa') : t('Closed short', 'Cerrada con faltante')

  // Close timestamp — most recent received_at across the batch
  // (falls back to canceled_at for all-canceled batches). Drives
  // the "Closed today / Closed Jun 4" subtitle. The Math.max over
  // an empty list would return -Infinity, so we guard with a
  // sentinel before calling; closed batches always have at least
  // one terminal-state line, so the guard is defensive.
  const closedAt = batch.lines.length === 0 ? 0 : Math.max(
    ...batch.lines.map((l) => {
      if (l.receivedAt) return new Date(l.receivedAt).getTime()
      if (l.canceledAt) return new Date(l.canceledAt).getTime()
      return 0
    }),
  )
  const closedLabel = closedAt > 0 ? formatBatchTimestamp(new Date(closedAt).toISOString()) : null

  // Final recorded spend — sum of expected_cost across RECEIVED
  // lines only (canceled lines never fired the Finance bridge). This
  // is what actually hit Finance for this order. Summation runs in
  // integer cents so a $1000.00 ticket split into 333.34/333.33/
  // 333.33 reads back exactly $1000.00 rather than $999.99 from
  // truncation or $1000.0000000001 from float drift.
  const finalSpend = receivedLines.reduce(
    (cents, l) => cents + Math.round((l.expectedCost ?? 0) * 100),
    0,
  ) / 100
  const hasSpend = receivedLines.some((l) => l.expectedCost !== null && (l.expectedCost ?? 0) > 0)

  // Comma-joined item-name preview for the collapsed card. Closed
  // orders read as quiet history; the names alone are enough at a
  // glance — exact ordered/received quantities belong in the
  // expanded details.
  const PREVIEW_LIMIT = 4
  const previewLines = batch.lines.slice(0, PREVIEW_LIMIT)
  const previewOverflow = batch.lines.length - previewLines.length
  const previewNames = previewLines
    .map((l) => itemsById.get(l.inventoryItemId)?.name ?? '—')
    .join(', ')
  const previewSuffix = previewOverflow > 0 ? ` + ${previewOverflow} ${t('more', 'más')}` : ''

  return (
    <li className="rounded-xl border border-gray-200/80 border-t-2 border-t-emerald-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      {/* Clickable collapsed card. Polish: spend leads the meta line
          (it's the most-scanned figure on a receipt), names are a
          single comma-joined string (not a stack of lines), and the
          expand affordance is a single quiet text link at the
          bottom right. */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-label={expanded ? t('Collapse closed order details', 'Contraer detalles de orden cerrada') : t('Expand closed order details', 'Expandir detalles de orden cerrada')}
        className="w-full text-left px-4 py-3.5 hover:bg-gray-50/60 transition-colors"
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-gray-900 truncate flex-1 min-w-0">
            {titleText}
            {vendorOverflow && <span className="text-gray-400 font-normal text-[11px]">{vendorOverflow}</span>}
          </p>
          <span className={`flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${pillBg}`}>
            <span className={`w-1 h-1 rounded-full ${pillDot}`} />
            {t('Closed', 'Cerrada')}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-gray-500">
          {hasSpend && (
            <>
              <span className="text-gray-700 font-mono tabular-nums font-medium">${finalSpend.toFixed(2)}</span>
              <span className="text-gray-300 mx-1">·</span>
            </>
          )}
          {batch.lines.length} {batch.lines.length === 1 ? t('item', 'artículo') : t('items', 'artículos')}
          {closedLabel && (
            <>
              <span className="text-gray-300 mx-1">·</span>
              <span>{t('Closed', 'Cerrada')} {closedLabel}</span>
            </>
          )}
        </p>
        {allCanceled && (
          <p className="mt-0.5 text-[10.5px] text-gray-400">
            {t('No items received — closed short.', 'Sin artículos recibidos — cerrada con faltante.')}
          </p>
        )}
        {!allReceived && !allCanceled && (
          <p className="mt-0.5 text-[10.5px] text-gray-500">
            {receivedLines.length} {t('received · ', 'recibidos · ')}{canceledLines.length} {t('closed short', 'cerrados con faltante')}
          </p>
        )}

        {!expanded && previewNames.length > 0 && (
          <p className="mt-2 text-[11px] text-gray-700 truncate">
            {previewNames}
            {previewSuffix && <span className="text-gray-400">{previewSuffix}</span>}
          </p>
        )}

        {/* Expand affordance — single quiet chevron link. */}
        <div className="mt-2 flex items-center justify-end">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-gray-400">
            {expanded ? t('Hide details', 'Ocultar detalles') : t('View details', 'Ver detalles')}
            <svg
              className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </span>
        </div>
      </button>

      {/* EXPANDED DETAIL — receipt-style read-only review.
            Three breathing-room sections, separated by light
            dividers:
              1. ORDER SUMMARY    → closed-at, status, final total
              2. RECEIVED ITEMS   → per-item card with 3-col stat
              3. FINANCE          → single calm note
            No dots, no inline-string density, no nested admin
            tables. Each item gets a name row + 3-column stat block
            that reads at a glance. */}
      {expanded && (
        <div className="border-t border-gray-100 bg-white">
          {/* 1. ORDER SUMMARY — eyebrow + breathing stack. */}
          <div className="px-5 pt-4 pb-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
              {t('Order Summary', 'Resumen de la orden')}
            </p>
            <div className="mt-2 space-y-1">
              <p className="text-xs text-gray-700">
                {closedLabel ? `${t('Closed', 'Cerrada')} ${closedLabel}` : t('Closed', 'Cerrada')}
              </p>
              <p className="text-xs text-gray-700">
                <span className="text-gray-500">{t('Status: ', 'Estado: ')}</span>
                <span className={`font-semibold ${isOrderComplete ? 'text-emerald-700' : 'text-gray-700'}`}>
                  {closeStatusLabel}
                </span>
              </p>
              {hasSpend && (
                <p className="text-xs text-gray-700">
                  <span className="text-gray-500">{t('Final recorded total: ', 'Total final registrado: ')}</span>
                  <span className="font-semibold font-mono tabular-nums">${finalSpend.toFixed(2)}</span>
                </p>
              )}
            </div>
          </div>

          {/* 2. RECEIVED ITEMS — name row + 3-col stat grid. */}
          <div className="px-5 pt-3 pb-1 border-t border-gray-100">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
              {allCanceled ? t('Order Items', 'Artículos de la orden') : t('Received Items', 'Artículos recibidos')}
            </p>
          </div>
          <ul className="px-5 pb-4 pt-2 space-y-3">
            {batch.lines.map((line) => {
              const item = itemsById.get(line.inventoryItemId)
              const unit = item?.unitOfMeasure ?? ''
              const ordered = line.quantity
              const received = line.status === 'received' ? (line.receivedQuantity ?? line.quantity) : 0
              const shortAmt = Math.max(0, ordered - received)
              const orderedStr = ordered.toFixed(ordered % 1 === 0 ? 0 : 2)
              const receivedStr = received.toFixed(received % 1 === 0 ? 0 : 2)
              const shortStr = shortAmt.toFixed(shortAmt % 1 === 0 ? 0 : 2)

              // Color semantics per spec:
              //   • Received → green when positive, gray when zero
              //   • Short    → amber only when > 0, gray when 0
              //   • Ordered  → always neutral gray (it's just the
              //                intent figure, no good/bad)
              const receivedColor = received > 0 ? 'text-emerald-700' : 'text-gray-400'
              const shortColor = shortAmt > 0 ? 'text-amber-700' : 'text-gray-400'

              return (
                <li key={line.id}>
                  <p className="text-xs font-semibold text-gray-900 truncate">
                    {item?.name ?? '—'}
                  </p>
                  <div className="mt-1.5 grid grid-cols-3 gap-2">
                    <ClosedStat label={t('Ordered', 'Pedido')} value={`${orderedStr} ${unit}`} valueColor="text-gray-700" />
                    <ClosedStat label={t('Received', 'Recibido')} value={`${receivedStr} ${unit}`} valueColor={receivedColor} />
                    <ClosedStat label={t('Short', 'Faltante')} value={`${shortStr} ${unit}`} valueColor={shortColor} />
                  </div>
                  {line.status === 'canceled' && (
                    <p className="mt-1 text-[10px] text-gray-500">{t('Closed short — not received.', 'Cerrado con faltante — no recibido.')}</p>
                  )}
                </li>
              )
            })}
          </ul>

          {/* 3. FINANCE — calm one-liner. No reconciliation surface;
              final-total adjustment + bank verification are deferred
              for pilot. */}
          <div className="px-5 pt-3 pb-4 border-t border-gray-100">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">{t('Finance', 'Finanzas')}</p>
            <p className="mt-2 text-[11px] text-gray-600 leading-relaxed">
              {hasSpend
                ? t('Inventory spend recorded from this ticket.', 'Gasto de inventario registrado desde esta boleta.')
                : t('No inventory spend recorded for this ticket.', 'Sin gasto de inventario registrado para esta boleta.')}
            </p>
          </div>
        </div>
      )}
    </li>
  )
}

// ----------------------------------------------------------------
// ClosedStat — one cell of the 3-column "Ordered / Received / Short"
// stat block inside the expanded Closed Order card. Compact label
// above (small uppercase) and the value below (mono, tabular).
// valueColor lets the caller tint the value semantically without
// re-implementing the layout per use.
// ----------------------------------------------------------------
function ClosedStat({ label, value, valueColor }: { label: string; value: string; valueColor: string }) {
  return (
    <div>
      <p className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-gray-400">
        {label}
      </p>
      <p className={`mt-0.5 text-[11px] font-mono font-semibold tabular-nums ${valueColor}`}>
        {value}
      </p>
    </div>
  )
}

// ----------------------------------------------------------------
// QuickActionDrawer — the lighter drawer treatment for fast,
// single-purpose creation actions (Add item, and future quick-adds
// elsewhere in the app). Intentionally distinct from the larger
// workflow `DrawerShell` so the manager reads it as a quick action
// rather than an unfinished full workflow:
//
//   • narrower (max-w-sm vs DrawerShell's max-w-md)
//   • compact header (py-3.5, smaller title size, blue-tinted eyebrow)
//   • compact body padding, tighter vertical rhythm
//   • compact footer (py-3, h-9 buttons)
//
// The shell only owns chrome — the concrete drawer (e.g.
// QuickAddItemDrawer) supplies the form body and footer buttons.
// Seeded here for the inventory Add Item flow; reuse it for other
// quick creation actions in future passes (do NOT swap workflow
// drawers like Cart / Orders / Item detail onto this shell).
// ----------------------------------------------------------------
function QuickActionDrawer({ eyebrow, title, helper, onClose, children, t }: {
  eyebrow: string
  title: string
  helper?: string
  onClose: () => void
  children: React.ReactNode
  t: T
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <aside
        className="fixed right-0 top-0 bottom-0 w-full max-w-sm bg-white border-l border-gray-200 shadow-xl z-50 flex flex-col"
        aria-label={title}
      >
        <header className="flex-shrink-0 border-b border-gray-100 px-5 py-3.5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-700">
              {eyebrow}
            </p>
            <h2 className="mt-0.5 text-base font-semibold tracking-tight text-gray-900 leading-tight">
              {title}
            </h2>
            {helper && (
              <p className="mt-0.5 text-[11px] text-gray-500 leading-relaxed">{helper}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Close', 'Cerrar')}
            className="flex-shrink-0 text-gray-400 hover:text-gray-600 p-1 -mt-0.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>
        {children}
      </aside>
    </>
  )
}

// Small uppercase group header used inside a QuickActionDrawer to
// segment fields into named bands ("Item", "Tracking", …) without
// introducing card chrome.
function QuickGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">
      {children}
    </p>
  )
}

// ----------------------------------------------------------------
// QuickAddItemDrawer — inventory Add Item flow, mounted on the new
// QuickActionDrawer shell. Two compact groups: Item (name + unit)
// and Tracking (low stock threshold). Form fields, FormData names,
// `createInventoryItem` action, and the auto-close-on-success
// behavior upstream are all unchanged from the previous treatment.
// ----------------------------------------------------------------
function QuickAddItemDrawer({ onClose, t }: { onClose: () => void; t: T }) {
  const [state, action, pending] = useActionState(createInventoryItem, null)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus() }, [])

  const fieldBase =
    'h-9 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition'

  return (
    <QuickActionDrawer
      eyebrow={t('Quick add', 'Agregado rápido')}
      title={t('New inventory item', 'Nuevo artículo de inventario')}
      helper={t('Track stock for an ingredient or supply.', 'Rastrea el stock de un ingrediente o suministro.')}
      onClose={onClose}
      t={t}
    >
      <form action={action} className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Item group */}
          <div className="space-y-2.5">
            <QuickGroupLabel>{t('Item', 'Artículo')}</QuickGroupLabel>
            <div>
              <label htmlFor="ci-name" className="block text-[11px] font-medium text-gray-600 mb-1">
                {t('Name', 'Nombre')}
              </label>
              <input
                ref={nameRef}
                id="ci-name"
                name="name"
                type="text"
                required
                placeholder={t('Mozzarella, Olive oil, Napkins…', 'Mozzarella, aceite de oliva, servilletas…')}
                className={fieldBase}
              />
            </div>
            <div>
              <label htmlFor="ci-unit" className="block text-[11px] font-medium text-gray-600 mb-1">
                {t('Unit of measure', 'Unidad de medida')}
              </label>
              <select
                id="ci-unit"
                name="unit_of_measure"
                defaultValue="units"
                className={fieldBase}
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
          </div>

          {/* Tracking group */}
          <div className="space-y-2.5">
            <QuickGroupLabel>{t('Tracking', 'Seguimiento')}</QuickGroupLabel>
            <div>
              <label htmlFor="ci-threshold" className="block text-[11px] font-medium text-gray-600 mb-1">
                {t('Low stock threshold', 'Umbral de bajo stock')}
              </label>
              <input
                id="ci-threshold"
                name="low_stock_threshold"
                type="number"
                min="0"
                step="0.01"
                defaultValue="5"
                className={`${fieldBase} font-mono`}
              />
            </div>
          </div>

          {state?.error && (
            <p className="text-[11px] text-red-600">{state.error}</p>
          )}
        </div>

        <div className="flex-shrink-0 border-t border-gray-100 px-5 py-3 bg-white flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-9 rounded-lg border border-gray-200 px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {t('Cancel', 'Cancelar')}
          </button>
          <button
            type="submit"
            disabled={pending}
            className="flex-1 h-9 rounded-lg bg-gray-900 px-3 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
          >
            {pending ? t('Creating…', 'Creando…') : t('Create item', 'Crear artículo')}
          </button>
        </div>
      </form>
    </QuickActionDrawer>
  )
}


// ----------------------------------------------------------------
// Default restock quantity for a quick-add. Uses the threshold as
// the floor — managers can refine in the drawer if they want a
// bigger or smaller order. Conservative starting point that always
// produces a plausible draft, even when stock isn't tracked yet.
// ----------------------------------------------------------------
function defaultRestockQty(item: Item): number {
  const t = item.threshold || 1
  return Math.max(t, 1)
}

// Render a yyyy-mm-dd date as a short, locale-friendly label
// ("Jun 5"). Strips time-zone ambiguity by treating the value as a
// plain calendar date — the database column is `date`, not
// `timestamptz`, so we never want time-zone math here.
function formatRestockDate(yyyymmdd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd)
  if (!m) return yyyymmdd
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ----------------------------------------------------------------
// ItemRow — replenishment-discovery row. Reads left-to-right:
//
//   [stripe] Item name                       Est. stock  • Status  [cart]
//            type · Threshold N unit
//
// Left:   thin status-colored stripe (red/amber/green/gray) for
//         at-a-glance scanning. Item name on top; supporting meta
//         line carries type context + the threshold target.
// Right:  one tight cluster — current stock value (the strongest
//         scanning anchor on the right) → status text → cart
//         action. Reads as "where we are now → next move."
//
// Selected: bg + stripe both shift blue so the row open in the
// drawer is unmistakable without becoming loud.
// ----------------------------------------------------------------
function ItemRow({ item, draftLine, selected, onOpen, t }: {
  item: Item
  draftLine: RestockOrder | null
  selected: boolean
  onOpen: () => void
  t: T
}) {
  // Display-clamped stock. The manager-facing UI never surfaces
  // negative values — they're confusing in the action context
  // ("if I receive 20 oz, do I land at 20 or 16?"). Internally
  // item.estimated stays raw so the depletion-vs-count drift
  // remains available for future accuracy intelligence; visually
  // we clamp at zero everywhere on this page.
  const displayEstimated = item.estimated !== null
    ? Math.max(0, item.estimated)
    : null
  const isOverdrawn = item.estimated !== null && item.estimated < 0

  // Stock-value color comes off the display value, not the raw
  // estimate. 0 reads red (out), low reads amber, healthy stays
  // gray-900. The red color carries the urgency; the negative sign
  // is gone from the surface.
  const stockColor =
    displayEstimated === null ? 'text-gray-300'
      : displayEstimated === 0 ? 'text-red-600'
        : item.status === 'low' ? 'text-amber-700'
          : 'text-gray-900'
  const typeLabel = item.recipeLinks > 0
    ? `${t('Used in', 'Usado en')} ${item.recipeLinks} ${item.recipeLinks > 1 ? t('recipes', 'recetas') : t('recipe', 'receta')}`
    : t('Standalone item', 'Artículo independiente')

  // Left-edge stripe — status semantics by default, swaps to blue
  // when the row is selected so "this is the row I'm inspecting"
  // reads even faster than the status itself.
  const stripeClass = selected
    ? 'bg-blue-500'
    : item.status === 'out'      ? 'bg-red-500'
      : item.status === 'low'    ? 'bg-amber-500'
        : item.status === 'ok'   ? 'bg-green-500'
          : 'bg-gray-300'

  // Inline status — colored dot + label, no pill chrome.
  const statusTextClass =
    item.status === 'out'      ? 'text-red-600'
      : item.status === 'low'  ? 'text-amber-600'
        : item.status === 'ok' ? 'text-green-700'
          : 'text-gray-500'
  const statusDotClass =
    item.status === 'out'      ? 'bg-red-500'
      : item.status === 'low'  ? 'bg-amber-500'
        : item.status === 'ok' ? 'bg-green-500'
          : 'bg-gray-400'
  const statusLabel = translateStatusLabel(item.status, t)

  return (
    <tr
      onClick={onOpen}
      className={`group cursor-pointer transition-all ${
        selected
          // Selected: blue tint + 2px blue inset ring so the row
          // open in the drawer is unmistakable.
          ? 'bg-blue-50 shadow-[inset_0_0_0_2px_rgba(59,130,246,0.30)]'
          // Calm neutral baseline. Urgency comes from the stock
          // number, the status text, the left stripe, and the
          // filter pills — not from the row background. Hover lifts
          // the row gently with a tiny inset line so it reads as a
          // discrete inspectable object.
          : 'hover:bg-gray-50 hover:shadow-[inset_0_0_0_1px_rgba(15,23,42,0.04)]'
      }`}
    >
      {/* Item — left-edge stripe + name + meta line. py-4 (bumped
          from py-3.5) gives each row a touch more vertical
          presence so the list reads as objects, not lines. */}
      <td className="relative px-6 py-4">
        <span
          className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripeClass}`}
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate group-hover:text-blue-700 transition-colors">
            {item.name}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500 truncate">
            <span>{typeLabel}</span>
            <span className="text-gray-300 mx-1.5">·</span>
            <span>
              {t('Reorder at', 'Reordenar en')}{' '}
              <span className="font-mono tabular-nums text-gray-600">
                {item.threshold.toFixed(2)}
              </span>{' '}
              {item.unitOfMeasure}
            </span>
          </p>
        </div>
      </td>

      {/* Right cluster — Est. stock anchors the scan, then status,
          then the cart action. Tight padding (pl-2 pr-1.5 / px-1.5 /
          pl-1.5 pr-4) collapses the gaps between them so they read
          as one decision zone rather than three independent
          columns. */}
      <td className="pl-2 pr-1.5 py-4 text-right whitespace-nowrap">
        {displayEstimated !== null ? (
          <span
            className="inline-flex items-baseline gap-1 font-mono"
            title={isOverdrawn ? t('Usage has passed the last count. Receiving will reset this item from zero.', 'El uso ha pasado el último conteo. Al recibir, este artículo se reiniciará desde cero.') : undefined}
          >
            <span className={`text-base font-bold font-mono tabular-nums ${stockColor}`}>
              {displayEstimated.toFixed(2)}
            </span>
            <span className="text-[10px] font-medium text-gray-400">{item.unitOfMeasure}</span>
          </span>
        ) : (
          <span className="text-gray-300 text-xs">—</span>
        )}
      </td>

      <td className="px-1.5 py-4 whitespace-nowrap">
        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${statusTextClass}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${statusDotClass}`} />
          {statusLabel}
        </span>
      </td>

      {/* Restock action — compact neutral affordance on every row.
          The earlier "urgent rows get a dark filled button" pass
          was rolled back: urgency is communicated by the stock
          number, status text, and left stripe; the action stays
          calm so the page reads as operational rather than alarmed.
          The "In cart · qty" state is preserved for staged drafts. */}
      <td className="pl-1.5 pr-4 py-4 text-right" onClick={(e) => e.stopPropagation()}>
        {draftLine ? (
          <button
            type="button"
            onClick={onOpen}
            title={`${t('In restock cart · ', 'En carrito de reabastecimiento · ')}${draftLine.quantity} ${item.unitOfMeasure} ${t('— click to edit', '— haz clic para editar')}`}
            aria-label={`${t('In restock cart · ', 'En carrito de reabastecimiento · ')}${draftLine.quantity} ${item.unitOfMeasure} ${t('— click to edit', '— haz clic para editar')}`}
            className="inline-flex items-center gap-1.5 h-8 rounded-md bg-blue-50 border border-blue-200 text-blue-700 px-2 hover:bg-blue-100 group-hover:border-blue-300 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span className="text-[10px] font-semibold font-mono tabular-nums">
              {t('In cart · ', 'En carrito · ')}{draftLine.quantity % 1 === 0
                ? draftLine.quantity.toFixed(0)
                : draftLine.quantity.toFixed(2)}
            </span>
          </button>
        ) : (
          <form action={quickAddToOrder} className="inline-block">
            <input type="hidden" name="inventory_item_id" value={item.id} />
            <input type="hidden" name="quantity" value={defaultRestockQty(item)} />
            <button
              type="submit"
              title={t('Add to restock', 'Agregar a reabastecimiento')}
              aria-label={t('Add to restock', 'Agregar a reabastecimiento')}
              className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-gray-900 hover:border-gray-300 group-hover:border-gray-300 group-hover:text-gray-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            </button>
          </form>
        )}
      </td>
    </tr>
  )
}

// Surface restock receipts as "Restock received · {vendor}" rather
// than the generic "Purchase · Restock received · {vendor}" the raw
// transaction type would produce. markRestockReceived stamps the
// reference_note with a stable `Restock received` prefix; when we
// see that on a `purchase` transaction we promote the prefix into
// the label and pass the vendor remainder through as the note. Any
// other purchase transaction keeps its generic label, so manual
// non-restock receipts still read normally.
function receiptAdjustedLabel(
  type: string,
  defaultLabel: string,
  note: string | null,
  t: T,
): { label: string; note: string | null } {
  if (type !== 'purchase' || !note) return { label: defaultLabel, note }
  const trimmed = note.trim()
  if (!trimmed.startsWith('Restock received')) return { label: defaultLabel, note }
  // Strip the leading "Restock received" + optional " · " separator
  const remainder = trimmed.slice('Restock received'.length).replace(/^\s*[·\-—]\s*/, '').trim()
  return { label: t('Restock received', 'Reabastecimiento recibido'), note: remainder.length > 0 ? remainder : null }
}

// ----------------------------------------------------------------
// ActivityFeed — compact supporting feed (replaces secondary table)
// ----------------------------------------------------------------
function ActivityFeed({ transactions, t }: { transactions: Transaction[]; t: T }) {
  // `initial_count` and `count` come from inventory_counts (merged
  // server-side). All other types come from inventory_transactions.
  const styleFor: Record<string, { bg: string; text: string; glyph: string; label: string; showSign: boolean }> = {
    purchase:      { bg: 'bg-green-50',  text: 'text-green-700',  glyph: '+', label: t('Purchase', 'Compra'),       showSign: true  },
    waste:         { bg: 'bg-red-50',    text: 'text-red-700',    glyph: '−', label: t('Waste', 'Desperdicio'),     showSign: true  },
    usage:         { bg: 'bg-blue-50',   text: 'text-blue-700',   glyph: '−', label: t('Usage', 'Uso'),             showSign: true  },
    count:         { bg: 'bg-gray-100',  text: 'text-gray-600',   glyph: '◉', label: t('Count', 'Conteo'),          showSign: false },
    initial_count: { bg: 'bg-emerald-50', text: 'text-emerald-700', glyph: '✦', label: t('Initial count', 'Conteo inicial'), showSign: false },
  }

  const visibleCount = Math.min(ACTIVITY_LIMIT, transactions.length)
  return (
    <section className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-900">{t('Activity', 'Actividad')}</p>
          <h2 className="text-base font-semibold tracking-tight text-gray-900 mt-1">{t('Recent movements', 'Movimientos recientes')}</h2>
        </div>
        <span className="flex-shrink-0 text-[10px] text-gray-400">{t('Last', 'Últimos')} {visibleCount}</span>
      </div>
      <ul className="divide-y divide-gray-50">
        {transactions.slice(0, ACTIVITY_LIMIT).map((tx) => {
          const style = styleFor[tx.type] ?? { bg: 'bg-gray-100', text: 'text-gray-600', glyph: '·', label: tx.type, showSign: false }
          const isInitial = tx.type === 'initial_count'
          const qtyClass = !style.showSign
            ? (isInitial ? 'text-emerald-700' : 'text-gray-600')
            : tx.qty > 0 ? 'text-green-700'
            : tx.qty < 0 ? 'text-red-600'
            : 'text-gray-600'
          const qtyPrefix = style.showSign && tx.qty > 0 ? '+' : ''
          const { label, note } = receiptAdjustedLabel(tx.type, style.label, tx.note, t)
          return (
            <li key={tx.id} className="flex items-center gap-3 px-5 py-2.5">
              <span className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${style.bg} ${style.text}`}>
                {style.glyph}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-700 truncate">
                  <span className="font-medium text-gray-900">{tx.itemName}</span>
                  <span className={`${isInitial ? 'text-emerald-700 font-semibold' : 'text-gray-400'}`}> · {label}</span>
                  {note && <span className="text-gray-400"> · {note}</span>}
                </p>
              </div>
              <span className={`text-xs font-mono font-semibold tabular-nums ${qtyClass}`}>
                {qtyPrefix}{tx.qty.toFixed(2)}
              </span>
              <span className="text-[10px] text-gray-400 w-12 text-right font-mono tabular-nums">
                {new Date(tx.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ----------------------------------------------------------------
// ItemMovementRow — single row in the per-item Movement list
// inside the selected-item rail. Compact rendering: type glyph +
// label + signed qty + date. Item name is intentionally omitted
// because the row already lives inside that item's workspace.
// ----------------------------------------------------------------
function ItemMovementRow({ tx, unit, t }: { tx: Transaction; unit: string; t: T }) {
  // Style map shared with ActivityFeed below so per-item and
  // global feeds stay visually consistent.
  //
  // Color semantics:
  //   purchase  → green   (positive stock movement, e.g. restock received)
  //   waste     → red     (negative stock movement, manual discard)
  //   usage     → red     (negative stock movement, sales depletion —
  //                        same direction as waste; the label
  //                        distinguishes the cause)
  //   count     → slate   (neutral correction event)
  //   initial   → emerald (the founding event that started tracking)
  const styleFor: Record<string, { bg: string; text: string; glyph: string; label: string; showSign: boolean }> = {
    purchase:      { bg: 'bg-green-50',   text: 'text-green-700',   glyph: '+', label: t('Purchase', 'Compra'),       showSign: true  },
    waste:         { bg: 'bg-red-50',     text: 'text-red-700',     glyph: '−', label: t('Waste', 'Desperdicio'),     showSign: true  },
    usage:         { bg: 'bg-red-50',     text: 'text-red-700',     glyph: '−', label: t('Usage', 'Uso'),             showSign: true  },
    count:         { bg: 'bg-slate-100',  text: 'text-slate-600',   glyph: '◉', label: t('Count', 'Conteo'),          showSign: false },
    initial_count: { bg: 'bg-emerald-50', text: 'text-emerald-700', glyph: '✦', label: t('Initial count', 'Conteo inicial'), showSign: false },
  }
  const style = styleFor[tx.type] ?? { bg: 'bg-slate-100', text: 'text-slate-600', glyph: '·', label: tx.type, showSign: false }
  const isInitial = tx.type === 'initial_count'
  const qtyClass = !style.showSign
    ? (isInitial ? 'text-emerald-700' : 'text-slate-600')
    : tx.qty > 0 ? 'text-green-700'
      : tx.qty < 0 ? 'text-red-600'
        : 'text-slate-600'
  const qtyPrefix = style.showSign && tx.qty > 0 ? '+' : ''
  const { label, note } = receiptAdjustedLabel(tx.type, style.label, tx.note, t)

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${style.bg} ${style.text}`}>
        {style.glyph}
      </span>
      <p className="text-[11px] text-gray-700 truncate flex-1 min-w-0">
        <span className={isInitial ? 'text-emerald-700 font-semibold' : 'text-gray-700 font-medium'}>{label}</span>
        {note && <span className="text-gray-400"> · {note}</span>}
      </p>
      <span className={`text-[11px] font-mono font-semibold tabular-nums ${qtyClass}`}>
        {qtyPrefix}{tx.qty.toFixed(2)}
        <span className="text-[9px] text-gray-400 font-normal ml-0.5">{unit}</span>
      </span>
      <span className="text-[10px] text-gray-400 w-10 text-right font-mono tabular-nums">
        {new Date(tx.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
      </span>
    </li>
  )
}

// ----------------------------------------------------------------
// RestockOrderRow — staged item card inside the item drawer's
// Replenish section. Two flavors:
//
//   draft   → "Staged" pill, qty stat, vendor/cost/date subtitle,
//             Cancel link. Bridging copy reminds the manager this
//             will move when the next restock order is created;
//             placement itself happens in the cart's bulk action.
//   ordered → "Awaiting receipt" pill, qty stat, "Mark received"
//             dark commit + Cancel link. Mark received hits the
//             same server action the batched receive panel uses,
//             so partial receipt isn't supported here — full
//             received qty is recorded.
// ----------------------------------------------------------------
function RestockOrderRow({ order, unit, t }: { order: RestockOrder; unit: string; t: T }) {
  const [receivedState, receivedAction, receivedPending] = useActionState(markRestockReceived, null)
  const [cancelState, cancelAction, cancelPending] = useActionState(cancelRestockOrder, null)

  const isDraft = order.status === 'draft'
  const statusLabel = isDraft ? t('Staged', 'Preparado') : t('Awaiting receipt', 'Esperando recepción')
  const statusClass = isDraft
    ? 'bg-gray-100 text-gray-700'
    : 'bg-amber-50 text-amber-700'
  const statusDot = isDraft ? 'bg-gray-400' : 'bg-amber-500'

  const detailParts = [
    order.vendor,
    order.expectedCost !== null ? `~$${order.expectedCost.toFixed(2)}` : null,
    order.expectedDate ? `${t('Expected', 'Esperada')} ${formatRestockDate(order.expectedDate)}` : null,
    order.notes,
  ].filter(Boolean)
  const detailLine = detailParts.length > 0
    ? detailParts.join(' · ')
    : t('No vendor or cost recorded', 'Sin proveedor ni costo registrado')

  const error = receivedState?.error ?? cancelState?.error

  return (
    <li className="rounded-lg border border-gray-200 bg-white px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${statusClass}`}>
            <span className={`w-1 h-1 rounded-full ${statusDot}`} />
            {statusLabel}
          </span>
          <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed truncate">
            {detailLine}
          </p>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">
            {isDraft ? t('Staged qty', 'Cant. preparada') : t('Ordered', 'Pedida')}
          </p>
          <p className="mt-0.5 text-base font-semibold font-mono tabular-nums text-gray-900">
            {order.quantity.toFixed(2)}
            <span className="ml-1 text-[10px] font-sans font-normal text-gray-400">{unit}</span>
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        {isDraft ? (
          <p className="flex-1 text-[10px] text-gray-400 leading-relaxed">
            {t('Moves with your next restock order.', 'Se mueve con tu próxima orden de reabastecimiento.')}
          </p>
        ) : (
          <form action={receivedAction} className="flex-1">
            <input type="hidden" name="order_id" value={order.id} />
            <button
              type="submit"
              disabled={receivedPending}
              className="w-full rounded-md bg-gray-900 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
            >
              {receivedPending ? t('Receiving…', 'Recibiendo…') : t('Mark received', 'Marcar recibido')}
            </button>
          </form>
        )}

        <form action={cancelAction}>
          <input type="hidden" name="order_id" value={order.id} />
          <button
            type="submit"
            disabled={cancelPending}
            className="text-[11px] font-medium text-gray-500 hover:text-red-600 disabled:opacity-60 px-1 transition-colors"
          >
            {cancelPending ? '…' : t('Remove', 'Quitar')}
          </button>
        </form>
      </div>

      {error && (
        <p className="mt-1.5 text-[11px] text-red-600">{error}</p>
      )}
    </li>
  )
}

// ----------------------------------------------------------------
// ItemDestructiveSection — drawer footer block for Archive / Delete.
// Replaces the old row-level kebab menu so the list stays focused
// on stock + ordering. Same conventions as Staffing's destructive
// confirms: text-only at rest, expand-into-confirm on click.
// ----------------------------------------------------------------
function ItemDestructiveSection({ item, t }: { item: Item; t: T }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  // archiveInventoryItem is now useActionState-shaped so the inline
  // archive button can surface the new "blocked because recipe-linked"
  // error returned by the action's recipe-link guard.
  const [archiveState, archiveAction, archivePending] = useActionState(archiveInventoryItem, null)

  const handleDelete = async () => {
    setDeletePending(true)
    setDeleteError(null)
    const fd = new FormData()
    fd.set('item_id', item.id)
    const result = await deleteInventoryItem(fd)
    if (result?.error) {
      setDeleteError(result.error)
      setDeletePending(false)
    }
    // On success the page revalidates and the drawer closes via the
    // selectedId-not-found effect upstream — no local cleanup needed.
  }

  return (
    <div className="pt-4 mt-2 border-t border-gray-100">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 mb-2">{t('Manage', 'Administrar')}</p>

      <div className="flex items-center gap-3">
        <form action={archiveAction}>
          <input type="hidden" name="item_id" value={item.id} />
          <button
            type="submit"
            disabled={archivePending}
            className="text-[11px] font-medium text-gray-600 hover:text-gray-900 disabled:opacity-60"
          >
            {archivePending ? t('Archiving…', 'Archivando…') : t('Archive item', 'Archivar artículo')}
          </button>
        </form>

        <span className="text-gray-200">·</span>

        {item.recipeLinks > 0 ? (
          <span
            className="text-[11px] text-gray-300"
            title={t('Linked to a recipe. Unlink from the recipe first, or archive instead.', 'Vinculado a una receta. Desvincula de la receta primero, o archiva en su lugar.')}
          >
            {t('Delete unavailable', 'Eliminación no disponible')}
          </span>
        ) : !confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="text-[11px] font-medium text-red-600 hover:text-red-700"
          >
            {t('Delete item', 'Eliminar artículo')}
          </button>
        ) : (
          <span className="text-[11px] text-gray-400">{t('Confirm below', 'Confirmar abajo')}</span>
        )}
      </div>

      {/* Archive error — the action's recipe-link guard surfaces here
          when the user tries to archive an item that's still in an
          active recipe. Tells them to remove the recipe link first
          instead of silently archiving into the invisible state. */}
      {archiveState?.error && (
        <p className="mt-2 text-[11px] text-amber-700 leading-relaxed">{archiveState.error}</p>
      )}

      {confirmDelete && item.recipeLinks === 0 && (
        <div className="mt-2.5 rounded-lg border border-red-200 bg-red-50/60 p-3">
          <p className="text-xs font-semibold text-red-900">{t('Delete', '¿Eliminar')} {item.name}?</p>
          <p className="mt-0.5 text-[11px] text-red-700/90 leading-relaxed">
            {t('This is permanent. Any past counts and stock transactions for this item will also be removed. Use Archive if you might restore it later.', 'Esto es permanente. Cualquier conteo y movimiento de stock anterior para este artículo también se eliminará. Usa Archivar si podrías restaurarlo después.')}
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={handleDelete}
              disabled={deletePending}
              className="h-9 rounded-md border border-red-300 bg-white px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60 transition-colors"
            >
              {deletePending ? t('Deleting…', 'Eliminando…') : t('Confirm delete', 'Confirmar eliminación')}
            </button>
            <button
              type="button"
              onClick={() => { setConfirmDelete(false); setDeleteError(null) }}
              className="text-[11px] text-gray-500 hover:text-gray-700"
            >
              {t('Cancel', 'Cancelar')}
            </button>
          </div>
          {deleteError && <p className="mt-1.5 text-[11px] text-red-700">{deleteError}</p>}
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// ItemWorkspaceDrawer — item-specific working surface, opened from
// the inventory list row click on any viewport.
//
// Drawer pattern is the sibling of Staffing's edit/add drawers
// (DrawerShell-style chrome) so the two pillars read as the same
// product family. Sectioned body keeps the workflow legible:
//
//   1. Header — name + status + type pills (both pills are
//      first-class so standalone items don't read as second-class)
//   2. Stock — current estimate + threshold
//   3. Update count — primary inventory action
//   4. Movement — last few transactions for THIS item, item-scoped
//
// Future replenishment / restock sections slot in cleanly between
// Update count and Movement (or below) without redesigning the
// drawer.
//
// `transactions` is the page-level activity feed; the drawer
// filters it down to just this item via `inventoryItemId`.
// ----------------------------------------------------------------
function ItemWorkspaceDrawer({ item, transactions, restockOrders, onClose, t }: {
  item: Item
  transactions: Transaction[]
  restockOrders: RestockOrder[]
  onClose: () => void
  t: T
}) {
  const st = STATUS[item.status]
  const [threshold, setThreshold] = useState(item.threshold.toString())
  const [thresholdSaving, setThresholdSaving] = useState(false)
  const [thresholdSaved, setThresholdSaved] = useState(false)
  const [thresholdEditing, setThresholdEditing] = useState(false)

  // ---- Identity edit (name + unit_of_measure) ----
  // Toggled from the header; opens a small form below the header
  // so the user can rename an item and change its unit without
  // leaving the drawer. Optimistic dirty state gates Save.
  const [identityEditing, setIdentityEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(item.name)
  const [unitDraft, setUnitDraft] = useState(item.unitOfMeasure)
  const [identitySaving, setIdentitySaving] = useState(false)
  const [identityError, setIdentityError] = useState<string | null>(null)
  // Reset drafts whenever the drawer opens on a different item, or
  // when the parent prop refreshes with the saved values.
  useEffect(() => {
    setNameDraft(item.name)
    setUnitDraft(item.unitOfMeasure)
    setIdentityEditing(false)
    setIdentityError(null)
  }, [item.id, item.name, item.unitOfMeasure])
  const identityDirty =
    nameDraft.trim().length > 0 &&
    unitDraft.trim().length > 0 &&
    (nameDraft.trim() !== item.name || unitDraft.trim() !== item.unitOfMeasure)
  const saveIdentity = async () => {
    if (!identityDirty || identitySaving) return
    setIdentitySaving(true)
    setIdentityError(null)
    const fd = new FormData()
    fd.set('item_id', item.id)
    fd.set('name', nameDraft.trim())
    fd.set('unit_of_measure', unitDraft.trim())
    const r = await updateInventoryItem(fd)
    setIdentitySaving(false)
    if ('error' in r) {
      setIdentityError(r.error)
      return
    }
    setIdentityEditing(false)
    // Parent will re-render with the new prop values via revalidate.
  }

  // Count form (uses existing createInventoryCount server action)
  const [countState, countAction, countPending] = useActionState(createInventoryCount, null)

  useEffect(() => {
    setThreshold(item.threshold.toString())
    setThresholdSaved(false)
  }, [item.id, item.threshold])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const thresholdDirty = parseFloat(threshold || '0') !== item.threshold

  const saveThreshold = async () => {
    if (!thresholdDirty || thresholdSaving) return
    setThresholdSaving(true)
    const fd = new FormData()
    fd.set('item_id', item.id)
    fd.set('low_stock_threshold', threshold)
    await updateThreshold(fd)
    setThresholdSaving(false)
    setThresholdSaved(true)
    setTimeout(() => setThresholdSaved(false), 1600)
  }

  const hasCount = item.lastCount !== null
  const countCtaLabel = hasCount ? t('Update stock count', 'Actualizar conteo de stock') : t('Record first count', 'Registrar primer conteo')

  // Item type — equally first-class for both variants. Recipe-linked
  // items get the count surfaced; standalone items are simply
  // labeled as such, never as "missing" metadata.
  const isRecipeLinked = item.recipeLinks > 0
  const typeLabel = isRecipeLinked
    ? `${t('Recipe-linked', 'Vinculado a receta')} · ${item.recipeLinks}`
    : t('Standalone', 'Independiente')
  const typeTitle = isRecipeLinked
    ? `${t('Used in', 'Usado en')} ${item.recipeLinks} ${item.recipeLinks > 1 ? t('recipes', 'recetas') : t('recipe', 'receta')}`
    : t('Standalone item — not linked to any recipe', 'Artículo independiente — no vinculado a ninguna receta')

  // Item-scoped movement — all transactions for THIS item that the
  // page-level feed surfaced (capped at 20 server-side). The drawer
  // paginates this list 5 at a time so Recent Movement stays
  // compact even on chatty items. movementPage resets to 1 when
  // the manager switches inspected items.
  const allItemMovement = transactions.filter(
    (tx) => tx.inventoryItemId === item.id,
  )
  const MOVEMENT_PAGE_SIZE = 5
  const totalMovementPages = Math.max(
    1,
    Math.ceil(allItemMovement.length / MOVEMENT_PAGE_SIZE),
  )
  const [movementPage, setMovementPage] = useState(1)
  useEffect(() => {
    setMovementPage(1)
  }, [item.id])
  const safeMovementPage = Math.min(movementPage, totalMovementPages)
  const movementStart = (safeMovementPage - 1) * MOVEMENT_PAGE_SIZE
  const visibleMovement = allItemMovement.slice(
    movementStart,
    movementStart + MOVEMENT_PAGE_SIZE,
  )

  // Display-clamped stock — manager-facing surfaces never show
  // negative values. The raw item.estimated can still be negative
  // (depletion drift past the last count) and the page-level
  // calculation still computes it that way for future intelligence,
  // but visually we clamp at zero here too. `isOverdrawn` drives
  // the one drift note inside the Stock Status card; no other
  // surface in the drawer repeats it.
  const displayEstimated = item.estimated !== null
    ? Math.max(0, item.estimated)
    : null
  const isOverdrawn = item.estimated !== null && item.estimated < 0

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <aside
        className="fixed right-0 top-0 bottom-0 w-full max-w-md md:max-w-lg lg:max-w-md bg-white border-l border-gray-200 shadow-xl z-50 flex flex-col"
        aria-label={t(`${item.name} workspace`, `espacio de trabajo de ${item.name}`)}
      >
        {/* Sticky header — same family as Staffing's drawers. The
            type/recipe pill carries first-class context for both
            recipe-linked ingredients and standalone supplies. */}
        <header className="flex-shrink-0 border-b border-gray-100 px-6 py-5 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400">{t('Inventory item', 'Artículo de inventario')}</p>
            <div className="mt-1 flex items-baseline gap-2">
              <h2 className="text-lg font-semibold tracking-tight text-gray-900 leading-tight truncate">{item.name}</h2>
              {!identityEditing && (
                <button
                  type="button"
                  onClick={() => setIdentityEditing(true)}
                  className="text-[10px] font-semibold text-gray-500 hover:text-gray-900 flex-shrink-0"
                >
                  {t('Edit', 'Editar')}
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${st.color}`}>
                <span className={`w-1 h-1 rounded-full ${st.dot}`} />
                {translateStatusLabel(item.status, t)}
              </span>
              <span
                className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600"
                title={typeTitle}
              >
                {typeLabel}
              </span>
            </div>

            {/* Inline identity editor. Opens under the header when
                the owner hits Edit; two fields (name + unit) with
                Save/Cancel. Optimistic dirty check keeps Save
                disabled until something actually changed. */}
            {identityEditing && (
              <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-2">
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 block mb-1">
                    {t('Name', 'Nombre')}
                  </label>
                  <input
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    className="w-full text-sm rounded-md border border-gray-300 bg-white px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-gray-400"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500 block mb-1">
                    {t('Unit of measure', 'Unidad de medida')}
                  </label>
                  <input
                    type="text"
                    value={unitDraft}
                    onChange={(e) => setUnitDraft(e.target.value)}
                    placeholder="units, kg, lbs, oz, liters…"
                    className="w-full text-sm rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono focus:outline-none focus:ring-2 focus:ring-gray-400"
                  />
                </div>
                {identityError && (
                  <p className="text-[11px] text-red-600">{identityError}</p>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={saveIdentity}
                    disabled={!identityDirty || identitySaving}
                    className="h-8 rounded-md bg-gray-900 px-3 text-xs font-semibold text-white hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {identitySaving ? t('Saving…', 'Guardando…') : t('Save', 'Guardar')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNameDraft(item.name)
                      setUnitDraft(item.unitOfMeasure)
                      setIdentityError(null)
                      setIdentityEditing(false)
                    }}
                    disabled={identitySaving}
                    className="text-[11px] text-gray-500 hover:text-gray-700 disabled:opacity-60"
                  >
                    {t('Cancel', 'Cancelar')}
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Close', 'Cerrar')}
            className="flex-shrink-0 text-gray-400 hover:text-gray-600 p-1 -mt-0.5"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* ---- STOCK STATUS — compact 3-column card. Three stats
                 across (Current stock | Reorder at | Last count)
                 with status pill in the card header. Update stock
                 count is merged inline as a collapsed <details>
                 inside the same card so stock truth + correction
                 sit in one band. A status-tinted 2px top border
                 echoes the status pill so the card reads its
                 bucket at a glance without tinting the body. */}
          <div className={`rounded-xl border border-gray-200/80 ${
            item.status === 'out' ? 'border-t-2 border-t-red-300'
              : item.status === 'low' ? 'border-t-2 border-t-amber-300'
                : item.status === 'ok' ? 'border-t-2 border-t-emerald-300'
                  : ''
          } bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden`}>
            <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-gray-900">{t('Stock Status', 'Estado del stock')}</p>
              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${st.color}`}>
                <span className={`w-1 h-1 rounded-full ${st.dot}`} />
                {translateStatusLabel(item.status, t)}
              </span>
            </div>

            {/* X | X | X stat row — Current stock, Reorder at,
                Last count. Each cell holds an uppercase eyebrow
                + a mono numeric value. Reorder at carries the
                inline Edit affordance for the threshold; Last
                count has a tiny "Manual" sub-line. */}
            <div className="px-4 py-3 grid grid-cols-3 gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-400">{t('Current stock', 'Stock actual')}</p>
                <p className={`mt-1 text-base font-semibold font-mono tabular-nums ${
                  displayEstimated === null ? 'text-gray-300'
                    : displayEstimated === 0 ? 'text-red-600'
                      : item.status === 'low' ? 'text-amber-700'
                        : 'text-gray-900'
                }`}>
                  {displayEstimated !== null ? displayEstimated.toFixed(2) : '—'}
                  <span className="ml-1 text-[10px] font-sans font-normal text-gray-400">{item.unitOfMeasure}</span>
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-400">{t('Reorder at', 'Reordenar en')}</p>
                {thresholdEditing ? (
                  <div className="mt-1 flex items-center gap-1">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={threshold}
                      onChange={(e) => setThreshold(e.target.value)}
                      autoFocus
                      className="w-16 h-7 rounded-md border border-gray-200 bg-white px-1.5 text-xs font-mono font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        await saveThreshold()
                        setThresholdEditing(false)
                      }}
                      disabled={!thresholdDirty || thresholdSaving}
                      className="text-[10px] font-semibold text-gray-700 hover:text-gray-900 disabled:opacity-40"
                    >
                      {thresholdSaving ? '…' : t('Save', 'Guardar')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setThreshold(item.threshold.toString())
                        setThresholdEditing(false)
                      }}
                      className="text-[10px] font-medium text-gray-400 hover:text-gray-600"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <p className="mt-1 text-base font-semibold font-mono tabular-nums text-gray-900">
                    {item.threshold.toFixed(2)}
                    <span className="ml-1 text-[10px] font-sans font-normal text-gray-400">{item.unitOfMeasure}</span>
                    {thresholdSaved ? (
                      <span className="ml-1.5 text-[10px] font-semibold text-emerald-600 font-sans">✓</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setThresholdEditing(true)}
                        className="ml-1.5 text-[10px] font-semibold text-gray-500 hover:text-gray-900 font-sans"
                      >
                        {t('Edit', 'Editar')}
                      </button>
                    )}
                  </p>
                )}
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-400">{t('Last count', 'Último conteo')}</p>
                <p className="mt-1 text-base font-semibold font-mono tabular-nums text-gray-900">
                  {hasCount
                    ? <>{item.lastCount!.toFixed(2)} <span className="text-[10px] font-sans font-normal text-gray-400">{item.unitOfMeasure}</span></>
                    : <span className="text-gray-400 font-sans font-normal text-xs">—</span>}
                </p>
                {hasCount && (
                  <p className="mt-0.5 text-[10px] text-gray-400">{t('Manual', 'Manual')}</p>
                )}
              </div>
            </div>

            {/* Update stock count — inline collapsed action inside
                the same card. Reads as a secondary correction
                affordance below the stock truth row. A small
                "Adjust" pill on the right makes the row read as
                actionable; the chevron beside it tells you whether
                it's open. Strengthened hover state so the row
                itself feels touchable without making it loud. */}
            <details className="group border-t border-gray-100">
              <summary className="px-4 py-2.5 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors list-none">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-gray-900">{countCtaLabel}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    {hasCount ? t('Adjust the quantity on hand', 'Ajustar la cantidad disponible') : t('Record the first physical count', 'Registrar el primer conteo físico')}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {/* "Adjust" pill picks up a soft blue accent so it
                      reads as a workflow affordance, not a neutral
                      chip. When open, the pill swaps to a quiet gray
                      "Close" because the action is no longer to act
                      — it's to dismiss. */}
                  <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-blue-700 group-hover:text-blue-800 bg-blue-50 group-hover:bg-blue-100 px-1.5 py-0.5 rounded transition-colors group-open:hidden">
                    {t('Adjust', 'Ajustar')}
                  </span>
                  <span className="hidden group-open:inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                    {t('Close', 'Cerrar')}
                  </span>
                  <svg className="w-3.5 h-3.5 text-gray-500 group-open:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </summary>
              <form action={countAction} className="border-t border-gray-100 px-4 py-3 space-y-2 bg-gray-50/40">
                <input type="hidden" name="inventory_item_id" value={item.id} />
                <div className="relative">
                  <input
                    name="quantity_on_hand"
                    type="number"
                    required
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 pr-12 text-sm font-mono font-semibold tabular-nums placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-medium text-gray-400">{item.unitOfMeasure}</span>
                </div>
                <button
                  type="submit"
                  disabled={countPending}
                  className="w-full h-9 rounded-md bg-gray-900 px-4 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
                >
                  {countPending ? t('Saving…', 'Guardando…') : t('Save count', 'Guardar conteo')}
                </button>
                {countState?.error && (
                  <p className="text-[11px] text-red-600">{countState.error}</p>
                )}
              </form>
            </details>
          </div>

          {/* ---- USED IN MENU ITEMS — read-only dependency context.
                 Sits right after Stock Status so the manager sees
                 stock truth, then immediately understands what is
                 affected if the item runs out. Recipe data comes
                 from recipe_components (server-fetched and joined
                 to active menu_items in page.tsx). Empty state is
                 compact; long lists collapse to a "+N more" tail. */}
          <UsedInMenuItemsCard item={item} t={t} />

          {/* ---- RESTOCK ITEM — quantity-only add-to-cart surface.
                 The drawer no longer collects vendor / cost / date /
                 notes — those move to the Restock Cart drawer where
                 the manager finalizes the order before committing.
                 Keeps the item drawer focused on "how much do we
                 need." */}
          <ReplenishSection
            item={item}
            orders={restockOrders}
            t={t}
          />

          {/* ---- RECENT MOVEMENT — item-scoped feed of counts and
                 depletion/receipt transactions. Paginated 3 at a
                 time so the drawer doesn't grow on chatty items.
                 Header right-edge shows total count; footer arrows
                 + "page X of N" appear only when more than one
                 page exists. Same Prev/Next idiom as the main
                 list's pagination. */}
          <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
            <div className="border-b border-gray-100 px-4 py-3 flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-900">{t('Recent movement', 'Movimiento reciente')}</p>
              <span className="text-[10px] text-gray-400 font-mono tabular-nums">
                {allItemMovement.length === 0
                  ? t('No movement yet', 'Sin movimientos aún')
                  : `${allItemMovement.length} ${allItemMovement.length === 1 ? t('movement', 'movimiento') : t('movements', 'movimientos')}`}
              </span>
            </div>
            {allItemMovement.length === 0 ? (
              <p className="px-4 py-2.5 text-[10.5px] text-gray-400 leading-relaxed">
                {t('Counts, sales usage, and received orders will appear here.', 'Los conteos, uso por ventas y órdenes recibidas aparecerán aquí.')}
              </p>
            ) : (
              <>
                {/* Stable min-height when pagination is active. Each
                    ItemMovementRow is ~37px tall (py-2 + small icon
                    + single line text + divider). Reserving 5 rows
                    of space (~185px) keeps the drawer from jumping
                    when the user steps onto a partial last page.
                    Single-page items don't get the reservation —
                    they keep their natural compact height. */}
                <ul
                  className={`divide-y divide-gray-50 ${
                    allItemMovement.length > MOVEMENT_PAGE_SIZE ? 'min-h-[185px]' : ''
                  }`}
                >
                  {visibleMovement.map((tx) => (
                    <ItemMovementRow key={tx.id} tx={tx} unit={item.unitOfMeasure} t={t} />
                  ))}
                </ul>
                {allItemMovement.length > MOVEMENT_PAGE_SIZE && (
                  <div className="border-t border-gray-100 px-4 py-2 flex items-center justify-between">
                    <p className="text-[10px] text-gray-500 font-mono tabular-nums">
                      {t('Showing', 'Mostrando')} <span className="font-semibold text-gray-700">{movementStart + 1}–{Math.min(movementStart + MOVEMENT_PAGE_SIZE, allItemMovement.length)}</span> {t('of', 'de')} <span className="font-semibold text-gray-700">{allItemMovement.length}</span>
                    </p>
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setMovementPage((p) => Math.max(1, p - 1))}
                        disabled={safeMovementPage === 1}
                        aria-label={t('Previous movements', 'Movimientos anteriores')}
                        className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        ←
                      </button>
                      <span className="text-[10px] text-gray-500 px-1.5 font-mono tabular-nums">
                        {safeMovementPage} / {totalMovementPages}
                      </span>
                      <button
                        type="button"
                        onClick={() => setMovementPage((p) => Math.min(totalMovementPages, p + 1))}
                        disabled={safeMovementPage === totalMovementPages}
                        aria-label={t('Next movements', 'Movimientos siguientes')}
                        className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        →
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ---- MANAGE ITEM — archive + delete pinned at the
                 bottom. Visually quiet by design; destructive
                 actions never compete with the primary lifecycle. */}
          <ItemDestructiveSection item={item} t={t} />
        </div>
      </aside>
    </>
  )
}

// ----------------------------------------------------------------
// UsedInMenuItemsCard — read-only "what depends on this item"
// surface in the item drawer. Lists active menu_items whose
// recipe_components reference this inventory_item, with the
// quantity_required per sale shown when non-zero. Each entry
// links to /menu?item=<id> — the Menu page hydrates that param
// on mount, opens the right-side drawer for that specific item,
// and scrolls the matching card into view. So clicking
// "Margarita" here lands the manager looking at Margarita's
// drawer, not the generic Menu page.
// ----------------------------------------------------------------
const USED_IN_VISIBLE_LIMIT = 5

function UsedInMenuItemsCard({ item, t }: { item: Item; t: T }) {
  const deps = item.menuItems
  const visible = deps.slice(0, USED_IN_VISIBLE_LIMIT)
  const overflowCount = deps.length - visible.length

  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-gray-900">{t('Used in menu items', 'Usado en artículos del menú')}</p>
        {deps.length > 0 && (
          <span className="text-[10px] text-gray-400 font-mono tabular-nums">
            {deps.length === 1 ? t('1 item', '1 artículo') : `${deps.length} ${t('items', 'artículos')}`}
          </span>
        )}
      </div>

      {deps.length === 0 ? (
        <p className="px-4 py-2.5 text-[10.5px] text-gray-400 leading-relaxed">
          {t('No mapped menu items yet.', 'Sin artículos del menú asignados aún.')}
        </p>
      ) : (
        <ul className="divide-y divide-gray-50">
          {visible.map((m) => (
            <li key={m.menuItemId}>
              <Link
                href={`/menu?item=${m.menuItemId}`}
                className="group/menu px-4 py-2 flex items-center justify-between gap-3 hover:bg-blue-50/40 transition-colors"
              >
                {/* Row title sits a hair smaller and lighter than
                    the section header so the eye can tell at a
                    glance which line is the header. Hover applies
                    a soft blue wash, lifts the title to blue-700,
                    and tints the chevron — three small signals
                    that together say "click to navigate." Usage
                    amount stays muted as secondary data. */}
                <p className="text-[11px] text-gray-700 truncate group-hover/menu:text-blue-700 transition-colors">
                  {m.menuItemName}
                </p>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {m.quantityRequired > 0 && (
                    <p className="text-[10px] text-gray-500 font-mono tabular-nums">
                      {t('Uses', 'Usa')} <span className="font-mono">{m.quantityRequired.toFixed(2)}</span> {item.unitOfMeasure}
                    </p>
                  )}
                  <svg
                    className="w-3 h-3 text-gray-300 group-hover/menu:text-blue-500 transition-colors"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    aria-hidden
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </Link>
            </li>
          ))}
          {overflowCount > 0 && (
            <li className="px-4 py-2 text-[10.5px] text-gray-400">
              +{overflowCount} {t('more', 'más')}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// ReplenishSection — drawer entry point that swaps between the
// stage-or-add states based on whether this item already has a
// draft restock_orders row. When staged: StagedItemCard takes
// over with Update/Remove. When not staged: RestockItemCard with
// Add. Either way the card is quantity-only — vendor / cost /
// date / notes live exclusively in the Restock Cart drawer.
//
// Multiple drafts for the same item are unusual (each Add creates
// a fresh draft, but the staged-state UI nudges the manager
// toward Update instead). When multiples exist, the first is
// driven by the card and the rest are surfaced as a quiet
// "+N more" tail.
// ----------------------------------------------------------------
function ReplenishSection({ item, orders, t }: { item: Item; orders: RestockOrder[]; t: T }) {
  const drafts = orders.filter((o) => o.status === 'draft')
  if (drafts.length > 0) {
    return (
      <StagedItemCard
        item={item}
        draft={drafts[0]}
        extraStagedCount={drafts.length - 1}
        t={t}
      />
    )
  }
  return <RestockItemCard item={item} t={t} />
}

// Compact quantity stepper — shared chrome for both the staged
// and unstaged restock card. h-8 / text-sm / tight padding so it
// reads as an operational input, not a checkout widget.
function CompactQtyStepper({
  qty,
  setQty,
  unit,
  label,
  t,
}: {
  qty: number
  setQty: (next: number) => void
  unit: string
  label: string
  t: T
}) {
  const step = 1
  const dec = () => setQty(Math.max(step, Math.round((qty - step) * 100) / 100))
  const inc = () => setQty(Math.round((qty + step) * 100) / 100)
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500 mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <div className="inline-flex items-stretch rounded-md border border-gray-200 bg-white overflow-hidden flex-1 max-w-[180px]">
          <button
            type="button"
            onClick={dec}
            className="px-2.5 text-gray-500 hover:bg-gray-50 transition-colors"
            aria-label={t('Decrease quantity', 'Disminuir cantidad')}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
            </svg>
          </button>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={qty}
            onChange={(e) => {
              const n = parseFloat(e.target.value)
              if (Number.isFinite(n) && n > 0) setQty(n)
            }}
            className="h-8 flex-1 min-w-0 text-center text-sm font-mono font-semibold tabular-nums border-x border-gray-200 focus:outline-none focus:bg-blue-50/40"
            aria-label={t('Quantity', 'Cantidad')}
          />
          <button
            type="button"
            onClick={inc}
            className="px-2.5 text-gray-500 hover:bg-gray-50 transition-colors"
            aria-label={t('Increase quantity', 'Aumentar cantidad')}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
        <span className="text-xs text-gray-500">{unit}</span>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// RestockItemCard — quantity-only "Add to restock" card shown
// when no draft exists for this item. Stripped down: header +
// compact stepper + dark commit. No "After receipt" projection,
// no helper copy about cart details. The drawer's role is to
// stage a quantity; everything else is the cart's job.
// ----------------------------------------------------------------
function RestockItemCard({ item, t }: { item: Item; t: T }) {
  const [qty, setQty] = useState<number>(defaultRestockQty(item))
  return (
    <div className="rounded-xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="border-b border-gray-100 px-4 py-2.5">
        <p className="text-xs font-semibold text-gray-900">{t('Restock item', 'Reabastecer artículo')}</p>
        <p className="mt-0.5 text-[10.5px] text-gray-500 leading-relaxed">
          {t('Add this item to the next restock cart.', 'Agrega este artículo al próximo carrito de reabastecimiento.')}
        </p>
      </div>
      <div className="px-4 py-3 space-y-3">
        <CompactQtyStepper qty={qty} setQty={setQty} unit={item.unitOfMeasure} label={t('Quantity', 'Cantidad')} t={t} />
        <form action={quickAddToOrder}>
          <input type="hidden" name="inventory_item_id" value={item.id} />
          <input type="hidden" name="quantity" value={qty} />
          <button
            type="submit"
            disabled={qty <= 0}
            className="w-full h-9 rounded-md bg-gray-900 px-4 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {t('Add to restock', 'Agregar a reabastecimiento')}
          </button>
        </form>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// StagedItemCard — replaces RestockItemCard when this item is
// already staged in the cart. Reads "Staged for restock · In
// cart" in the header, shows the current staged quantity as a
// hero stat, and the stepper drives updateRestockQuantity so
// the same draft row is mutated rather than a fresh duplicate
// row being created. A quiet "Remove from cart" link below
// cancels the draft via cancelRestockOrder.
//
// Stepper is seeded with the current staged quantity so a
// single-click Update is a no-op affordance and the manager
// only types when actually changing the amount.
// ----------------------------------------------------------------
function StagedItemCard({
  item,
  draft,
  extraStagedCount,
  t,
}: {
  item: Item
  draft: RestockOrder
  extraStagedCount: number
  t: T
}) {
  const [qty, setQty] = useState<number>(draft.quantity)
  const [updateState, updateAction, updatePending] = useActionState(updateRestockQuantity, null)
  const [removeState, removeAction, removePending] = useActionState(cancelRestockOrder, null)

  // Keep the stepper in sync when the draft is updated server-side
  // (e.g., the manager edits qty from the cart drawer instead).
  useEffect(() => {
    setQty(draft.quantity)
  }, [draft.quantity])

  const error = updateState?.error ?? removeState?.error
  const isDirty = qty !== draft.quantity

  return (
    // Soft blue top accent marks the workflow state — the card is
    // not just inventory data, it's something staged for action.
    // Matches the "In cart" pill in the header so the two color
    // signals reinforce each other.
    <div className="rounded-xl border border-gray-200/80 border-t-2 border-t-blue-300 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="border-b border-gray-100 px-4 py-2.5 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-gray-900">{t('Staged for restock', 'Preparado para reabastecimiento')}</p>
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">
          <span className="w-1 h-1 rounded-full bg-blue-500" />
          {t('In cart', 'En carrito')}
        </span>
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* Hero stat — current staged quantity. Reads as the
            object-of-attention; the stepper below is the editor. */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-gray-400">{t('Staged quantity', 'Cantidad preparada')}</p>
          <p className="mt-0.5 text-lg font-semibold font-mono tabular-nums text-gray-900">
            {draft.quantity.toFixed(2)}
            <span className="ml-1 text-[10px] font-sans font-normal text-gray-400">{item.unitOfMeasure}</span>
          </p>
        </div>

        <CompactQtyStepper qty={qty} setQty={setQty} unit={item.unitOfMeasure} label={t('Adjust quantity', 'Ajustar cantidad')} t={t} />

        <form action={updateAction}>
          <input type="hidden" name="order_id" value={draft.id} />
          <input type="hidden" name="quantity" value={qty} />
          <button
            type="submit"
            disabled={updatePending || qty <= 0 || !isDirty}
            className="w-full h-9 rounded-md bg-gray-900 px-4 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {updatePending ? t('Updating…', 'Actualizando…') : t('Update staged quantity', 'Actualizar cantidad preparada')}
          </button>
        </form>

        <form action={removeAction} className="text-center">
          <input type="hidden" name="order_id" value={draft.id} />
          <button
            type="submit"
            disabled={removePending}
            className="text-[11px] font-medium text-gray-500 hover:text-red-600 disabled:opacity-60 transition-colors"
          >
            {removePending ? '…' : t('Remove from cart', 'Quitar del carrito')}
          </button>
        </form>

        {extraStagedCount > 0 && (
          <p className="text-[10px] text-gray-400 leading-relaxed text-center">
            +{extraStagedCount} {extraStagedCount === 1 ? t('more staged line for this item in the Restock cart.', 'línea preparada más para este artículo en el Carrito de reabastecimiento.') : t('more staged lines for this item in the Restock cart.', 'líneas preparadas más para este artículo en el Carrito de reabastecimiento.')}
          </p>
        )}

        {error && (
          <p className="text-[11px] text-red-600">{error}</p>
        )}
      </div>
    </div>
  )
}

// ================================================================
// DuplicateMergeBanner — surfaces same-named active inventory items
// and offers one-click resolution via cleanupDuplicateInventoryItems.
// The merge action re-points recipe_components, inventory_counts,
// and inventory_transactions to a single canonical row chosen by
// most-deps-wins, so a click immediately makes prior depletion
// writes land on the visible row.
// ================================================================
function DuplicateMergeBanner({
  groups,
  onPickManually,
  t,
}: {
  groups: { displayName: string; count: number }[]
  onPickManually: () => void
  t: T
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const handleMerge = () => {
    setResult(null)
    startTransition(async () => {
      const res = await cleanupDuplicateInventoryItems()
      if (res?.error) {
        setResult({ ok: false, message: res.error })
      } else {
        const merged = (res as { merged?: number })?.merged ?? 0
        setResult({
          ok: true,
          message:
            merged > 0
              ? `${t('Merged', 'Se combinaron')} ${merged} ${merged === 1 ? t('duplicate. Stock movement will now land on the canonical row.', 'duplicado. El movimiento de stock ahora caerá en la fila canónica.') : t('duplicates. Stock movement will now land on the canonical row.', 'duplicados. El movimiento de stock ahora caerá en la fila canónica.')}`
              : t('No active duplicates found.', 'No se encontraron duplicados activos.'),
        })
      }
    })
  }

  // Compact preview — first three duplicate names, ellipsized if more.
  const preview = groups
    .slice(0, 3)
    .map((g) => `${g.displayName} ×${g.count}`)
    .join(', ')
  const more = groups.length > 3 ? `, +${groups.length - 3} ${t('more', 'más')}` : ''

  return (
    <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-900">
            {t('Duplicate inventory items detected', 'Artículos de inventario duplicados detectados')}
          </p>
          <p className="mt-1 text-xs text-amber-800 leading-relaxed">
            {groups.length} {groups.length === 1 ? t('item name has more than one active row.', 'nombre de artículo tiene más de una fila activa.') : t('item names have more than one active row.', 'nombres de artículos tienen más de una fila activa.')}{' '}
            {t('Stock movement may not show against the row you’re looking at. Merge to consolidate.', 'El movimiento de stock puede no mostrarse en la fila que estás viendo. Combina para consolidar.')}
          </p>
          <p className="mt-1.5 text-[11px] text-amber-700/80 truncate">
            {preview}{more}
          </p>
          {result && (
            <p className={`mt-2 text-[11px] ${result.ok ? 'text-green-700' : 'text-red-700'}`}>
              {result.message}
            </p>
          )}
        </div>
        <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={handleMerge}
            disabled={pending}
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
          >
            {pending ? t('Merging…', 'Combinando…') : t('Merge duplicates', 'Combinar duplicados')}
          </button>
          <button
            type="button"
            onClick={onPickManually}
            className="text-[11px] font-medium text-amber-700 hover:text-amber-800 underline-offset-2 hover:underline transition-colors"
          >
            {t('Pick manually', 'Elegir manualmente')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ================================================================
// ArchivedInRecipesBanner — surfaces archived inventory_items still
// referenced by active recipe_components. This is the smoking-gun
// state for "POS depletion writes exist but stock movement isn't
// visible" — the recipe forwards depletion to the archived id while
// the Inventory table filters that row out. One click runs the
// integrity check, which auto-reactivates these rows so depletion
// lands on a visible item again.
// ================================================================
function ArchivedInRecipesBanner({ names, t }: { names: string[]; t: T }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const handleRepair = () => {
    setResult(null)
    startTransition(async () => {
      const res = await runInventoryIntegrityChecks()
      if (res?.error) {
        setResult({ ok: false, message: res.error })
      } else {
        const reactivated = (res?.issues ?? []).find(
          (i) => i.category === 'Reactivated recipe-linked items'
        )
        setResult({
          ok: true,
          message: reactivated?.message ?? t('Integrity check complete — no recipe-linked archived items found.', 'Verificación de integridad completa — no se encontraron artículos archivados vinculados a recetas.'),
        })
      }
    })
  }

  const preview = names.slice(0, 3).join(', ')
  const more = names.length > 3 ? `, +${names.length - 3} ${t('more', 'más')}` : ''

  return (
    <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-900">
            {t('Archived items still used in active recipes', 'Artículos archivados aún usados en recetas activas')}
          </p>
          <p className="mt-1 text-xs text-amber-800 leading-relaxed">
            {names.length === 1
              ? `${names.length} ${t('archived inventory item is still referenced by active recipes, so stock movement is disappearing from the list. Reactivate to bring it back.', 'artículo de inventario archivado sigue siendo referenciado por recetas activas, por lo que el movimiento de stock está desapareciendo de la lista. Reactiva para traerlo de vuelta.')}`
              : `${names.length} ${t('archived inventory items are still referenced by active recipes, so stock movement is disappearing from the list. Reactivate to bring them back.', 'artículos de inventario archivados siguen siendo referenciados por recetas activas, por lo que el movimiento de stock está desapareciendo de la lista. Reactiva para traerlos de vuelta.')}`}
          </p>
          <p className="mt-1.5 text-[11px] text-amber-700/80 truncate">{preview}{more}</p>
          {result && (
            <p className={`mt-2 text-[11px] ${result.ok ? 'text-green-700' : 'text-red-700'}`}>
              {result.message}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleRepair}
          disabled={pending}
          className="flex-shrink-0 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition-colors"
        >
          {pending ? t('Repairing…', 'Reparando…') : t('Reactivate items', 'Reactivar artículos')}
        </button>
      </div>
    </div>
  )
}

// ================================================================
// MergeItemsDrawer — manual canonical/duplicate picker.
//
// Always available via the header "Merge items" link, even when the
// auto-banner doesn't fire (one duplicate already archived, names
// not exact matches, or the user just wants to consolidate two
// items by hand). Calls `mergeInventoryItems(canonicalId, dupId)`
// which re-points every dependent reference to the canonical row.
//
// The picker lists active + archived items so the user can resolve
// active+archived pairs — the case where a previously-archived row
// still carries the count or recipe link that splits depletion away
// from the visible "Tequila" row.
// ================================================================
function MergeItemsDrawer({
  mergeableItems,
  onClose,
  t,
}: {
  mergeableItems: { id: string; name: string; active: boolean }[]
  onClose: () => void
  t: T
}) {
  const [canonicalId, setCanonicalId] = useState('')
  const [duplicateId, setDuplicateId] = useState('')
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

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

  const handleMerge = () => {
    setResult(null)
    if (!canonicalId || !duplicateId) {
      setResult({ ok: false, message: t('Pick both items before merging.', 'Elige ambos artículos antes de combinar.') })
      return
    }
    if (canonicalId === duplicateId) {
      setResult({ ok: false, message: t('Canonical and duplicate must be different items.', 'Las filas canónica y duplicada deben ser artículos diferentes.') })
      return
    }
    startTransition(async () => {
      const res = await mergeInventoryItems(canonicalId, duplicateId)
      if (res.error) {
        setResult({ ok: false, message: res.error })
      } else {
        setResult({ ok: true, message: res.message })
        setCanonicalId('')
        setDuplicateId('')
      }
    })
  }

  const canonical = mergeableItems.find((i) => i.id === canonicalId) ?? null
  const duplicate = mergeableItems.find((i) => i.id === duplicateId) ?? null

  // Sort: active first, then by name. Archived rows are still
  // selectable but visually labeled so the user knows.
  const sortedItems = [...mergeableItems].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-gray-900/30 backdrop-blur-[1px] z-40"
      />
      <aside className="fixed top-0 right-0 z-50 h-full w-full sm:max-w-md md:max-w-lg lg:max-w-md bg-white shadow-2xl border-l border-gray-200 flex flex-col">

        {/* Header */}
        <div className="border-b border-gray-100 px-6 py-5 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate">
              {t('Inventory cleanup', 'Limpieza de inventario')}
            </p>
            <h2 className="mt-1 text-base font-bold text-gray-900">{t('Merge inventory items', 'Combinar artículos de inventario')}</h2>
            <p className="mt-1 text-xs text-gray-500 leading-relaxed">
              {t('Re-points counts, recipe links, and stock transactions from the duplicate row to the canonical row, then removes the duplicate.', 'Reasigna conteos, vínculos de receta y movimientos de stock de la fila duplicada a la fila canónica, luego elimina la duplicada.')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
          >
            {t('Close', 'Cerrar')}
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">

          <div>
            <label className="block text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate mb-1.5">
              {t('Canonical (the row to keep)', 'Canónica (la fila a conservar)')}
            </label>
            <select
              value={canonicalId}
              onChange={(e) => setCanonicalId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
            >
              <option value="">{t('Select an item…', 'Selecciona un artículo…')}</option>
              {sortedItems.map((item) => (
                <option key={item.id} value={item.id} disabled={item.id === duplicateId}>
                  {item.name}{item.active ? '' : ` ${t('(archived)', '(archivado)')}`}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate mb-1.5">
              {t('Duplicate (merged into canonical)', 'Duplicada (combinada en canónica)')}
            </label>
            <select
              value={duplicateId}
              onChange={(e) => setDuplicateId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition"
            >
              <option value="">{t('Select an item…', 'Selecciona un artículo…')}</option>
              {sortedItems.map((item) => (
                <option key={item.id} value={item.id} disabled={item.id === canonicalId}>
                  {item.name}{item.active ? '' : ` ${t('(archived)', '(archivado)')}`}
                </option>
              ))}
            </select>
          </div>

          {/* Preview */}
          {canonical && duplicate && (
            <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-4">
              <p className="text-[10px] font-semibold font-mono uppercase tracking-[0.14em] text-slate mb-2">
                {t('What will happen', 'Lo que sucederá')}
              </p>
              <ul className="text-[12px] text-gray-700 space-y-1.5 leading-relaxed">
                <li>
                  {t('Counts, recipe links, and stock transactions from', 'Conteos, vínculos de receta y movimientos de stock de')}{' '}
                  <span className="font-semibold">{duplicate.name}{duplicate.active ? '' : ` ${t('(archived)', '(archivado)')}`}</span> {t('move onto', 'se mueven a')}{' '}
                  <span className="font-semibold">{canonical.name}{canonical.active ? '' : ` ${t('(archived)', '(archivado)')}`}</span>.
                </li>
                <li>
                  {t('Canonical is set to active if it isn’t already.', 'La canónica se establece como activa si aún no lo está.')}
                </li>
                <li>
                  {t('Duplicate is removed (or archived if a hard delete is blocked).', 'La duplicada se elimina (o se archiva si la eliminación está bloqueada).')}
                </li>
              </ul>
            </div>
          )}

          {result && (
            <p className={`text-[11px] leading-relaxed ${result.ok ? 'text-green-700' : 'text-red-700'}`}>
              {result.message}
            </p>
          )}
        </div>

        {/* Footer action zone */}
        <div className="border-t border-gray-200 bg-gray-50/40 px-6 py-4 flex-shrink-0 flex items-center gap-2">
          <button
            type="button"
            onClick={handleMerge}
            disabled={pending || !canonicalId || !duplicateId || canonicalId === duplicateId}
            className="flex-1 rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {pending ? t('Merging…', 'Combinando…') : t('Merge items', 'Combinar artículos')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {t('Cancel', 'Cancelar')}
          </button>
        </div>
      </aside>
    </>
  )
}
