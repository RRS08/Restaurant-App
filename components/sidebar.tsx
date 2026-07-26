'use client'

// ----------------------------------------------------------------
// Sidebar Component
//
// WHY 'use client'?
//   This component uses usePathname() — a React hook that reads the
//   current URL so we can highlight the active nav link. Hooks only
//   work in Client Components.
//
// WHY a separate component instead of putting this in layout.tsx?
//   layout.tsx is a Server Component — it does auth checks and
//   database queries, which must run on the server. But we need a
//   hook (usePathname) for the active link highlight, and hooks
//   require a Client Component.
//
//   The solution: layout.tsx stays on the server and passes the
//   user/restaurant data down as props to this Client Component.
//   This is the standard Next.js App Router pattern:
//   "Server Component fetches data → Client Component handles interactivity"
//
// PROPS this component receives from layout.tsx:
//   - restaurantName: shown at the top of the sidebar
//   - userFullName:   shown at the bottom of the sidebar
//   - userEmail:      fallback if no full name
// ----------------------------------------------------------------

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useSidebarClose } from '@/app/(app)/app-shell'
import { BrandMark, BrandWordmark } from '@/components/brand'
import { lockDevice } from '@/app/actions/access'
import { makeT, type Lang } from '@/lib/i18n'
import {
  LayoutDashboard, UtensilsCrossed, TrendingUp, Package, Users,
  DollarSign, Settings, LogOut, Lock, ShoppingCart, BarChart3, Wrench, X,
} from 'lucide-react'

// ----------------------------------------------------------------
// Nav item definitions
//
// Centralising the nav items here means:
// - Adding a new page = add one line here
// - No duplication across sidebar and any mobile nav you add later
// ----------------------------------------------------------------
// `dev: true` items are filtered out for non-dev viewers. The
// /dev-tools page is also server-side guarded (`isDevEmail`); this
// flag controls sidebar visibility only — convenience, not security.
//
// labelEn + labelEs feed makeT() at render time so the same item
// list serves both languages. Spanish strings stay inline next to
// English so future translators can scan the file once.
const navItems: Array<{
  labelEn: string; labelEs: string; href: string; icon: typeof LayoutDashboard; dev?: true
}> = [
  { labelEn: 'Dashboard',   labelEs: 'Panel',         href: '/dashboard', icon: LayoutDashboard },
  { labelEn: 'Menu',        labelEs: 'Menú',          href: '/menu',      icon: UtensilsCrossed },
  { labelEn: 'POS',         labelEs: 'POS',           href: '/pos',       icon: ShoppingCart },
  { labelEn: 'Sales',       labelEs: 'Ventas',        href: '/sales',     icon: TrendingUp },
  { labelEn: 'Inventory',   labelEs: 'Inventario',    href: '/inventory', icon: Package },
  { labelEn: 'Staffing',    labelEs: 'Personal',      href: '/staffing',  icon: Users },
  { labelEn: 'Finance',     labelEs: 'Finanzas',      href: '/finance',   icon: DollarSign },
  { labelEn: 'Analytics',   labelEs: 'Analíticas',    href: '/analytics', icon: BarChart3 },
  { labelEn: 'Settings',    labelEs: 'Ajustes',       href: '/settings',  icon: Settings },
  { labelEn: 'Dev Toolbox', labelEs: 'Dev Toolbox',   href: '/dev-tools', icon: Wrench, dev: true },
]

interface SidebarProps {
  restaurantName: string
  userFullName: string | null
  userEmail: string
  /** Restaurant's onboarding-time choice. Native POS users use our
   *  in-app POS; External POS users ring up sales in Square/Clover
   *  and don't need our POS surface at all. */
  operatingMode: 'native_pos' | 'external_pos' | null
  /** Owner opt-in to expose the in-app POS while operating_mode is
   *  still 'external_pos' — set via Settings → Activate local POS.
   *  Lets a merchant trial the native POS alongside an existing
   *  external terminal without flipping their source of truth. */
  nativePosEnabled: boolean
  /** Dev override — when true, every link is shown regardless of
   *  mode so the testing workflow can hit both surfaces. */
  isDev: boolean
  /** Active language for this device. Set via Settings → Language. */
  lang: Lang
}

