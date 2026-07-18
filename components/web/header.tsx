'use client'

// ----------------------------------------------------------------
// WebHeader — top navigation for the web-native operator experience.
//
// Visually a sibling of the marketing site nav: cream background,
// subtle bottom border, BrandLockup on the left, monospace module
// links in the middle, account dropdown on the right. The whole
// point is brand continuity — someone scrolling from onchecked.app
// straight into their logged-in dashboard should feel like they're
// in the same product, not switching to a different "app".
//
// Module links use monospace + uppercase + letter-spacing to mirror
// the marketing site's eyebrow texture. Active state lights ink
// (#18181B); idle stays at slate (#52525B). Hover slides toward ink.
//
// The account dropdown is intentionally minimal — restaurant name,
// signed-in email, and a Sign out action. Future: account/billing/
// team links as those surfaces ship.
// ----------------------------------------------------------------

import { useState, useRef, useEffect, type CSSProperties } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BrandLockup } from '@/components/brand'
import { makeT, type Lang } from '@/lib/i18n'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'

interface Props {
  restaurantName: string
  userFullName: string | null
  userEmail: string
  lang: Lang
}

interface SubLink {
  href: string
  label: string
}

interface NavLink {
  href: string
  label: string
  matchPrefix: string
  /** Sub-pages shown in a hover dropdown beneath the module link.
   *  When omitted, the module behaves as a single page (no dropdown). */
  subLinks?: SubLink[]
}

