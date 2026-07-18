'use client'

// ----------------------------------------------------------------
// WebMenuClient — web-native menu display.
//
//   eyebrow + headline + summary
//   filter chips (all / active / inactive)
//   categories — each section shows its items as type-led rows
//   focused card on click → recipe components + source
// ----------------------------------------------------------------

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { makeT, type Lang } from '@/lib/i18n'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'
const mono = (extra: CSSProperties = {}): CSSProperties => ({ fontFamily: MONO, ...extra })
const wrap = (extra: CSSProperties = {}): CSSProperties => ({ maxWidth: 1160, margin: '0 auto', ...extra })
const eyebrow: CSSProperties = mono({
  fontSize: 11.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#6B6B70',
})

interface RecipeComponent {
  id: string; inventoryItemId: string; inventoryItemName: string
  unitOfMeasure: string; quantityRequired: number
}
interface MenuItem {
  id: string; name: string; price: number; active: boolean
  source: string; externalProvider: string | null
  recipe: RecipeComponent[]
}
interface Category {
  id: string; name: string; items: MenuItem[]
}
interface Props { lang: Lang; categories: Category[]; totalItems: number }

type Filter = 'all' | 'active' | 'inactive'

const fmt = (n: number) => `$${n.toFixed(2)}`

export default function WebMenuClient({ lang, categories, totalItems }: Props) {
  const t = makeT(lang)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState<MenuItem | null>(null)

  useEffect(() => {
    if (!focused) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocused(null) }
    window.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
  }, [focused])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return categories
      .map((c) => ({
        ...c,
        items: c.items
          .filter((it) => filter === 'all' ? true : filter === 'active' ? it.active : !it.active)
          .filter((it) => q === '' ? true : it.name.toLowerCase().includes(q)),
      }))
      .filter((c) => c.items.length > 0)
  }, [categories, filter, query])

  const counts = useMemo(() => {
    let active = 0; let inactive = 0
    for (const c of categories) for (const it of c.items) {
      if (it.active) active++; else inactive++
    }
    return { active, inactive, all: active + inactive }
  }, [categories])

  return (
    <div style={wrap({ padding: '56px 24px 96px' })}>
      <div style={{ marginBottom: 40 }}>
        <div style={eyebrow}>
          {t('Menu', 'Menú')} · {t(`${totalItems} items`, `${totalItems} artículos`)}
        </div>
        <h1 style={{
          fontSize: 'clamp(36px, 5.4vw, 56px)', lineHeight: 1.02,
          letterSpacing: '-1.6px', fontWeight: 700, margin: '14px 0 0', color: '#18181B',
        }}>
          {t('Your menu.', 'Tu menú.')}
        </h1>
        <p style={{
          fontSize: 17, lineHeight: 1.55, color: '#52525B',
          margin: '18px 0 0', maxWidth: 620,
        }}>
          {t(
            'Every dish, drink, and side — with the recipe that ties it to your inventory.',
            'Cada platillo, bebida y acompañamiento — con la receta que lo conecta a tu inventario.'
          )}
        </p>
      </div>

      {/* Filter row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, marginBottom: 24, flexWrap: 'wrap' }}>
        {(['all', 'active', 'inactive'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            style={{
              ...eyebrow,
              background: 'transparent',
              border: 'none', cursor: 'pointer', padding: 0,
              color: filter === f ? '#18181B' : '#9CA3AF',
              fontFamily: MONO,
            }}
          >
            {f === 'all' ? t('All', 'Todos') : f === 'active' ? t('Active', 'Activos') : t('Inactive', 'Inactivos')}
            {' · '}
            {f === 'all' ? counts.all : f === 'active' ? counts.active : counts.inactive}
          </button>
        ))}
      </div>

      {/* Search */}
      <div style={{ marginBottom: 32, maxWidth: 420 }}>
        <label htmlFor="menu-search" style={{ ...eyebrow, display: 'block', marginBottom: 8 }}>
          {t('Search', 'Buscar')}
        </label>
        <input
          id="menu-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Item name…', 'Nombre del artículo…')}
          style={{
            width: '100%', background: 'transparent', border: 'none',
            borderBottom: '1px solid #D8D8D4', borderRadius: 0,
            padding: '8px 0', fontFamily: 'inherit', fontSize: 16, color: '#18181B', outline: 'none',
          }}
        />
      </div>

      {/* Categories + items */}
      {visible.length === 0 ? (
        <div style={{
          borderTop: '1px solid #E7E6E2', padding: '40px 0',
          textAlign: 'center', color: '#9CA3AF', fontSize: 14,
        }}>
          {t('No items match.', 'No hay artículos que coincidan.')}
        </div>
      ) : (
        visible.map((cat) => (
          <section key={cat.id} style={{ marginBottom: 48 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
              <h2 style={{
                fontSize: 'clamp(22px, 2.4vw, 28px)', lineHeight: 1.1,
                letterSpacing: '-0.6px', fontWeight: 700, margin: 0, color: '#18181B',
              }}>
                {cat.name}
              </h2>
              <span style={mono({ fontSize: 12, color: '#9CA3AF' })}>{cat.items.length}</span>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {cat.items.map((it, idx) => (
                <li key={it.id} style={{
                  borderTop: idx === 0 ? '1px solid #E7E6E2' : undefined,
                  borderBottom: '1px solid #E7E6E2',
                }}>
                  <button
                    type="button"
                    onClick={() => setFocused(it)}
                    className="web-menu-row"
                    style={{
                      display: 'grid', width: '100%',
                      gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 0.8fr) minmax(0, auto) minmax(80px, auto)',
                      gap: 18, alignItems: 'center', padding: '14px 0',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      fontFamily: 'inherit', color: 'inherit', textAlign: 'left',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontSize: 15, fontWeight: 600,
                        color: it.active ? '#18181B' : '#9CA3AF',
                        textDecoration: it.active ? 'none' : 'line-through',
                      }}>{it.name}</div>
                    </div>
                    <div style={mono({ fontSize: 12, color: '#9CA3AF' })}>
                      {it.recipe.length === 0
                        ? t('No recipe', 'Sin receta')
                        : t(`${it.recipe.length} ingredients`, `${it.recipe.length} ingredientes`)}
                    </div>
                    <div style={mono({ fontSize: 14.5, fontWeight: 600, color: '#18181B' })}>
                      {fmt(it.price)}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <ActivePill active={it.active} lang={lang} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <FooterLink t={t} />

      {focused && (
        <FocusedItemCard item={focused} onClose={() => setFocused(null)} t={t} lang={lang} />
      )}

      <style>{`
        .web-menu-row:hover { background: rgba(24,24,27,0.025); }
        @keyframes webModalBackdropIn { from{opacity:0} to{opacity:1} }
        @keyframes webModalCardIn { from{opacity:0;transform:translateY(8px) scale(.985)} to{opacity:1;transform:translateY(0) scale(1)} }
      `}</style>
    </div>
  )
}

function ActivePill({ active, lang }: { active: boolean; lang: Lang }) {
  const t = makeT(lang)
  return (
    <span style={mono({
      fontSize: 10.5, letterSpacing: '0.06em', padding: '4px 9px', borderRadius: 6,
      background: active ? '#F0FDF4' : '#F4F4F1',
      color: active ? '#15803D' : '#6B6B70',
      textTransform: 'uppercase', fontWeight: 600,
    })}>
      {active ? t('Active', 'Activo') : t('Off', 'Inactivo')}
    </span>
  )
}

function FocusedItemCard({ item, onClose, t, lang }: {
  item: MenuItem; onClose: () => void; t: (en: string, es?: string) => string; lang: Lang
}) {
  return (
    <div
      className="web-modal-backdrop" role="dialog" aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(24,24,27,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, backdropFilter: 'saturate(1.1) blur(2px)',
        animation: 'webModalBackdropIn 180ms ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 720, maxHeight: '90vh', overflowY: 'auto',
          background: '#FAF9F6', border: '1px solid #E0DED7',
          borderRadius: 16, boxShadow: '0 24px 60px -20px rgba(24,24,27,0.32)',
          animation: 'webModalCardIn 240ms cubic-bezier(0.22, 0.7, 0.2, 1)',
        }}
      >
        <div style={{
          position: 'sticky', top: 0, background: '#FAF9F6',
          padding: '24px 28px 20px', borderBottom: '1px solid #E7E6E2',
          display: 'flex', justifyContent: 'space-between', gap: 18,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={eyebrow}>{t('Menu item', 'Artículo del menú')}</div>
            <h2 style={{
              fontSize: 'clamp(24px, 3vw, 30px)', lineHeight: 1.1,
              letterSpacing: '-0.8px', fontWeight: 700, margin: '6px 0 0', color: '#18181B',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{item.name}</h2>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <ActivePill active={item.active} lang={lang} />
              {item.externalProvider && (
                <span style={mono({
                  fontSize: 10.5, letterSpacing: '0.06em', padding: '4px 9px',
                  borderRadius: 6, background: '#EFF4FF', color: '#1D4ED8',
                  textTransform: 'uppercase', fontWeight: 600,
                })}>
                  {t(`From ${item.externalProvider}`, `De ${item.externalProvider}`)}
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} aria-label={t('Close', 'Cerrar')} style={closeBtn}>×</button>
        </div>

        <div style={{ padding: '24px 28px 28px' }}>
          {/* Price + recipe count */}
          <section>
            <div style={{
              display: 'flex', alignItems: 'stretch',
              borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
            }}>
              <Cell label={t('Price', 'Precio')} value={fmt(item.price)} isFirst />
              <Cell label={t('Ingredients', 'Ingredientes')} value={`${item.recipe.length}`} />
            </div>
          </section>

          {/* Recipe components */}
          <section style={{ marginTop: 32 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div style={eyebrow}>{t('Recipe', 'Receta')}</div>
              {item.recipe.length > 0 && (
                <span style={mono({ fontSize: 11, color: '#C9C9CE' })}>{item.recipe.length}</span>
              )}
            </div>
            {item.recipe.length === 0 ? (
              <p style={{
                fontSize: 13.5, color: '#9CA3AF', margin: '12px 0 0',
                padding: '14px 0',
                borderTop: '1px solid #E7E6E2', borderBottom: '1px solid #E7E6E2',
                textAlign: 'center',
              }}>
                {t('No recipe yet.', 'Aún sin receta.')}
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
                {item.recipe.map((r, idx) => (
                  <li key={r.id} style={{
                    borderTop: idx === 0 ? '1px solid #E7E6E2' : undefined,
                    borderBottom: '1px solid #E7E6E2',
                    padding: '12px 0',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18,
                  }}>
                    <span style={{ fontSize: 14.5, fontWeight: 600, color: '#18181B' }}>
                      {r.inventoryItemName}
                    </span>
                    <span style={mono({ fontSize: 12.5, color: '#52525B' })}>
                      {r.quantityRequired} {r.unitOfMeasure}{' '}
                      <span style={{ color: '#9CA3AF' }}>{t('per sale', 'por venta')}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p style={{ fontSize: 13, color: '#9CA3AF', margin: '28px 0 0' }}>
            {t('Edit the recipe or price in the', 'Edita la receta o el precio en el')}{' '}
            <Link href="/menu" style={{ color: '#18181B', textDecoration: 'underline', textUnderlineOffset: 3 }}>
              {t('classic menu workspace', 'espacio clásico del menú')}
            </Link>.
          </p>
        </div>
      </div>
    </div>
  )
}

const closeBtn: CSSProperties = {
  flex: '0 0 auto', width: 36, height: 36, borderRadius: 8,
  border: '1px solid #E7E6E2', background: 'transparent', color: '#6B6B70',
  cursor: 'pointer', fontFamily: 'inherit', fontSize: 18, lineHeight: 1,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}

function Cell({ label, value, isFirst }: { label: string; value: string; isFirst?: boolean }) {
  return (
    <div style={{
      flex: 1, padding: '18px 20px',
      borderLeft: isFirst ? 'none' : '1px solid #E7E6E2',
    }}>
      <div style={eyebrow}>{label}</div>
      <div style={mono({ fontSize: 26, fontWeight: 600, lineHeight: 1, color: '#18181B', marginTop: 10 })}>
        {value}
      </div>
    </div>
  )
}

function FooterLink({ t }: { t: (en: string, es?: string) => string }) {
  return (
    <div style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid #E7E6E2' }}>
      <p style={{ fontSize: 14, color: '#9CA3AF', margin: 0 }}>
        {t('Need to add an item, edit a recipe, or change a price?', '¿Necesitas agregar, editar la receta o cambiar un precio?')}{' '}
        <Link href="/menu" style={{ color: '#18181B', textDecoration: 'underline', textUnderlineOffset: 3 }}>
          {t('Open the classic menu workspace', 'Abre el espacio clásico del menú')}
        </Link>.
      </p>
    </div>
  )
}
