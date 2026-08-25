// ----------------------------------------------------------------
// /catalog — every product on the tenant's online storefront.
//
// Server component: fetches site + products, hands off to the
// interactive client for search + drawer edit + add flows. Reads
// only site_products; the retail menu (Poynt/GoDaddy sync) and
// the online catalog are separate concerns.
// ----------------------------------------------------------------

import { createClient } from '@/lib/supabase/server'
import type { SiteProductRow } from '@/lib/sites/types'
import ComingSoon from '@/components/coming-soon'
import CatalogClient from './client'

export const metadata = { title: 'Catalog · Checked' }

export default async function CatalogPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return <EmptyShell reason="not-signed-in" />

  const { data: role } = await supabase
    .from('user_roles')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .single()
  if (!role) return <EmptyShell reason="no-restaurant" />

  const { data: site } = await supabase
    .from('sites')
    .select('id, slug, name')
    .eq('restaurant_id', role.restaurant_id)
    .maybeSingle()
  if (!site) return <EmptyShell reason="no-site" />

  const { data: products, error } = await supabase
    .from('site_products')
    .select('*')
    .eq('site_id', site.id)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })
  if (error) {
    console.error('[catalog] product query failed', error)
    return <EmptyShell reason="query-error" />
  }

  const rows = (products ?? []) as SiteProductRow[]
  return (
    <CatalogClient
      siteName={site.name ?? 'Online storefront'}
      products={rows}
    />
  )
}

function EmptyShell({ reason }: { reason: string }) {
  const copy: Record<string, { title: string; body: string }> = {
    'not-signed-in': { title: 'Sign in required', body: 'You need to be signed in to view your catalog.' },
    'no-restaurant': { title: 'No restaurant set up', body: 'Finish onboarding to see your online catalog.' },
    'no-site': { title: 'No online storefront yet', body: 'Your tenant does not have an online site configured. Add one to start listing products here.' },
    'query-error': { title: 'Could not load catalog', body: 'Something went wrong loading the catalog. Refresh to try again.' },
  }
  const c = copy[reason] ?? copy['query-error']
  return <ComingSoon eyebrow="CATALOG" title={c.title} body={c.body} />
}
