'use client'

// ----------------------------------------------------------------
// AppShell — responsive shell wrapper for the protected app pages.
//
// Behavior by breakpoint:
//   xl+ (≥1280px) — DESKTOP: sidebar is a normal flex item, always
//                   visible, content offset to its right. Identical
//                   to the pre-tablet-pass shell.
//   <xl (≤1279px) — TABLET: sidebar is hidden by default and slides
//                   in from the left over the page when toggled.
//                   A backdrop scrim sits behind it; clicking the
//                   scrim or hitting Escape closes the sidebar. A
//                   compact menu button anchors the top-left of the
//                   main content area so the manager can reopen
//                   navigation from any page.
//
// Why a client wrapper:
//   layout.tsx must stay a server component (auth gate + initial
//   data fetch). The state for "is the tablet sidebar open" lives
//   here so a single React state owns both the slide animation and
//   the scrim + close behaviors.
//
// z-index map (tablet only):
//   menu trigger button : z-30
//   backdrop scrim      : z-30
//   sidebar overlay     : z-40
//   page-level drawers  : z-50  (existing — unchanged)
//
// That ordering means: when a manager opens a page drawer (Finance
// Money Review, Inventory item drawer, etc.) on tablet, the drawer
// sits ABOVE both the sidebar and the scrim, so the two never
// fight visually. Clicking outside the drawer closes the drawer
// only — the sidebar stays in whatever state it was in.
// ----------------------------------------------------------------

import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'

export default function AppShell({
  sidebar,
  children,
}: {
  /** Render-prop for the sidebar. Accepts an `onNavigate` callback
   *  the sidebar can fire when a nav item is clicked so the overlay
   *  closes automatically on tablet. */
  sidebar: (props: { onNavigate: () => void }) => React.ReactNode
  children: React.ReactNode
}) {
  const [isOpen, setIsOpen] = useState(false)
  const close = () => setIsOpen(false)
  const open = () => setIsOpen(true)

  // Escape closes the tablet overlay. No-op on desktop where the
  // sidebar is always visible — Escape just won't find an open
  // overlay to close.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen])

  // Lock body scroll while the overlay is open on tablet so the
  // page behind doesn't pan around as the manager taps the scrim.
  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [isOpen])

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* ----------------------------------------------------------------
          Sidebar container.
          • xl+      static flex item — same layout as before.
          • <xl      fixed-position overlay, off-screen by default,
                     slides in on isOpen.
          The `xl:` classes intentionally come last so they win on
          large screens. The transform transition only fires below
          xl; at xl+ the sidebar is static and translate-x doesn't
          apply.
      ---------------------------------------------------------------- */}
      <div
        className={`
          fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-out
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
          xl:static xl:translate-x-0 xl:transition-none
        `}
      >
        {sidebar({ onNavigate: close })}
      </div>

      {/* Backdrop scrim — visible only when sidebar is open on
          tablet. Hidden on desktop entirely. */}
      {isOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={close}
          className="fixed inset-0 bg-gray-900/30 z-30 xl:hidden"
        />
      )}

      {/* Main content. Extra top padding only on tablet so the
          fixed menu button doesn't visually overlap page chrome. */}
      <main className="flex-1 overflow-y-auto p-8 max-xl:pt-16">
        {children}
      </main>

      {/* Tablet menu trigger. Fixed top-left so it's reachable from
          any page. Hidden on desktop (sidebar is always visible
          there, so there's nothing to open). aria-expanded reflects
          state for screen readers. */}
      <button
        type="button"
        onClick={open}
        aria-label="Open navigation menu"
        aria-expanded={isOpen}
        className="xl:hidden fixed top-3 left-3 z-30 inline-flex items-center justify-center w-11 h-11 rounded-lg bg-white border border-gray-200 shadow-sm text-gray-700 hover:bg-gray-50 transition-colors"
      >
        <Menu className="w-5 h-5" />
      </button>
    </div>
  )
}
