// ----------------------------------------------------------------
// Web-native Home  →  /web/home
//
// Phase 1 deliverable. This page exists to set the visual tone for
// the new browser-first operator experience. It is NOT a dashboard
// in the traditional sense — no KPI panels, no widget grid, no
// fixed-position chrome. It reads like a section of the marketing
// site: large monospace eyebrows, type-led headlines, generous
// whitespace, content flows top-down.
//
// Each module gets a preview block: title, one or two real numbers
// pulled cheaply, a CTA into the deeper module page. Modules that
// haven't been converted yet say "coming soon" plainly rather than
// fake a state. Honesty over polish.
//
// As we deepen each module (Inventory first), the preview block
// for that module gets richer — but the page structure stays the
// same. New modules append to the list as they ship.
// ----------------------------------------------------------------

import Link from 'next/link'
import type { CSSProperties } from 'react'
import { createClient } from '@/lib/supabase/server'
import { getLang, getT } from '@/lib/i18n-server'

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

export default async function WebHomePage() {
  const supabase = await createClient()
  const lang = await getLang()
  const t = await getT()

  // The layout already gated this — user + role are guaranteed
  // here. We just want the restaurant name + a few light counts to
  // animate the page. Anything heavier belongs inside a module.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data: userRole } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user!.id)
    .single()
  const restaurantId = userRole!.restaurant_id

  const [{ data: restaurant }, { count: itemCount }, { count: lowStockCount }] =
    await Promise.all([
      supabase.from('restaurants').select('name').eq('id', restaurantId).single(),
      // Total active inventory items — gives the home page a concrete
      // first number to show. Doesn't need to be a heavy query.
      supabase
        .from('inventory_items')
        .select('id', { count: 'exact', head: true })
        .eq('active', true),
      // Items where the most recent count is at or below threshold.
      // For Phase 1 we approximate via a simple join + filter. If
      // this gets slow it can move into a materialized view later.
      supabase
        .from('inventory_items')
        .select('id, low_stock_threshold', { count: 'exact', head: true })
        .eq('active', true)
        .not('low_stock_threshold', 'is', null),
    ])

  // Date formatting — server side, deliberately uncluttered.
  // "WED · MAR 14" feels closer to the marketing site's eyebrow
  // texture than a long ISO timestamp. Language switches the
  // weekday and month abbreviation.
  const now = new Date()
  const dateLabel = formatDate(now, lang)

  return (
    <div style={wrap({ padding: '56px 24px 96px' })}>
      {/* HEAD — restaurant + date eyebrow, then the page title.
          Mirrors the marketing site's "ACT 01" rhythm: small label
          on top, big headline below, then a short paragraph that
          frames what this page is for. */}
      <div style={{ marginBottom: 56 }}>
        <div style={eyebrow}>
          {(restaurant?.name ?? 'Restaurant')} · {dateLabel}
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
          {t('Today’s read.', 'Lectura de hoy.')}
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
            'A quick look at where every part of the operation sits right now. Click into any module to go deeper.',
            'Un vistazo rápido a dónde está cada parte de la operación ahora. Entra a cualquier módulo para profundizar.'
          )}
        </p>
      </div>

      {/* MODULE PREVIEW: INVENTORY — the first module being deepened.
          Real numbers, real CTA. As inventory's web-native pages
          ship in Phase 2, this block can grow to show today's most
          urgent items, projected stockouts, etc. For now: the count
          and the low-stock count, plus the door in. */}
      <ModuleBlock
        eyebrow={t('Inventory', 'Inventario')}
        title={t('Stock counts itself.', 'El inventario se cuenta solo.')}
        body={t(
          'Every Square sale deducts the right ingredients automatically. Recipe-level — not catalog-level.',
          'Cada venta en Square descuenta los ingredientes correctos automáticamente. Por receta, no por catálogo.'
        )}
        stats={[
          { value: String(itemCount ?? 0), label: t('items tracked', 'artículos en seguimiento') },
          { value: String(lowStockCount ?? 0), label: t('with reorder thresholds', 'con punto de reorden') },
        ]}
        ctaHref="/web/inventory"
        ctaLabel={t('Open inventory', 'Abrir inventario')}
      />

      {/* MODULE PREVIEWS: PIPELINE — these are honest "coming soon"
          blocks for the modules being deepened next (Staffing →
          Payroll, then Finance, then Online Presence). When each
          ships its web-native version, this block converts into a
          real preview like Inventory above. */}
      <ModuleBlock
        eyebrow={t('Staffing + Payroll', 'Personal + Nómina')}
        title={t('Hours flow into payroll.', 'Las horas fluyen a nómina.')}
        body={t(
          'Schedule, time clock, labor cost real-time. Hours land in payroll automatically — no re-keying on Sunday night.',
          'Horario, reloj, costo de mano de obra en vivo. Las horas llegan a nómina automáticamente — sin volver a capturar el domingo.'
        )}
        comingSoon
      />

      <ModuleBlock
        eyebrow={t('Finance', 'Finanzas')}
        title={t('Net today, not net month-end.', 'Utilidad de hoy, no de fin de mes.')}
        body={t(
          'Bank context from Plaid, COGS from inventory, labor from staffing. Real-time profit — no Sunday-night reconstruction.',
          'Contexto del banco vía Plaid, COGS del inventario, mano de obra del personal. Utilidad en vivo — sin reconstruir el domingo.'
        )}
        comingSoon
      />

      <ModuleBlock
        eyebrow={t('Online presence', 'Presencia en línea')}
        title={t('A home page that sells.', 'Una página que vende.')}
        body={t(
          'A real website and storefront under your brand. Orders flow back into Square and deduct inventory automatically.',
          'Un sitio real y tienda en línea con tu marca. Las órdenes fluyen a Square y descuentan inventario automáticamente.'
        )}
        comingSoon
      />
    </div>
  )
}

