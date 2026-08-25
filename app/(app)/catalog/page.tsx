// ----------------------------------------------------------------
// /catalog — every product on the tenant's online storefront.
//
// Read-only surface for now. Pulls site_products for the tenant's
// site and renders one row per product with the same signal set
// the storefront card carries (image, name, primary/focus, price,
// variant hint). Empty state when the tenant has no site or the
// site has no live products yet.
//
// The nav item only appears when the active place is online, but
// this page renders regardless of active place — a direct URL
// hit still lands on the catalog rather than 404ing.
// ----------------------------------------------------------------

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
const MONO = "'Geist Mono', ui-monospace, monospace"

const CATEGORY_LABELS: Record<string, string> = {
  'tea-blends': 'Tea blends',
  'ointments': 'Ointments',
  'accessories': 'Accessories',
}

export default async function CatalogPage() {
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

  return (
    <div style={{
      minHeight: '100vh', background: '#fff',
      fontFamily: "'Geist', system-ui, sans-serif", color: INK,
    }}>
      {/* Header band — matches the sales/ledger surface: eyebrow,
          heading, small count. Sticky so the catalog list scrolls
          under it. */}
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
            <span style={{
              fontFamily: MONO, fontSize: 12, color: MUTED,
            }}>
              {rows.length} {rows.length === 1 ? 'product' : 'products'}
            </span>
          </div>
        </div>
      </div>

      {/* Product rows — one per site_products row. Hairline
          divider between each; image on the left, meta stack in
          the middle, price on the right. Wraps gracefully on
          narrow viewports (phone stacks the price under the meta). */}
      <div>
        {rows.map((p) => (
          <ProductRow key={p.id} p={p} />
        ))}
      </div>
    </div>
  )
}

function ProductRow({ p }: { p: SiteProductRow }) {
  const priceNum = typeof p.price === 'number' ? p.price : parseFloat(String(p.price))
  const priceStr = Number.isFinite(priceNum) ? `$${priceNum.toFixed(2)}` : '—'
  const groups = normalizeGroups(p.options)
  const categoryLabel = CATEGORY_LABELS[p.category ?? ''] ?? p.category ?? ''
  const isLive = p.status === 'live'

  // Variant hint: "2 forms" / "3 colors · 5 sizes" etc. Zero
  // groups → no chip, keeps the meta line clean.
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
      {/* Thumb — square 44px tile. Falls back to a placeholder
          block when the product has no image_url so the row
          doesn't collapse. */}
      <div style={{
        width: 44, height: 44, borderRadius: 8, flex: '0 0 auto',
        background: SURFACE, border: `1px solid ${LINE_SOFT}`,
        overflow: 'hidden',
      }}>
        {p.image_url && (
          // Plain <img> — this route is server-rendered and doesn't
          // sit behind next/image's optimizer; keeps the catalog
          // free of extra config for now.
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

      {/* Name + meta */}
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

      {/* Right column: price + status */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flex: '0 0 auto',
      }}>
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
