// ----------------------------------------------------------------
// /orders — online-workspace fulfillment queue stub.
//
// Groundwork only. The real page will render web orders by
// fulfillment state (New / Preparing / Ready / Completed / Voided)
// with state-transition buttons in the drawer, buyer status
// emails, and a "needs action" ping on the sidebar nav item.
// Until then, this route just proves the online nav wires up.
// ----------------------------------------------------------------

import ComingSoon from '@/components/coming-soon'

export const metadata = { title: 'Orders · Checked' }

export default function OrdersPage() {
  return (
    <ComingSoon
      eyebrow="ONLINE"
      title="Orders"
      body="Pickup and delivery orders will land here — new orders at the top with a one-tap advance through Preparing → Ready → Completed."
    />
  )
}
