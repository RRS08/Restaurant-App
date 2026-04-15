// ----------------------------------------------------------------
// Protected App Layout  →  wraps every page inside app/(app)/
//
// This is a SERVER COMPONENT. It:
//   1. Verifies the user is logged in          (auth check)
//   2. Verifies the user belongs to a restaurant  (restaurant check)
//   3. Fetches the data needed by the sidebar   (name, email)
//   4. Renders the sidebar + the page content   (layout)
//
// It does NOT handle active link highlighting — that needs usePathname()
// which requires a Client Component. That logic lives in Sidebar.
//
// Data flow:
//   layout.tsx (Server) → fetches user + restaurant data
//       ↓ passes as props
//   <Sidebar> (Client) → handles active links with usePathname()
//       ↓ renders alongside
//   {children} → the current page (e.g. DashboardPage, SalesPage)
// ----------------------------------------------------------------

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Sidebar from '@/components/sidebar'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  // ---- Auth check ----
  // getUser() validates the session with Supabase's server.
  // proxy.ts already does this for the route, but we check here too.
  // This pattern is called "defense in depth" — multiple layers of protection.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // ---- Restaurant check ----
  // If the user has no row in user_roles, they haven't completed onboarding.
  const { data: userRole } = await supabase
    .from('user_roles')
    .select('restaurant_id, role')
    .eq('user_id', user.id)
    .single()

  if (!userRole) {
    redirect('/onboarding')
  }

  // ---- Fetch display data for the sidebar ----
  // We run these two queries at the same time using Promise.all.
  // This is faster than running them one after another.
  const [{ data: profile }, { data: restaurant }] = await Promise.all([
    supabase
      .from('profiles')
      .select('full_name')
      .eq('id', user.id)
      .single(),
    supabase
      .from('restaurants')
      .select('name')
      .eq('id', userRole.restaurant_id)
      .single(),
  ])

  // ---- Render the shell ----
  return (
    <div className="flex min-h-screen bg-gray-50">

      {/*
        Sidebar receives the data it needs as props.
        It's a Client Component so it can use usePathname() for active links.
        Server Components CAN render Client Components — they just can't use
        hooks themselves.
      */}
      <Sidebar
        restaurantName={restaurant?.name ?? 'My Restaurant'}
        userFullName={profile?.full_name ?? null}
        userEmail={user.email ?? ''}
      />

      {/*
        Main content area.
        `children` is whatever page is currently active:
        DashboardPage, SalesPage, SettingsPage, etc.
        Each page is responsible for its own title and content.
      */}
      <main className="flex-1 overflow-y-auto p-8">
        {children}
      </main>

    </div>
  )
}
