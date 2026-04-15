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
} from 'lucide-react'

// ----------------------------------------------------------------
// Nav item definitions
//
// Centralising the nav items here means:
// - Adding a new page = add one line here
// - No duplication across sidebar and any mobile nav you add later
// ----------------------------------------------------------------
const navItems = [
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
]

// ----------------------------------------------------------------
// Props type
// TypeScript "interface" describes the shape of the props object.
// ----------------------------------------------------------------
interface SidebarProps {
  restaurantName: string
  userFullName: string | null
  userEmail: string
}

export default function Sidebar({
  restaurantName,
  userFullName,
  userEmail,
}: SidebarProps) {
  // usePathname() returns the current URL path, e.g. "/dashboard"
  // We use it to compare against each nav item's href.
  const pathname = usePathname()

  // Display name: use full name if available, otherwise show email.
  const displayName = userFullName ?? userEmail

  return (
    <aside className="w-60 min-h-screen bg-white border-r border-gray-200 flex flex-col">

      {/* ---- Top: Restaurant brand ---- */}
      <div className="px-5 py-5 border-b border-gray-100">
        <div className="flex items-center gap-2.5">
          {/* Logo placeholder — replace with an actual logo image later */}
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0">
            <ChefHat className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-gray-900 text-sm leading-tight truncate">
            {restaurantName}
          </span>
        </div>
      </div>

      {/* ---- Middle: Navigation links ---- */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {navItems.map((item) => {
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
              {item.label}
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
