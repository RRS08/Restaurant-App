'use client'

// ----------------------------------------------------------------
// AppShell — responsive shell wrapper for the protected app pages.
//
// Three navigation surfaces, one per breakpoint band:
//   xl+   (≥1280px) DESKTOP — the labeled 240px sidebar, sticky
//                    flex item.
//   md–xl (768–1279) TABLET — a 76px icon-only rail (IPadRail),
//                    ALWAYS visible.
//   <md   (<768px)  PHONE  — a 4-tab bottom bar (Home / Staff /
//                    Stock / Money). The old labeled-sidebar slide-
//                    in overlay was removed on the phone pass — the
//                    tab bar is the only phone navigation. Menu,
//                    POS, Analytics, and Settings have no phone
//                    destination on purpose (see phone spec §8:
//                    read-only until proven otherwise).
//
// server/client boundary safety: `sidebar` and `rail` are both
// React.ReactNode (pre-built JSX), not render-prop functions.
// ----------------------------------------------------------------

import { PhoneTabBar } from '@/components/phone-tab-bar'

/** Kept as a null-returning stub for backwards compatibility with
 *  the Sidebar component. Previously closed the phone slide-in
 *  overlay; the overlay was replaced by the 4-tab bottom bar so
 *  there's nothing left to close on nav-item click. Sidebar still
 *  imports this hook — returning null means calling code no-ops. */
export function useSidebarClose(): (() => void) | null {
  return null
}

export default function AppShell({
  sidebar,
  rail,
  children,
}: {
  /** Labeled 240px sidebar. Rendered at xl+ (as static flex item). */
  sidebar: React.ReactNode
  /** 76px icon rail. Rendered at md–lt-xl only. */
  rail: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen bg-white">
      {/* ----------------------------------------------------------------
          Tablet (md–lt-xl) — 76px icon rail. FIXED, not sticky, so it
          never rubber-bands with content on iOS Safari's overscroll.
          Out of flex flow — main compensates with md:pl-14 below.
      ---------------------------------------------------------------- */}
      <div className="hidden md:block xl:hidden fixed inset-y-0 left-0 z-20">
        {rail}
      </div>

      {/* ----------------------------------------------------------------
          Desktop (xl+) — labeled 240px sidebar. Same fixed treatment
          for the same reason (Mac trackpad rubber-band). Main
          compensates with xl:pl-60 below.
      ---------------------------------------------------------------- */}
      <div className="hidden xl:block fixed inset-y-0 left-0 z-20">
        {sidebar}
      </div>

      {/* Main content.
          • <md   No top padding — the header of each phone page is
                   flush against the viewport top. Bottom padding is
                   applied INSIDE each phone page (PhonePage) to
                   clear the fixed tab bar + safe area.
          • md–xl NO padding except left = rail width (56px), since
                   the rail is fixed and out of flow.
          • xl+   NO padding except left = sidebar width (240px),
                   since the sidebar is fixed and out of flow.
          No overflow-y here — the WINDOW is the scroll container so
          the fixed rail stays perfectly locked. */}
      <main className="flex-1 min-w-0 md:p-0 md:pl-14 xl:pl-60">
        {children}
      </main>

      {/* Phone (<md) — 4-tab bottom bar. Hidden on tablet + desktop. */}
      <div className="md:hidden">
        <PhoneTabBar />
      </div>
    </div>
  )
}
