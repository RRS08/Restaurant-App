// ----------------------------------------------------------------
// /catalog — every product on the tenant's online storefront.
//
// Two-column layout mirrors the retail Menu page: a category rail
// on the left partitions the storefront by section (Tea blends,
// Ointments, Accessories, …), the right column renders one row
// per product with the storefront's signal set (image, name,
// primary pill, focus, variant hint, price).
//
// Category filtering is URL-driven via ?category=<slug>. A missing
// param renders everything under an "All" chip so the merchant can
// scan the whole catalog at a glance.
//
// site_products is the ONLY source — this page never reads
// menu_items. The retail menu (Poynt/GoDaddy sync) and the online
// catalog are separate concerns with separate copy, images, and
// pricing; keeping the data sources apart matches how the
// storefront widgets already resolve products.
// ----------------------------------------------------------------

import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { normalizeGroups } from '@/lib/sites/cart-options'
import type { SiteProductRow } from '@/lib/sites/types'
import ComingSoon from '@/components/coming-soon'

export const metadata = { title: 'Catalog · Checked' }

const INK = '#18181B'
const MUTED = '#6B6B70'
const FAINT = '#A1A1A6'
const LINE = '#E7E6E2'
const LINE_SOFT = '#F0EFEB'
const SURFACE = '#FAFAF9'
const RAIL_ACTIVE = '#F4F4F5'
const MONO = "'Geist Mono', ui-monospace, monospace"

// Display labels for the known slugs. Anything else falls back to
// a title-cased version of the slug, so a new category dropped
// into site_products.category shows up in the rail without a code
// change.
const CATEGORY_LABELS: Record<string, string> = {
  'tea-blends': 'Tea blends',
  'ointments': 'Ointments',
  'accessories': 'Accessories',
}

function labelFor(slug: string): string {
  return CATEGORY_LABELS[slug]
    ?? slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

interface CatalogPageProps {
  // Next 16 App Router: dynamic pages receive `searchParams` as a
  // Promise so the server can suspend on it without blocking the
  // rest of the render tree. Awaiting it inline reads cleanly.
  searchParams: Promise<{ category?: string | string[] }>
}

export default async function CatalogPage({ searchParams }: CatalogPageProps) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return <EmptyShell reason="not-signed-in" />

  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role) return <EmptyShell reason="no-restaurant" />

  const { data: site } = await supabase
    .from('sites')
    .select('id, slug, name')
    .eq('restaurant_id', role.restaurant_id)
    .maybeSingle()
  if (!site) return <EmptyShell reason="no-site" />

  const { data: products, error } = await supabase
    .from('site_products')
    .select('*')
    .eq('site_id', site.id)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
  if (error) {
    console.error('[catalog] product query failed', error)
    return <EmptyShell reason="query-error" />
  }

  const rows = (products ?? []) as SiteProductRow[]
  if (rows.length === 0) return <EmptyShell reason="no-products" />

  // Derive the category rail from the actual data — every distinct
  // non-null category, ordered by whatever the labels array
  // implies (known categories first, then anything new alphabetized).
  const categoryCounts = new Map<string, number>()
  for (const p of rows) {
    const key = p.category ?? ''
    if (!key) continue
    categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1)
  }
  const knownOrder = Object.keys(CATEGORY_LABELS)
  const categories = Array.from(categoryCounts.keys()).sort((a, b) => {
    const ai = knownOrder.indexOf(a); const bi = knownOrder.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })

  const params = await searchParams
  const rawSelected = Array.isArray(params.category) ? params.category[0] : params.category
  const selected = rawSelected && categoryCounts.has(rawSelected) ? rawSelected : ''

  const visible = selected ? rows.filter(p => (p.category ?? '') === selected) : rows

  return (
    <div style={{
      minHeight: '100vh', background: '#fff',
      fontFamily: "'Geist', system-ui, sans-serif", color: INK,
    }}>
      {/* Header band — mirrors the sales/ledger surface: mono
          eyebrow, site name, product count. Sticky so the
          catalog list scrolls under it. */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 5, background: '#fff',
        borderBottom: `1px solid ${LINE}`,
      }}>
        <div style={{ padding: '20px 24px 16px' }}>
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
              {site.name ?? 'Online storefront'}
            </h1>
            <span style={{ fontFamily: MONO, fontSize: 12, color: MUTED }}>
              {rows.length} {rows.length === 1 ? 'product' : 'products'}
            </span>
          </div>
        </div>
      </div>

      {/* Two-column body. Grid at md+ (rail | products), stacks
          on phone so the rail becomes a scannable filter strip
          at the top of the list. Both columns scroll
          independently under the sticky header. */}
      <div className="catalog-grid">
        <aside className="catalog-rail">
          <div style={{
            fontFamily: MONO, fontSize: 10, letterSpacing: '0.16em',
            color: FAINT, marginBottom: 10, padding: '0 4px',
          }}>
            CATEGORIES
          </div>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <RailLink
              href="/catalog"
              label="All"
              count={rows.length}
              active={selected === ''}
            />
            {categories.map(cat => (
              <RailLink
                key={cat}
                href={`/catalog?category=${encodeURIComponent(cat)}`}
                label={labelFor(cat)}
                count={categoryCounts.get(cat) ?? 0}
                active={selected === cat}
              />
            ))}
          </nav>
        </aside>

        <section className="catalog-list">
          {visible.length === 0 ? (
            <div style={{ padding: '32px 24px', color: FAINT, fontSize: 13 }}>
              No products in this category yet.
            </div>
          ) : visible.map(p => (
            <ProductRow key={p.id} p={p} />
          ))}
        </section>
      </div>

      {/* Responsive scaffolding — server component can't use
          Tailwind arbitrary breakpoints on nested elements as
          cleanly as inline styles, so the grid + rail rules
          live in a scoped <style> tag. Wraps to one column on
          phone; the rail turns into a horizontal scroll strip. */}
      <style>{`
        .catalog-grid { display: grid; grid-template-columns: 220px 1fr; gap: 0; }
        .catalog-rail {
          padding: 20px 16px 32px;
          border-right: 1px solid ${LINE};
          background: #fff;
          align-self: start;
          position: sticky;
          top: 74px;
        }
        .catalog-list { min-width: 0; }
        @media (max-width: 767px) {
          .catalog-grid { grid-template-columns: 1fr; }
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
          .catalog-rail nav a { white-space: nowrap; }
        }
      `}</style>
    </div>
  )
}

