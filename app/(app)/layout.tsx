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
import AppShell from './app-shell'
import { getOperatingMode } from '@/lib/readiness'
import { isDevEmail } from '@/lib/dev'

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
  const [{ data: profile }, { data: restaurant }, operatingMode] = await Promise.all([
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
    getOperatingMode(supabase, userRole.restaurant_id),
  ])

  // Dev accounts override mode-based gating so the testing workflow
  // can see both Native POS and External POS surfaces regardless of
  // the restaurant's actual operating mode.
  const isDev = isDevEmail(user.email)

  // ---- Render the shell ----
  // AppShell is a Client Component that owns the responsive sidebar
  // state. The Sidebar element is passed as a serializable JSX
  // node (NOT a render-prop function) so it can safely cross the
  // server→client boundary. The "close on nav-item click"
  // behavior is wired through a React Context inside AppShell;
  // Sidebar consumes it via the useSidebarClose() hook — no
  // function ever travels from server to client.
  return (
    <AppShell
      sidebar={
        <Sidebar
          restaurantName={restaurant?.name ?? 'My Restaurant'}
          userFullName={profile?.full_name ?? null}
          userEmail={user.email ?? ''}
          operatingMode={operatingMode}
          isDev={isDev}
        />
      }
    >
      {children}
    </AppShell>
  )
}
