'use client'

// ----------------------------------------------------------------
// Catalog client — search, category rail, product cards, drawer
// editor, and the add-product flow.
//
// The drawer serves double duty: click a card to edit that
// product, click the "+ Add product" button to open the same
// drawer with a blank draft. Save action goes through
// createProduct / updateProduct in app/actions/catalog.ts —
// server-side guards prevent cross-tenant writes.
//
// Categories are derived from the products themselves (distinct
// site_products.category values) so a new category slug shows up
// in the rail the instant a product lands there. First-class
// category management (add empty, reorder, rename) lands in a
// follow-up alongside subsections.
// ----------------------------------------------------------------

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createProduct, updateProduct, deleteProduct, addCategory, type CatalogProductInput } from '@/app/actions/catalog'
import { normalizeGroups } from '@/lib/sites/cart-options'
import type { SiteProductRow } from '@/lib/sites/types'

const INK = '#18181B'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const LINE = '#E7E6E2'
const LINE_SOFT = '#F0EFEB'
const SURFACE = '#FAFAF9'
const RAIL_ACTIVE = '#F4F4F5'
const DANGER = '#B91C1C'
const MONO = "'Geist Mono', ui-monospace, monospace"

const CATEGORY_LABELS: Record<string, string> = {
  'tea-blends': 'Tea blends',
  'ointments': 'Ointments',
  'accessories': 'Accessories',
}

