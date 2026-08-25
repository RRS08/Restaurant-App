// ----------------------------------------------------------------
// /chat — online-workspace inbox stub.
//
// Groundwork only. Landing here confirms the online sidebar nav
// routes correctly; the real inbox (buyer messages, thread view,
// reply composer) lands in a follow-up.
// ----------------------------------------------------------------

import ComingSoon from '@/components/coming-soon'

export const metadata = { title: 'Chat · Checked' }

export default function ChatPage() {
  return (
    <ComingSoon
      eyebrow="ONLINE"
      title="Chat"
      body="Buyer messages will land here — order questions, delivery updates, and post-purchase follow-ups in one thread per customer."
    />
  )
}
