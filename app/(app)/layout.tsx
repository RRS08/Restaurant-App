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
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import Sidebar from '@/components/sidebar'
import AppShell from './app-shell'
import { getOperatingMode } from '@/lib/readiness'
import { isDevEmail } from '@/lib/dev'
import { BrandMark } from '@/components/brand'
import { Lock } from 'lucide-react'
import { getLang, getT } from '@/lib/i18n-server'

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

  // Language is cookie-driven (same `lang` cookie as the marketing
  // site), set via the toggle in Settings → Language. Fetched once
  // here and passed down so both the sidebar and the kiosk header
  // share a single source of truth.
  const lang = await getLang()
  const t = await getT()

  // ---- Staff kiosk mode ----
  //
  // When pos_mode === 'staff' the device is locked to /pos. We
  // render the page WITHOUT the sidebar/shell so it sits in a
  // dedicated kiosk frame: a thin top strip carrying the brand +
  // restaurant name + a Lock link, then the POS content centered
  // in a max-width container. The Lock link goes to /access where
  // the owner can switch back into full system access.
  const posMode = (await cookies()).get('pos_mode')?.value
  if (posMode === 'staff') {
    // Pull just the restaurant name for the kiosk header strip.
    // We deliberately skip the heavier sidebar fetches (profile,
    // operating mode) — they're not used in kiosk mode.
    const { data: kioskRestaurant } = await supabase
      .from('restaurants')
      .select('name')
      .eq('id', userRole.restaurant_id)
      .single()

    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        {/* Kiosk header — calm, single line. Brand mark + restaurant
            name on the left, Lock link on the right. Sticky so it
            stays in reach as the POS grid scrolls. */}
        <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
          <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 h-12 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <BrandMark size={22} />
              <span className="text-[11px] font-mono uppercase tracking-[0.16em] text-gray-500 truncate">
                {kioskRestaurant?.name ?? 'Checked'} · POS
              </span>
            </div>
            <a
              href="/access"
              className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.16em] text-gray-500 hover:text-gray-900 transition-colors px-2 py-1 rounded-md hover:bg-gray-50"
            >
              <Lock className="w-3.5 h-3.5" />
              {t('Lock', 'Bloquear')}
            </a>
          </div>
        </header>

        {/* Content — centered, max-width matches the POS internal
            container so it doesn't double-shrink. */}
        <main className="flex-1">
          <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
            {children}
          </div>
        </main>
      </div>
    )
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
          lang={lang}
        />
      }
    >
      {children}
    </AppShell>
  )
}
