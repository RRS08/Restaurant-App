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
// IMPORTANT — server/client boundary safety:
//   This component receives `sidebar` as `React.ReactNode` — a JSX
//   element, which IS serializable across the server/client
//   boundary. It does NOT accept a render-prop function. Passing
//   functions from a Server Component to a Client Component is a
//   React runtime error ("Functions cannot be passed directly to
//   Client Components unless you explicitly expose it by marking
//   it with 'use server'"). That blew up production briefly
//   during the iPad pass — the fix is the React Context below.
//
//   The Sidebar component, also a client component, reads the
//   close callback via the `useSidebarClose()` hook so the
//   "close on nav-item click" behavior still works without any
//   function ever crossing the server→client boundary.
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

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { Menu } from 'lucide-react'

// React Context for the tablet-overlay close handler. Lives entirely
// in client space so a regular function value is safe here. Sidebar
// reads this with useSidebarClose() and calls it on nav-item click.
const SidebarCloseContext = createContext<(() => void) | null>(null)

/** Hook for child client components (the Sidebar) to fetch the
 *  tablet overlay's close handler. Returns null on desktop or when
 *  the consumer is rendered outside the AppShell tree — callers
 *  should null-check before invoking. */
export function useSidebarClose(): (() => void) | null {
  return useContext(SidebarCloseContext)
}

export default function AppShell({
  sidebar,
  children,
}: {
  /** Pre-built sidebar JSX element. Must be a React element (not a
   *  function) so it can cross the server→client boundary safely. */
  sidebar: React.ReactNode
  children: React.ReactNode
}) {
  const [isOpen, setIsOpen] = useState(false)
  const close = useCallback(() => setIsOpen(false), [])
  const open = useCallback(() => setIsOpen(true), [])

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
  }, [isOpen, close])

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
    <SidebarCloseContext.Provider value={close}>
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
          {sidebar}
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
    </SidebarCloseContext.Provider>
  )
}