function labelFor(slug: string): string {
  return CATEGORY_LABELS[slug]
    ?? slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

type Draft = Partial<CatalogProductInput> & { id?: string }

export default function CatalogClient({
  siteName, products, persistedCategories,
}: {
  siteName: string
  products: SiteProductRow[]
  /** Empty categories the operator has explicitly added on
   *  site.config.catalog_categories. Merged with the derived
   *  categories below so the rail shows both populated and empty
   *  ones. Order in this list is preserved on the rail. */
  persistedCategories: Array<{ key: string; label: string }>
}) {
  const [selected, setSelected] = useState<string>('')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCategoryLabel, setNewCategoryLabel] = useState('')
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [savingCategory, startCategorySave] = useTransition()
  const router = useRouter()

  // Category rail data — merge two sources:
  //   1. persistedCategories from site.config (empty ones the
  //      operator added; kept even when no product uses them)
  //   2. distinct site_products.category slugs (populated ones)
  // Persisted order wins; anything derived-only appends after,
  // known slugs first (tea-blends, ointments, accessories), then
  // alphabetical for anything new.
  const categoryCounts = new Map<string, number>()
  for (const p of products) {
    const key = p.category ?? ''
    if (!key) continue
    categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1)
  }
  const labelByKey = new Map<string, string>()
  for (const c of persistedCategories) labelByKey.set(c.key, c.label)
  const knownOrder = Object.keys(CATEGORY_LABELS)
  const derivedOnly = Array.from(categoryCounts.keys())
    .filter(k => !labelByKey.has(k))
    .sort((a, b) => {
      const ai = knownOrder.indexOf(a); const bi = knownOrder.indexOf(b)
      if (ai === -1 && bi === -1) return a.localeCompare(b)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
  const categories: Array<{ key: string; label: string }> = [
    ...persistedCategories.map(c => ({ key: c.key, label: c.label })),
    ...derivedOnly.map(k => ({ key: k, label: labelFor(k) })),
  ]

  function handleAddCategory() {
    const label = newCategoryLabel.trim()
    if (!label) return
    setCategoryError(null)
    startCategorySave(async () => {
      const result = await addCategory(label)
      if ('error' in result) {
        setCategoryError(result.error)
      } else {
        setNewCategoryLabel('')
        setAddingCategory(false)
        router.refresh()
      }
    })
  }

  // Filter chain: category → search. Search matches name, slug,
  // secondary_name, benefit, purpose (all lowercased for a
  // case-insensitive scan).
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products.filter(p => {
      if (selected && (p.category ?? '') !== selected) return false
      if (!q) return true
      const hay = [
        p.name, p.slug, p.secondary_name, p.benefit, p.purpose, p.ingredients,
      ].filter(Boolean).map(s => (s as string).toLowerCase())
      return hay.some(h => h.includes(q))
    })
  }, [products, selected, query])

  function openEdit(p: SiteProductRow) {
    setDraft(productToDraft(p))
  }

  function openNew() {
    setDraft({
      name: '',
      category: selected || 'tea-blends',
      price: 0,
      status: 'live',
    })
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#fff', color: INK,
      fontFamily: "'Geist', system-ui, sans-serif",
    }}>
      {/* Sticky header — mono eyebrow, site name, count, then a
          search box on the right and an Add-product CTA. */}
      <div style={{ position: 'sticky', top: 0, zIndex: 5, background: '#fff', borderBottom: `1px solid ${LINE}` }}>
        <div style={{
          padding: '20px 24px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, flexWrap: 'wrap',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em',
              color: FAINT, marginBottom: 6,
            }}>
              CATALOG
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <h1 style={{
                margin: 0, fontSize: 21, fontWeight: 700,
                letterSpacing: '-0.035em', whiteSpace: 'nowrap',
              }}>
                {siteName}
              </h1>
              <span style={{ fontFamily: MONO, fontSize: 12, color: MUTED }}>
                {products.length} {products.length === 1 ? 'product' : 'products'}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              border: `1px solid ${LINE}`, borderRadius: 999,
              padding: '6px 12px', background: SURFACE,
              minWidth: 240,
            }}>
              <SearchIcon />
              <input
                type="search"
                placeholder="Search products"
                value={query}
                onChange={e => setQuery(e.target.value)}
                style={{
                  flex: 1, minWidth: 0, border: 0, outline: 'none',
                  background: 'transparent', font: 'inherit', fontSize: 13,
                  color: INK,
                }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  style={{
                    border: 0, background: 'transparent', padding: 0,
                    color: FAINT, fontSize: 14, cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={openNew}
              style={{
                border: 0, background: INK, color: '#FAF9F6',
                borderRadius: 10, padding: '9px 16px',
                font: 'inherit', fontSize: 13, fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              + Add product
            </button>
          </div>
        </div>
      </div>

      {/* Two-column body. Rail on the left, card grid on the
          right. Same responsive scaffolding as before. */}
      <div className="catalog-grid">
        <aside className="catalog-rail">
          <div style={{
            fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em',
            color: FAINT, marginBottom: 10, padding: '0 4px',
          }}>
            CATEGORIES
          </div>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <RailLink label="All" count={products.length} active={selected === ''} onClick={() => setSelected('')} />
            {categories.map(cat => (
              <RailLink
                key={cat.key}
                label={cat.label}
                count={categoryCounts.get(cat.key) ?? 0}
                active={selected === cat.key}
                onClick={() => setSelected(cat.key)}
              />
            ))}
            {/* + Add category — inline input expands from the
                rail's bottom. Empty categories persist via
                addCategory() so they stay in the rail (and on
                the shop's filter chips) even without products. */}
            {addingCategory ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 4px 0' }}>
                <input
                  type="text"
                  autoFocus
                  value={newCategoryLabel}
                  placeholder="Category name"
                  onChange={e => setNewCategoryLabel(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); handleAddCategory() }
                    else if (e.key === 'Escape') {
                      setAddingCategory(false); setNewCategoryLabel(''); setCategoryError(null)
                    }
                  }}
                  disabled={savingCategory}
                  style={{
                    padding: '7px 10px', font: 'inherit', fontSize: 13,
                    border: `1px solid ${LINE}`, borderRadius: 8, background: '#fff',
                    color: INK, outline: 'none',
                  }}
                />
                {categoryError && (
                  <div style={{ fontSize: 11, color: DANGER }}>{categoryError}</div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingCategory(false); setNewCategoryLabel(''); setCategoryError(null)
                    }}
                    disabled={savingCategory}
                    style={{
                      flex: 1, border: `1px solid ${LINE}`, background: '#fff', color: '#3F3F46',
                      borderRadius: 8, padding: '6px 10px', font: 'inherit',
                      fontSize: 12, fontWeight: 500,
                      cursor: savingCategory ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleAddCategory}
                    disabled={savingCategory || !newCategoryLabel.trim()}
                    style={{
                      flex: 1, border: 0, background: INK, color: '#FAF9F6',
                      borderRadius: 8, padding: '7px 10px', font: 'inherit',
                      fontSize: 12, fontWeight: 600,
                      cursor: savingCategory ? 'wait' : 'pointer',
                      opacity: savingCategory || !newCategoryLabel.trim() ? 0.6 : 1,
                    }}
                  >
                    {savingCategory ? 'Adding…' : 'Add'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingCategory(true)}
                style={{
                  marginTop: 6, padding: '8px 12px', borderRadius: 8,
                  background: 'transparent', color: MUTED,
                  fontSize: 13, fontWeight: 500,
                  border: `1px dashed ${LINE}`, cursor: 'pointer',
                  textAlign: 'left', font: 'inherit',
                }}
              >
                + Add category
              </button>
            )}
          </nav>
        </aside>

        <section className="catalog-cards">
          {visible.length === 0 ? (
            <div style={{ padding: '32px 24px', color: FAINT, fontSize: 13, gridColumn: '1 / -1' }}>
              {query
                ? `No products match "${query}".`
                : 'No products in this category yet.'}
            </div>
          ) : visible.map(p => (
            <ProductCard key={p.id} p={p} onClick={() => openEdit(p)} />
          ))}
        </section>
      </div>

      {draft && (
        <ProductDrawer
          draft={draft}
          onClose={() => setDraft(null)}
        />
      )}

      <style>{`
        .catalog-grid { display: grid; grid-template-columns: 220px 1fr; gap: 0; }
        .catalog-rail {
          padding: 20px 16px 32px;
          border-right: 1px solid ${LINE};
          background: #fff;
          align-self: start;
          position: sticky;
          top: 90px;
        }
        .catalog-cards {
          min-width: 0;
          padding: 20px 24px 32px;
          display: grid;
          gap: 16px;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          align-content: start;
        }
        @media (max-width: 767px) {
          .catalog-grid { grid-template-columns: 1fr; }
          .catalog-cards { padding: 16px; grid-template-columns: repeat(2, 1fr); gap: 12px; }
          .catalog-rail {
            border-right: 0;
            border-bottom: 1px solid ${LINE};
            padding: 14px 16px;
            position: static;
            overflow-x: auto;
          }
          .catalog-rail nav {
            flex-direction: row !important;
            gap: 6px !important;
            flex-wrap: nowrap;
          }
        }
        @media (max-width: 420px) {
          .catalog-cards { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  )
}

// ================================================================
// Rail
// ================================================================

function RailLink({ label, count, active, onClick }: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, padding: '8px 12px', borderRadius: 8,
        background: active ? RAIL_ACTIVE : 'transparent',
        color: active ? INK : '#3F3F46',
        fontSize: 13, fontWeight: active ? 600 : 500,
        border: 0, cursor: 'pointer', textAlign: 'left', font: 'inherit',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <span style={{
        fontFamily: MONO, fontSize: 11,
        color: active ? MUTED : FAINT,
      }}>
        {count}
      </span>
    </button>
  )
}

// ================================================================
// Card
// ================================================================

function ProductCard({ p, onClick }: { p: SiteProductRow; onClick: () => void }) {
  const priceNum = typeof p.price === 'number' ? p.price : parseFloat(String(p.price))
  const priceStr = Number.isFinite(priceNum) ? `$${priceNum.toFixed(2)}` : '—'
  const groups = normalizeGroups(p.options)
  const isLive = p.status === 'live'
  const variantHint = groups.map(g => `${g.choices.length} ${g.label.toLowerCase()}`).join(' · ')

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${LINE}`, borderRadius: 12,
        background: '#fff', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        opacity: isLive ? 1 : 0.6,
        cursor: 'pointer', padding: 0, textAlign: 'left', font: 'inherit',
        color: 'inherit',
      }}
    >
      <div style={{
        aspectRatio: '1 / 1', background: SURFACE,
        borderBottom: `1px solid ${LINE_SOFT}`,
        overflow: 'hidden',
      }}>
        {p.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.image_url}
            alt={p.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
      </div>
      <div style={{
        padding: '12px 14px 14px',
        display: 'flex', flexDirection: 'column', gap: 8, flex: 1,
      }}>
        <div style={{
          fontSize: 14, fontWeight: 600, letterSpacing: '-0.015em', color: INK,
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
          lineHeight: 1.25,
        }}>
          {p.name}
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          minHeight: 20,
        }}>
          {p.benefit && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', borderRadius: 999,
              padding: '1px 8px', fontSize: 10, fontWeight: 600,
              background: '#EEF2FF', color: '#27306F',
            }}>
              {p.benefit}
            </span>
          )}
          {p.purpose && (
            <span style={{ fontSize: 11, color: MUTED }}>{p.purpose}</span>
          )}
          {variantHint && (
            <>
              {(p.benefit || p.purpose) && <span aria-hidden style={{ width: 3, height: 3, borderRadius: '50%', background: LINE }} />}
              <span style={{ fontSize: 11, color: MUTED }}>{variantHint}</span>
            </>
          )}
        </div>
        <div style={{
          marginTop: 'auto', paddingTop: 6,
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: 8, borderTop: `1px solid ${LINE_SOFT}`,
        }}>
          {p.unit && (
            <span style={{ fontSize: 11, color: FAINT, whiteSpace: 'nowrap' }}>
              {p.unit}
            </span>
          )}
          <span style={{
            fontFamily: MONO, fontSize: 15, fontWeight: 600,
            letterSpacing: '-0.02em', color: INK, whiteSpace: 'nowrap',
            marginLeft: 'auto',
          }}>
            {priceStr}
          </span>
        </div>
        {!isLive && (
          <span style={{
            alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center',
            borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 600,
            background: '#F4F4F5', color: MUTED,
          }}>
            {p.status}
          </span>
        )}
      </div>
    </button>
  )
}

