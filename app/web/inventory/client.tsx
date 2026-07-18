'use client'

// ----------------------------------------------------------------
// WebInventoryClient — web-native inventory display.
//
// The page reads top-down like a section of the marketing site:
//
//   eyebrow + headline + summary
//   status snapshot (four counts; click to filter)
//   search field (optional, inline, calm)
//   items list (one row per item, urgency-sorted)
//
// Display only. Editing surfaces (counts, threshold updates,
// archive, restock workflow) still live in the classic /inventory
// route until they're given their own web-native version. The
// avatar dropdown's "Switch to classic view" carries the owner
// there when they need to act.
// ----------------------------------------------------------------

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { makeT, type Lang } from '@/lib/i18n'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })
const wrap = (extra: CSSProperties = {}): CSSProperties => ({
  maxWidth: 1160,
  margin: '0 auto',
  ...extra,
})

const eyebrow: CSSProperties = mono({
  fontSize: 11.5,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#6B6B70',
})

// Same four buckets as the classic route, identical urgency order
// (out → low → no_count → ok) so the two surfaces never disagree.
type Status = 'no_count' | 'out' | 'low' | 'ok'
type Filter = 'all' | Status

interface MenuDep {
  menuItemId: string
  menuItemName: string
  /** Quantity required per sale of the menu item, in this inventory
   *  item's unit. Powers the "Used in" rows in the focused card. */
  quantityRequired: number
}

interface Item {
  id: string
  name: string
  unitOfMeasure: string
  threshold: number
  estimated: number | null
  lastCount: number | null
  /** Date the last count was recorded. Used in the focused card's
   *  Last count cell sub-line ("Apr 12"). null when no count yet. */
  lastCountDate: string | null
  status: Status
  /** Active menu items whose recipes consume this ingredient.
   *  Pre-computed server-side and sorted by menu item name. */
  menuItems: MenuDep[]
}

interface InventoryTx {
  id: string
  inventoryItemId: string
  type: string
  quantity: number
  note: string | null
  date: string
}

interface InventoryCount {
  id: string
  inventoryItemId: string
  quantity: number
  date: string
}

const STATUS_ORDER: Record<Status, number> = { out: 0, low: 1, no_count: 2, ok: 3 }

// Status visual tokens. Soft pill backgrounds + a punchier dot for
// the row-level marker. Tones drawn from the marketing palette so
// the inventory page reads continuous with the rest of /web.
const STATUS_TONE: Record<Status, { dot: string; pillBg: string; pillFg: string }> = {
  out:      { dot: '#DC2626', pillBg: '#FEF2F2', pillFg: '#B91C1C' },
  low:      { dot: '#F59E0B', pillBg: '#FFFBEB', pillFg: '#B45309' },
  no_count: { dot: '#9CA3AF', pillBg: '#F4F4F1', pillFg: '#6B6B70' },
  ok:       { dot: '#16A34A', pillBg: '#F0FDF4', pillFg: '#15803D' },
}

interface Props {
  items: Item[]
  transactions: InventoryTx[]
  // Renamed from `counts` to avoid colliding with the local
  // status-totals memo named `counts` further down.
  inventoryCounts: InventoryCount[]
  lang: Lang
}

