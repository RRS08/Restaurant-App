// ----------------------------------------------------------------
// /catalog — online-workspace product catalog stub.
//
// Groundwork only. The real page will surface every site_products
// row for the tenant's site — the online equivalent of /menu for
// retail. Edit copy, variants, ingredients, steep, images, and
// featured flags without leaving the workspace.
// ----------------------------------------------------------------

import ComingSoon from '@/components/coming-soon'

export const metadata = { title: 'Catalog · Checked' }

export default function CatalogPage() {
  return (
    <ComingSoon
      eyebrow="ONLINE"
      title="Catalog"
      body="Every product on the storefront — names, prices, variants, ingredients, images — editable in one place."
    />
  )
}
