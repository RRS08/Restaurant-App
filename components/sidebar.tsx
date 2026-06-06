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
import { logout } from '@/app/actions/auth'
import { useSidebarClose } from '@/app/(app)/app-shell'
import {
  LayoutDashboard,
  UtensilsCrossed,
  TrendingUp,
  Package,
  Users,
  DollarSign,
  Settings,
  LogOut,
  ChefHat,
  ShoppingCart,
  BarChart3,
  Wrench,
  X,
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
const navItems: Array<{
  label: string
  href: string
  icon: typeof LayoutDashboard
  dev?: true
}> = [
  {
    label: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
  },
  {
    label: 'Menu',
    href: '/menu',
    icon: UtensilsCrossed,
  },
  {
    label: 'POS',
    href: '/pos',
    icon: ShoppingCart,
  },
  {
    label: 'Sales',
    href: '/sales',
    icon: TrendingUp,
  },
  {
    label: 'Inventory',
    href: '/inventory',
    icon: Package,
  },
  {
    label: 'Staffing',
    href: '/staffing',
    icon: Users,
  },
  {
    label: 'Finance',
    href: '/finance',
    icon: DollarSign,
  },
  {
    label: 'Analytics',
    href: '/analytics',
    icon: BarChart3,
  },
  {
    label: 'Settings',
    href: '/settings',
    icon: Settings,
  },
  {
    label: 'Dev Toolbox',
    href: '/dev-tools',
    icon: Wrench,
    dev: true,
  },
]

// ----------------------------------------------------------------
// Props type
// TypeScript "interface" describes the shape of the props object.
// ----------------------------------------------------------------
interface SidebarProps {
  restaurantName: string
  userFullName: string | null
  userEmail: string
  /** Restaurant's onboarding-time choice. Native POS users use our
   *  in-app POS; External POS users ring up sales in Square/Clover
   *  and don't need our POS surface at all. */
  operatingMode: 'native_pos' | 'external_pos' | null
  /** Dev override — when true, every link is shown regardless of
   *  mode so the testing workflow can hit both surfaces. */
  isDev: boolean
}

export default function Sidebar({
  restaurantName,
  userFullName,
  userEmail,
  operatingMode,
  isDev,
}: SidebarProps) {
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
  //   • POS link hides for external_pos restaurants (their selling
  //     happens in Square/Clover). Dev accounts still see it so the
  //     testing workflow can hit both surfaces.
  const visibleNavItems = navItems.filter((item) => {
    if (item.dev && !isDev) return false
    if (isDev) return true
    if (item.href === '/pos' && operatingMode === 'external_pos') return false
    return true
  })
  // usePathname() returns the current URL path, e.g. "/dashboard"
  // We use it to compare against each nav item's href.
  const pathname = usePathname()

  // Display name: use full name if available, otherwise show email.
  const displayName = userFullName ?? userEmail

  return (
    <aside className="w-60 min-h-screen bg-white border-r border-gray-200 flex flex-col">

      {/* ---- Top: Restaurant brand ---- */}
      <div className="px-4 py-4 border-b border-gray-100 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Logo placeholder — replace with an actual logo image later */}
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0">
            <ChefHat className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-gray-900 text-sm leading-tight truncate">
            {restaurantName}
          </span>
        </div>
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
            className="xl:hidden flex-shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* ---- Middle: Navigation links ---- */}
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
                // Base styles that apply to every link
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                // Conditional styles based on whether the link is active
                isActive
                  ? 'bg-blue-50 text-blue-700'          // active: blue tint
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900' // inactive
              )}
            >
              <Icon
                className={cn(
                  'w-4 h-4 flex-shrink-0',
                  isActive ? 'text-blue-600' : 'text-gray-400'
                )}
              />
              <span className="flex-1">{item.label}</span>
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

      {/* ---- Bottom: User info + sign out ---- */}
      <div className="px-3 py-4 border-t border-gray-100">
        {/* User info */}
        <div className="px-3 py-2 mb-1">
          <p className="text-sm font-medium text-gray-900 truncate">{displayName}</p>
          {userFullName && (
            <p className="text-xs text-gray-400 truncate">{userEmail}</p>
          )}
        </div>

        {/* Sign out — uses a form so the server action works without JS */}
        <form action={logout}>
          <button
            type="submit"
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm
                       font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900
                       transition-colors"
          >
            <LogOut className="w-4 h-4 text-gray-400 flex-shrink-0" />
            Sign out
          </button>
        </form>
      </div>

    </aside>
  )
}
