// ----------------------------------------------------------------
// /edit-site — online-workspace storefront editor stub.
//
// Groundwork only. The real page will let the operator edit
// site_pages content, site.config (nav, footer, announcement,
// locations, delivery options), and swap the theme without
// touching the database directly. Until then, this route just
// proves the online nav wires up.
// ----------------------------------------------------------------

import ComingSoon from '@/components/coming-soon'

export const metadata = { title: 'Edit site · Checked' }

export default function EditSitePage() {
  return (
    <ComingSoon
      eyebrow="ONLINE"
      title="Edit site"
      body="Storefront pages, navigation, footer, announcement bar, and payment/delivery config — edit them all here without touching a line of code."
    />
  )
}
