'use client'

// ----------------------------------------------------------------
// LanguageToggle — bottom-right floating EN/ES pill.
//
// Client component. The current language is resolved server-side
// (see `resolveLanguage` in app/(marketing)/page.tsx) and passed
// in as `currentLang`. Clicking the other language writes a `lang`
// cookie and hard-reloads so the server re-renders the page with
// the new preference. A cookie-then-reload pattern is the simplest
// route here because nothing about the page is client-state-aware
// — the entire content tree is rendered on the server.
//
// Pill anchors fixed to bottom-right with a z-index above the
// FloorSim overlays so it stays reachable from any section.
// ----------------------------------------------------------------

import { useTransition } from 'react'

const MONO = 'var(--font-geist-mono), ui-monospace, SFMono-Regular, monospace'

interface Props {
  currentLang: 'en' | 'es'
}

export default function LanguageToggle({ currentLang }: Props) {
  const [isPending, startTransition] = useTransition()

  const handleSwitch = (newLang: 'en' | 'es') => {
    if (newLang === currentLang || isPending) return
    // One-year cookie, root path, Lax for cross-link navigation.
    // No `secure` — set to whatever the deploy environment provides
    // by default (production over HTTPS gets a secure cookie via
    // Vercel anyway; localhost stays plain).
    document.cookie = `lang=${newLang}; path=/; max-age=${365 * 24 * 60 * 60}; SameSite=Lax`
    startTransition(() => {
      window.location.reload()
    })
  }

  const baseBtn = {
    padding: '6px 14px',
    border: 'none',
    borderRadius: 999,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    letterSpacing: 'inherit',
    fontWeight: 600,
    transition: 'background 150ms ease, color 150ms ease',
  } as const

  const activeBtn = { ...baseBtn, background: '#FAF9F6', color: '#18181B', cursor: 'default' }
  const idleBtn = { ...baseBtn, background: 'transparent', color: '#FAF9F6', cursor: 'pointer' }

  return (
    <div
      role="group"
      aria-label="Language"
      className="mk-lang-toggle"
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 100,
        display: 'flex',
        gap: 2,
        background: '#18181B',
        borderRadius: 999,
        padding: 4,
        fontFamily: MONO,
        fontSize: 12,
        letterSpacing: '0.12em',
        boxShadow: '0 6px 18px -6px rgba(24, 24, 27, 0.4)',
        opacity: isPending ? 0.7 : 1,
      }}
    >
      <button
        type="button"
        onClick={() => handleSwitch('en')}
        aria-pressed={currentLang === 'en'}
        style={currentLang === 'en' ? activeBtn : idleBtn}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => handleSwitch('es')}
        aria-pressed={currentLang === 'es'}
        style={currentLang === 'es' ? activeBtn : idleBtn}
      >
        ES
      </button>
    </div>
  )
}