// ----------------------------------------------------------------
// ModuleBlock — one section of the home page. Marketing-style:
// monospace eyebrow, big headline, short body paragraph, then
// either stat lines + a CTA (live module) or a calm "in build"
// label (pipeline module). No card chrome, no boxes — just type
// and a hairline divider between blocks.
// ----------------------------------------------------------------
interface Stat {
  value: string
  label: string
}

interface ModuleBlockProps {
  eyebrow: string
  title: string
  body: string
  stats?: Stat[]
  ctaHref?: string
  ctaLabel?: string
  comingSoon?: boolean
}

function ModuleBlock({
  eyebrow: eyebrowText,
  title,
  body,
  stats,
  ctaHref,
  ctaLabel,
  comingSoon,
}: ModuleBlockProps) {
  return (
    <section
      style={{
        borderTop: '1px solid #E7E6E2',
        padding: '40px 0',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        gap: 'clamp(20px, 4vw, 60px)',
        alignItems: 'start',
      }}
    >
      {/* LEFT COLUMN: eyebrow + title + body */}
      <div>
        <div style={eyebrow}>{eyebrowText}</div>
        <h2
          style={{
            fontSize: 'clamp(22px, 2.6vw, 30px)',
            lineHeight: 1.1,
            letterSpacing: '-0.8px',
            fontWeight: 700,
            margin: '10px 0 0',
            color: '#18181B',
          }}
        >
          {title}
        </h2>
        <p
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            color: '#52525B',
            margin: '14px 0 0',
            maxWidth: 480,
          }}
        >
          {body}
        </p>
      </div>

      {/* RIGHT COLUMN: stats + CTA, or pipeline label */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 18 }}>
        {stats && stats.length > 0 && (
          <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
            {stats.map((s) => (
              <div key={s.label}>
                <div
                  style={mono({
                    fontSize: 32,
                    fontWeight: 600,
                    lineHeight: 1,
                    color: '#18181B',
                  })}
                >
                  {s.value}
                </div>
                <div style={{ ...eyebrow, marginTop: 8 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {ctaHref && ctaLabel && !comingSoon && (
          <Link
            href={ctaHref}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              background: '#18181B',
              color: '#FAF9F6',
              textDecoration: 'none',
              fontSize: 14,
              fontWeight: 600,
              padding: '11px 18px',
              borderRadius: 10,
            }}
          >
            {ctaLabel}
            <span style={mono({ fontSize: 14 })}>&rarr;</span>
          </Link>
        )}

        {comingSoon && (
          <div
            style={{
              ...eyebrow,
              color: '#9CA3AF',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#D4D7DD',
                display: 'inline-block',
              }}
            />
            In build
          </div>
        )}
      </div>
    </section>
  )
}

// Cheap, dependency-free date formatter. Marketing-eyebrow texture:
// "WED · MAR 14". Spanish swaps the weekday/month abbreviations.
function formatDate(d: Date, lang: 'en' | 'es'): string {
  const weekdaysEn = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
  const monthsEn = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
  const weekdaysEs = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB']
  const monthsEs = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']
  const w = lang === 'es' ? weekdaysEs[d.getDay()] : weekdaysEn[d.getDay()]
  const m = lang === 'es' ? monthsEs[d.getMonth()] : monthsEn[d.getMonth()]
  return `${w} · ${m} ${d.getDate()}`
}
