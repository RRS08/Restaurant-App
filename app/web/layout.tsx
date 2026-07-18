// ----------------------------------------------------------------
// Web-native operator layout — wraps every page inside app/web/
//
// This is the new browser-first experience for owners and managers
// who work from a laptop/desktop. It deliberately reuses the
// marketing site's visual language (cream background, monospace
// accents, generous whitespace, top-nav web layout) so logging in
// feels like staying inside onchecked.app rather than entering a
// different product.
//
// The existing tablet-shell app (sidebar + AppShell) at /dashboard,
// /inventory, /sales, etc. is preserved untouched at its current
// URLs. That experience continues to serve service-floor / kiosk
// use cases and will become the foundation for the eventual native
// iPad app. Two presentations of the same underlying system; both
// read/write the same data.
//
// Phase 1 scope:
//   - This layout (header + content container)
//   - <WebHeader /> shared component
//   - /web/home — single landing page that sets the tone
//
// Future phases convert one module at a time (Inventory first,
// then Staffing + Payroll, then Finance) into web-native deep
// pages that sit under this same shell.
// ----------------------------------------------------------------

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getLang } from '@/lib/i18n-server'
import WebHeader from '@/components/web/header'

export default async function WebLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: userRole } = await supabase
    .from('user_roles')
    .select('restaurant_id, role')
    .eq('user_id', user.id)
    .single()

  if (!userRole) {
    redirect('/onboarding')
  }

  const [{ data: profile }, { data: restaurant }, lang] = await Promise.all([
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
    getLang(),
  ])

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#FAF9F6',
        color: '#18181B',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <WebHeader
        restaurantName={restaurant?.name ?? 'My Restaurant'}
        userFullName={profile?.full_name ?? null}
        userEmail={user.email ?? ''}
        lang={lang}
      />
      <main style={{ flex: 1 }}>{children}</main>
    </div>
  )
}
