'use client'

// ----------------------------------------------------------------
// AppShell — responsive shell wrapper for the protected app pages.
//
// Three navigation surfaces, one per breakpoint band:
//   xl+   (≥1280px) DESKTOP — the labeled 240px sidebar, sticky
//                    flex item.
//   md–xl (768–1279) TABLET — a 76px icon-only rail (IPadRail),
//                    ALWAYS visible. Replaces the hamburger
//                    overlay we used to render at these widths;
//                    the rail saves ~164px of content room vs
//                    the labeled sidebar so pages like /menu
//                    stop wrapping.
//   <md   (<768px)  MOBILE — the labeled sidebar slides in from
//                    the left as an overlay when the top-left
//                    Menu button is tapped. Kept for phone-sized
//                    windows where 76px + content is too tight.
//
// z-index map (mobile overlay only — rail and desktop sidebar are
// static flex items so they don't need z-index):
//   menu trigger button : z-30
//   backdrop scrim      : z-30
//   sidebar overlay     : z-40
//   page-level drawers  : z-50  (existing — unchanged)
//
// server/client boundary safety: `sidebar` and `rail` are both
// React.ReactNode (pre-built JSX), not render-prop functions.
// Functions can't cross the server→client boundary. The
// mobile-overlay close callback flows through the React Context
// below instead of a prop.
// ----------------------------------------------------------------

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { Menu } from 'lucide-react'

const SidebarCloseContext = createContext<(() => void) | null>(null)

/** Hook the labeled Sidebar uses to close the mobile overlay
 *  after a nav-item click. Returns null on desktop / tablet
 *  where the sidebar is always visible and doesn't need closing. */
export function useSidebarClose(): (() => void) | null {
  return useContext(SidebarCloseContext)
}

export default function AppShell({
  sidebar,
  rail,
  children,
}: {
  /** Labeled 240px sidebar. Rendered at <md (as slide-in overlay)
   *  and xl+ (as static flex item). Same JSX in both spots. */
  sidebar: React.ReactNode
  /** 76px icon rail. Rendered at md–lt-xl only. */
  rail: React.ReactNode
  children: React.ReactNode
}) {
  const [isOpen, setIsOpen] = useState(false)
  const close = useCallback(() => setIsOpen(false), [])
  const open = useCallback(() => setIsOpen(true), [])

  // Escape closes the mobile overlay. No-op on tablet / desktop.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, close])

  // Lock body scroll while the mobile overlay is open so the
  // page behind doesn't pan around under the finger.
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
      <div className="flex min-h-screen bg-white">
        {/* ----------------------------------------------------------------
            Mobile (<md) — labeled sidebar as a slide-in overlay.
            Fixed-position so it sits above content when open, off-
            screen otherwise. Hidden entirely on md+.
        ---------------------------------------------------------------- */}
        <div
          className={`
            md:hidden fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-out
            ${isOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
        >
          {sidebar}
        </div>

        {/* ----------------------------------------------------------------
            Tablet (md–lt-xl) — 76px icon rail. Sticky flex item so
            it stays pinned as the page scrolls. Always visible.
        ---------------------------------------------------------------- */}
        <div className="hidden md:block xl:hidden sticky top-0 h-screen self-start">
          {rail}
        </div>

        {/* ----------------------------------------------------------------
            Desktop (xl+) — labeled sidebar as a sticky flex item.
            Same content as the mobile overlay above, different
            positioning.
        ---------------------------------------------------------------- */}
        <div className="hidden xl:block sticky top-0 h-screen self-start">
          {sidebar}
        </div>

        {/* Backdrop scrim — only visible when the mobile overlay
            is open. Tap-to-close. */}
        {isOpen && (
          <button
            type="button"
            aria-label="Close menu"
            onClick={close}
            className="fixed inset-0 bg-zinc-900/30 z-30 md:hidden"
          />
        )}

        {/* Main content. Extra top padding on <md so the fixed
            Menu button doesn't cover page chrome. No overflow-y
            here — the WINDOW is the scroll container so the
            sticky sidebar/rail can pin properly. */}
        <main className="flex-1 min-w-0 p-8 max-md:pt-16">
          {children}
        </main>

        {/* Menu trigger — only <md. On tablet the rail is always
            visible; on desktop the sidebar is always visible; so
            there's nothing to open at md+. */}
        <button
          type="button"
          onClick={open}
          aria-label="Open navigation menu"
          aria-expanded={isOpen}
          className="md:hidden fixed top-3 left-3 z-30 inline-flex items-center justify-center w-11 h-11 rounded-lg bg-white border border-hairline shadow-sm text-zinc-700 hover:bg-zinc-50 transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>
    </SidebarCloseContext.Provider>
  )
}