export default function WebInventoryClient({ items, transactions, inventoryCounts, lang }: Props) {
  const t = makeT(lang)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  // Selected item drives the focused-card overlay. Held in component
  // state (no URL change) — clicking a row pulls the item into focus
  // over the list; Escape, the close button, or a backdrop click
  // returns to the list without losing scroll position or filter.
  const [focused, setFocused] = useState<Item | null>(null)

  // Lock body scroll while the focused card is open. Without this
  // the page behind the modal can scroll under the user's wheel,
  // which feels broken.
  useEffect(() => {
    if (!focused) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [focused])

  // Escape closes the focused card. Standard browser modal behavior.
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocused(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused])

  // Status label translation — kept inline rather than imported
  // because the classic client owns its own translateStatusLabel
  // for its own UI. The two never share state; duplicating the
  // small literal map keeps each surface independently editable.
  const statusLabel = (s: Status): string => {
    switch (s) {
      case 'no_count': return t('No count', 'Sin conteo')
      case 'out':      return t('Out',      'Agotado')
      case 'low':      return t('Low',      'Bajo')
      case 'ok':       return t('OK',       'OK')
    }
  }

  // Counts per status — drives both the snapshot strip and the
  // "X items in this filter" sub-line.
  const counts = useMemo(() => {
    const c = { all: items.length, out: 0, low: 0, no_count: 0, ok: 0 }
    for (const item of items) {
      c[item.status] += 1
    }
    return c
  }, [items])

  // Filter + search + sort. Sort is stable: urgency bucket first,
  // then name within bucket. Search is a simple case-insensitive
  // substring match on the item name.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items
      .filter((i) => (filter === 'all' ? true : i.status === filter))
      .filter((i) => (q === '' ? true : i.name.toLowerCase().includes(q)))
      .sort((a, b) => {
        const diff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
        if (diff !== 0) return diff
        return a.name.localeCompare(b.name)
      })
  }, [items, filter, query])

  // Snapshot strip — four tiles, each clickable as a filter. The
  // active filter lights its tile with the ink border so the user
  // sees which bucket they're focused on.
  const snapshot: { key: Filter; label: string; count: number }[] = [
    { key: 'out',      label: t('Out',      'Agotado'),    count: counts.out      },
    { key: 'low',      label: t('Low',      'Bajo'),       count: counts.low      },
    { key: 'no_count', label: t('No count', 'Sin conteo'), count: counts.no_count },
    { key: 'ok',       label: t('OK',       'OK'),         count: counts.ok       },
  ]

  return (
    <div style={wrap({ padding: '56px 24px 96px' })}>
      {/* HEAD — eyebrow with live counts, big headline, framing copy.
          Mirrors the home page's rhythm so navigating from /web/home
          into /web/inventory feels like the same product, not a
          context switch. */}
      <div style={{ marginBottom: 40 }}>
        <div style={eyebrow}>
          {t('Inventory', 'Inventario')} ·{' '}
          {t(`${counts.all} items tracked`, `${counts.all} artículos en seguimiento`)}
        </div>
        <h1
          style={{
            fontSize: 'clamp(36px, 5.4vw, 56px)',
            lineHeight: 1.02,
            letterSpacing: '-1.6px',
            fontWeight: 700,
            margin: '14px 0 0',
            color: '#18181B',
          }}
        >
          {t('Stock counts itself.', 'El inventario se cuenta solo.')}
        </h1>
        <p
          style={{
            fontSize: 17,
            lineHeight: 1.55,
            color: '#52525B',
            margin: '18px 0 0',
            maxWidth: 620,
          }}
        >
          {t(
            'Every Square sale deducts the right ingredients automatically. What you see below reflects your latest counts plus every sale since.',
            'Cada venta en Square descuenta los ingredientes correctos automáticamente. Lo que ves abajo refleja tus últimos conteos más cada venta desde entonces.'
          )}
        </p>
      </div>

      {/* SNAPSHOT — four status counts laid out as a hairline-divided
          strip on the cream background. No card chrome, no borders
          around each cell; the row reads as type, not as boxed widgets.
          Active filter dims its label to ink and lights the count; idle
          filters fade. Clicking toggles the filter on/off. */}
      <section
        style={{
          marginBottom: 36,
          borderTop: '1px solid #E7E6E2',
          borderBottom: '1px solid #E7E6E2',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          {snapshot.map((s, idx) => {
            const active = filter === s.key
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setFilter(active ? 'all' : s.key)}
                aria-pressed={active}
                style={{
                  flex: 1,
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  borderLeft: idx === 0 ? 'none' : '1px solid #E7E6E2',
                  padding: '18px 20px 18px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    ...eyebrow,
                    color: active ? '#18181B' : '#6B6B70',
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: STATUS_TONE[s.key as Status].dot,
                      display: 'inline-block',
                    }}
                  />
                  {s.label}
                </div>
                <div
                  style={mono({
                    fontSize: 26,
                    fontWeight: 600,
                    lineHeight: 1,
                    color: active ? '#18181B' : s.count === 0 ? '#C9C9CE' : '#18181B',
                    marginTop: 10,
                  })}
                >
                  {s.count}
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {/* Filter status — calm "All" toggle + active filter label.
          Sits below the snapshot as a small, secondary line rather
          than another row of controls. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <button
          type="button"
          onClick={() => setFilter('all')}
          style={{
            ...eyebrow,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            color: filter === 'all' ? '#18181B' : '#9CA3AF',
            fontFamily: MONO,
          }}
        >
          {t('All', 'Todos')} · {counts.all}
        </button>
        {filter !== 'all' && (
          <span style={mono({ fontSize: 11.5, color: '#9CA3AF', letterSpacing: '0.06em' })}>
            {t('Showing', 'Mostrando')} {statusLabel(filter as Status).toLowerCase()}
          </span>
        )}
      </div>

      {/* SEARCH — calm bottom-bordered input on the cream background.
          No box, no padding chrome around the field; it reads as a
          line of type with a typeable underline. */}
      <div style={{ marginBottom: 32, maxWidth: 420 }}>
        <label htmlFor="inv-search" style={{ ...eyebrow, display: 'block', marginBottom: 8 }}>
          {t('Search', 'Buscar')}
        </label>
        <input
          id="inv-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Item name…', 'Nombre del artículo…')}
          style={{
            width: '100%',
            background: 'transparent',
            border: 'none',
            borderBottom: '1px solid #D8D8D4',
            borderRadius: 0,
            padding: '8px 0',
            fontFamily: 'inherit',
            fontSize: 16,
            color: '#18181B',
            outline: 'none',
          }}
        />
      </div>

      {/* ITEMS LIST — top-down rows on the cream background. A single
          column-header row sits above the items with eyebrow labels;
          the rows below just show the values, no repeated labels.
          Hairline dividers between rows, no card chrome, no zebra
          stripes — reads as type on a page, not widgets in a grid. */}
      <section>
        {/* Shared column template — keeps the header row and item
            rows in perfect alignment without duplicating the spec. */}
        {visible.length === 0 ? (
          <div
            style={{
              borderTop: '1px solid #E7E6E2',
              padding: '40px 0',
              textAlign: 'center',
              color: '#9CA3AF',
              fontSize: 14,
            }}
          >
            {query.trim() !== ''
              ? t('No items match your search.', 'No hay artículos que coincidan.')
              : t('No items in this filter.', 'No hay artículos en este filtro.')}
          </div>
        ) : (
          <>
            {/* COLUMN HEADER — labels appear once, eyebrow style.
                Last count is no longer a column; it lives on each
                item's detail page now (one click into a row). */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns:
                  'minmax(0, 1.8fr) minmax(0, 0.7fr) minmax(0, 0.7fr) minmax(70px, auto)',
                gap: 18,
                alignItems: 'baseline',
                padding: '0 0 12px',
                borderBottom: '1px solid #E7E6E2',
              }}
            >
              <div style={eyebrow}>{t('Item', 'Artículo')}</div>
              <div style={eyebrow}>{t('Unit', 'Unidad')}</div>
              <div style={eyebrow}>{t('Estimated', 'Estimado')}</div>
              <div style={{ ...eyebrow, textAlign: 'right' }}>
                {t('Status', 'Estado')}
              </div>
            </div>

            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {visible.map((item) => {
                const tone = STATUS_TONE[item.status]
                return (
                  <li
                    key={item.id}
                    style={{
                      borderBottom: '1px solid #E7E6E2',
                    }}
                  >
                    {/* The whole row is a button that pulls the item
                        into the focused-card overlay. Same hairline
                        row treatment; the only chrome is a subtle
                        cream-on-cream hover wash so the cursor knows
                        it's a hit target. */}
                    <button
                      type="button"
                      onClick={() => setFocused(item)}
                      style={{
                        display: 'grid',
                        width: '100%',
                        gridTemplateColumns:
                          'minmax(0, 1.8fr) minmax(0, 0.7fr) minmax(0, 0.7fr) minmax(70px, auto)',
                        gap: 18,
                        alignItems: 'center',
                        padding: '14px 0',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        color: 'inherit',
                        textAlign: 'left',
                      }}
                      className="web-inv-row"
                    >
                      {/* Name + status dot */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          minWidth: 0,
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: tone.dot,
                            flex: '0 0 auto',
                          }}
                        />
                        <span
                          style={{
                            fontSize: 15,
                            fontWeight: 600,
                            color: '#18181B',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {item.name}
                        </span>
                      </div>

                      {/* Unit */}
                      <div style={mono({ fontSize: 12, color: '#9CA3AF' })}>
                        {item.unitOfMeasure}
                      </div>

                      {/* Estimated stock */}
                      <div style={mono({ fontSize: 14.5, fontWeight: 600, color: '#18181B' })}>
                        {item.estimated === null ? '—' : item.estimated}
                      </div>

                      {/* Status pill */}
                      <div style={{ textAlign: 'right' }}>
                        <span
                          style={mono({
                            fontSize: 10.5,
                            letterSpacing: '0.06em',
                            padding: '4px 9px',
                            borderRadius: 6,
                            background: tone.pillBg,
                            color: tone.pillFg,
                            textTransform: 'uppercase',
                            fontWeight: 600,
                          })}
                        >
                          {statusLabel(item.status)}
                        </span>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
            <style>{`
              .web-inv-row:hover { background: rgba(24,24,27,0.025); }
            `}</style>
          </>
        )}
      </section>

      {/* FOOTER NOTE — honesty about what isn't here yet. Editing
          surfaces (counts, thresholds, restock workflow) still live
          in the classic view. This calm one-line link sets that
          expectation without burying the display work above. */}
      <div style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid #E7E6E2' }}>
        <p style={{ fontSize: 14, color: '#9CA3AF', margin: 0 }}>
          {t(
            'Need to record a count, update a threshold, or place a restock order?',
            '¿Necesitas registrar un conteo, actualizar un umbral o hacer un pedido?'
          )}{' '}
          <Link
            href="/inventory"
            style={{ color: '#18181B', textDecoration: 'underline', textUnderlineOffset: 3 }}
          >
            {t('Open the classic inventory workspace', 'Abre el espacio clásico de inventario')}
          </Link>
          .
        </p>
      </div>

      {/* FOCUSED CARD OVERLAY — opens when a row is clicked. The page
          stays where it is; the card lifts the chosen item into focus
          with the main stats. Backdrop click, Escape, or the close
          button dismisses. URL doesn't change — this is presentation
          state, not navigation state. */}
      {focused && (
        <FocusedItemCard
          item={focused}
          unit={focused.unitOfMeasure}
          transactions={transactions.filter((tx) => tx.inventoryItemId === focused.id)}
          counts={inventoryCounts.filter((c) => c.inventoryItemId === focused.id)}
          onClose={() => setFocused(null)}
          t={t}
          lang={lang}
          statusLabel={statusLabel(focused.status)}
          tone={STATUS_TONE[focused.status]}
        />
      )}

      <style>{`
        @keyframes webModalBackdropIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes webModalCardIn {
          from { opacity: 0; transform: translateY(8px) scale(0.985); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .web-modal-backdrop, .web-modal-card { animation: none !important; }
        }
      `}</style>
    </div>
  )
}

// ----------------------------------------------------------------
// FocusedItemCard — centered overlay that appears when the user
// clicks an item row. Carries the same sections the classic app
// shell's item drawer carries (header, stock stats, used-in, recent
// movement) but presented as a centered focused card on a dimmed
// backdrop rather than a right-side drawer.
//
// Editing surfaces (record count, adjust threshold, restock) still
// live in the classic workspace — the footer link routes there.
// V1 of this card is rich READ-ONLY display. Editing inline can
// land in a later pass once the read pattern is settled.
//
// Close handled via X button, backdrop click, or Escape key (the
// Escape handler lives in the parent so it can stay coupled to the
// selected-item state).
// ----------------------------------------------------------------
function FocusedItemCard({
  item,
  unit,
  transactions,
  counts,
  onClose,
  t,
  lang,
  statusLabel,
  tone,
}: {
  item: Item
  unit: string
  transactions: InventoryTx[]
  counts: InventoryCount[]
  onClose: () => void
  t: (en: string, es?: string) => string
  lang: Lang
  statusLabel: string
  tone: { dot: string; pillBg: string; pillFg: string }
}) {
  // Build a unified movement feed for this item: transactions +
  // counts, newest first, top 10. Same pattern as the classic
  // drawer's "Recent movement" section — both event kinds in one
  // chronological list so the manager sees the full story.
  type FeedRow = {
    id: string
    kind: 'count' | 'tx'
    type: string
    quantity: number
    note: string | null
    date: string
  }
  const txRows: FeedRow[] = transactions.map((tx) => ({
    id: `tx:${tx.id}`,
    kind: 'tx',
    type: tx.type,
    quantity: tx.quantity,
    note: tx.note,
    date: tx.date,
  }))
  const countRows: FeedRow[] = counts.map((c) => ({
    id: `ct:${c.id}`,
    kind: 'count',
    type: 'count',
    quantity: c.quantity,
    note: null,
    date: c.date,
  }))
  const feed = [...txRows, ...countRows]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 10)

  // Item type pill — recipe-linked items surface the dependency
  // count; standalone items get a calm "Standalone" label. Mirrors
  // the classic drawer so the two surfaces tell the same story.
  const recipeLinks = item.menuItems.length
  const isRecipeLinked = recipeLinks > 0
  const typePillLabel = isRecipeLinked
    ? `${t('Recipe-linked', 'Vinculado a receta')} · ${recipeLinks}`
    : t('Standalone', 'Independiente')

  return (
    <div
      className="web-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(24,24,27,0.42)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        animation: 'webModalBackdropIn 180ms ease',
        backdropFilter: 'saturate(1.1) blur(2px)',
      }}
    >
      <div
        className="web-modal-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 720,
          maxHeight: '90vh',
          overflowY: 'auto',
          background: '#FAF9F6',
          border: '1px solid #E0DED7',
          borderRadius: 16,
          boxShadow: '0 24px 60px -20px rgba(24,24,27,0.32)',
          animation: 'webModalCardIn 240ms cubic-bezier(0.22, 0.7, 0.2, 1)',
        }}
      >
        {/* HEADER — sticky inside the scroll container so the title +
            close button stay reachable when the card content scrolls.
            Eyebrow carries status + type pills; headline is the item
            name. Close is a discrete bordered button on the right. */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            background: '#FAF9F6',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 18,
            padding: '24px 28px 20px',
            borderBottom: '1px solid #E7E6E2',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ ...eyebrow, color: '#6B6B70' }}>
              {t('Inventory item', 'Artículo de inventario')}
            </div>
            <h2
              style={{
                fontSize: 'clamp(24px, 3vw, 30px)',
                lineHeight: 1.1,
                letterSpacing: '-0.8px',
                fontWeight: 700,
                margin: '6px 0 0',
                color: '#18181B',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.name}
            </h2>
            {/* Status + type pills — twin row beneath the title.
                Status pill is color-coded; type pill is calm neutral. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 12,
                flexWrap: 'wrap',
              }}
            >
              <span
                style={mono({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  padding: '4px 9px',
                  borderRadius: 6,
                  background: tone.pillBg,
                  color: tone.pillFg,
                })}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: tone.dot,
                    display: 'inline-block',
                  }}
                />
                {statusLabel}
              </span>
              <span
                style={mono({
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontSize: 10.5,
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  padding: '4px 9px',
                  borderRadius: 6,
                  background: '#F1F0EC',
                  color: '#6B6B70',
                })}
              >
                {typePillLabel}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label={t('Close', 'Cerrar')}
            style={{
              flex: '0 0 auto',
              width: 36,
              height: 36,
              borderRadius: 8,
              border: '1px solid #E7E6E2',
              background: 'transparent',
              color: '#6B6B70',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 18,
              lineHeight: 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>

        {/* BODY — sections stacked top-down. Each has an eyebrow
            heading and either a stats strip or a hairline list. */}
        <div style={{ padding: '24px 28px 28px' }}>
          {/* STOCK STATUS — three numeric cells, no card chrome
              around them; just hairline top/bottom borders. Same
              shape as the snapshot strip on the inventory list page,
              so the rhythm carries between list and card. */}
          <section>
            <div style={eyebrow}>{t('Stock status', 'Estado del stock')}</div>
            <div
              style={{
                marginTop: 12,
                display: 'flex',
                alignItems: 'stretch',
                borderTop: '1px solid #E7E6E2',
                borderBottom: '1px solid #E7E6E2',
              }}
            >
              <ModalStat
                label={t('Estimated', 'Estimado')}
                value={item.estimated === null ? '—' : `${item.estimated}`}
                unit={unit}
                isFirst
              />
              <ModalStat
                label={t('Reorder at', 'Reordenar en')}
                value={`${item.threshold}`}
                unit={unit}
              />
              <ModalStat
                label={t('Last count', 'Último conteo')}
                value={item.lastCount === null ? '—' : `${item.lastCount}`}
                unit={unit}
                sub={
                  item.lastCountDate
                    ? formatDate(item.lastCountDate, lang)
                    : t('No count yet', 'Aún sin conteo')
                }
              />
            </div>
          </section>

          {/* USED IN — menu items that consume this ingredient. Only
              renders when there's at least one dependency so unused
              ingredients don't show an empty header. Each row shows
              the dish name and the recipe quantity per sale. */}
          {item.menuItems.length > 0 && (
            <section style={{ marginTop: 32 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <div style={eyebrow}>{t('Used in', 'Usado en')}</div>
                <span style={mono({ fontSize: 11, color: '#C9C9CE' })}>
                  {item.menuItems.length}
                </span>
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
                {item.menuItems.map((m, idx) => (
                  <li
                    key={m.menuItemId}
                    style={{
                      borderTop: idx === 0 ? '1px solid #E7E6E2' : undefined,
                      borderBottom: '1px solid #E7E6E2',
                      padding: '12px 0',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 18,
                    }}
                  >
                    <span style={{ fontSize: 14.5, fontWeight: 600, color: '#18181B' }}>
                      {m.menuItemName}
                    </span>
                    <span style={mono({ fontSize: 12.5, color: '#52525B' })}>
                      {m.quantityRequired} {unit}{' '}
                      <span style={{ color: '#9CA3AF' }}>
                        {t('per sale', 'por venta')}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* RECENT MOVEMENT — interleaved counts + transactions for
              this item, newest first, top 10. Sale depletions render
              red, additions (counts / restocks) render green. */}
          <section style={{ marginTop: 32 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div style={eyebrow}>{t('Recent movement', 'Movimiento reciente')}</div>
              {feed.length > 0 && (
                <span style={mono({ fontSize: 11, color: '#C9C9CE' })}>{feed.length}</span>
              )}
            </div>
            {feed.length === 0 ? (
              <p
                style={{
                  fontSize: 13.5,
                  color: '#9CA3AF',
                  margin: '12px 0 0',
                  padding: '14px 0',
                  borderTop: '1px solid #E7E6E2',
                  borderBottom: '1px solid #E7E6E2',
                  textAlign: 'center',
                }}
              >
                {t('No activity yet.', 'Aún sin actividad.')}
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
                {feed.map((row, idx) => (
                  <li
                    key={row.id}
                    style={{
                      borderTop: idx === 0 ? '1px solid #E7E6E2' : undefined,
                      borderBottom: '1px solid #E7E6E2',
                      padding: '12px 0',
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, auto)',
                      gap: 18,
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#18181B' }}>
                      {row.kind === 'count'
                        ? t('Count taken', 'Conteo registrado')
                        : translateTxType(row.type, lang)}
                    </span>
                    <span style={mono({ fontSize: 13, color: '#52525B' })}>
                      {row.kind === 'count' ? (
                        <span>
                          {row.quantity} {unit}
                        </span>
                      ) : (
                        <span style={{ color: row.quantity < 0 ? '#B91C1C' : '#15803D' }}>
                          {row.quantity > 0 ? '+' : ''}
                          {row.quantity} {unit}
                        </span>
                      )}
                    </span>
                    <span style={mono({ fontSize: 11.5, color: '#9CA3AF' })}>
                      {formatDate(row.date, lang)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* FOOTER LINK — calm pointer to the classic workspace for
              editing actions. Travels with the focused item rather
              than the page so it reads as part of the card's offer. */}
          <p style={{ fontSize: 13, color: '#9CA3AF', margin: '28px 0 0' }}>
            {t(
              'Record a count, adjust threshold, or place a restock order in the',
              'Registra un conteo, ajusta el umbral o haz un pedido en el'
            )}{' '}
            <Link
              href="/inventory"
              style={{ color: '#18181B', textDecoration: 'underline', textUnderlineOffset: 3 }}
            >
              {t('classic inventory workspace', 'espacio clásico de inventario')}
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  )
}

// ModalStat — one cell of the focused card's stock-status strip.
// Vertical hairline divider on the left (skipped for the first
// cell). Eyebrow label up top, big monospace number with unit, and
// an optional sub-line (used for the last-count date).
function ModalStat({
  label,
  value,
  unit,
  sub,
  isFirst,
}: {
  label: string
  value: string
  unit: string
  sub?: string
  isFirst?: boolean
}) {
  return (
    <div
      style={{
        flex: 1,
        padding: '18px 20px',
        borderLeft: isFirst ? 'none' : '1px solid #E7E6E2',
      }}
    >
      <div style={eyebrow}>{label}</div>
      <div
        style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
        }}
      >
        <span
          style={mono({
            fontSize: 26,
            fontWeight: 600,
            lineHeight: 1,
            color: '#18181B',
          })}
        >
          {value}
        </span>
        <span style={mono({ fontSize: 11, color: '#9CA3AF' })}>{unit}</span>
      </div>
      {sub && (
        <div
          style={mono({
            fontSize: 11,
            color: '#9CA3AF',
            marginTop: 8,
            letterSpacing: '0.04em',
          })}
        >
          {sub}
        </div>
      )}
    </div>
  )
}

// Cheap, dependency-free date formatter — matches /web/home's
// eyebrow date texture so dates read the same way across the app.
function formatDate(d: string, lang: 'en' | 'es'): string {
  const date = new Date(d)
  const weekdaysEn = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
  const monthsEn = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
  const weekdaysEs = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB']
  const monthsEs = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']
  const w = lang === 'es' ? weekdaysEs[date.getDay()] : weekdaysEn[date.getDay()]
  const m = lang === 'es' ? monthsEs[date.getMonth()] : monthsEn[date.getMonth()]
  return `${w} · ${m} ${date.getDate()}`
}

// Friendly label for a transaction type. Falls back to the raw
// type string with underscores swapped to spaces if we haven't
// added an explicit translation yet — better than rendering raw
// snake_case to an owner.
function translateTxType(type: string, lang: 'en' | 'es'): string {
  const map: Record<string, { en: string; es: string }> = {
    sale_depletion:    { en: 'Sale',              es: 'Venta'           },
    manual_adjustment: { en: 'Manual adjustment', es: 'Ajuste manual'   },
    restock_received:  { en: 'Restock received',  es: 'Pedido recibido' },
    waste:             { en: 'Waste',             es: 'Merma'           },
    initial_count:     { en: 'Initial count',     es: 'Conteo inicial'  },
    count:             { en: 'Count',             es: 'Conteo'          },
  }
  const hit = map[type]
  if (hit) return lang === 'es' ? hit.es : hit.en
  return type.replace(/_/g, ' ')
}
