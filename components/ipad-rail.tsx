'use client'

// ----------------------------------------------------------------
// IPadRail — 76px icon-only sidebar for tablet widths.
//
// Replaces the hamburger + slide-in overlay we used to render at
// tablet breakpoints. The rail is ALWAYS visible so navigation is
// one tap, and the 76px width leaves ~164px more content room than
// the labeled 240px desktop sidebar — enough for the Menu page's
// section chips to fit in one row on an 11" iPad.
//
// Kept in strict parallel with components/sidebar.tsx:
//   • same nav item order + same href/icon pairing
//   • same visibility rules (POS hidden for external_pos unless
//     nativePosEnabled or isDev; Dev Toolbox hidden for non-dev)
//   • same Lock device server action, same Sign out target
//
// Active-state style matches the labeled sidebar: bg #F4F4F5, ink
// glyph. Inactive uses a faint grey so the whole rail reads as a
// single monochrome column, not a stack of buttons.
//
// Account popover: click the avatar to reveal Lock device + Sign
// out. Long-press could open the same popover on touch devices
// (browsers dispatch a click on release anyway, so no extra
// handler needed).
// ----------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { lockDevice } from '@/app/actions/access'
import { changePlace } from '@/app/actions/places'
import type { Place } from '@/lib/places'
import { makeT, type Lang } from '@/lib/i18n'
import {
  LayoutDashboard, UtensilsCrossed, ShoppingCart, TrendingUp,
  Package, Users, DollarSign, BarChart3, Settings, Lock, LogOut, Wrench,
  MessageCircle, ClipboardList, PencilLine, Store, Globe,
} from 'lucide-react'

const INK = '#18181B'
const LINE = '#E7E6E2'
const FILL = '#F4F4F5'
const FAINT = '#A1A1A6'

type NavItem = {
  labelEn: string; labelEs: string; href: string; icon: typeof LayoutDashboard; dev?: true
}

const RETAIL_NAV: NavItem[] = [
  { labelEn: 'Dashboard',   labelEs: 'Panel',       href: '/dashboard', icon: LayoutDashboard },
  { labelEn: 'Menu',        labelEs: 'Menú',        href: '/menu',      icon: UtensilsCrossed },
  { labelEn: 'POS',         labelEs: 'POS',         href: '/pos',       icon: ShoppingCart },
  { labelEn: 'Sales',       labelEs: 'Ventas',      href: '/sales',     icon: TrendingUp },
  { labelEn: 'Inventory',   labelEs: 'Inventario',  href: '/inventory', icon: Package },
  { labelEn: 'Staffing',    labelEs: 'Personal',    href: '/staffing',  icon: Users },
  { labelEn: 'Finance',     labelEs: 'Finanzas',    href: '/finance',   icon: DollarSign },
  { labelEn: 'Analytics',   labelEs: 'Analíticas',  href: '/analytics', icon: BarChart3 },
  { labelEn: 'Settings',    labelEs: 'Ajustes',     href: '/settings',  icon: Settings },
  { labelEn: 'Dev Toolbox', labelEs: 'Dev Toolbox', href: '/dev-tools', icon: Wrench, dev: true },
]

const ONLINE_NAV: NavItem[] = [
  { labelEn: 'Dashboard',   labelEs: 'Panel',       href: '/dashboard', icon: LayoutDashboard },
  { labelEn: 'Chat',        labelEs: 'Chat',        href: '/chat',      icon: MessageCircle },
  { labelEn: 'Orders',      labelEs: 'Pedidos',     href: '/orders',    icon: ClipboardList },
  { labelEn: 'Catalog',     labelEs: 'Catálogo',    href: '/catalog',   icon: UtensilsCrossed },
  { labelEn: 'Inventory',   labelEs: 'Inventario',  href: '/inventory', icon: Package },
  { labelEn: 'Customers',   labelEs: 'Clientes',    href: '/customers', icon: Users },
  { labelEn: 'Edit site',   labelEs: 'Editar sitio',href: '/edit-site', icon: PencilLine },
  { labelEn: 'Settings',    labelEs: 'Ajustes',     href: '/settings',  icon: Settings },
  { labelEn: 'Dev Toolbox', labelEs: 'Dev Toolbox', href: '/dev-tools', icon: Wrench, dev: true },
]

interface IPadRailProps {
  restaurantName: string
  userFullName: string | null
  userEmail: string
  operatingMode: 'native_pos' | 'external_pos' | null
  nativePosEnabled: boolean
  isDev: boolean
  lang: Lang
  activePlace: Place
}