// ================================================================
// Drawer / editor
// ================================================================

function productToDraft(p: SiteProductRow): Draft {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    secondary_name: p.secondary_name ?? '',
    category: p.category ?? '',
    price: typeof p.price === 'number' ? p.price : parseFloat(String(p.price)),
    unit: p.unit ?? '',
    benefit: p.benefit ?? '',
    purpose: p.purpose ?? '',
    short_description: p.short_description ?? '',
    long_description: p.long_description ?? '',
    ritual: p.ritual ?? '',
    ritual_label: p.ritual_label ?? '',
    ingredients: p.ingredients ?? '',
    image_url: p.image_url ?? '',
    featured: p.featured ?? false,
    status: (p.status === 'draft' ? 'draft' : 'live'),
    sort_order: p.sort_order,
    options: p.options,
  }
}

function ProductDrawer({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<Draft>(draft)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const isEdit = !!form.id

  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  function save() {
    setError(null)
    startTransition(async () => {
      const payload: CatalogProductInput = {
        name: (form.name ?? '').trim(),
        slug: form.slug?.trim() || undefined,
        secondary_name: form.secondary_name ?? null,
        category: form.category ?? null,
        price: typeof form.price === 'number' ? form.price : 0,
        unit: form.unit ?? null,
        benefit: form.benefit ?? null,
        purpose: form.purpose ?? null,
        short_description: form.short_description ?? null,
        long_description: form.long_description ?? null,
        ritual: form.ritual ?? null,
        ritual_label: form.ritual_label ?? null,
        ingredients: form.ingredients ?? null,
        image_url: form.image_url ?? null,
        featured: !!form.featured,
        status: form.status === 'draft' ? 'draft' : 'live',
        sort_order: form.sort_order ?? null,
        options: form.options,
      }
      const result = isEdit
        ? await updateProduct(form.id!, payload)
        : await createProduct(payload)
      if ('error' in result) {
        setError(result.error)
      } else {
        router.refresh()
        onClose()
      }
    })
  }

  function remove() {
    if (!form.id) return
    setError(null)
    startTransition(async () => {
      const result = await deleteProduct(form.id!)
      if ('error' in result) {
        setError(result.error)
        setConfirmingDelete(false)
      } else {
        router.refresh()
        onClose()
      }
    })
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 40, display: 'flex', justifyContent: 'flex-end',
      color: INK, fontFamily: "'Geist', system-ui, sans-serif",
    }}>
      <div
        onClick={pending ? undefined : onClose}
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(24,24,27,0.28)',
          cursor: pending ? 'wait' : 'pointer',
        }}
      />
      <div style={{
        position: 'relative', width: 520, maxWidth: '100%', flex: '0 0 520px',
        height: '100vh', background: '#fff',
        borderLeft: `1px solid ${LINE}`, boxShadow: '-24px 0 48px rgba(24,24,27,0.10)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '18px 24px 14px', borderBottom: `1px solid ${LINE}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em', color: FAINT }}>
              {isEdit ? 'EDIT PRODUCT' : 'NEW PRODUCT'}
            </div>
            <div style={{
              marginTop: 4, fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {form.name || 'Untitled product'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Close"
            style={{
              border: `1px solid ${LINE}`, background: '#fff', borderRadius: 8,
              width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
              font: 'inherit', fontSize: 15, color: MUTED,
              cursor: pending ? 'not-allowed' : 'pointer', flex: '0 0 auto',
              opacity: pending ? 0.4 : 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 24px 24px' }}>
          <FormRow label="Name" required>
            <TextInput value={form.name ?? ''} onChange={v => set('name', v)} />
          </FormRow>
          <Field2Col>
            <FormRow label="Slug" hint="URL segment. Auto-generated on save if blank.">
              <TextInput value={form.slug ?? ''} onChange={v => set('slug', v)} placeholder="auto" />
            </FormRow>
            <FormRow label="Status">
              <Select
                value={form.status ?? 'live'}
                onChange={v => set('status', v as 'live' | 'draft')}
                options={[{ value: 'live', label: 'Live' }, { value: 'draft', label: 'Draft' }]}
              />
            </FormRow>
          </Field2Col>

          <FormRow label="Secondary name" hint="Small kicker under the title on the PDP.">
            <TextInput value={form.secondary_name ?? ''} onChange={v => set('secondary_name', v)} />
          </FormRow>

          <Field2Col>
            <FormRow label="Category">
              <TextInput
                value={form.category ?? ''}
                onChange={v => set('category', v)}
                placeholder="tea-blends"
              />
            </FormRow>
            <FormRow label="Unit" hint="e.g. 3 oz pouch, 50 g tin">
              <TextInput value={form.unit ?? ''} onChange={v => set('unit', v)} />
            </FormRow>
          </Field2Col>

          <Field2Col>
            <FormRow label="Price" required>
              <TextInput
                value={String(form.price ?? '')}
                onChange={v => set('price', parseFloat(v) || 0)}
                placeholder="0.00"
                inputMode="decimal"
              />
            </FormRow>
            <FormRow label="Sort order" hint="Lower = earlier. Blank = alphabetical.">
              <TextInput
                value={form.sort_order == null ? '' : String(form.sort_order)}
                onChange={v => set('sort_order', v === '' ? null : parseInt(v, 10))}
                placeholder="—"
                inputMode="numeric"
              />
            </FormRow>
          </Field2Col>

          <Field2Col>
            <FormRow label="Primary benefit" hint="Blue pill on the card (e.g. Sleep, Energy).">
              <TextInput value={form.benefit ?? ''} onChange={v => set('benefit', v)} />
            </FormRow>
            <FormRow label="Focus" hint="One word — Flavor or Health.">
              <TextInput value={form.purpose ?? ''} onChange={v => set('purpose', v)} />
            </FormRow>
          </Field2Col>

          <FormRow label="Description" hint="Body paragraph on the PDP.">
            <TextArea value={form.long_description ?? ''} onChange={v => set('long_description', v)} rows={4} />
          </FormRow>

          <FormRow label="Ingredients">
            <TextArea value={form.ingredients ?? ''} onChange={v => set('ingredients', v)} rows={2} />
          </FormRow>

          <Field2Col>
            <FormRow label="Ritual / steep" hint='e.g. "190°F · 5–10 minutes"'>
              <TextInput value={form.ritual ?? ''} onChange={v => set('ritual', v)} />
            </FormRow>
            <FormRow label="Ritual label" hint='Defaults to "How to steep" if blank.'>
              <TextInput value={form.ritual_label ?? ''} onChange={v => set('ritual_label', v)} />
            </FormRow>
          </Field2Col>

          <FormRow label="Image URL">
            <TextInput value={form.image_url ?? ''} onChange={v => set('image_url', v)} placeholder="/assets/example.png" />
          </FormRow>

          <label style={{
            display: 'flex', alignItems: 'center', gap: 8, marginTop: 12,
            fontSize: 13, color: INK, cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={!!form.featured}
              onChange={e => set('featured', e.target.checked)}
              style={{ margin: 0 }}
            />
            Featured (appears in the shop's "Featured" strip)
          </label>

          {isEdit && (
            <div style={{
              marginTop: 24, padding: '12px 14px', border: `1px solid ${LINE}`,
              borderRadius: 10, background: SURFACE,
            }}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
                Options / variants are edited via the JSON below for now.
                A visual editor lands with subsections in a follow-up.
              </div>
              <TextArea
                value={JSON.stringify(form.options ?? null, null, 2)}
                onChange={v => {
                  try { set('options', v.trim() === '' ? null : JSON.parse(v)) }
                  catch { /* leave as-is on parse error; the raw string
                             stays in the textarea until it's valid */ }
                }}
                rows={6}
                mono
              />
            </div>
          )}
        </div>

        <div style={{
          borderTop: `1px solid ${LINE}`, padding: '14px 24px',
          display: 'flex', alignItems: 'center', gap: 10, background: '#fff',
        }}>
          {isEdit && !confirmingDelete && (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={pending}
              style={{
                border: `1px solid ${LINE}`, background: '#fff', color: DANGER,
                borderRadius: 9, padding: '9px 14px', font: 'inherit',
                fontSize: 13, fontWeight: 500, cursor: pending ? 'not-allowed' : 'pointer',
              }}
            >
              Delete
            </button>
          )}
          {confirmingDelete && (
            <>
              <span style={{ fontSize: 12, color: DANGER, marginRight: 'auto' }}>
                Delete this product? This can't be undone.
              </span>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={pending}
                style={{
                  border: `1px solid ${LINE}`, background: '#fff', color: '#3F3F46',
                  borderRadius: 9, padding: '9px 14px', font: 'inherit',
                  fontSize: 13, fontWeight: 500, cursor: pending ? 'not-allowed' : 'pointer',
                }}
              >
                Keep it
              </button>
              <button
                type="button"
                onClick={remove}
                disabled={pending}
                style={{
                  border: 0, background: DANGER, color: '#fff',
                  borderRadius: 9, padding: '10px 16px', font: 'inherit',
                  fontSize: 13, fontWeight: 600, cursor: pending ? 'wait' : 'pointer',
                  opacity: pending ? 0.7 : 1,
                }}
              >
                {pending ? 'Deleting…' : 'Delete for good'}
              </button>
            </>
          )}
          {!confirmingDelete && (
            <>
              <div style={{ marginLeft: 'auto' }} />
              {error && <span style={{ fontSize: 12, color: DANGER }}>{error}</span>}
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                style={{
                  border: `1px solid ${LINE}`, background: '#fff', color: '#3F3F46',
                  borderRadius: 9, padding: '9px 14px', font: 'inherit',
                  fontSize: 13, fontWeight: 500, cursor: pending ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={pending}
                style={{
                  border: 0, background: INK, color: '#FAF9F6',
                  borderRadius: 9, padding: '10px 16px', font: 'inherit',
                  fontSize: 13, fontWeight: 600, cursor: pending ? 'wait' : 'pointer',
                  opacity: pending ? 0.75 : 1,
                }}
              >
                {pending ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save changes' : 'Create product')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ================================================================
// Form primitives — small so the drawer stays readable
// ================================================================

function FormRow({
  label, hint, required, children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{
        display: 'block', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: MUTED, fontWeight: 600, marginBottom: 5,
      }}>
        {label}{required && <span style={{ color: DANGER, marginLeft: 3 }}>*</span>}
      </label>
      {children}
      {hint && (
        <div style={{ fontSize: 11, color: FAINT, marginTop: 4 }}>{hint}</div>
      )}
    </div>
  )
}

function Field2Col({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      {children}
    </div>
  )
}

function TextInput({
  value, onChange, placeholder, inputMode,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  inputMode?: 'text' | 'decimal' | 'numeric'
}) {
  return (
    <input
      type="text"
      inputMode={inputMode}
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', padding: '9px 12px', font: 'inherit', fontSize: 13,
        border: `1px solid ${LINE}`, borderRadius: 8, background: '#fff',
        color: INK, outline: 'none',
      }}
    />
  )
}

function TextArea({
  value, onChange, rows, mono,
}: {
  value: string
  onChange: (v: string) => void
  rows: number
  mono?: boolean
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', padding: '9px 12px', font: 'inherit',
        fontSize: mono ? 12 : 13,
        fontFamily: mono ? MONO : "'Geist', system-ui, sans-serif",
        border: `1px solid ${LINE}`, borderRadius: 8, background: '#fff',
        color: INK, outline: 'none', resize: 'vertical', lineHeight: 1.5,
      }}
    />
  )
}

function Select({
  value, onChange, options,
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', padding: '9px 12px', font: 'inherit', fontSize: 13,
        border: `1px solid ${LINE}`, borderRadius: 8, background: '#fff',
        color: INK, outline: 'none',
      }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14 14l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
