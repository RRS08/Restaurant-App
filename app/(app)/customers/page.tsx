// ----------------------------------------------------------------
// /customers — online-workspace directory stub.
//
// Groundwork only. The real page will roll every buyer up from
// site_orders_link + web contact rows into a per-customer view
// (order history, total spend, last purchase, opt-in status),
// searchable and exportable.
// ----------------------------------------------------------------

import ComingSoon from '@/components/coming-soon'

export const metadata = { title: 'Checked' }

export default function CustomersPage() {
  return (
    <ComingSoon
      eyebrow="ONLINE"
      title="Customers"
      body="Every buyer with an order history, contact info, and marketing opt-in status — one row per person, click through for the full purchase timeline."
    />
  )
}