function RailLink({
  href, label, count, active,
}: {
  href: string
  label: string
  count: number
  active: boolean
}) {
  return (
    <Link
      href={href}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, padding: '8px 12px', borderRadius: 8,
        background: active ? RAIL_ACTIVE : 'transparent',
        color: active ? INK : '#3F3F46',
        fontSize: 13, fontWeight: active ? 600 : 500,
        textDecoration: 'none',
        transition: 'background 120ms ease',
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
    </Link>
  )
}

function ProductRow({ p }: { p: SiteProductRow }) {
  const priceNum = typeof p.price === 'number' ? p.price : parseFloat(String(p.price))
  const priceStr = Number.isFinite(priceNum) ? `$${priceNum.toFixed(2)}` : '—'
  const groups = normalizeGroups(p.options)
  const categoryLabel = labelFor(p.category ?? '')
  const isLive = p.status === 'live'
  const variantHint = groups.map(g => `${g.choices.length} ${g.label.toLowerCase()}`).join(' · ')

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '14px 24px',
        borderBottom: `1px solid ${LINE_SOFT}`,
        opacity: isLive ? 1 : 0.6,
      }}
    >
      <div style={{
        width: 44, height: 44, borderRadius: 8, flex: '0 0 auto',
        background: SURFACE, border: `1px solid ${LINE_SOFT}`,
        overflow: 'hidden',
      }}>
        {p.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.image_url}
            alt={p.name}
            width={44}
            height={44}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
      </div>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 14, fontWeight: 600, letterSpacing: '-0.015em',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {p.name}
        </div>
        <div style={{
          marginTop: 3, display: 'flex', alignItems: 'center',
          gap: 8, flexWrap: 'wrap',
        }}>
          {categoryLabel && (
            <span style={{ fontSize: 11, color: MUTED }}>{categoryLabel}</span>
          )}
          {p.benefit && (
            <>
              <Dot />
              <span style={{
                display: 'inline-flex', alignItems: 'center', borderRadius: 999,
                padding: '1px 8px', fontSize: 10, fontWeight: 600,
                background: '#EEF2FF', color: '#27306F',
              }}>
                {p.benefit}
              </span>
            </>
          )}
          {p.purpose && (
            <>
              <Dot />
              <span style={{ fontSize: 11, color: MUTED }}>{p.purpose}</span>
            </>
          )}
          {variantHint && (
            <>
              <Dot />
              <span style={{ fontSize: 11, color: MUTED }}>{variantHint}</span>
            </>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: '0 0 auto' }}>
        {p.unit && (
          <span style={{ fontSize: 11, color: FAINT, whiteSpace: 'nowrap' }}>
            {p.unit}
          </span>
        )}
        <span style={{
          fontFamily: MONO, fontSize: 15, fontWeight: 600,
          letterSpacing: '-0.02em', color: INK, whiteSpace: 'nowrap',
        }}>
          {priceStr}
        </span>
        {!isLive && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', borderRadius: 999,
            padding: '2px 8px', fontSize: 10, fontWeight: 600,
            background: '#F4F4F5', color: MUTED,
          }}>
            {p.status}
          </span>
        )}
      </div>
    </div>
  )
}

function Dot() {
  return (
    <span aria-hidden style={{
      width: 3, height: 3, borderRadius: '50%', background: LINE,
      flex: '0 0 auto',
    }} />
  )
}

function EmptyShell({ reason }: { reason: string }) {
  const copy: Record<string, { title: string; body: string }> = {
    'not-signed-in': {
      title: 'Sign in required',
      body: 'You need to be signed in to view your catalog.',
    },
    'no-restaurant': {
      title: 'No restaurant set up',
      body: 'Finish onboarding to see your online catalog.',
    },
    'no-site': {
      title: 'No online storefront yet',
      body: 'Your tenant does not have an online site configured. Add one to start listing products here.',
    },
    'no-products': {
      title: 'No products yet',
      body: 'When you add products to your online storefront, they will appear here.',
    },
    'query-error': {
      title: 'Could not load catalog',
      body: 'Something went wrong loading the catalog. Refresh to try again.',
    },
  }
  const c = copy[reason] ?? copy['query-error']
  return <ComingSoon eyebrow="CATALOG" title={c.title} body={c.body} />
}