export default function Sidebar({
  restaurantName, userFullName, userEmail, operatingMode, nativePosEnabled, isDev, lang,
}: SidebarProps) {
  const t = makeT(lang)
  // Tablet overlay close handler — pulled from AppShell's React
  // Context. `null` on desktop (sidebar always visible) or when
  // mounted outside AppShell. Called on nav-item click to close
  // the slide-in overlay so the manager lands cleanly on the new
  // page. NEVER passed in as a prop — that would put a function
  // across the server/client boundary and crash the Vercel runtime.
  const closeSidebar = useSidebarClose()

  // Visibility filter:
  //   • `dev: true` items render for dev accounts only. The page
  //     itself is server-side guarded; this is a convenience.
  //   • POS link hides for external_pos restaurants unless the
  //     owner has explicitly opted in via Settings → Activate
  //     local POS (nativePosEnabled=true) to trial the in-app
  //     POS alongside their external terminal. Dev accounts
  //     always see it so the testing workflow can hit both.
  const visibleNavItems = navItems.filter((item) => {
    if (item.dev && !isDev) return false
    if (isDev) return true
    if (item.href === '/pos' && operatingMode === 'external_pos' && !nativePosEnabled) return false
    return true
  })
  // usePathname() returns the current URL path, e.g. "/dashboard"
  // We use it to compare against each nav item's href.
  const pathname = usePathname()

  // Display name: use full name if available, otherwise show email.
  const displayName = userFullName ?? userEmail

  return (
    // Brand cream (#FAF9F6) matches the marketing site's canvas so
    // the app shell reads as continuous with the landing surface.
    // h-full lets the sticky wrapper in AppShell own the height —
    // was min-h-screen, which made the aside grow with the page and
    // scroll out of view when main content overflowed.
    <aside className="w-60 h-full bg-[#FAF9F6] border-r border-hairline flex flex-col">

      {/* Top: product mark + tenant identity */}
      <div className="px-4 py-4 border-b border-hairline flex items-center justify-between gap-2">
        <Link href="/dashboard" className="flex items-center gap-2.5 min-w-0 group">
          <BrandMark size={32} variant="solid" className="flex-shrink-0 rounded-lg" />
          <span className="font-semibold text-zinc-900 text-sm leading-tight truncate group-hover:text-slate transition-colors">
            {restaurantName}
          </span>
        </Link>
        {/* Tablet-only close — only renders when AppShell is
            providing a close handler via Context (i.e. when the
            sidebar is mounted inside the tablet overlay). The
            `xl:hidden` class also hides it on desktop even when
            present, so desktop stays visually identical. */}
        {closeSidebar && (
          <button
            type="button"
            onClick={closeSidebar}
            aria-label="Close menu"
            className="xl:hidden flex-shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Middle: navigation */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {visibleNavItems.map((item) => {
          // Determine if this link is the currently active page.
          // startsWith handles sub-pages too:
          //   pathname "/menu/new-item" starts with "/menu" → Menu is active
          //   pathname "/dashboard" starts with "/dashboard" → Dashboard is active
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={closeSidebar ?? undefined}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-zinc-100 text-zinc-900 font-semibold'                 // active: monochrome ink
                  : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900'      // inactive
              )}
            >
              <Icon
                className={cn(
                  'w-4 h-4 flex-shrink-0',
                  isActive ? 'text-zinc-900' : 'text-zinc-400'
                )}
              />
              <span className="flex-1">{t(item.labelEn, item.labelEs)}</span>
              {item.dev && (
                <span
                  className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700 bg-amber-50 border border-amber-100 px-1.5 py-0.5 rounded"
                  aria-label="developer only"
                >
                  Dev
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* Bottom: user + sign out */}
      <div className="px-3 py-4 border-t border-hairline">
        <div className="px-3 py-2 mb-1">
          <p className="text-sm font-medium text-zinc-900 truncate">{displayName}</p>
          {userFullName && (
            <p className="text-xs text-zinc-400 truncate">{userEmail}</p>
          )}
        </div>

        {/* Lock device — calls the lockDevice server action which
            clears the pos_mode cookie without ending the auth
            session. Used when the owner hands the device to a
            server: next request lands on /access for the staff
            code prompt. Same affordance as the Lock button in
            Settings → Access codes, just reachable from any page. */}
        <form action={lockDevice}>
          <button
            type="submit"
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm
                       font-medium text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900
                       transition-colors"
          >
            <Lock className="w-4 h-4 text-zinc-400 flex-shrink-0" />
            {t('Lock device', 'Bloquear dispositivo')}
          </button>
        </form>

        {/* Sign-out routes through /access?signout=1 — the owner
            passcode is required to actually end the session. This
            is the kiosk model: staff can't unilaterally sign the
            device out, and the owner confirms with their code. */}
        <Link
          href="/access?signout=1"
          className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm
                     font-medium text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900
                     transition-colors"
        >
          <LogOut className="w-4 h-4 text-zinc-400 flex-shrink-0" />
          {t('Sign out', 'Cerrar sesión')}
        </Link>

        {/* Product wordmark — calm, small, sits below the user
            block to anchor the sidebar with the brand without
            competing with the tenant name at the top. */}
        <div className="mt-3 px-3 pt-3 border-t border-hairline flex items-center justify-between">
          <BrandWordmark size="sm" className="text-slate" />
          <span className="text-[10px] text-zinc-300 font-medium tabular-nums">v1</span>
        </div>
      </div>
    </aside>
  )
}