export default function IPadRail({
  userFullName, userEmail, operatingMode, nativePosEnabled, isDev, lang, activePlace,
}: IPadRailProps) {
  const t = makeT(lang)
  const pathname = usePathname()
  const [accountOpen, setAccountOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const avatarBtnRef = useRef<HTMLButtonElement>(null)

  // Pick nav list off the active place's kind. Same filter rules
  // as the labeled sidebar so the rail and desktop sidebar always
  // surface the same set of icons in the same order.
  const baseNav = activePlace.kind === 'online' ? ONLINE_NAV : RETAIL_NAV
  const visibleNavItems = baseNav.filter((item) => {
    if (item.dev && !isDev) return false
    if (isDev) return true
    if (item.href === '/pos' && operatingMode === 'external_pos' && !nativePosEnabled) return false
    return true
  })

  // Close-on-outside-click + Escape for the account popover.
  useEffect(() => {
    if (!accountOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popoverRef.current?.contains(t) || avatarBtnRef.current?.contains(t)) return
      setAccountOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAccountOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [accountOpen])

  // Initials for the avatar. Two-letter form when we have a full
  // name with a space; otherwise first two chars of the single-
  // token name or the email local part.
  const initials = ((): string => {
    if (userFullName) {
      const parts = userFullName.trim().split(/\s+/)
      if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      if (parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase()
      return (parts[0][0] || '?').toUpperCase()
    }
    return (userEmail || '?').slice(0, 2).toUpperCase()
  })()
  const displayName = userFullName ?? userEmail

  return (
    <aside
      style={{
        width: 56, flex: '0 0 56px', height: '100%',
        borderRight: `1px solid ${LINE}`, background: '#fff',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        // Safe-area allowance so the brand mark doesn't sit under
        // an iPad status bar in stand-alone (Home Screen) mode.
        // Falls back to plain 12px on browsers without env().
        padding: 'calc(12px + env(safe-area-inset-top)) 0 calc(12px + env(safe-area-inset-bottom))',
      }}
    >
      {/* Active-place chip — icon-only on the rail. Submitting the
          changePlace form clears the active_place_id cookie and
          bounces to /places, matching the labeled sidebar's
          "Change place" affordance. */}
      <form
        action={changePlace}
        style={{ flex: '0 0 auto', margin: 0, padding: 0, lineHeight: 0 }}
      >
        <button
          type="submit"
          title={`${activePlace.name} — ${t('Change place', 'Cambiar lugar')}`}
          aria-label={`${activePlace.name} — ${t('Change place', 'Cambiar lugar')}`}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 34, height: 34, borderRadius: 9,
            border: 0, background: FILL, color: INK, cursor: 'pointer',
            padding: 0, font: 'inherit',
          }}
        >
          {activePlace.kind === 'online'
            ? <Globe width={18} height={18} strokeWidth={1.8} />
            : <Store width={18} height={18} strokeWidth={1.8} />}
        </button>
      </form>

      {/* Divider — narrow hairline under the brand, floated
          between big top and bottom margins so the brand and
          the first nav item both get breathing room. */}
      <div
        aria-hidden
        style={{
          flex: '0 0 auto', width: 24, height: 1, background: LINE,
          margin: '16px 0',
        }}
      />

      {/* Nav — top-anchored, flex:1 so the avatar stays pinned
          at the bottom. Reads as a familiar top-loaded nav rail. */}
      <nav
        style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'flex-start', gap: 4, width: '100%',
        }}
      >
        {visibleNavItems.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/')
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              title={t(item.labelEn, item.labelEs)}
              aria-label={t(item.labelEn, item.labelEs)}
              aria-current={active ? 'page' : undefined}
              style={{
                position: 'relative',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 42, height: 42, borderRadius: 10,
                textDecoration: 'none',
                background: active ? FILL : 'transparent',
                color: active ? INK : FAINT,
                transition: 'background 120ms ease, color 120ms ease',
              }}
            >
              <Icon width={20} height={20} strokeWidth={2} />
            </Link>
          )
        })}
      </nav>

      {/* Avatar + account popover. Click reveals Lock device +
          Sign out — same actions as the labeled sidebar's footer,
          just moved off the visible chrome to fit the 76px rail. */}
      <div style={{ position: 'relative', flex: '0 0 auto' }}>
        <button
          ref={avatarBtnRef}
          type="button"
          onClick={() => setAccountOpen((v) => !v)}
          title={displayName}
          aria-label={displayName}
          aria-expanded={accountOpen}
          aria-haspopup="menu"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 0, background: 'transparent', borderRadius: 999, padding: 0,
            font: 'inherit', cursor: 'pointer',
          }}
        >
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 999,
              background: accountOpen ? '#E7E6E2' : '#F4F4F2',
              fontSize: 11, fontWeight: 600, color: '#52525B',
              transition: 'background 120ms ease',
            }}
          >
            {initials}
          </span>
        </button>

        {accountOpen && (
          <div
            ref={popoverRef}
            role="menu"
            style={{
              position: 'absolute', bottom: 0, left: 'calc(100% + 8px)',
              zIndex: 60, minWidth: 220,
              border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff',
              boxShadow: '0 12px 32px rgba(24,24,27,0.14)', padding: 6,
            }}
          >
            <div style={{ padding: '8px 10px 10px', borderBottom: `1px solid ${LINE}`, marginBottom: 4 }}>
              <div style={{
                fontSize: 13, fontWeight: 600, color: INK,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {displayName}
              </div>
              {userFullName && (
                <div style={{
                  fontSize: 11, color: FAINT, marginTop: 2,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {userEmail}
                </div>
              )}
            </div>
            <form action={lockDevice}>
              <button
                type="submit"
                onClick={() => setAccountOpen(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '9px 10px', border: 0, background: 'transparent',
                  borderRadius: 8, cursor: 'pointer', font: 'inherit',
                  fontSize: 13, color: '#52525B', textAlign: 'left',
                }}
              >
                <Lock className="w-4 h-4 text-zinc-400" />
                {t('Lock device', 'Bloquear dispositivo')}
              </button>
            </form>
            <Link
              href="/access?signout=1"
              onClick={() => setAccountOpen(false)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '9px 10px', borderRadius: 8, textDecoration: 'none',
                fontSize: 13, color: '#52525B',
              }}
            >
              <LogOut className="w-4 h-4 text-zinc-400" />
              {t('Sign out', 'Cerrar sesión')}
            </Link>
          </div>
        )}
      </div>
    </aside>
  )
}