export default function WebHeader({ restaurantName, userFullName, userEmail, lang }: Props) {
  const t = makeT(lang)
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Hover dropdown state — at most one module's sub-menu is open at
  // a time. Tracked by the module's href. Open/close use short
  // timers so the dropdown doesn't flicker as the cursor moves
  // between the label and the dropdown body.
  const [openModule, setOpenModule] = useState<string | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelTimers = () => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }
  const scheduleOpen = (href: string) => {
    cancelTimers()
    openTimer.current = setTimeout(() => setOpenModule(href), 60)
  }
  const scheduleClose = () => {
    cancelTimers()
    closeTimer.current = setTimeout(() => setOpenModule(null), 160)
  }

  // Close the account menu when the user clicks outside it.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  // Close the hover dropdown when navigating to a new page.
  useEffect(() => {
    cancelTimers()
    setOpenModule(null)
  }, [pathname])

  // Full module set with sub-pages mirrored from each module's
  // layout.tsx sub-nav. Hovering a module label opens the dropdown
  // with its Overview + sub-pages. Clicking the module label itself
  // still navigates to its Overview, so the click behavior stays
  // intuitive even when a sub-menu is hover-able.
  const links: NavLink[] = [
    {
      href: '/web/sales', label: t('Sales', 'Ventas'), matchPrefix: '/web/sales',
      subLinks: [
        { href: '/web/sales',         label: t('Overview', 'Resumen') },
        { href: '/web/sales/history', label: t('History',  'Historial') },
      ],
    },
    {
      href: '/web/menu', label: t('Menu', 'Menú'), matchPrefix: '/web/menu',
      subLinks: [
        { href: '/web/menu',            label: t('Overview',   'Resumen') },
        { href: '/web/menu/categories', label: t('Categories', 'Categorías') },
      ],
    },
    {
      href: '/web/inventory', label: t('Inventory', 'Inventario'), matchPrefix: '/web/inventory',
      subLinks: [
        { href: '/web/inventory',         label: t('Overview', 'Resumen') },
        { href: '/web/inventory/counts',  label: t('Counts',   'Conteos') },
        { href: '/web/inventory/restock', label: t('Restock',  'Reorden') },
      ],
    },
    {
      href: '/web/staffing', label: t('Staffing', 'Personal'), matchPrefix: '/web/staffing',
      subLinks: [
        { href: '/web/staffing',          label: t('Overview', 'Resumen') },
        { href: '/web/staffing/schedule', label: t('Schedule', 'Horario') },
        { href: '/web/staffing/roster',   label: t('Roster',   'Equipo') },
        { href: '/web/staffing/time',     label: t('Time',     'Tiempo') },
        { href: '/web/staffing/payroll',  label: t('Payroll',  'Nómina') },
      ],
    },
    {
      href: '/web/finance', label: t('Finance', 'Finanzas'), matchPrefix: '/web/finance',
      subLinks: [
        { href: '/web/finance',          label: t('Overview', 'Resumen') },
        { href: '/web/finance/expenses', label: t('Expenses', 'Gastos') },
        { href: '/web/finance/bank',     label: t('Bank',     'Banco') },
      ],
    },
    {
      href: '/web/analytics', label: t('Analytics', 'Analíticas'), matchPrefix: '/web/analytics',
      subLinks: [
        { href: '/web/analytics',            label: t('Overview',   'Resumen') },
        { href: '/web/analytics/items',      label: t('Items',      'Artículos') },
        { href: '/web/analytics/categories', label: t('Categories', 'Categorías') },
      ],
    },
  ]

  const isActive = (l: NavLink) => pathname === l.href || pathname.startsWith(l.matchPrefix + '/')
  const isSubActive = (sub: SubLink, moduleHref: string) =>
    sub.href === moduleHref ? pathname === sub.href : pathname === sub.href || pathname.startsWith(sub.href + '/')

  const linkBase: CSSProperties = {
    fontFamily: MONO,
    fontSize: 11.5,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    textDecoration: 'none',
    padding: '6px 2px',
    transition: 'color 150ms ease',
  }

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        backdropFilter: 'saturate(1.4) blur(10px)',
        background: 'rgba(250,249,246,0.86)',
        borderBottom: '1px solid #E7E6E2',
      }}
    >
      <div
        style={{
          maxWidth: 1160,
          margin: '0 auto',
          padding: '13px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 18,
        }}
      >
        {/* Left: brand mark linking back to home */}
        <Link href="/web/home" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
          <BrandLockup size="md" />
        </Link>

        {/* Center-left: module nav with hover dropdowns.
            Each module's container handles its own hover state so
            the dropdown stays open while the cursor moves between
            the label and the sub-menu body. */}
        <nav style={{ display: 'flex', alignItems: 'center', gap: 26, flex: 1, justifyContent: 'center' }}>
          {links.map((l) => {
            const open = openModule === l.href
            return (
              <div
                key={l.href}
                onMouseEnter={() => l.subLinks && scheduleOpen(l.href)}
                onMouseLeave={scheduleClose}
                style={{ position: 'relative' }}
              >
                <Link
                  href={l.href}
                  style={{ ...linkBase, color: isActive(l) ? '#18181B' : '#52525B', display: 'inline-block' }}
                >
                  {l.label}
                </Link>

                {/* DROPDOWN — sits directly under the label, lined up
                    with the label's left edge. Cream card with a soft
                    border + shadow; mono items echoing the eyebrow
                    rhythm used elsewhere in /web. Animates in via a
                    short fade + slide. */}
                {open && l.subLinks && (
                  <div
                    onMouseEnter={cancelTimers}
                    onMouseLeave={scheduleClose}
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 10px)',
                      left: '-12px',
                      minWidth: 180,
                      background: '#FFFFFF',
                      border: '1px solid #E7E6E2',
                      borderRadius: 12,
                      boxShadow: '0 16px 40px -18px rgba(24,24,27,0.22)',
                      padding: 6,
                      animation: 'webNavDropdownIn 160ms ease',
                      zIndex: 60,
                    }}
                  >
                    {l.subLinks.map((sub) => {
                      const subActive = isSubActive(sub, l.href)
                      return (
                        <Link
                          key={sub.href}
                          href={sub.href}
                          onClick={() => setOpenModule(null)}
                          style={{
                            display: 'block',
                            padding: '9px 12px',
                            borderRadius: 8,
                            fontFamily: MONO,
                            fontSize: 11,
                            letterSpacing: '0.14em',
                            textTransform: 'uppercase',
                            textDecoration: 'none',
                            color: subActive ? '#18181B' : '#6B6B70',
                            background: subActive ? '#F4F2EE' : 'transparent',
                          }}
                        >
                          {sub.label}
                        </Link>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </nav>

        <style>{`
          @keyframes webNavDropdownIn {
            from { opacity: 0; transform: translateY(-4px); }
            to   { opacity: 1; transform: translateY(0); }
          }
        `}</style>

        {/* Right: restaurant name + account menu */}
        <div ref={menuRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 14 }}>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 11,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#6B6B70',
              maxWidth: 180,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {restaurantName}
          </span>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: '#18181B',
              color: '#FAF9F6',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: 0,
            }}
          >
            {(userFullName || userEmail).slice(0, 1).toUpperCase()}
          </button>

          {menuOpen && (
            <div
              role="menu"
              style={{
                position: 'absolute',
                top: 'calc(100% + 10px)',
                right: 0,
                minWidth: 240,
                background: '#FFFFFF',
                border: '1px solid #E7E6E2',
                borderRadius: 12,
                boxShadow: '0 12px 32px -16px rgba(24,24,27,0.22)',
                padding: 6,
              }}
            >
              <div style={{ padding: '10px 12px 12px', borderBottom: '1px solid #F1F0EC' }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: '#18181B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {userFullName ?? userEmail}
                </div>
                {userFullName && (
                  <div style={{ fontFamily: MONO, fontSize: 11, color: '#6B6B70', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {userEmail}
                  </div>
                )}
              </div>
              <Link
                href="/dashboard"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                style={{
                  display: 'block',
                  padding: '9px 12px',
                  fontSize: 13.5,
                  color: '#52525B',
                  textDecoration: 'none',
                  borderRadius: 8,
                }}
              >
                {t('Switch to classic view', 'Cambiar a vista clásica')}
              </Link>
              <Link
                href="/settings"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                style={{
                  display: 'block',
                  padding: '9px 12px',
                  fontSize: 13.5,
                  color: '#52525B',
                  textDecoration: 'none',
                  borderRadius: 8,
                }}
              >
                {t('Settings', 'Configuración')}
              </Link>
              {/* Sign-out goes through /access?signout=1 — the owner
                  must enter their passcode to actually sign out (same
                  flow the kiosk uses). Keeps a single source of truth
                  for the sign-out behavior across surfaces. */}
              <Link
                href="/access?signout=1"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                style={{
                  display: 'block',
                  padding: '9px 12px',
                  fontSize: 13.5,
                  color: '#52525B',
                  textDecoration: 'none',
                  borderRadius: 8,
                }}
              >
                {t('Sign out', 'Cerrar sesión')}
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
